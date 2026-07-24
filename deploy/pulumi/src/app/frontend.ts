import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, frontendImage, toResourceRequirements } from "../config";
import { commonLabels } from "../platform/namespaces";
import { installPdb, spreadAcrossNodes } from "../platform/scheduling";
import { AppWiring, frontendEnv } from "./config";

export interface Frontend {
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
  hpa: k8s.autoscaling.v2.HorizontalPodAutoscaler;
  pdb: k8s.policy.v1.PodDisruptionBudget;
}

/**
 * Frontend: Next.js UI + BFF API routes + the WebSocket gateway (server.js),
 * all in one Node process per pod. Runs HORIZONTALLY: it is stateless once the
 * shared cache (Dragonfly/Redis) is wired — which it is — so an HPA scales it on
 * CPU. Command is overridden to `node server.js`; the image's default also runs
 * `drizzle-kit migrate`, which we deliberately move to the one-shot migration
 * Job to avoid replicas racing on migrations.
 *
 * A chat WS connection pins to whichever pod terminated its upgrade and stays
 * there for its lifetime, so no session affinity is required at the ingress.
 */
export function installFrontend(
  w: AppWiring,
  cfg: GridConfig,
  secret: k8s.core.v1.Secret,
  dependsOn: pulumi.Resource[],
): Frontend {
  const labels = commonLabels("frontend");

  const deployment = new k8s.apps.v1.Deployment(
    "frontend",
    {
      metadata: { name: "frontend", namespace: w.namespace, labels },
      spec: {
        // Initial size; the HPA owns replica count thereafter.
        replicas: cfg.frontend.minReplicas,
        selector: { matchLabels: labels },
        strategy: {
          type: "RollingUpdate",
          rollingUpdate: { maxUnavailable: 0, maxSurge: 1 },
        },
        template: {
          metadata: { labels },
          spec: {
            // Spread replicas across worker nodes so a single node loss (or the
            // provider's automatic upgrade node-replacement) never drops the
            // whole frontend tier. Soft (ScheduleAnyway) — never blocks a deploy.
            topologySpreadConstraints: spreadAcrossNodes(labels),
            containers: [
              {
                name: "frontend",
                image: frontendImage(cfg),
                imagePullPolicy: cfg.images.pullPolicy,
                // Skip the image's built-in migrate; the Job owns migrations.
                command: ["node", "server.js"],
                ports: [{ containerPort: 3000, name: "http" }],
                env: frontendEnv(w),
                resources: toResourceRequirements(cfg.frontend.resources),
                readinessProbe: {
                  httpGet: { path: "/api/healthz", port: 3000 },
                  initialDelaySeconds: 10,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: "/api/healthz", port: 3000 },
                  initialDelaySeconds: 30,
                  periodSeconds: 15,
                  failureThreshold: 5,
                },
              },
            ],
          },
        },
      },
    },
    // The HPA owns spec.replicas after creation — don't let `pulumi up` revert
    // an autoscaling decision back to minReplicas.
    { provider: w.provider, dependsOn: [secret, ...dependsOn], ignoreChanges: ["spec.replicas"] },
  );

  const service = new k8s.core.v1.Service(
    "frontend",
    {
      metadata: { name: "frontend", namespace: w.namespace, labels },
      spec: {
        selector: labels,
        ports: [{ port: 3000, targetPort: 3000, name: "http" }],
      },
    },
    { provider: w.provider, dependsOn: deployment },
  );

  const hpa = new k8s.autoscaling.v2.HorizontalPodAutoscaler(
    "frontend",
    {
      metadata: { name: "frontend", namespace: w.namespace, labels },
      spec: {
        scaleTargetRef: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: deployment.metadata.name,
        },
        minReplicas: cfg.frontend.minReplicas,
        maxReplicas: cfg.frontend.maxReplicas,
        metrics: [
          {
            type: "Resource",
            resource: {
              name: "cpu",
              target: {
                type: "Utilization",
                averageUtilization: cfg.frontend.hpaCpuTargetPercent,
              },
            },
          },
        ],
      },
    },
    { provider: w.provider, dependsOn: deployment },
  );

  // Cap voluntary disruptions at one pod so an automatic-upgrade node drain
  // can't evict every frontend replica simultaneously.
  const pdb = installPdb("frontend", w.namespace, w.provider, labels, [deployment]);

  return { deployment, service, hpa, pdb };
}
