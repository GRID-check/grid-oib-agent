import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, pullPolicyFor } from "../config";
import { commonLabels } from "../platform/namespaces";
import { hardenedContainerSecurityContext } from "../platform/security";
import { ROLLOUT, gracefulShutdown, surgeRollout } from "../platform/rollout";
import { GOTENBERG, PORT, UID } from "../constants";

export interface Gotenberg {
  deployment: k8s.apps.v1.Deployment;
  service: k8s.core.v1.Service;
  /** In-cluster URL the frontend's `GOTENBERG_URL` points at. */
  url: pulumi.Output<string>;
}

/**
 * Gotenberg: the office → PDF converter behind the document viewer (ADR-0070).
 *
 * The frontend BFF posts a Word/Excel/PowerPoint original to the LibreOffice
 * route and stores the PDF beside it; nothing else calls this. It holds no
 * state and no secret, so it takes none: no `grid-secrets`, no pull Secret
 * (a public upstream image), no service-account token.
 *
 * It is required, not optional (ADR-0071): the backend indexes Word,
 * presentation, .xls and .ods files from this PDF and has no fallback reader.
 * A conversion that fails, or that no converter answers, marks the file
 * failed with a retryable reason; "Erneut lesen" recovers it. .xlsx/.xlsm
 * still index without it, only without preview or thumbnail.
 *
 * `gotenbergReplicas` (default one) is the fleet's conversion capacity: one
 * LibreOffice converts one document at a time per replica, and the `bff-jobs`
 * pool's ceiling on background conversions is held to it (`renditionCeiling`
 * against `gotenbergCapacity`, asserted in `gotenberg.spec.ts`). A restart
 * mid-conversion fails that ingest, so the `converter` rollout profile drains:
 * the new pod is ready before the old one stops (surge), a preStop sleep
 * covers endpoint removal, and Gotenberg finishes a conversion in flight for
 * up to 120s after SIGTERM. A crash or an OOM kill is not covered; those
 * ingests fail retryably. The frontend still does not wait on it at boot:
 * uploads of other types work without it.
 *
 * It parses untrusted files, so it is the most exposed process in the
 * namespace after the edge. `platform/network-policies.ts` admits only the
 * frontend and denies it all egress when networkPolicies is on; the flags in
 * `GOTENBERG.args` close the routes that would fetch from a URL and refuse
 * every outbound fetch LibreOffice itself would make, with or without them.
 */
export function installGotenberg(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  dependsOn: pulumi.Resource[],
): Gotenberg {
  const labels = commonLabels(GOTENBERG.name);
  // A conversion cut at a rollout is a failed ingest (ADR-0071), so drain:
  // preStop `sleep` (the image ships coreutils, not node or python), then
  // Gotenberg's own graceful shutdown inside the grace period.
  const shutdown = gracefulShutdown(ROLLOUT.converter, "coreutils");

  const deployment = new k8s.apps.v1.Deployment(
    GOTENBERG.name,
    {
      metadata: { name: GOTENBERG.name, namespace, labels },
      spec: {
        replicas: cfg.gotenberg.replicas,
        selector: { matchLabels: labels },
        ...surgeRollout(ROLLOUT.converter),
        template: {
          metadata: { labels },
          spec: {
            enableServiceLinks: false, // see chroma.ts — legacy env collisions
            automountServiceAccountToken: false,
            terminationGracePeriodSeconds: shutdown.terminationGracePeriodSeconds,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: UID.gotenberg,
              runAsGroup: UID.gotenberg,
            },
            containers: [
              {
                name: GOTENBERG.name,
                image: cfg.gotenberg.image,
                imagePullPolicy: pullPolicyFor(cfg.gotenberg.image),
                securityContext: hardenedContainerSecurityContext(),
                lifecycle: shutdown.lifecycle,
                // The image's ENTRYPOINT is tini, so args replace only its CMD.
                args: [...GOTENBERG.args],
                ports: [{ containerPort: PORT.gotenberg, name: "http" }],
                resources: GOTENBERG.resources,
                // /health reports each module, LibreOffice included.
                readinessProbe: {
                  httpGet: { path: "/health", port: PORT.gotenberg },
                  initialDelaySeconds: 10,
                  periodSeconds: 10,
                },
                livenessProbe: {
                  httpGet: { path: "/health", port: PORT.gotenberg },
                  initialDelaySeconds: 30,
                  periodSeconds: 20,
                  failureThreshold: 5,
                },
              },
            ],
          },
        },
      },
    },
    { provider, dependsOn },
  );

  const service = new k8s.core.v1.Service(
    GOTENBERG.name,
    {
      metadata: { name: GOTENBERG.name, namespace, labels },
      spec: {
        selector: labels,
        ports: [{ port: PORT.gotenberg, targetPort: PORT.gotenberg, name: "http" }],
      },
    },
    { provider, dependsOn: deployment },
  );

  return {
    deployment,
    service,
    url: pulumi.output(`http://${GOTENBERG.name}:${PORT.gotenberg}`),
  };
}
