import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig } from "../config";
import { EDGE_RATE_LIMIT, LANGFUSE, PORT } from "../constants";

/**
 * `app.kubernetes.io/name` of the Aspire dashboard. Referenced by rule 2 (which
 * must NOT select it) as well as rules 7 and 8 (which grant it exactly two
 * callers), so the three stay in agreement.
 */
const OBSERVABILITY_DASHBOARD = "aspire-dashboard";

/**
 * `app.kubernetes.io/name` of the err2issue sink (ADR-0031). Held to the same
 * arrangement as the dashboard: withheld from rule 2, granted one caller in
 * rule 9.
 */
const ERR2ISSUE = "err2issue";

/**
 * `app.kubernetes.io/name` of the two Langfuse workloads and their ClickHouse
 * (ADR-0044). All three are withheld from rule 2 and granted named callers in
 * rules 10-12, on the same reasoning as the dashboard.
 */
const LANGFUSE_WEB = LANGFUSE.web;
const LANGFUSE_WORKER = LANGFUSE.worker;
const CLICKHOUSE = LANGFUSE.clickhouse;

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
 *     here and are far easier to get subtly wrong. The ONE exception is the
 *     Aspire dashboard, which authenticates nobody itself (auth lives on the
 *     Gateway, ADR-0029 Amendment 2) and so cannot be left open to the
 *     namespace — see rules 2 and 8.
 *   - Cross-namespace allows are explicit: the **edge** (Envoy Gateway) to the
 *     three public services, and the **CNPG operator** to its managed pods.
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

  // 2. Allow any pod in `grid` to reach any other pod in `grid` — EXCEPT the
  //    Aspire dashboard.
  //
  //    The dashboard runs `AuthMode=Unsecured` because authentication moved to
  //    the Gateway SecurityPolicy (ADR-0029 Amendment 2). That makes the
  //    wholesale allow below actively dangerous for this one pod: it would let
  //    ANY pod in the namespace — the internet-facing BFF, an LLM agent worker
  //    running model-chosen tool calls — read every tenant's telemetry
  //    (prompts, retrieved snippets, LLM output, and span URLs carrying live
  //    presigned S3 URLs) over :18888 with no credential whatsoever. Before the
  //    dashboard's own OIDC was removed, that path still met a claim gate.
  //
  //    NetworkPolicy has no deny rule and allows are additive, so the narrower
  //    `allow-edge-to-aspire-dashboard` below cannot subtract anything. NOT
  //    SELECTING the pod here is the only way to withhold the blanket allow.
  //    Its one legitimate in-namespace client is granted explicitly in rule 8.
  //
  //    `NotIn` also matches pods that lack the label entirely (Kubernetes label
  //    semantics), so CNPG-managed Postgres pods and anything else without
  //    `app.kubernetes.io/name` keep the intra-namespace allow.
  //
  //    err2issue (ADR-0031) is withheld on the same grounds when deployed. Its
  //    OTLP receiver authenticates nobody either, and the pod holds a GitHub
  //    token with Issues write — so a blanket allow would let any pod in the
  //    namespace, including the agent worker executing model-chosen tool calls,
  //    forge issues into the repo. Rule 9 grants its one real caller.
  //
  //    The Langfuse tier (ADR-0044) is withheld for a related but distinct
  //    reason, and the distinction is worth stating because it is easy to argue
  //    the other way. Unlike the dashboard these pods DO authenticate — the web
  //    tier has sessions and API keys, ClickHouse has a password. What they do
  //    not have is any legitimate in-namespace caller other than each other and
  //    the collector. Leaving them in the blanket allow would expose, to every
  //    pod in the namespace: an ingestion API that accepts a bearer key
  //    (guessable? no — but reachable, and reachability is what a policy
  //    controls), and a ClickHouse speaking PLAINTEXT HTTP that answers to a
  //    password sitting in an env var on four different pods. The store behind
  //    it is every tenant's prompts and completions. Rules 10-12 name the
  //    callers that actually exist.
  const langfuseWithheld = cfg.langfuse.enabled
    ? [LANGFUSE_WEB, LANGFUSE_WORKER, CLICKHOUSE]
    : [];
  const intra = mk("allow-same-namespace", {
    podSelector: {
      matchExpressions: [
        {
          key: "app.kubernetes.io/name",
          operator: "NotIn",
          values: [
            OBSERVABILITY_DASHBOARD,
            ...(cfg.err2issue.enabled ? [ERR2ISSUE] : []),
            ...langfuseWithheld,
          ],
        },
      ],
    },
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

  // 5b. Edge → web (the web HTTPRoute serves the public landing site + blog).
  const edgeWeb = mk("allow-edge-to-web", {
    podSelector: { matchLabels: { "app.kubernetes.io/name": "web" } },
    policyTypes: ["Ingress"],
    ingress: [
      { from: [nsLabel("envoy-gateway-system")], ports: [{ protocol: "TCP", port: PORT.web }] },
    ],
  });

  // 5c. Rate limit service → the edge rate-limit counter store (ADR-0040 L1).
  //
  //     Envoy Gateway's rate limit service runs in `envoy-gateway-system`; its
  //     Redis-protocol counter store runs here in `grid`. Rule 2's wholesale
  //     intra-namespace allow does not cover a caller from another namespace,
  //     and rules 4/5/5b grant the edge exactly three destinations — none of
  //     them this one. Without this rule every rate-limit lookup fails.
  //
  //     That failure is INVISIBLE by design: the rate limiter is configured
  //     fail-open, so a policy gap does not break traffic, it just quietly
  //     enforces nothing. This rule and `platform/gateway.ts`'s backend address
  //     are two halves of one thing; changing either alone is the bug.
  //
  //     Only the dedicated store is exposed, never the ADR-0020 cache — the
  //     edge has no business reading application cache entries.
  const edgeRateLimitStore = cfg.rateLimit.enabled
    ? mk("allow-edge-to-ratelimit-store", {
        podSelector: {
          matchLabels: { "app.kubernetes.io/name": EDGE_RATE_LIMIT.storeService },
        },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [nsLabel("envoy-gateway-system")],
            ports: [{ protocol: "TCP", port: PORT.redis }],
          },
        ],
      })
    : undefined;

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
        podSelector: { matchLabels: { "app.kubernetes.io/name": OBSERVABILITY_DASHBOARD } },
        policyTypes: ["Ingress"],
        ingress: [
          { from: [nsLabel("envoy-gateway-system")], ports: [{ protocol: "TCP", port: 18888 }] },
        ],
      })
    : undefined;

  // 8. otel-collector → Aspire dashboard OTLP/HTTP. Rule 2 deliberately leaves
  //    the dashboard out of the wholesale intra-namespace allow, so its only
  //    legitimate in-cluster client needs saying explicitly. Port 4318 alone:
  //    the collector's `otlphttp/aspire` exporter targets
  //    http://aspire-dashboard:4318 and nothing speaks 4317 to it.
  //
  //    Not covered here (deliberately): kubelet probes the dashboard on 18888
  //    from the host, which is not gated by NetworkPolicy on Cilium — see the
  //    header. If a future CNI does gate them, this pod's probes are the first
  //    place that will show up.
  const collectorToDashboard = cfg.observability.enabled
    ? mk("allow-collector-to-aspire-dashboard", {
        podSelector: { matchLabels: { "app.kubernetes.io/name": OBSERVABILITY_DASHBOARD } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "otel-collector" } } }],
            ports: [{ protocol: "TCP", port: 4318 }],
          },
        ],
      })
    : undefined;

  // 9. otel-collector → err2issue OTLP/HTTP (ADR-0031). Mirrors rule 8: rule 2
  //    leaves err2issue out of the wholesale allow, and the collector's
  //    `otlp_http/err2issue` exporter is its only legitimate client. Port 4318
  //    alone — the sink speaks no gRPC.
  const collectorToErr2Issue = cfg.err2issue.enabled
    ? mk("allow-collector-to-err2issue", {
        podSelector: { matchLabels: { "app.kubernetes.io/name": ERR2ISSUE } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "otel-collector" } } }],
            ports: [{ protocol: "TCP", port: 4318 }],
          },
        ],
      })
    : undefined;

  // 10. Edge → Langfuse web (the langfuse HTTPRoute serves its UI). The
  //     SecurityPolicy on that route is what authorizes the request; this rule
  //     is only what makes the route reachable at all.
  const edgeLangfuse = cfg.langfuse.enabled
    ? mk("allow-edge-to-langfuse", {
        podSelector: { matchLabels: { "app.kubernetes.io/name": LANGFUSE_WEB } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [nsLabel("envoy-gateway-system")],
            ports: [{ protocol: "TCP", port: PORT.langfuseWeb }],
          },
        ],
      })
    : undefined;

  // 11. otel-collector → Langfuse web OTLP ingestion. Mirrors rules 8 and 9:
  //     rule 2 leaves the web tier out of the wholesale allow, and the
  //     collector's `otlp_http/langfuse` exporter is its only in-namespace
  //     client. Same port as the UI — Langfuse serves `/api/public/otel/*` on
  //     the one HTTP listener, so this cannot be narrowed further by port. It
  //     is narrowed by CALLER instead, which is the control that matters.
  const collectorToLangfuse = cfg.langfuse.enabled
    ? mk("allow-collector-to-langfuse", {
        podSelector: { matchLabels: { "app.kubernetes.io/name": LANGFUSE_WEB } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "otel-collector" } } }],
            ports: [{ protocol: "TCP", port: PORT.langfuseWeb }],
          },
        ],
      })
    : undefined;

  // 12. Langfuse web + worker → ClickHouse, on both interfaces: HTTP 8123 for
  //     queries and native 9000 for the schema migrator. Nothing else in the
  //     deployment speaks to ClickHouse, and it holds the trace store in
  //     plaintext behind a password that four pods carry in env — so "only the
  //     two pods that own it" is the whole point of withholding it from rule 2.
  const langfuseToClickhouse = cfg.langfuse.enabled
    ? mk("allow-langfuse-to-clickhouse", {
        podSelector: { matchLabels: { "app.kubernetes.io/name": CLICKHOUSE } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [
              { podSelector: { matchLabels: { "app.kubernetes.io/name": LANGFUSE_WEB } } },
              { podSelector: { matchLabels: { "app.kubernetes.io/name": LANGFUSE_WORKER } } },
            ],
            ports: [
              { protocol: "TCP", port: PORT.clickhouseHttp },
              { protocol: "TCP", port: PORT.clickhouseNative },
            ],
          },
        ],
      })
    : undefined;

  return [
    deny,
    intra,
    cnpg,
    edgeFrontend,
    edgeS3,
    edgeWeb,
    ...(edgeRateLimitStore ? [edgeRateLimitStore] : []),
    acmeSolver,
    ...(edgeOtel ? [edgeOtel] : []),
    ...(collectorToDashboard ? [collectorToDashboard] : []),
    ...(collectorToErr2Issue ? [collectorToErr2Issue] : []),
    ...(edgeLangfuse ? [edgeLangfuse] : []),
    ...(collectorToLangfuse ? [collectorToLangfuse] : []),
    ...(langfuseToClickhouse ? [langfuseToClickhouse] : []),
  ];
}
