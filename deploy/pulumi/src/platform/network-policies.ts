import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { GridConfig, backendAutoscaled } from "../config";
import { CHROMA_MIGRATION, EDGE_RATE_LIMIT, GOTENBERG, LANGFUSE, PORT, QDRANT } from "../constants";
import { KEDA_NAMESPACE, KEDA_OPERATOR_LABEL } from "./keda";
import { CLUSTER_NAME as POSTGRES_CLUSTER } from "../data/postgres";

/**
 * `app.kubernetes.io/name` of the two Langfuse workloads and their ClickHouse
 * (ADR-0044). All three are withheld from rule 2 and granted named callers in
 * rules 10-12.
 */
const LANGFUSE_WEB = LANGFUSE.web;
const LANGFUSE_WORKER = LANGFUSE.worker;
const CLICKHOUSE = LANGFUSE.clickhouse;

/**
 * The backend roles that carry the Langfuse API keys (`backendEnv`, less the
 * ingest worker) and so are named callers of the web tier in rule 11d.
 */
export const LANGFUSE_BACKEND_CALLERS = ["aiq-agent", "aiq-api", "agent-worker"] as const;

/**
 * The pods that get `AIQ_QDRANT_URL` (every role built from `backendEnv`), the
 * snapshot CronJob, the one-shot Chroma migration's importer, and the
 * operator's throwaway `qdrant-ops` pod (the runbook's restore and shard
 * moves, run from inside the namespace): the named callers of Qdrant's client
 * ports in rule 16. A pod that reads or writes vectors and is missing here
 * times out on every call while its plan is green.
 */
export const QDRANT_CALLERS = [
  "aiq-agent",
  "aiq-api",
  "agent-worker",
  "ingest-worker",
  "legacy-corpus-import",
  QDRANT.snapshotJob,
  CHROMA_MIGRATION.name,
  QDRANT.opsLabel,
] as const;

/**
 * Namespace-scoped NetworkPolicies for `grid`: a **default-deny for ingress**
 * plus the minimum set of allows the stack actually needs. This contains lateral
 * movement — a compromised pod in another namespace can't reach the app/data
 * tiers, and nothing outside the allow-list can open a connection into `grid`.
 *
 * Scope decisions:
 *   - **Ingress only**, with one exception. Egress is left open on purpose: the
 *     agent calls many external endpoints (OpenRouter, Tavily, WorkOS, ACME)
 *     plus cluster DNS, and an egress allow-list is the easiest way to silently
 *     break the product. Tightening egress is a follow-up that needs a live
 *     cluster to validate. The exception is Gotenberg (rule 13), which needs no
 *     egress at all, so denying all of it cannot break anything it does.
 *   - **Intra-namespace is allowed wholesale** (frontend→backend, backend→data,
 *     workers→data, backend→frontend BFF). Per-edge micro-policies buy little
 *     here and are far easier to get subtly wrong. The exceptions are the pods
 *     whose receivers authenticate nobody or hold a store of every tenant's
 *     text (Langfuse and its ClickHouse, Gotenberg, Qdrant) — see rule 2.
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
  //    pods below.
  //
  //    NetworkPolicy has no deny rule and allows are additive, so a narrower
  //    allow cannot subtract anything from this one. NOT SELECTING a pod here
  //    is the only way to withhold the blanket allow; each pod's legitimate
  //    in-namespace callers are granted explicitly in the rules that follow.
  //
  //    `NotIn` also matches pods that lack the label entirely (Kubernetes label
  //    semantics), so CNPG-managed Postgres pods and anything else without
  //    `app.kubernetes.io/name` keep the intra-namespace allow.
  //
  //    The Langfuse tier (ADR-0044) is withheld, and the reason is worth
  //    stating because it is easy to argue the other way. These pods DO
  //    authenticate — the web tier has sessions and API keys, ClickHouse has a password. What they do
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
            ...langfuseWithheld,
            ...(cfg.gotenberg.enabled ? [GOTENBERG.name] : []),
            QDRANT.name,
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

  // 7-8. Were the Aspire dashboard's (edge → UI, collector → OTLP). Retired with
  //      it; the numbers are kept so the rules below keep the names that docs
  //      and ADRs already cite.

  // 9. Was otel-collector → err2issue (ADR-0031), retired with it; the number is
  //    kept so the rules below keep the names that docs and ADRs already cite.

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

  // 11. otel-collector → Langfuse web OTLP ingestion. Mirrors rule 9: rule 2 leaves the web tier out of the wholesale allow, and the
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

  // 11b. The purger and the skill-scheduler → Langfuse web, for its public API:
  //     the purger deletes an erased chat's traces and the scheduler deletes the
  //     ones past retention (ADR-0044; `workers/langfuse-traces.js`). Rule 2
  //     withholds the web tier from the wholesale allow, so each caller is named,
  //     as the collector is in rule 11. Deleting traces is theirs alone: the BFF
  //     (rule 11c) and the agent (rule 11d) write scores but delete nothing.
  const workersToLangfuse = cfg.langfuse.enabled
    ? mk("allow-workers-to-langfuse", {
        podSelector: { matchLabels: { "app.kubernetes.io/name": LANGFUSE_WEB } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: ["purger", "skill-scheduler"].map((name) => ({
              podSelector: { matchLabels: { "app.kubernetes.io/name": name } },
            })),
            ports: [{ protocol: "TCP", port: PORT.langfuseWeb }],
          },
        ],
      })
    : undefined;

  // 11c. frontend (the BFF) → Langfuse web public API. The BFF writes every
  //      answer-feedback vote as a score on its trace (ADR-0044, Amendment 3)
  //      through `LANGFUSE_HOST`, the in-cluster Service: the public host sits
  //      behind the edge's OIDC gate, which a server-side call cannot pass.
  //      Named by caller, like the collector; the backend tiers have their own
  //      rule (11d).
  const frontendToLangfuse = cfg.langfuse.enabled
    ? mk("allow-frontend-to-langfuse", {
        podSelector: { matchLabels: { "app.kubernetes.io/name": LANGFUSE_WEB } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "frontend" } } }],
            ports: [{ protocol: "TCP", port: PORT.langfuseWeb }],
          },
        ],
      })
    : undefined;

  // 11d. The backend tiers → Langfuse web public API. The agent writes the
  //      answer pipeline's checks as scores on each turn's trace (ADR-0089,
  //      `aiq_agent/observability/langfuse_scores.py`) through `LANGFUSE_HOST`,
  //      the in-cluster Service, for the reason rule 11c gives. The three roles
  //      that run answers or serve them: chat (`aiq-agent`), api (`aiq-api`)
  //      and the research worker (`agent-worker`). The ingest worker is not
  //      named and does not get the keys (`ingestWorkerEnv`): it writes none.
  const backendToLangfuse = cfg.langfuse.enabled
    ? mk("allow-backend-to-langfuse", {
        podSelector: { matchLabels: { "app.kubernetes.io/name": LANGFUSE_WEB } },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: LANGFUSE_BACKEND_CALLERS.map((name) => ({
              podSelector: { matchLabels: { "app.kubernetes.io/name": name } },
            })),
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

  // 13. Gotenberg (ADR-0070): the frontend and the bff-jobs pool in, nothing out.
  //
  //     It parses untrusted office files, and an office file can reference
  //     external URLs (linked images, OLE links) that LibreOffice resolves
  //     while rendering. Denying egress turns every such reference into a
  //     failed fetch, so the converter cannot be used to reach the internet or
  //     another pod, whatever a document asks of it. No DNS either: it has
  //     nothing to resolve.
  //
  //     Withheld from rule 2 on the same grounds as Langfuse, so the
  //     frontend BFF is its caller, and the bff-jobs pool is the same BFF
  //     running the background conversions (ADR-0079), so it is named too: a
  //     pool left out here would fail every office file with a green plan. The
  //     agent never calls it (the BFF hands the backend the finished PDF), and
  //     nothing else has a reason to.
  const gotenberg = cfg.gotenberg.enabled
    ? mk("gotenberg-frontend-only", {
        podSelector: { matchLabels: { "app.kubernetes.io/name": GOTENBERG.name } },
        policyTypes: ["Ingress", "Egress"],
        ingress: [
          {
            from: [
              { podSelector: { matchLabels: { "app.kubernetes.io/name": "frontend" } } },
              ...(cfg.bffJobs.enabled
                ? [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "bff-jobs" } } }]
                : []),
            ],
            ports: [{ protocol: "TCP", port: PORT.gotenberg }],
          },
        ],
        // Present and empty: with `Egress` in policyTypes, no rule = deny all.
        egress: [],
      })
    : undefined;

  // 14-15. KEDA (its own namespace) reaches exactly the two kinds of target its
  //     triggers name, and nothing else in `grid`. The caller is the OPERATOR pod,
  //     not the namespace: the operator runs every scaler (the metrics server and
  //     the admission webhooks in `keda` ask it, they poll nothing), so those two
  //     have no reason to open a connection into the app or data tier.
  const kedaOperator = [{ ...nsLabel(KEDA_NAMESPACE), podSelector: { matchLabels: { ...KEDA_OPERATOR_LABEL } } }];

  // 14. The queues' depth, to scale the ingest-worker and agent-worker tiers
  //     (ADR-0076, ADR-0079) and the bff_job_queue's, to scale the bff-jobs pool:
  //     Postgres only, port 5432 only. The operator runs one COUNT(*) there as the
  //     read-only scaler login.
  const kedaToPostgres = mk("allow-keda-to-postgres", {
    podSelector: { matchLabels: { "cnpg.io/cluster": POSTGRES_CLUSTER } },
    policyTypes: ["Ingress"],
    ingress: [{ from: kedaOperator, ports: [{ protocol: "TCP", port: 5432 }] }],
  });

  // 15. The fleet's running turns, from the backend's internal occupancy route,
  //     to scale the chat tier (ADR-0080). The backend port only, on the backend
  //     pods only, and only when that tier autoscales. (Its cpu trigger reads
  //     `metrics.k8s.io`, which is no connection into `grid`.)
  const kedaToBackend = backendAutoscaled(cfg)
    ? mk("allow-keda-to-aiq-agent", {
        podSelector: { matchLabels: { "app.kubernetes.io/name": "aiq-agent" } },
        policyTypes: ["Ingress"],
        ingress: [{ from: kedaOperator, ports: [{ protocol: "TCP", port: PORT.backend }] }],
      })
    : undefined;

  // 16-17. Qdrant (ADR-0113), withheld from rule 2. Every office's chunk text
  //     and vectors sit behind one API key that six workloads carry, and its p2p
  //     port moves shards and Raft state between peers: no other pod has any
  //     reason to open either. 16 admits the vector callers to the client ports;
  //     17 keeps p2p (and the client ports, which peers forward requests over)
  //     between the peers alone.
  const qdrantPod = { podSelector: { matchLabels: { "app.kubernetes.io/name": QDRANT.name } } };
  const appToQdrant = mk("allow-app-to-qdrant", {
    ...qdrantPod,
    policyTypes: ["Ingress"],
    ingress: [
      {
        from: QDRANT_CALLERS.map((name) => ({
          podSelector: { matchLabels: { "app.kubernetes.io/name": name } },
        })),
        ports: [
          { protocol: "TCP", port: PORT.qdrantHttp },
          { protocol: "TCP", port: PORT.qdrantGrpc },
        ],
      },
    ],
  });
  const qdrantPeers = mk("qdrant-peers", {
    ...qdrantPod,
    policyTypes: ["Ingress"],
    ingress: [
      {
        from: [qdrantPod],
        ports: [
          { protocol: "TCP", port: PORT.qdrantHttp },
          { protocol: "TCP", port: PORT.qdrantGrpc },
          { protocol: "TCP", port: PORT.qdrantP2p },
        ],
      },
    ],
  });

  // 18. otel-collector → each Qdrant peer's metrics port, which answers without
  //     a key (`PORT.qdrantMetrics`): the collector alone, that port alone. Rule
  //     2 withholds Qdrant, and rules 16-17 grant neither the collector nor this
  //     port, so without it every scrape times out and `up` reads 0 for every
  //     peer, which looks exactly like the cluster being down.
  const collectorToQdrant = cfg.observability.enabled
    ? mk("allow-collector-to-qdrant-metrics", {
        ...qdrantPod,
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [{ podSelector: { matchLabels: { "app.kubernetes.io/name": "otel-collector" } } }],
            ports: [{ protocol: "TCP", port: PORT.qdrantMetrics }],
          },
        ],
      })
    : undefined;

  // 19. Edge → Qdrant's REST port, for the dashboard route
  //     (`platform/qdrant-dashboard.ts`), only while `qdrantDashboardEnabled`.
  //     Like rule 10 it only makes the route reachable; the SecurityPolicy on
  //     that route authorizes the request and Qdrant's own key the call. 6333
  //     alone: the dashboard and the REST API it calls share that listener,
  //     and nothing at the edge speaks gRPC, p2p or the metrics port.
  const edgeQdrant = cfg.qdrant.dashboard.enabled
    ? mk("allow-edge-to-qdrant-dashboard", {
        ...qdrantPod,
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [nsLabel("envoy-gateway-system")],
            ports: [{ protocol: "TCP", port: PORT.qdrantHttp }],
          },
        ],
      })
    : undefined;

  return [
    deny,
    intra,
    cnpg,
    ...(kedaToPostgres ? [kedaToPostgres] : []),
    ...(kedaToBackend ? [kedaToBackend] : []),
    edgeFrontend,
    edgeS3,
    edgeWeb,
    ...(edgeRateLimitStore ? [edgeRateLimitStore] : []),
    acmeSolver,
    ...(edgeLangfuse ? [edgeLangfuse] : []),
    ...(collectorToLangfuse ? [collectorToLangfuse] : []),
    ...(workersToLangfuse ? [workersToLangfuse] : []),
    ...(frontendToLangfuse ? [frontendToLangfuse] : []),
    ...(backendToLangfuse ? [backendToLangfuse] : []),
    ...(langfuseToClickhouse ? [langfuseToClickhouse] : []),
    ...(gotenberg ? [gotenberg] : []),
    appToQdrant,
    qdrantPeers,
    ...(collectorToQdrant ? [collectorToQdrant] : []),
    ...(edgeQdrant ? [edgeQdrant] : []),
  ];
}
