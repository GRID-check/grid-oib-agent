import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  GridConfig,
  assertHpaTargetIsProportional,
  assertMemoryFitsLimit,
  toResourceRequirements,
  webImage,
} from "../config";
import { commonLabels } from "../platform/namespaces";
import { installPdb, spreadAcrossNodes } from "../platform/scheduling";
import { hardenedContainerSecurityContext } from "../platform/security";
import { ROLLOUT, gracefulShutdown, surgeRollout } from "../platform/rollout";
import { PORT, UID } from "../constants";

export interface Web {
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
  hpa: k8s.autoscaling.v2.HorizontalPodAutoscaler;
  pdb: k8s.policy.v1.PodDisruptionBudget;
}

/**
 * Landing site (frontends/web): Astro on the Node standalone adapter. The pages
 * are prerendered at build time (static HTML + assets served by the adapter),
 * with SSR routes for the Keystatic admin. No database, no app secrets, no
 * cross-service calls — so unlike the frontend tier this workload has no
 * dependency on `grid-secrets`. It DOES carry the registry imagePullSecrets:
 * the web image is pulled from the same registry as the other app images, so
 * a private registry without the pull Secret is an instant ImagePullBackOff.
 * Runs HORIZONTALLY: stateless, HPA on CPU.
 */
export function installWeb(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  imagePullSecrets: { name: string }[],
  dependsOn: pulumi.Resource[],
): Web {
  const labels = commonLabels("web");
  const shutdown = gracefulShutdown(ROLLOUT.web, "node");

  assertHpaTargetIsProportional("web", cfg.web.resources, cfg.web.hpaCpuTargetPercent);
  assertMemoryFitsLimit("web", cfg.web.resources);

  const deployment = new k8s.apps.v1.Deployment(
    "web",
    {
      metadata: { name: "web", namespace, labels },
      spec: {
        replicas: cfg.web.minReplicas,
        selector: { matchLabels: labels },
        ...surgeRollout(ROLLOUT.web),
        template: {
          metadata: { labels },
          spec: {
            enableServiceLinks: false, // see chroma.ts — legacy env collisions
            imagePullSecrets,
            terminationGracePeriodSeconds: shutdown.terminationGracePeriodSeconds,
            securityContext: { runAsNonRoot: true, runAsUser: UID.web, runAsGroup: UID.web },
            topologySpreadConstraints: spreadAcrossNodes(labels),
            containers: [
              {
                name: "web",
                image: webImage(cfg),
                imagePullPolicy: cfg.images.pullPolicy,
                securityContext: hardenedContainerSecurityContext(),
                // Astro node adapter: entry.mjs reads HOST/PORT from env.
                command: ["node", "dist/server/entry.mjs"],
                ports: [{ containerPort: PORT.web, name: "http" }],
                env: [
                  { name: "HOST", value: "0.0.0.0" },
                  { name: "PORT", value: String(PORT.web) },
                ],
                resources: toResourceRequirements(cfg.web.resources),
                lifecycle: shutdown.lifecycle,
                readinessProbe: {
                  httpGet: { path: "/", port: PORT.web },
                  initialDelaySeconds: 5,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: "/", port: PORT.web },
                  initialDelaySeconds: 15,
                  periodSeconds: 15,
                  failureThreshold: 5,
                },
              },
            ],
          },
        },
      },
    },
    {
      provider,
      dependsOn,
      ignoreChanges: ["spec.replicas"],
      customTimeouts: { create: "20m", update: "20m" },
    },
  );

  const service = new k8s.core.v1.Service(
    "web",
    {
      metadata: { name: "web", namespace, labels },
      spec: {
        selector: labels,
        ports: [{ port: PORT.web, targetPort: PORT.web, name: "http" }],
      },
    },
    { provider, dependsOn: deployment },
  );

  const hpa = new k8s.autoscaling.v2.HorizontalPodAutoscaler(
    "web",
    {
      metadata: { name: "web", namespace, labels },
      spec: {
        scaleTargetRef: {
          apiVersion: "apps/v1",
          kind: "Deployment",
          name: deployment.metadata.name,
        },
        minReplicas: cfg.web.minReplicas,
        maxReplicas: cfg.web.maxReplicas,
        metrics: [
          {
            type: "Resource",
            resource: {
              name: "cpu",
              target: {
                type: "Utilization",
                averageUtilization: cfg.web.hpaCpuTargetPercent,
              },
            },
          },
        ],
      },
    },
    { provider, dependsOn: deployment },
  );

  const pdb = installPdb("web", namespace, provider, labels, [deployment]);

  return { deployment, service, hpa, pdb };
}
