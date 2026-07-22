import * as k8s from "@pulumi/kubernetes";

/**
 * Traefik ingress controller.
 *
 * WHY NOT ingress-nginx: the Kubernetes ingress-nginx controller is being
 * RETIRED (maintenance ends 2026-03-31 — no further releases, bugfixes, or
 * security patches). Traefik is actively maintained, modern, and terminates
 * HTTP(S) for us. It handles the app's two traffic shapes out of the box:
 * WebSocket chat upgrades (native, no annotations) and large document uploads
 * (no default request-body size limit). It keeps the standard Ingress API, so
 * cert-manager HTTP-01 issuance is unchanged. (Gateway API via Envoy Gateway is
 * the longer-term direction; see docs/deployment/kubernetes.md.)
 *
 * It registers itself as the default IngressClass `traefik`, which the app's
 * Ingress resources and the cert-manager ACME solver reference.
 */
export function installTraefik(provider: k8s.Provider): k8s.helm.v3.Release {
  const ns = new k8s.core.v1.Namespace(
    "traefik-ns",
    { metadata: { name: "traefik" } },
    { provider },
  );

  return new k8s.helm.v3.Release(
    "traefik",
    {
      chart: "traefik",
      version: "33.2.1",
      namespace: ns.metadata.name,
      repositoryOpts: { repo: "https://traefik.github.io/charts" },
      values: {
        ingressClass: { enabled: true, isDefaultClass: true, name: "traefik" },
        service: {
          type: "LoadBalancer",
          // Preserve the client source IP — the gateway's per-IP WS rate limiter
          // depends on it.
          spec: { externalTrafficPolicy: "Local" },
        },
        // Long-lived WS chat upgrades: generous read/idle timeouts on the web
        // entrypoint.
        ports: {
          websecure: {
            transport: {
              respondingTimeouts: { readTimeout: "3600s", idleTimeout: "3600s" },
            },
          },
        },
        resources: {
          requests: { cpu: "100m", memory: "128Mi" },
        },
      },
    },
    { provider, dependsOn: ns },
  );
}
