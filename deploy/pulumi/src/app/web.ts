import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  GridConfig,
  appPullPolicy,
  assertHpaTargetIsProportional,
  assertMemoryFitsLimit,
  toResourceRequirements,
  webImage,
} from "../config";
import { commonLabels } from "../platform/namespaces";
import { installPdb, spreadAcrossNodes } from "../platform/scheduling";
import { hardenedContainerSecurityContext } from "../platform/security";
import {
  ROLLOUT,
  gracefulShutdown,
  secretChecksum,
  secretChecksumAnnotations,
  surgeRollout,
} from "../platform/rollout";
import { PORT, UID } from "../constants";

export interface Web {
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
  hpa: k8s.autoscaling.v2.HorizontalPodAutoscaler;
  pdb: k8s.policy.v1.PodDisruptionBudget;
  /** The contact form's two secrets, when `contactAddress` is set. */
  contactSecret?: k8s.core.v1.Secret;
}

/** The web tier's own Secret: the contact form's, and nothing else. */
export const WEB_CONTACT_SECRET_NAME = "web-contact"; // pragma: allowlist secret (Kubernetes Secret resource name, not a credential)

type EnvVar = k8s.types.input.core.v1.EnvVar;

/**
 * The contact form's env (`frontends/web/src/lib/contact.ts` reads the five):
 * where it sends from and to, the account it sends through, and, from the web
 * tier's own Secret, the Email Sending token and the form's HMAC key.
 */
function contactEnv(cfg: GridConfig, accountId: pulumi.Input<string>): EnvVar[] {
  const fromSecret = (name: string): EnvVar => ({
    name,
    valueFrom: { secretKeyRef: { name: WEB_CONTACT_SECRET_NAME, key: name } },
  });
  return [
    { name: "CONTACT_FROM", value: cfg.contact.address },
    { name: "CONTACT_FORWARD_TO", value: cfg.contact.forwardTo.join(",") },
    { name: "CLOUDFLARE_ACCOUNT_ID", value: accountId },
    fromSecret("CLOUDFLARE_EMAIL_TOKEN"),
    fromSecret("CONTACT_FORM_SECRET"),
  ];
}

/**
 * Landing site (frontends/web): Astro on the Node standalone adapter. The pages
 * are prerendered at build time (static HTML + assets served by the adapter),
 * with SSR routes for the Keystatic admin and the contact form. No database,
 * no app secrets, no cross-service calls — so unlike the frontend tier this
 * workload has no dependency on `grid-secrets`. Its only credentials are the
 * contact form's, in a Secret of its own (`web-contact`), and only when
 * `contactAddress` is set; `contactAccountId` comes from the app zone's lookup
 * (`platform/contact-mail.ts`). It DOES carry the registry imagePullSecrets:
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
  contactAccountId?: pulumi.Output<string>,
): Web {
  const labels = commonLabels("web");
  const shutdown = gracefulShutdown(ROLLOUT.web, "node");

  // Set together or not at all: `loadConfig` requires the tokens with the
  // address, and the account id exists exactly when the address is set.
  const contact = cfg.contact.enabled && contactAccountId !== undefined;
  const contactValues: Record<string, pulumi.Input<string>> = {
    CLOUDFLARE_EMAIL_TOKEN: cfg.contact.emailToken,
    CONTACT_FORM_SECRET: cfg.contact.formSecret,
  };
  const contactSecret = contact
    ? new k8s.core.v1.Secret(
        WEB_CONTACT_SECRET_NAME,
        {
          metadata: { name: WEB_CONTACT_SECRET_NAME, namespace, labels },
          stringData: contactValues,
        },
        { provider, dependsOn },
      )
    : undefined;

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
          metadata: {
            labels,
            // secretKeyRef is read once at container start: without the
            // checksum a rotated token changes the Secret and no running pod.
            ...(contact
              ? { annotations: secretChecksumAnnotations(secretChecksum(contactValues)) }
              : {}),
          },
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
                imagePullPolicy: appPullPolicy(cfg, webImage(cfg)),
                securityContext: hardenedContainerSecurityContext(),
                // No `command`: the image's CMD (`node runtime/server.mjs`, the
                // Astro node adapter behind a Cache-Control step) is the one
                // source for how the site starts, so an image and this program
                // can never disagree about an entry file the other lacks. The
                // server reads HOST/PORT from the env below.
                ports: [{ containerPort: PORT.web, name: "http" }],
                env: [
                  { name: "HOST", value: "0.0.0.0" },
                  { name: "PORT", value: String(PORT.web) },
                  {
                    // Where the landing site's "Anmelden" link hands off
                    // (/sign-in endpoint). Runtime, not baked: one web image
                    // serves every stack — this is the same per-stack host
                    // derivation the app tier gets for GRID_LANDING_URL,
                    // pointed the other way.
                    name: "PUBLIC_APP_URL",
                    value: `https://${cfg.ingress.appDomain}`,
                  },
                  ...(contact && contactAccountId ? contactEnv(cfg, contactAccountId) : []),
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
      dependsOn: [...dependsOn, ...(contactSecret ? [contactSecret] : [])],
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

  return { deployment, service, hpa, pdb, contactSecret };
}
