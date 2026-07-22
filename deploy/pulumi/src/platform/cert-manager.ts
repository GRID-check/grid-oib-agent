import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";

export interface CertManager {
  release: k8s.helm.v3.Release;
  /** Name of the ClusterIssuer the Ingresses should reference. */
  issuerName: pulumi.Output<string>;
}

/**
 * Install cert-manager (Helm) and a Let's Encrypt ClusterIssuer (HTTP-01 via
 * the ingress-nginx class). Ingress resources annotate
 * `cert-manager.io/cluster-issuer: <issuerName>` to get auto-provisioned TLS.
 */
export function installCertManager(
  cfg: GridConfig,
  provider: k8s.Provider,
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
      version: "v1.16.2",
      namespace: ns.metadata.name,
      repositoryOpts: { repo: "https://charts.jetstack.io" },
      values: {
        // Install the CRDs with the chart so ClusterIssuer/Certificate exist.
        crds: { enabled: true },
        // Small footprint; bump if issuance volume grows.
        resources: {
          requests: { cpu: "10m", memory: "64Mi" },
        },
      },
    },
    { provider },
  );

  const issuerName = cfg.ingress.useStagingIssuer
    ? "letsencrypt-staging"
    : "letsencrypt-prod";

  const acmeServer = cfg.ingress.useStagingIssuer
    ? "https://acme-staging-v02.api.letsencrypt.org/directory"
    : "https://acme-v02.api.letsencrypt.org/directory";

  // ClusterIssuer is a cert-manager CRD; create it after the chart (which
  // installs the CRD) is ready.
  new k8s.apiextensions.CustomResource(
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
            { http01: { ingress: { ingressClassName: "nginx" } } },
          ],
        },
      },
    },
    { provider, dependsOn: release },
  );

  return { release, issuerName: pulumi.output(issuerName) };
}
