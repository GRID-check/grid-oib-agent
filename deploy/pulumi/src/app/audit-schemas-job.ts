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
 * 400, and the DEFAULT emitter never throws — so the privileged mutation
 * succeeds while its audit trail quietly does not exist. That is exactly how
 * nine actions (issues #255/#256) stayed broken behind a manual "run this once
 * per environment" runbook step. Tying it to the deploy makes the environment
 * follow the code by construction, the same way the drizzle Job does for the
 * schema of grid_app.
 *
 * The script reconciles (reads first, writes only what is missing or changed),
 * which is what makes per-deploy execution safe: an unchanged registry writes
 * nothing rather than minting a new schema version every rollout.
 *
 * ## Nothing depends on this Job — and since 2026-08-20 that IS a trade
 *
 * The line that used to stand here said "the audit trail is not on any request
 * path". That stopped being true when agent-authored documents shipped:
 * `fileGeneratedDocument` emits `document.generated` with the THROWING emitter
 * (`recordAuditEventOrThrow`), because "a machine wrote this on this human's
 * authority" has no domain table to fall back on. An unregistered schema there
 * does not thin the trail — WorkOS rejects the event, the emit throws, and the
 * document is unfiled, row and object both. The user gets a report with no file.
 *
 * So the reconcile is now on the request path of one feature, and the ordering
 * this file does NOT establish is a real (small) window: the frontend Deployment
 * is created with `[migrations, backend.service]` as its dependencies and never
 * this Job, so a rollout that introduces a NEW action — or changes an existing
 * one's metadata keys, which WorkOS rejects exactly like a missing schema — can
 * serve filing requests for as long as the Job takes to finish. Existing schemas
 * are already registered from earlier deploys, so the exposure is bounded to
 * that one rollout and it is self-healing.
 *
 * That window was left standing deliberately rather than closed by adding the
 * Job to the frontend's `dependsOn`: doing so would make every release of the
 * app — including a release fixing an unrelated outage — wait on a third party
 * being reachable, to protect a bounded window in which the failure is loud
 * (a 500 on the diagram route, `filingFailed: true` on the report route) and
 * the remedy is pressing the button again. It is a judgement call and it should
 * be revisited if a second throwing emitter appears. Compose and Coolify make
 * the opposite call for a stack-specific reason — there is no rolling update to
 * protect and WorkOS is already a hard dependency of those stacks (see
 * `deploy/compose/docker-compose*.yaml`, service `grid-audit-schemas`).
 *
 * Two knobs follow from the premise change rather than from taste:
 *   - `backoffLimit` (10) is what actually closes the window — the Job retries
 *     through a WorkOS hiccup instead of leaving the environment unreconciled.
 *   - `ttlSecondsAfterFinished` (300) reaps the Job object five minutes after it
 *     finishes, failure included. That is short for evidence now: the durable
 *     signals are the stack update and the ABSENCE of `document.generated`
 *     events, which is the check `docs/deployment/agent-authored-documents-rollout.md`
 *     §5 asks for after every deploy.
 *
 * One caveat this Job inherits from the migrations Job: it re-fires only when
 * its spec changes. CI pins `imageTag` per SHA, so a CI deploy re-runs it; a
 * hand-run deploy against a MOVING tag does not, and then the registry in the
 * image and the schemas in WorkOS can drift apart silently.
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
