import * as k8s from "@pulumi/kubernetes";

/**
 * Install the ingress-nginx controller (Helm). It provisions the provider's
 * cloud LoadBalancer and terminates HTTP(S). Defaults are tuned for the app's
 * two traffic shapes:
 *   - WebSocket chat upgrades (long-lived, so generous proxy read/send timeouts)
 *   - Large document uploads streamed to SeaweedFS (bumped proxy-body-size)
 */
export function installIngressNginx(provider: k8s.Provider): k8s.helm.v3.Release {
  const ns = new k8s.core.v1.Namespace(
    "ingress-nginx-ns",
    { metadata: { name: "ingress-nginx" } },
    { provider },
  );

  return new k8s.helm.v3.Release(
    "ingress-nginx",
    {
      chart: "ingress-nginx",
      version: "4.11.3",
      namespace: ns.metadata.name,
      repositoryOpts: { repo: "https://kubernetes.github.io/ingress-nginx" },
      values: {
        controller: {
          ingressClassResource: { default: true },
          // Global defaults; per-Ingress annotations can still override.
          config: {
            "proxy-body-size": "128m",
            "proxy-read-timeout": "3600",
            "proxy-send-timeout": "3600",
            "use-forwarded-headers": "true",
          },
          service: {
            // externalTrafficPolicy: Local preserves the client source IP,
            // which the gateway's per-IP WS rate limiter relies on.
            externalTrafficPolicy: "Local",
          },
          resources: {
            requests: { cpu: "100m", memory: "128Mi" },
          },
        },
      },
    },
    { provider, dependsOn: ns },
  );
}
