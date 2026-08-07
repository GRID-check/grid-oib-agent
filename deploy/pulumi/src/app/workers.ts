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
import { BOOTSTRAP_JOB_RESOURCES, JOB_DEFAULTS, LIGHT_WORKER_RESOURCES, PORT, UID } from "../constants";
import { AppSecrets, AppWiring, purgerEnv, schedulerEnv, sref } from "./config";

/**
 * One POST to the internal storage-alert sweep, as a `node -e` program.
 *
 * Written out here rather than inline so the quoting stays readable and so the
 * two things that make it a real check — a non-2xx becoming a non-zero exit, and
 * a bounded timeout — are visible. Without the status check the Job would report
 * success for a 403 from a rotated token, and alerting would be dead with a
 * green CronJob history above it.
 */
const STORAGE_ALERT_SWEEP_SCRIPT = [
  "const url = process.env.SWEEP_URL;",
  "const token = process.env.GRID_INTERNAL_API_TOKEN;",
  // A 10-minute ceiling: the sweep is one grouped aggregate plus a little work
  // per tenant over the threshold, so anything near this is a fault, and hanging
  // forever would block the next tick under concurrencyPolicy: Forbid.
  "const signal = AbortSignal.timeout(600000);",
  "fetch(url, { method: 'POST', headers: { 'x-grid-internal-token': token }, signal })",
  "  .then(async (response) => {",
  "    const body = await response.text();",
  "    if (!response.ok) throw new Error(`sweep failed: ${response.status} ${body}`);",
  // The counts land in the pod log, which is where an operator looks when asking
  // whether alerting ran at all.
  "    console.log(`[storage-alerts] ${body}`);",
  "  })",
  "  .catch((error) => {",
  "    console.error('[storage-alerts]', error.message);",
  "    process.exit(1);",
  "  });",
].join("\n");

/**
 * The two background workers, both built off the frontend image with an
 * overridden command (same pattern as compose). Each is a single replica —
 * both are already multi-instance-safe via `FOR UPDATE SKIP LOCKED`, so one is
 * sufficient and avoids redundant polling.
 *
 * Plus the storage-alert sweep, which is a CronJob rather than a worker — see
 * the comment at its definition for why the shapes differ.
 */
export function installWorkers(
  w: AppWiring,
  cfg: GridConfig,
  secrets: AppSecrets,
  dependsOn: pulumi.Resource[],
): {
  purger: k8s.apps.v1.Deployment;
  scheduler?: k8s.apps.v1.Deployment;
  storageAlerts?: k8s.batch.v1.CronJob;
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
            annotations: secretChecksumAnnotations(secrets.checksum),
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

  // The scheduler container exits 0 immediately when the Workflows feature is
  // off (its own runtime gate) — under a Deployment that means a permanent
  // CrashLoopBackOff. So only create it when the feature is actually enabled;
  // flipping workflowsEnabled + re-running `pulumi up` adds it later.
  const scheduler = cfg.workflows.enabled
    ? new k8s.apps.v1.Deployment(
        "workflow-scheduler",
        {
          metadata: {
            name: "workflow-scheduler",
            namespace: w.namespace,
            labels: commonLabels("workflow-scheduler"),
          },
          spec: {
            replicas: 1,
            ...recreateRollout(ROLLOUT.lightWorker),
            selector: { matchLabels: commonLabels("workflow-scheduler") },
            template: {
              metadata: {
                labels: commonLabels("workflow-scheduler"),
                annotations: secretChecksumAnnotations(secrets.checksum),
              },
              spec: {
                enableServiceLinks: false, // see chroma.ts — legacy env collisions
                imagePullSecrets: w.imagePullSecrets,
                securityContext: { runAsNonRoot: true, runAsUser: UID.frontend, runAsGroup: UID.frontend },
                // Finish the claimed scheduler batch before exiting.
                terminationGracePeriodSeconds: shutdown.terminationGracePeriodSeconds,
                containers: [
                  {
                    name: "workflow-scheduler",
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
      )
    : undefined;

  /**
   * Storage-quota alerting (ADR-0042).
   *
   * A CronJob rather than a third polling Deployment, which is the opposite
   * choice from the two workers above and deliberate. Those two hold a claim on
   * rows (`FOR UPDATE SKIP LOCKED`) and must be resident to keep polling; this
   * one is a periodic sweep with no state between ticks and nothing to claim, so
   * a resident pod would spend 24 hours idle to do a few seconds of work.
   *
   * It calls the BFF rather than doing the work itself because the sweep needs
   * the app's database context, WorkOS client and inbox emitter — all of which
   * already exist behind `/api/internal/storage/alerts`. Re-implementing them in
   * a worker image would be a second copy of the alerting rules to keep in step.
   *
   * `concurrencyPolicy: Forbid` because a tick that overruns its period must not
   * be joined by the next one: two concurrent sweeps could both pass the
   * suppression probe for the same crossing before either has written its row,
   * and emit the alert twice. The endpoint is idempotent across SEQUENTIAL runs
   * (a live row suppresses re-emission), which is what makes at-least-once
   * delivery safe — not concurrent ones.
   *
   * `node -e` with global fetch rather than a curl image: the frontend image is
   * already on every node and already Node, so this adds no pull and no second
   * base image to patch. A non-2xx answer exits non-zero so the Job actually
   * fails instead of reporting success for a 403 — the failure mode that would
   * otherwise leave alerting silently dead behind a rotated token.
   */
  const storageAlerts = cfg.storageAlerts.enabled
    ? new k8s.batch.v1.CronJob(
        "storage-alerts",
        {
          metadata: {
            name: "storage-alerts",
            namespace: w.namespace,
            labels: commonLabels("storage-alerts"),
          },
          spec: {
            schedule: cfg.storageAlerts.schedule,
            concurrencyPolicy: "Forbid",
            successfulJobsHistoryLimit: 3,
            failedJobsHistoryLimit: 3,
            jobTemplate: {
              spec: {
                // Deliberately lower than JOB_DEFAULTS.backoffLimit: the
                // bootstrap Jobs retry hard because they wait on services coming
                // up, whereas a failed sweep is retried by the NEXT tick anyway.
                // Hammering a broken BFF for ten attempts would just move the
                // outage into the alerting path.
                backoffLimit: 2,
                ttlSecondsAfterFinished: JOB_DEFAULTS.ttlSecondsAfterFinished,
                template: {
                  metadata: { labels: commonLabels("storage-alerts") },
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
                        name: "storage-alerts",
                        image: frontendImage(cfg),
                        imagePullPolicy: appPullPolicy(cfg, frontendImage(cfg)),
                        securityContext: hardenedContainerSecurityContext(),
                        resources: BOOTSTRAP_JOB_RESOURCES,
                        command: ["node", "-e", STORAGE_ALERT_SWEEP_SCRIPT],
                        env: [
                          { name: "SWEEP_URL", value: `http://frontend:${PORT.frontend}/api/internal/storage/alerts` },
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
      )
    : undefined;

  return { purger, scheduler, storageAlerts };
}
