import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { PORT } from "../constants";

/**
 * Namespace-scoped NetworkPolicies for `grid`: a **default-deny for ingress**
 * plus the minimum set of allows the stack actually needs. This contains lateral
 * movement — a compromised pod in another namespace can't reach the app/data
 * tiers, and nothing outside the allow-list can open a connection into `grid`.
 *
 * Scope decisions:
 *   - **Ingress only.** Egress is left open on purpose: the agent calls many
 *     external endpoints (OpenRouter, Tavily, WorkOS, ACME) plus cluster DNS, and
 *     an egress allow-list is the easiest way to silently break the product.
 *     Tightening egress is a follow-up that needs a live cluster to validate.
 *   - **Intra-namespace is allowed wholesale** (frontend→backend, backend→data,
 *     workers→data, backend→frontend BFF). Per-edge micro-policies buy little
 *     here and are far easier to get subtly wrong.
 *   - Cross-namespace allows are explicit: the **edge** (Envoy Gateway) to the
 *     two public services, and the **CNPG operator** to its managed pods.
 *
 * On Cilium, kubelet health probes originate from the host and are not gated by
 * these policies, so readiness/liveness keep working.
 */
export function installNetworkPolicies(
  cfg: GridConfig,
  provider: k8s.Provider,
  namespace: pulumi.Input<string>,
): k8s.networking.v1.NetworkPolicy[] {
  const nsLabel = (name: string) => ({
    namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": name } },
  });
  const mk = (
    name: string,
    spec: k8s.types.input.networking.v1.NetworkPolicySpec,
  ): k8s.networking.v1.NetworkPolicy =>
    new k8s.networking.v1.NetworkPolicy(name, { metadata: { name, namespace }, spec }, { provider });

  // 1. Default-deny all ingress (no rules → nothing may connect in).
  const deny = mk("default-deny-ingress", {
    podSelector: {},
    policyTypes: ["Ingress"],
  });

  // 2. Allow any pod in `grid` to reach any other pod in `grid`.
  const intra = mk("allow-same-namespace", {
    podSelector: {},
    policyTypes: ["Ingress"],
    ingress: [{ from: [{ podSelector: {} }] }],
  });

  // 3. Allow the CloudNativePG operator (cnpg-system) to reach its managed
  //    Postgres pods (instance-manager status/liveness, backups coordination).
  const cnpg = mk("allow-cnpg-operator", {
    podSelector: {},
    policyTypes: ["Ingress"],
    ingress: [{ from: [nsLabel("cnpg-system")] }],
  });

  // 4. Edge → frontend (the app HTTPRoute terminates at Envoy, then hits :3000).
  const edgeFrontend = mk("allow-edge-to-frontend", {
    podSelector: { matchLabels: { "app.kubernetes.io/name": "frontend" } },
    policyTypes: ["Ingress"],
    ingress: [
      { from: [nsLabel("envoy-gateway-system")], ports: [{ protocol: "TCP", port: PORT.frontend }] },
    ],
  });

  // 5. Edge → SeaweedFS S3 (the s3 HTTPRoute serves browser presigned URLs).
  const edgeS3 = mk("allow-edge-to-seaweedfs", {
    podSelector: { matchLabels: { "app.kubernetes.io/name": "seaweedfs" } },
    policyTypes: ["Ingress"],
    ingress: [
      { from: [nsLabel("envoy-gateway-system")], ports: [{ protocol: "TCP", port: PORT.seaweedS3 }] },
    ],
  });

  // 6. Edge → cert-manager ACME HTTP-01 solver. Some cert-manager versions place
  //    the temporary solver pod in the Gateway's namespace (`grid`); if so, the
  //    default-deny would black-hole the ACME challenge and TLS would never
  //    issue. Allow the edge to reach any solver pod (labelled by cert-manager)
  //    so certificate issuance works regardless of where the solver lands.
  const acmeSolver = mk("allow-edge-to-acme-solver", {
    podSelector: { matchLabels: { "acme.cert-manager.io/http01-solver": "true" } },
    policyTypes: ["Ingress"],
    ingress: [{ from: [nsLabel("envoy-gateway-system")] }],
  });

  // 7. Edge → Aspire dashboard (the otel HTTPRoute) — only when the
  //    observability tier is deployed (ADR-0029).
  const edgeOtel = cfg.observability.enabled
    ? mk("allow-edge-to-aspire-dashboard", {
        podSelector: { matchLabels: { "app.kubernetes.io/name": "aspire-dashboard" } },
        policyTypes: ["Ingress"],
        ingress: [
          { from: [nsLabel("envoy-gateway-system")], ports: [{ protocol: "TCP", port: 18888 }] },
        ],
      })
    : undefined;

  return [deny, intra, cnpg, edgeFrontend, edgeS3, acmeSolver, ...(edgeOtel ? [edgeOtel] : [])];
}
