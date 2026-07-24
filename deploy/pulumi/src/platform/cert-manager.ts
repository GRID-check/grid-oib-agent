import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { GATEWAY_NAME } from "./gateway";

export interface CertManager {
  release: k8s.helm.v3.Release;
  /** The ClusterIssuer resource — Gateway resources should `dependsOn` this so
   *  the cert-manager Gateway shim never references a not-yet-created issuer. */
  issuer: k8s.apiextensions.CustomResource;
  /** Name of the ClusterIssuer the Gateway references for TLS. */
  issuerName: pulumi.Output<string>;
}

/**
 * cert-manager (Helm) with **Gateway API integration enabled**, plus a Let's
 * Encrypt ClusterIssuer whose ACME HTTP-01 challenge is solved via the Gateway
 * API (`gatewayHTTPRoute`) rather than an Ingress. The Gateway is annotated
 * with this issuer so cert-manager provisions a Certificate per HTTPS listener.
 *
 * Ordering: this depends on the Gateway API CRDs already existing (installed by
 * the Envoy Gateway controller), because cert-manager reads them at startup to
 * enable the integration — pass the controller release in `dependsOn`.
 */
export function installCertManager(
  cfg: GridConfig,
  provider: k8s.Provider,
  gatewayNamespace: pulumi.Input<string>,
  dependsOn: pulumi.Resource[],
): CertManager {
  const ns = new k8s.core.v1.Namespace(
    "cert-manager-ns",
    { metadata: { name: "cert-manager" } },
    { provider },
  );

  const release = new k8s.helm.v3.Release(
    "cert-manager",
    {
      chart: "cert-manager",
      // Unpinned: track the latest chart. `enableGatewayAPI` has been stable
      // config since v1.15, so newer releases stay compatible with the wiring
      // below.
      namespace: ns.metadata.name,
      repositoryOpts: { repo: "https://charts.jetstack.io" },
      values: {
        crds: { enabled: true },
        // Enable the Gateway API integration (HTTP-01 gatewayHTTPRoute solver +
        // the Gateway certificate shim). Requires the Gateway API CRDs to exist.
        config: {
          apiVersion: "controller.config.cert-manager.io/v1alpha1",
          kind: "ControllerConfiguration",
          enableGatewayAPI: true,
        },
        resources: {
          requests: { cpu: "10m", memory: "64Mi" },
          limits: { cpu: "100m", memory: "128Mi" },
        },
      },
    },
    { provider, dependsOn: [ns, ...dependsOn] },
  );

  const issuerName = cfg.ingress.useStagingIssuer ? "letsencrypt-staging" : "letsencrypt-prod";
  const acmeServer = cfg.ingress.useStagingIssuer
    ? "https://acme-staging-v02.api.letsencrypt.org/directory"
    : "https://acme-v02.api.letsencrypt.org/directory";

  const issuer = new k8s.apiextensions.CustomResource(
    "letsencrypt-issuer",
    {
      apiVersion: "cert-manager.io/v1",
      kind: "ClusterIssuer",
      metadata: { name: issuerName },
      spec: {
        acme: {
          server: acmeServer,
          email: cfg.ingress.letsEncryptEmail,
          privateKeySecretRef: { name: `${issuerName}-account-key` },
          solvers: [
            {
              http01: {
                gatewayHTTPRoute: {
                  parentRefs: [
                    {
                      name: GATEWAY_NAME,
                      namespace: gatewayNamespace,
                      kind: "Gateway",
                      group: "gateway.networking.k8s.io",
                    },
                  ],
                },
              },
            },
          ],
        },
      },
    },
    { provider, dependsOn: release },
  );

  return { release, issuer, issuerName: pulumi.output(issuerName) };
}
