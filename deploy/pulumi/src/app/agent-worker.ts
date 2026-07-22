import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, backendImage, toResourceRequirements } from "../config";
import { commonLabels } from "../platform/namespaces";
import { AppWiring, workerEnv } from "./config";

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
): { deployment: k8s.apps.v1.Deployment; hpa: k8s.autoscaling.v2.HorizontalPodAutoscaler } {
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
            securityContext: { runAsUser: 1000, runAsGroup: 1000 },
            containers: [
              {
                name: "agent-worker",
                image: backendImage(cfg),
                imagePullPolicy: cfg.images.pullPolicy,
                env: workerEnv(w),
                resources: toResourceRequirements(cfg.agentWorker.resources),
                // Liveness: the process is healthy as long as it's running its
                // claim loop; a simple exec check that the python worker is up.
                livenessProbe: {
                  exec: { command: ["pgrep", "-f", "aiq_api.jobs.worker"] },
                  initialDelaySeconds: 20,
                  periodSeconds: 30,
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

  return { deployment, hpa };
}
