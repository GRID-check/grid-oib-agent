import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, appPullPolicy, frontendImage } from "../config";
import { commonLabels } from "../platform/namespaces";
import { hardenedContainerSecurityContext } from "../platform/security";
import { JOB_DEFAULTS, LIGHT_WORKER_RESOURCES, UID } from "../constants";
import { AppSecrets, AppWiring, auditSchemaEnv } from "./config";

/**
 * Reconciles the WorkOS Audit Log schemas with the app's audit registry
 * (`frontends/ui/src/lib/audit/schemas.mjs`) once per deploy, from the frontend
 * image.
 *
 * It is a deploy step because the failure it prevents is silent: an action the
 * code emits but the environment has no schema for is rejected by WorkOS with a
 * 400, and the emitter never throws — so the privileged mutation succeeds while
 * its audit trail quietly does not exist. That is exactly how nine actions
 * (issues #255/#256) stayed broken behind a manual "run this once per
 * environment" runbook step. Tying it to the deploy makes the environment
 * follow the code by construction, the same way the drizzle Job does for the
 * schema of grid_app.
 *
 * The script reconciles (reads first, writes only what is missing or changed),
 * which is what makes per-deploy execution safe: an unchanged registry writes
 * nothing rather than minting a new schema version every rollout.
 *
 * Nothing depends on this Job. The audit trail is not on any request path, and
 * a WorkOS outage must not be able to hold back a release of the app itself.
 */
export function reconcileAuditSchemas(
  w: AppWiring,
  cfg: GridConfig,
  secrets: AppSecrets,
  dependsOn: pulumi.Resource[],
): k8s.batch.v1.Job {
  return new k8s.batch.v1.Job(
    "grid-app-audit-schemas",
    {
      metadata: { namespace: w.namespace },
      spec: {
        backoffLimit: JOB_DEFAULTS.backoffLimit,
        ttlSecondsAfterFinished: JOB_DEFAULTS.ttlSecondsAfterFinished,
        template: {
          metadata: { labels: commonLabels("grid-app-audit-schemas") },
          spec: {
            enableServiceLinks: false, // see chroma.ts — legacy env collisions
            imagePullSecrets: w.imagePullSecrets,
            restartPolicy: "OnFailure",
            securityContext: { runAsNonRoot: true, runAsUser: UID.frontend, runAsGroup: UID.frontend },
            containers: [
              {
                name: "audit-schemas",
                image: frontendImage(cfg),
                imagePullPolicy: appPullPolicy(cfg, frontendImage(cfg)),
                securityContext: hardenedContainerSecurityContext(),
                // Bare `node`: the runtime image drops npm/npx and every
                // devDependency, so the script must be plain ESM with no loader.
                command: ["node", "scripts/provision-workos-audit-schemas.mjs", "--apply"],
                env: auditSchemaEnv(),
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
