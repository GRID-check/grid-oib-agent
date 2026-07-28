import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, frontendImage } from "../config";
import { commonLabels } from "../platform/namespaces";
import { hardenedContainerSecurityContext } from "../platform/security";
import { JOB_DEFAULTS, LIGHT_WORKER_RESOURCES, UID } from "../constants";
import { AppSecrets, AppWiring, migrationEnv } from "./config";

/**
 * Runs `drizzle-kit migrate` against grid_app once per deploy, from the frontend
 * image. This is why the frontend Deployment overrides its command to
 * `node server.js` (dropping the image's default `drizzle-kit migrate && …`):
 * with ≥2 frontend replicas, per-pod migration would race. Centralising it in
 * one Job makes rollout deterministic. drizzle migrations are transactional and
 * idempotent, so re-running is always safe. NOTE: the Job re-fires when its
 * spec changes (e.g. the per-SHA imageTag CI pins) or under `--refresh` after
 * the TTL reaped it — with a MOVING tag and no refresh a redeploy is a no-op
 * and migrations do NOT re-run (see kubernetes.md §2b).
 */
export function runMigrations(
  w: AppWiring,
  cfg: GridConfig,
  secrets: AppSecrets,
  dependsOn: pulumi.Resource[],
): k8s.batch.v1.Job {
  return new k8s.batch.v1.Job(
    "grid-app-migrate",
    {
      metadata: { namespace: w.namespace },
      spec: {
        backoffLimit: JOB_DEFAULTS.backoffLimit,
        ttlSecondsAfterFinished: JOB_DEFAULTS.ttlSecondsAfterFinished,
        template: {
          metadata: { labels: commonLabels("grid-app-migrate") },
          spec: {
            enableServiceLinks: false, // see chroma.ts — legacy env collisions
            imagePullSecrets: w.imagePullSecrets,
            restartPolicy: "OnFailure",
            securityContext: { runAsNonRoot: true, runAsUser: UID.frontend, runAsGroup: UID.frontend },
            containers: [
              {
                name: "migrate",
                image: frontendImage(cfg),
                imagePullPolicy: cfg.images.pullPolicy,
                securityContext: hardenedContainerSecurityContext(),
                command: ["node", "node_modules/drizzle-kit/bin.cjs", "migrate"],
                env: migrationEnv(),
                resources: LIGHT_WORKER_RESOURCES,
              },
            ],
          },
        },
      },
    },
    { provider: w.provider, dependsOn: [secrets.secret, ...dependsOn] },
  );
}
