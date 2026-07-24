import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, frontendImage } from "../config";
import { commonLabels } from "../platform/namespaces";
import { hardenedContainerSecurityContext } from "../platform/security";
import { AppWiring, migrationEnv } from "./config";

/**
 * Runs `drizzle-kit migrate` against grid_app once per deploy, from the frontend
 * image. This is why the frontend Deployment overrides its command to
 * `node server.js` (dropping the image's default `drizzle-kit migrate && …`):
 * with ≥2 frontend replicas, per-pod migration would race. Centralising it in
 * one Job makes rollout deterministic. drizzle migrations are transactional and
 * idempotent, so re-running on every `pulumi up` is safe.
 */
export function runMigrations(
  w: AppWiring,
  cfg: GridConfig,
  secret: k8s.core.v1.Secret,
  dependsOn: pulumi.Resource[],
): k8s.batch.v1.Job {
  return new k8s.batch.v1.Job(
    "grid-app-migrate",
    {
      metadata: { namespace: w.namespace },
      spec: {
        backoffLimit: 6,
        ttlSecondsAfterFinished: 300,
        template: {
          metadata: { labels: commonLabels("grid-app-migrate") },
          spec: {
            restartPolicy: "OnFailure",
            securityContext: { runAsNonRoot: true, runAsUser: 1001, runAsGroup: 1001 },
            containers: [
              {
                name: "migrate",
                image: frontendImage(cfg),
                imagePullPolicy: cfg.images.pullPolicy,
                securityContext: hardenedContainerSecurityContext(),
                command: ["node", "node_modules/drizzle-kit/bin.cjs", "migrate"],
                env: migrationEnv(),
                resources: {
                  requests: { cpu: "50m", memory: "128Mi" },
                  limits: { cpu: "500m", memory: "512Mi" },
                },
              },
            ],
          },
        },
      },
    },
    { provider: w.provider, dependsOn: [secret, ...dependsOn] },
  );
}
