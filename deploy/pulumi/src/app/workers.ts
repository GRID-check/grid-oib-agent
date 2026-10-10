import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, appPullPolicy, frontendImage } from "../config";
import { commonLabels } from "../platform/namespaces";
import { hardenedContainerSecurityContext } from "../platform/security";
import {
  ROLLOUT,
  gracefulShutdown,
  recreateRollout,
  secretChecksumAnnotations,
} from "../platform/rollout";
import { withLangfuseKeysChecksum } from "../platform/langfuse";
import { BOOTSTRAP_JOB_RESOURCES, JOB_DEFAULTS, LIGHT_WORKER_RESOURCES, PORT, UID } from "../constants";
import { AppSecrets, AppWiring, BACKEND_URL, purgerEnv, schedulerEnv, sref } from "./config";

const FRONTEND_URL = `http://frontend:${PORT.frontend}`;

/**
 * One POST to an internal sweep route, as a `node -e` program.
 *
 * Written out here rather than inline so the quoting stays readable and so the
 * two things that make it a real check — a non-2xx becoming a non-zero exit, and
 * a bounded timeout — are visible. Without the status check the Job would report
 * success for a 403 from a rotated token, and the sweep would be dead with a
 * green CronJob history above it.
 *
 * One factory for every sweep CronJob (storage alerts, vector reconcile) so the
 * two cannot drift on exactly those two properties.
 */
function internalSweepScript(label: string, timeoutMs: number): string {
  return [
    "const url = process.env.SWEEP_URL;",
    "const token = process.env.GRID_INTERNAL_API_TOKEN;",
    // A ceiling: anything near it is a fault, and hanging forever would block
    // the next tick under concurrencyPolicy: Forbid.
    `const signal = AbortSignal.timeout(${timeoutMs});`,
    "fetch(url, { method: 'POST', headers: { 'x-grid-internal-token': token }, signal })",
    "  .then(async (response) => {",
    "    const body = await response.text();",
    "    if (!response.ok) throw new Error(`sweep failed: ${response.status} ${body}`);",
    // The counts land in the pod log, which is where an operator looks when
    // asking whether the sweep ran at all.
    `    console.log(\`[${label}] \${body}\`);`,
    "  })",
    "  .catch((error) => {",
    `    console.error('[${label}]', error.message);`,
    "    process.exit(1);",
    "  });",
  ].join("\n");
}

/**
 * A CronJob that POSTs to one internal route, the BFF's or the backend's, on a
 * schedule.
 *
 * A CronJob rather than a polling Deployment, which is the opposite choice
 * from the two workers below and deliberate. Those two hold a claim on rows
 * (`FOR UPDATE SKIP LOCKED`) and must be resident to keep polling; a sweep has
 * no state between ticks and nothing to claim, so a resident pod would spend
 * the whole period idle to do a few seconds of work.
 *
 * It calls an app route rather than doing the work itself because the sweep
 * needs the app's database context and clients — all of which already exist
 * behind the internal route. Re-implementing them in a worker image would be a
 * second copy of the rules to keep in step.
 *
 * `concurrencyPolicy: Forbid` because a tick that overruns its period must not
 * be joined by the next one. The endpoints are idempotent across SEQUENTIAL
 * runs, which is what makes at-least-once delivery safe — not concurrent ones.
 *
 * `node -e` with global fetch rather than a curl image: the frontend image is
 * already on every node and already Node, so this adds no pull and no second
 * base image to patch.
 */
function internalSweepCronJob(
  w: AppWiring,
  cfg: GridConfig,
  secrets: AppSecrets,
  dependsOn: pulumi.Resource[],
  sweep: { name: string; schedule: string; url: string; timeoutMs: number },
): k8s.batch.v1.CronJob {
  return new k8s.batch.v1.CronJob(
    sweep.name,
    {
      metadata: {
        name: sweep.name,
        namespace: w.namespace,
        labels: commonLabels(sweep.name),
      },
      spec: {
        schedule: sweep.schedule,
        concurrencyPolicy: "Forbid",
        successfulJobsHistoryLimit: 3,
        failedJobsHistoryLimit: 3,
        jobTemplate: {
          spec: {
            // Deliberately lower than JOB_DEFAULTS.backoffLimit: the
            // bootstrap Jobs retry hard because they wait on services coming
            // up, whereas a failed sweep is retried by the NEXT tick anyway.
            // Hammering a broken BFF for ten attempts would just move the
            // outage into the sweep's path.
            backoffLimit: 2,
            ttlSecondsAfterFinished: JOB_DEFAULTS.ttlSecondsAfterFinished,
            template: {
              metadata: { labels: commonLabels(sweep.name) },
              spec: {
                enableServiceLinks: false, // see chroma.ts — legacy env collisions
                imagePullSecrets: w.imagePullSecrets,
                restartPolicy: "OnFailure",
                securityContext: {
                  runAsNonRoot: true,
                  runAsUser: UID.frontend,
                  runAsGroup: UID.frontend,
                },
                containers: [
                  {
                    name: sweep.name,
                    image: frontendImage(cfg),
                    imagePullPolicy: appPullPolicy(cfg, frontendImage(cfg)),
                    securityContext: hardenedContainerSecurityContext(),
                    resources: BOOTSTRAP_JOB_RESOURCES,
                    command: ["node", "-e", internalSweepScript(sweep.name, sweep.timeoutMs)],
                    env: [
                      { name: "SWEEP_URL", value: sweep.url },
                      // The token never reaches the command line — an `-H`
                      // argument would show up in `kubectl describe pod` and
                      // in every process listing in the container.
                      sref("GRID_INTERNAL_API_TOKEN"),
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    },
    { provider: w.provider, dependsOn: [secrets.secret, ...dependsOn] },
  );
}

/**
 * The two background workers, both built off the frontend image with an
 * overridden command (same pattern as compose). Each is a single replica —
 * both are already multi-instance-safe via `FOR UPDATE SKIP LOCKED`, so one is
 * sufficient and avoids redundant polling.
 *
 * Plus two sweeps — storage alerts and the orphaned-vector reconcile — which
 * are CronJobs rather than workers; `internalSweepCronJob` says why.
 */
export function installWorkers(
  w: AppWiring,
  cfg: GridConfig,
  secrets: AppSecrets,
  dependsOn: pulumi.Resource[],
): {
  purger: k8s.apps.v1.Deployment;
  scheduler: k8s.apps.v1.Deployment;
  storageAlerts?: k8s.batch.v1.CronJob;
  vectorReconcile?: k8s.batch.v1.CronJob;
  housekeeping: k8s.batch.v1.CronJob[];
} {
  const workerResources = LIGHT_WORKER_RESOURCES;
  const shutdown = gracefulShutdown(ROLLOUT.lightWorker);

  const purger = new k8s.apps.v1.Deployment(
    "purger",
    {
      metadata: { name: "purger", namespace: w.namespace, labels: commonLabels("purger") },
      spec: {
        replicas: 1,
        // Only one purger; avoid two racing (safe, but wasteful). Recreate, but
        // still gated by minReadySeconds + a progress deadline so a
        // crash-looping replacement fails the deploy instead of passing it.
        ...recreateRollout(ROLLOUT.lightWorker),
        selector: { matchLabels: commonLabels("purger") },
        template: {
          metadata: {
            labels: commonLabels("purger"),
            annotations: secretChecksumAnnotations(withLangfuseKeysChecksum(cfg, secrets.checksum)),
          },
          spec: {
            enableServiceLinks: false, // see chroma.ts — legacy env collisions
            imagePullSecrets: w.imagePullSecrets,
            securityContext: { runAsNonRoot: true, runAsUser: UID.frontend, runAsGroup: UID.frontend },
            // Room to finish the purge tick in flight (S3 deletes + DB writes)
            // rather than being SIGKILLed part-way through one.
            terminationGracePeriodSeconds: shutdown.terminationGracePeriodSeconds,
            containers: [
              {
                name: "purger",
                image: frontendImage(cfg),
                imagePullPolicy: appPullPolicy(cfg, frontendImage(cfg)),
                securityContext: hardenedContainerSecurityContext(),
                command: ["node", "purger/index.js"],
                env: purgerEnv(w),
                resources: workerResources,
              },
            ],
          },
        },
      },
    },
    { provider: w.provider, dependsOn: [secrets.secret, ...dependsOn] },
  );

  // Created whatever `skillsEnabled` says. The container used to exit 0 when
  // Agent Skills were off, which under a Deployment is a permanent
  // CrashLoopBackOff, so it was only created with the feature on. It now also
  // drives the run reconciler (`frontends/ui/src/lib/runs/reconcile.ts`), and
  // runs exist without Agent Skills (an escalated chat question), so with the
  // feature off it stays up as a reconcile-only worker and fires no schedules.
  const scheduler = new k8s.apps.v1.Deployment(
        "skill-scheduler",
        {
          metadata: {
            name: "skill-scheduler",
            namespace: w.namespace,
            labels: commonLabels("skill-scheduler"),
          },
          spec: {
            replicas: 1,
            ...recreateRollout(ROLLOUT.lightWorker),
            selector: { matchLabels: commonLabels("skill-scheduler") },
            template: {
              metadata: {
                labels: commonLabels("skill-scheduler"),
                annotations: secretChecksumAnnotations(withLangfuseKeysChecksum(cfg, secrets.checksum)),
              },
              spec: {
                enableServiceLinks: false, // see chroma.ts — legacy env collisions
                imagePullSecrets: w.imagePullSecrets,
                securityContext: { runAsNonRoot: true, runAsUser: UID.frontend, runAsGroup: UID.frontend },
                // Finish the claimed scheduler batch before exiting.
                terminationGracePeriodSeconds: shutdown.terminationGracePeriodSeconds,
                containers: [
                  {
                    name: "skill-scheduler",
                    image: frontendImage(cfg),
                    imagePullPolicy: appPullPolicy(cfg, frontendImage(cfg)),
                    securityContext: hardenedContainerSecurityContext(),
                    command: ["node", "scheduler/index.js"],
                    env: schedulerEnv(w),
                    resources: workerResources,
                  },
                ],
              },
            },
          },
        },
        { provider: w.provider, dependsOn: [secrets.secret, ...dependsOn] },
      );

  /**
   * Storage-quota alerting (ADR-0042). A 10-minute ceiling: the sweep is one
   * grouped aggregate plus a little work per tenant over the threshold. The
   * endpoint is idempotent across sequential runs (a live row suppresses
   * re-emission); two concurrent sweeps could both pass the suppression probe
   * for the same crossing before either has written its row, and emit the
   * alert twice — which is what `Forbid` in the factory is for.
   */
  const storageAlerts = cfg.storageAlerts.enabled
    ? internalSweepCronJob(w, cfg, secrets, dependsOn, {
        name: "storage-alerts",
        schedule: cfg.storageAlerts.schedule,
        url: `${FRONTEND_URL}/api/internal/storage/alerts`,
        timeoutMs: 600_000,
      })
    : undefined;

  /**
   * The orphaned-vector sweep. A cleanup that needs a platform owner to click
   * is not a ratchet, and the orphans it recovers are invisible in the product
   * — so this is the clock behind Platform → Vector maintenance. Weekly,
   * off-peak by default (`vectorReconcileSchedule`). A 30-minute ceiling: the
   * BFF lists and diffs every live collection, and the backend then walks the
   * same collections' summaries, each with its own 15-second per-call timeout,
   * so a deployment of a few hundred projects is minutes, not tens of them.
   */
  const vectorReconcile = cfg.vectorReconcile.enabled
    ? internalSweepCronJob(w, cfg, secrets, dependsOn, {
        name: "vector-reconcile",
        schedule: cfg.vectorReconcile.schedule,
        url: `${FRONTEND_URL}/api/internal/maintenance/reconcile-vectors`,
        timeoutMs: 1_800_000,
      })
    : undefined;

  /**
   * The backend's housekeeping (ADR-0082 step A1). The backend runs none of it
   * on its own: each route does one cycle when called, and these CronJobs are
   * what calls them. Each cycle takes a Postgres advisory lock, so a tick that
   * overlaps a slow previous one skips.
   *
   * The ghost reaper fails a job after 300 seconds without an event; every two
   * minutes puts the worst case at 420 seconds. Two are hourly, on minutes apart
   * from each other and from the hourly storage sweep. The base corpus is the
   * fourth: one sync cycle records the ingest jobs that finished and queues a job
   * on the ingest queue for every file that still has none (an upload whose job
   * could not be queued, a chunking change), so a document never waits longer than
   * ten minutes for its job, and a cycle that runs past its tick blocks the next
   * (`Forbid`). The cycle ingests nothing: the ingest workers (or the claiming web
   * pods) run the jobs.
   */
  const housekeeping = [
    { name: "housekeeping-ghost-jobs", schedule: "*/2 * * * *", route: "ghost-jobs", timeoutMs: 90_000 },
    { name: "housekeeping-job-events", schedule: "7 * * * *", route: "job-events", timeoutMs: 900_000 },
    { name: "housekeeping-chat-checkpoints", schedule: "37 * * * *", route: "chat-checkpoints", timeoutMs: 900_000 },
    { name: "housekeeping-base-corpus", schedule: "*/10 * * * *", route: "base-corpus", timeoutMs: 600_000 },
  ].map(({ route, ...sweep }) =>
    internalSweepCronJob(w, cfg, secrets, dependsOn, {
      ...sweep,
      url: `${BACKEND_URL}/v1/maintenance/housekeeping/${route}`,
    }),
  );

  return { purger, scheduler, storageAlerts, vectorReconcile, housekeeping };
}
