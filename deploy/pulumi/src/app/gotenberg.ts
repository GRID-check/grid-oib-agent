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
 * One replica. Conversion fails open in the BFF (the original stays
 * downloadable, and a missing rendition is retried lazily on the next view),
 * so a pod restart costs a slower preview, never a failed upload. That is also
 * why the frontend does not wait on it.
 *
 * It parses untrusted files, so it is the most exposed process in the
 * namespace after the edge. `platform/network-policies.ts` admits only the
 * frontend and denies it all egress; the flags in `GOTENBERG.args` close the
 * routes that would fetch from a URL.
 */
export function installGotenberg(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  dependsOn: pulumi.Resource[],
): Gotenberg {
  const labels = commonLabels(GOTENBERG.name);
  // No preStop drain: its one caller retries lazily, so a request cut at a
  // rollout is a retried preview rather than a lost one.
  const shutdown = gracefulShutdown(ROLLOUT.dataPlane);

  const deployment = new k8s.apps.v1.Deployment(
    GOTENBERG.name,
    {
      metadata: { name: GOTENBERG.name, namespace, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        ...surgeRollout(ROLLOUT.dataPlane),
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
