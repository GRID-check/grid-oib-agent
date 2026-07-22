import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { commonLabels } from "../platform/namespaces";

/**
 * Public ingress with automatic Let's Encrypt TLS (via cert-manager):
 *   - appDomain → frontend:3000 (UI + BFF + WebSocket chat upgrades)
 *   - s3Domain  → seaweedfs:8333 (the S3 endpoint the browser hits for
 *                 presigned document preview/download URLs)
 */
export function installIngress(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
  issuerName: pulumi.Input<string>,
  dependsOn: pulumi.Resource[],
): { app: k8s.networking.v1.Ingress; s3: k8s.networking.v1.Ingress } {
  const tlsAnnotations = {
    "cert-manager.io/cluster-issuer": issuerName as string,
  };

  const app = new k8s.networking.v1.Ingress(
    "grid-app-ingress",
    {
      metadata: {
        name: "grid-app",
        namespace,
        labels: commonLabels("frontend"),
        annotations: {
          ...tlsAnnotations,
          // WebSocket chat: long-lived upgrades need generous timeouts.
          "nginx.ingress.kubernetes.io/proxy-read-timeout": "3600",
          "nginx.ingress.kubernetes.io/proxy-send-timeout": "3600",
          "nginx.ingress.kubernetes.io/proxy-body-size": "128m",
        },
      },
      spec: {
        ingressClassName: "nginx",
        tls: [{ hosts: [cfg.ingress.appDomain], secretName: "grid-app-tls" }],
        rules: [
          {
            host: cfg.ingress.appDomain,
            http: {
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: { service: { name: "frontend", port: { number: 3000 } } },
                },
              ],
            },
          },
        ],
      },
    },
    { provider, dependsOn },
  );

  const s3 = new k8s.networking.v1.Ingress(
    "grid-s3-ingress",
    {
      metadata: {
        name: "grid-s3",
        namespace,
        labels: commonLabels("seaweedfs"),
        annotations: {
          ...tlsAnnotations,
          // Uploads/downloads stream through here — allow large bodies.
          "nginx.ingress.kubernetes.io/proxy-body-size": "0",
        },
      },
      spec: {
        ingressClassName: "nginx",
        tls: [{ hosts: [cfg.ingress.s3Domain], secretName: "grid-s3-tls" }],
        rules: [
          {
            host: cfg.ingress.s3Domain,
            http: {
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: { service: { name: "seaweedfs", port: { number: 8333 } } },
                },
              ],
            },
          },
        ],
      },
    },
    { provider, dependsOn },
  );

  return { app, s3 };
}
