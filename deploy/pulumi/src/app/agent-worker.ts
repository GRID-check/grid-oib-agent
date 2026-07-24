import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, backendImage, toResourceRequirements } from "../config";
import { commonLabels } from "../platform/namespaces";
import { installPdb, spreadAcrossNodes } from "../platform/scheduling";
import { hardenedContainerSecurityContext } from "../platform/security";
import { AppWiring, workerEnv } from "./config";
import { UID } from "../constants";

/**
 * Research worker tier (ADR-0021) — only deployed when jobExecution = "db".
 *
 * Dedicated worker replicas (same backend image, `GRID_ROLE=worker`) claim
 * deep-research jobs from Postgres and execute them, so the token-heavy
 * workload scales horizontally and independently of the chat/web tier. No web
 * port, no Dask, no PVC — workers are stateless (vectors live in shared Chroma,
 * job state in Postgres). An HPA scales them on CPU.
 */
export function installAgentWorker(
  w: AppWiring,
  cfg: GridConfig,
  secret: k8s.core.v1.Secret,
  dependsOn: pulumi.Resource[],
): {
  deployment: k8s.apps.v1.Deployment;
  hpa: k8s.autoscaling.v2.HorizontalPodAutoscaler;
  pdb: k8s.policy.v1.PodDisruptionBudget;
} {
  const labels = commonLabels("agent-worker");

  const deployment = new k8s.apps.v1.Deployment(
    "agent-worker",
    {
      metadata: { name: "agent-worker", namespace: w.namespace, labels },
      spec: {
        replicas: cfg.agentWorker.minReplicas,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            securityContext: { runAsNonRoot: true, runAsUser: UID.backend, runAsGroup: UID.backend },
            // Spread workers across nodes (autoscaler prerequisite + survives a
            // single node loss / automatic-upgrade node replacement).
            topologySpreadConstraints: spreadAcrossNodes(labels),
            containers: [
              {
                name: "agent-worker",
                image: backendImage(cfg),
                imagePullPolicy: cfg.images.pullPolicy,
                securityContext: hardenedContainerSecurityContext(),
                env: workerEnv(w),
                resources: toResourceRequirements(cfg.agentWorker.resources),
                // Liveness: the worker touches /tmp/research-worker.alive every
                // claim-loop tick. Probe with python (present in the image; the
                // debian-slim backend image has NO pgrep/procps) and fail if the
                // marker is stale (loop hung) or missing.
                livenessProbe: {
                  exec: {
                    command: [
                      "python",
                      "-c",
                      "import os,sys,time; f='/tmp/research-worker.alive'; " +
                        "sys.exit(0 if os.path.exists(f) and time.time()-os.path.getmtime(f) < 180 else 1)",
                    ],
                  },
                  initialDelaySeconds: 30,
                  periodSeconds: 30,
                  failureThreshold: 3,
                },
                // The marker only appears on the FIRST claim-loop tick, which is
                // gated behind importing the full aiq_api stack + connecting to
                // Postgres/Chroma. On a cold node that can exceed the liveness
                // window and crash-loop the pod before it ever works. A startup
                // probe holds liveness off until first boot completes (up to
                // 60×10s = 10 min) instead of killing a still-booting worker.
                startupProbe: {
                  exec: {
                    command: ["python", "-c", "import os,sys; sys.exit(0 if os.path.exists('/tmp/research-worker.alive') else 1)"],
                  },
                  periodSeconds: 10,
                  failureThreshold: 60,
                },
              },
            ],
          },
        },
      },
    },
    { provider: w.provider, dependsOn: [secret, ...dependsOn], ignoreChanges: ["spec.replicas"] },
  );

  const hpa = new k8s.autoscaling.v2.HorizontalPodAutoscaler(
    "agent-worker",
    {
      metadata: { name: "agent-worker", namespace: w.namespace, labels },
      spec: {
        scaleTargetRef: { apiVersion: "apps/v1", kind: "Deployment", name: deployment.metadata.name },
        minReplicas: cfg.agentWorker.minReplicas,
        maxReplicas: cfg.agentWorker.maxReplicas,
        metrics: [
          {
            type: "Resource",
            resource: {
              name: "cpu",
              target: { type: "Utilization", averageUtilization: cfg.agentWorker.hpaCpuTargetPercent },
            },
          },
        ],
      },
    },
    { provider: w.provider, dependsOn: deployment },
  );

  // One-at-a-time voluntary disruptions so an upgrade node drain can't evict
  // the whole worker tier and stall all in-flight research jobs at once.
  const pdb = installPdb("agent-worker", w.namespace, w.provider, labels, [deployment]);

  return { deployment, hpa, pdb };
}
