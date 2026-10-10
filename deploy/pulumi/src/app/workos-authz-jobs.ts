import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, appPullPolicy, frontendImage } from "../config";
import { commonLabels } from "../platform/namespaces";
import { hardenedContainerSecurityContext } from "../platform/security";
import { JOB_DEFAULTS, LIGHT_WORKER_RESOURCES, UID } from "../constants";
import { AppSecrets, AppWiring, authzCatalogEnv, folderGrantsCarryOverEnv } from "./config";

type EnvVar = k8s.types.input.core.v1.EnvVar;

/**
 * One run-to-completion Job from the frontend image. Bare `node` on a bundle:
 * the runtime image drops bun, npx, tsx and every devDependency, so the
 * TypeScript scripts are bundled to plain ESM at image build time
 * (`frontends/ui/deploy/Dockerfile`, `dist-scripts/`), with their packages
 * resolved from the production `node_modules`.
 */
function workosJob(
  name: string,
  container: string,
  script: string,
  env: EnvVar[],
  w: AppWiring,
  cfg: GridConfig,
  secrets: AppSecrets,
  dependsOn: pulumi.Resource[],
): k8s.batch.v1.Job {
  return new k8s.batch.v1.Job(
    name,
    {
      metadata: { namespace: w.namespace },
      spec: {
        backoffLimit: JOB_DEFAULTS.backoffLimit,
        ttlSecondsAfterFinished: JOB_DEFAULTS.ttlSecondsAfterFinished,
        template: {
          metadata: { labels: commonLabels(name) },
          spec: {
            enableServiceLinks: false, // see chroma.ts — legacy env collisions
            imagePullSecrets: w.imagePullSecrets,
            restartPolicy: "OnFailure",
            securityContext: { runAsNonRoot: true, runAsUser: UID.frontend, runAsGroup: UID.frontend },
            containers: [
              {
                name: container,
                image: frontendImage(cfg),
                imagePullPolicy: appPullPolicy(cfg, frontendImage(cfg)),
                securityContext: hardenedContainerSecurityContext(),
                command: ["node", `dist-scripts/${script}`, "--apply"],
                env,
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

/**
 * Makes the WorkOS environment hold every permission and role of the app's
 * authorization catalog (`frontends/ui/src/lib/authz/catalog.ts`) once per
 * deploy: `provision:authz --apply`, which used to be a runbook step per
 * environment and was skipped often enough that Production lacked a permission
 * the code already checked.
 *
 * Safe to run every deploy because the catalog is what the code checks: the
 * script creates a missing permission or role, sets a catalog role's
 * permissions to the catalog's, and deletes no permission and no role. Custom
 * roles an office made are not in the catalog and are never touched. An
 * unchanged catalog writes nothing.
 *
 * What it cannot do is create a resource type: neither the SDK nor the public
 * API exposes them. A catalog tier whose type is missing fails the Job, which
 * fails the stack update and names the type (`docs/deployment/workos-provisioning.md`).
 *
 * Nothing waits on it, for the reason `audit-schemas-job.ts` gives: a release
 * must not depend on a third party being reachable. Started early, it usually
 * finishes before the frontend rollout does; when it does not, a permission
 * the new code checks is briefly missing and the check denies. That is the
 * narrow direction.
 */
export function reconcileAuthzCatalog(
  w: AppWiring,
  cfg: GridConfig,
  secrets: AppSecrets,
  dependsOn: pulumi.Resource[],
): k8s.batch.v1.Job {
  return workosJob(
    "grid-app-authz-catalog",
    "authz-catalog",
    "provision-workos-authz.mjs",
    authzCatalogEnv(cfg),
    w,
    cfg,
    secrets,
    dependsOn,
  );
}

/**
 * Carries the role grants of folders with their own list over to WorkOS folder
 * roles (ADR-0097, `migrate:folder-grants --apply`), after the frontend that
 * reads folder roles has rolled out and after the catalog Job has created the
 * folder roles.
 *
 * After, not before, because a list narrowed in the old dialog after an early
 * run would come back wider: the script skips a folder it already registered.
 * Until it has run, a folder with its own list is readable only by
 * organization admins (and by every project member when everyone reads it).
 *
 * Re-running every deploy is a no-op: it skips a registered folder, and saving
 * a list in the new dialog deletes that folder's `project_folder_grants` rows,
 * so a list someone changed is never carried over again. Delete this Job with
 * the migration that drops `project_folder_grants`.
 */
export function carryOverFolderGrants(
  w: AppWiring,
  cfg: GridConfig,
  secrets: AppSecrets,
  dependsOn: pulumi.Resource[],
): k8s.batch.v1.Job {
  return workosJob(
    "grid-app-folder-grants",
    "folder-grants",
    "migrate-folder-grants-to-workos.mjs",
    folderGrantsCarryOverEnv(),
    w,
    cfg,
    secrets,
    dependsOn,
  );
}
