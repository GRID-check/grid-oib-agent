import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { GATEWAY_NAME } from "./gateway";
import { proxiedHosts, proxyPlan } from "./dns";
import { PLATFORM_RESOURCES } from "../constants";

/** Secret (in `cert-manager`) holding the Cloudflare token the DNS-01 solver reads. */
const CLOUDFLARE_TOKEN_SECRET = "cloudflare-api-token"; // pragma: allowlist secret (Kubernetes Secret resource name, not a credential)
/** Key inside that Secret. Named once so the Secret and the solver cannot drift. */
const CLOUDFLARE_TOKEN_KEY = "api-token"; // pragma: allowlist secret (Secret key name, not a credential)

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
        resources: PLATFORM_RESOURCES.certManager,
      },
    },
    { provider, dependsOn: [ns, ...dependsOn] },
  );

  const issuerName = cfg.ingress.useStagingIssuer ? "letsencrypt-staging" : "letsencrypt-prod";
  const acmeServer = cfg.ingress.useStagingIssuer
    ? "https://acme-staging-v02.api.letsencrypt.org/directory"
    : "https://acme-v02.api.letsencrypt.org/directory";

  // ── ACME solvers ────────────────────────────────────────────────
  //
  // HTTP-01 answers the challenge on the Gateway itself and needs nothing else,
  // which is why it is still the default for every host.
  //
  // It stops being the right answer for a host behind Cloudflare's proxy. The
  // challenge then has to survive four things this program does not own — that
  // Cloudflare forwards `/.well-known/acme-challenge/` rather than answering it,
  // that `alwaysUseHttps` (`platform/edge.ts`) redirects the challenge to a
  // scheme Let's Encrypt still follows, that the edge is reachable on :80 at
  // all, and that none of those change under us. None of them fails loudly:
  // certificates keep working for up to 90 days after renewal starts failing,
  // and the first symptom is an expired certificate on a live host.
  //
  // DNS-01 removes all four for the cost of one Secret, using the SAME token
  // that already writes this zone's records. Scoped by `dnsNames` to exactly
  // the proxied hosts, so an unproxied host's issuance path is untouched —
  // cert-manager picks the most specific matching solver.
  const proxied = cfg.dns.enabled
    ? proxiedHosts(
        proxyPlan({
          enabled: cfg.dns.proxyEnabled,
          hosts: cfg.dns.hosts,
          appDomain: cfg.ingress.appDomain,
          s3Domain: cfg.ingress.s3Domain,
          webDomain: cfg.ingress.webDomain,
        }),
      )
    : [];

  const tokenSecret =
    proxied.length > 0
      ? new k8s.core.v1.Secret(
          "cert-manager-cloudflare-token",
          {
            metadata: { name: CLOUDFLARE_TOKEN_SECRET, namespace: ns.metadata.name },
            stringData: { [CLOUDFLARE_TOKEN_KEY]: cfg.dns.apiToken },
          },
          { provider, dependsOn: ns },
        )
      : undefined;

  const http01Solver = {
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
  };

  const dns01Solvers =
    proxied.length > 0
      ? [
          {
            // Most specific selector wins, so this claims exactly the proxied
            // hosts and the catch-all below keeps the rest.
            selector: { dnsNames: proxied },
            dns01: {
              cloudflare: {
                apiTokenSecretRef: { name: CLOUDFLARE_TOKEN_SECRET, key: CLOUDFLARE_TOKEN_KEY },
              },
            },
          },
        ]
      : [];

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
          solvers: [...dns01Solvers, http01Solver],
        },
      },
    },
    { provider, dependsOn: [release, ...(tokenSecret ? [tokenSecret] : [])] },
  );

  return { release, issuer, issuerName: pulumi.output(issuerName) };
}
