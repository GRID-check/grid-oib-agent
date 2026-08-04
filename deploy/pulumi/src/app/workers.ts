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
import { LIGHT_WORKER_RESOURCES, UID } from "../constants";
import { AppSecrets, AppWiring, purgerEnv, schedulerEnv } from "./config";

/**
 * The two background workers, both built off the frontend image with an
 * overridden command (same pattern as compose). Each is a single replica —
 * both are already multi-instance-safe via `FOR UPDATE SKIP LOCKED`, so one is
 * sufficient and avoids redundant polling.
 */
export function installWorkers(
  w: AppWiring,
  cfg: GridConfig,
  secrets: AppSecrets,
  dependsOn: pulumi.Resource[],
): { purger: k8s.apps.v1.Deployment; scheduler?: k8s.apps.v1.Deployment } {
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

  return { purger, scheduler };
}
