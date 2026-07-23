import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, frontendImage, toResourceRequirements } from "../config";
import { commonLabels } from "../platform/namespaces";
import { AppWiring, purgerEnv, schedulerEnv } from "./config";

/**
 * The two background workers, both built off the frontend image with an
 * overridden command (same pattern as compose). Each is a single replica —
 * both are already multi-instance-safe via `FOR UPDATE SKIP LOCKED`, so one is
 * sufficient and avoids redundant polling.
 */
export function installWorkers(
  w: AppWiring,
  cfg: GridConfig,
  secret: k8s.core.v1.Secret,
  dependsOn: pulumi.Resource[],
): { purger: k8s.apps.v1.Deployment; scheduler: k8s.apps.v1.Deployment } {
  const workerResources = toResourceRequirements({
    requestsCpu: "50m",
    requestsMemory: "128Mi",
    limitsCpu: "500m",
    limitsMemory: "512Mi",
  });

  const purger = new k8s.apps.v1.Deployment(
    "purger",
    {
      metadata: { name: "purger", namespace: w.namespace, labels: commonLabels("purger") },
      spec: {
        replicas: 1,
        // Only one purger; avoid two racing (safe, but wasteful).
        strategy: { type: "Recreate" },
        selector: { matchLabels: commonLabels("purger") },
        template: {
          metadata: { labels: commonLabels("purger") },
          spec: {
            containers: [
              {
                name: "purger",
                image: frontendImage(cfg),
                imagePullPolicy: cfg.images.pullPolicy,
                command: ["node", "purger/index.js"],
                env: purgerEnv(w),
                resources: workerResources,
              },
            ],
          },
        },
      },
    },
    { provider: w.provider, dependsOn: [secret, ...dependsOn] },
  );

  const scheduler = new k8s.apps.v1.Deployment(
    "workflow-scheduler",
    {
      metadata: {
        name: "workflow-scheduler",
        namespace: w.namespace,
        labels: commonLabels("workflow-scheduler"),
      },
      spec: {
        replicas: 1,
        strategy: { type: "Recreate" },
        selector: { matchLabels: commonLabels("workflow-scheduler") },
        template: {
          metadata: { labels: commonLabels("workflow-scheduler") },
          spec: {
            containers: [
              {
                name: "workflow-scheduler",
                image: frontendImage(cfg),
                imagePullPolicy: cfg.images.pullPolicy,
                command: ["node", "scheduler/index.js"],
                env: schedulerEnv(w),
                resources: workerResources,
              },
            ],
          },
        },
      },
    },
    { provider: w.provider, dependsOn: [secret, ...dependsOn] },
  );

  return { purger, scheduler };
}
