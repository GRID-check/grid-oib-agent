# ADR-0044: Langfuse as the durable LLM-observability backend

- **Status:** Proposed
- **Date:** 2026-08-09
- **Deciders:** Platform
- **Related:** ADR-0029 (Aspire dashboard telemetry), ADR-0031 (err2issue),
  ADR-0015 (LLM budgets and usage ledger), ADR-0041 (row-level security),
  ADR-0043 (SeaweedFS split topology and per-tenant buckets)

## Context

ADR-0029 deployed the .NET Aspire standalone dashboard as a live telemetry pane
and was explicit about what it was not:

> **Negative:** In-memory ring buffer (50k log/trace entries) — data is lost on
> pod restart; no post-mortem debugging from historical traces.

It also rejected "Option 1 — Full OTel Collector + Grafana stack" at the time,
and named the seam a durable backend would arrive through:

> The OTLP boundary means we can add a collector later without touching app
> code.

That collector exists now (`otel-collector`), and its own module docstring
states the contract this ADR cashes in:

> Swapping the storage/UI backend later (Grafana/Tempo/…) is a config change
> HERE, not in any app.

Three questions the current stack cannot answer, all of them ordinary:

1. **"What did this run cost, and on which model?"** ADR-0015's ledger records
   spend per organization for budget enforcement. It does not record which span
   inside a research run spent it, so a run that costs 40× the median is a
   number with no explanation attached.
2. **"What changed?"** Every prompt, retrieval strategy and model default in
   this product is tunable at runtime (Platform → Models, per-org overrides).
   Nothing measures a change against the one before it, because there is no
   store that outlives a pod restart.
3. **"What did the user actually see?"** Reproducing a complaint means finding
   the conversation while it is still in a 50k-entry ring buffer.

Aspire answers none of these and was never meant to. It answers "what is the
system doing right now", which remains valuable and is not being retired.

The relevant constraint on the choice: **free**. No per-seat or per-event
licence, no trace quota, and no requirement to send prompts and completions to
a third party — this deployment holds Austrian building-code consulting work
under tenant isolation controls (ADR-0041, ADR-0043) that a hosted trace store
would sit outside.

## Decision

We will deploy **Langfuse, self-hosted, in its free MIT-licensed OSS build**, as
a second consumer on the collector's traces signal, and fan traces into it
alongside the Aspire dashboard.

**No licence key is configured anywhere in the program.** Everything wired here
is core Langfuse: tracing, sessions, user attribution, cost tracking, prompt
management, datasets, evaluations, and SSO. The features behind the Enterprise
licence — project-level RBAC, audit logs, server-side data masking, UI
customisation, and **data-retention policies** — are not used, and the last of
those has a consequence recorded below rather than papered over.

### Shape

```text
producers ──OTLP──> otel-collector ──┬──> aspire-dashboard   (live, in-memory)
(BFF, agent,          (one traces     ├──> langfuse-web      (durable, queryable)
 worker)               pipeline)      └──> err2issue         (logs, ERROR only)
```

Langfuse v3 is four workloads, not one, and three of its four backing stores
already exist here:

| Component | Provision |
|---|---|
| `langfuse-web` | New Deployment. UI + public API + the OTLP receiver. |
| `langfuse-worker` | New Deployment. Drains the queue into ClickHouse. |
| ClickHouse | **New** StatefulSet, single node. No Postgres-only mode exists. |
| Postgres | Existing CNPG cluster — dedicated `langfuse` database and `langfuse_app` role. |
| Redis-protocol queue | Existing Dragonfly *pattern* — a third instance, eviction off. |
| S3 | Existing SeaweedFS — one `langfuse` bucket, its own scoped identity. |

### Decisions inside the approach

- **A second exporter on the existing traces pipeline, not a new pipeline.**
  The opposite of the choice ADR-0031 made for err2issue one signal down, and
  the difference is the processor chain: err2issue needs a severity filter that
  must not apply to the dashboard's copy. Langfuse wants exactly the spans
  Aspire wants, so a separate pipeline would duplicate `memory_limiter` and
  `batch` over one input to produce identical output.

- **Availability = flag AND capability**, as everywhere else. `langfuseEnabled`
  is the product decision; the capability is derived from the credentials the
  tier cannot boot without *plus* `observabilityEnabled` — Langfuse has no
  receiver of its own in this design, so without the collector it is four
  workloads that can only sit idle. The flag defaults **on** (Amendment 1); the
  credentials are what a stack actually has to set.

- **Two independent access gates, and both are wanted.** The Envoy
  `SecurityPolicy` on the route admits only WorkOS identities holding
  `platform:organizations:view` — the same rule ADR-0029 Amendment 2 settled on,
  because the data is the same data. Langfuse's own SSO (`AUTH_CUSTOM_*`)
  against the same issuer then establishes a Langfuse session.

  The second is not redundant. Unlike the Aspire dashboard, Langfuse *cannot*
  run unauthenticated — it has users, projects and API keys and must know who is
  asking. But on its own it would accept anyone who can sign in to the WorkOS
  environment at all; the permission narrowing exists only at the edge. The two
  OIDC flows chain without conflict: Envoy claims `/oauth2/callback` and
  `/logout`, NextAuth uses `/api/auth/callback/custom`, and the second hop is
  silent because the WorkOS session already exists.

  One Connect application serves both routes rather than a fourth OIDC triple
  for an operator to provision and mis-scope. It carries three redirect URIs:
  Envoy's callback on each host, plus Langfuse's own `/api/auth/callback/custom`
  — which WorkOS validates against the allowlist like any other, session or no
  session, so leaving it out breaks SSO while the edge gate keeps working.

- **Ingestion keys are pre-seeded** via headless initialization
  (`LANGFUSE_INIT_PROJECT_*`). This is what makes the tier deployable in one
  `pulumi up`: the collector needs an ingestion credential in the same apply
  that creates Langfuse, and the alternative — boot, log in, mint a key by hand,
  put it in stack config, apply again — is a bootstrap that cannot be automated
  and quietly rots. The `Basic base64(pk:sk)` header is precomputed into the
  Langfuse Secret because the collector's only secret-injection mechanism is
  `${env:VAR}` interpolation of a whole header value.

- **Session and user attribution is app-side, and off by default.** Two of the
  three identifiers Langfuse needs already arrive for free, which is worth
  recording because it was checked rather than assumed: NAT's span exporter
  already sets `session.id` from `Context.conversation_id`, and it already emits
  OpenInference `input.value` / `output.value`, both of which Langfuse maps
  natively. What is missing is the **user** and the **tenant**, which NAT has no
  concept of — they arrive on the `X-Grid-*` request headers. A NAT pipeline
  processor projects them onto every span.

  It is gated on `GRID_TRACE_IDENTITY_ATTRIBUTES`, injected only where the
  Langfuse tier exists, because attaching a user id to telemetry changes what
  the store *is*: ADR-0029 accepted that traces carry user CONTENT on the
  reasoning that access is gated to platform operators. Making every span
  attributable to a named individual is a further step and should arrive with
  the product decision that needs it.

  The processor runs **ahead of** NAT's redaction processor. Attributes added
  after redaction can never be redacted, which would make listing
  `langfuse.user.id` in `redaction_attributes` a privacy setting that silently
  does nothing.

- **Least privilege carried through, not approximated.** The `langfuse` Postgres
  role owns one database and holds no CREATEDB/CREATEROLE — Langfuse runs its
  own Prisma migrations, so its credential has DDL rights, and those have no
  business reaching `grid_app`. The `grid-langfuse` S3 identity is scoped
  `<Action>:langfuse` and nothing else; conversely the general-purpose `grid`
  identity is **withheld** from the Langfuse bucket, so adding a platform bucket
  did not silently widen the credential the BFF and purger already hold.

- **ClickHouse, `langfuse-web`, `langfuse-worker` are withheld from the
  wholesale intra-namespace NetworkPolicy allow**, with named callers granted
  instead. These pods do authenticate — the distinction from ADR-0029's
  unsecured dashboard is real — but they have no legitimate in-namespace caller
  besides each other and the collector, and ClickHouse answers a password over
  plaintext HTTP for a store holding every tenant's prompts.

## Amendment 1 (2026-08-10): the flag defaults on

`langfuseEnabled` now defaults to **`true`**, matching `observabilityEnabled`.

The original default-off was written while the tier was unproven, and it made
adoption a two-step: set ten credentials, then remember an eleventh setting that
does nothing on its own. Durable traces are the expected shape of a stack now,
so the flag stops being the thing an operator has to discover.

**Nothing about what gets provisioned changed.** Availability is still flag AND
capability, and the capability half is untouched: every credential the tier
cannot boot without, plus `observabilityEnabled`. A stack that has not set them
gets the same `pulumi preview` warning naming what is missing, and the same
empty result — no workloads, no `https-langfuse` listener, no collector
exporter, no identity attributes. What flipped is which way the two-part gate
reads: setting the credentials is now sufficient, and `langfuseEnabled=false` is
how a stack declines the four workloads and the unbounded PVC.

The Docker Compose profile is unchanged and stays opt-in
(`--profile langfuse`) — nothing feeds it traces locally, as Open Questions
records, so starting ClickHouse and three more containers by default on a laptop
would buy an empty UI.

## Amendment 2 (2026-08-24): the picking becomes a first-class observation

The first production weeks exposed an asymmetry in what the traces could
answer. Cost per model, per session, per user — all there. But ask *which
knowledge documents the agent picked, and what it skipped* — the question every
operator asks of a weak answer — and the only place to look was the formatted
prose inside a tool span's `output.value`. A search that returned nothing was
indistinguishable from a turn that never searched at all.

**Change:** the knowledge layer now emits one balanced NAT step pair per
search, named `retrieve.<tool>` (`retrieve.knowledge_search`), via
`aiq_agent.observability.retrieval_trace`. It flows through the same exporter
pipeline, so it gets session/user attribution and Langfuse mapping for free and
nests under the calling tool's FUNCTION span.

**Content discipline — metadata only.** The input side carries query,
augmented retrieval query, collections with shelves, candidate/top-k budgets,
rerank flag and how many chunks a relevance floor dropped; the output side
carries one entry per picked chunk: id, file name, page, score (4 dp),
collection, shelf, doc class. **No chunk text.** That keeps the span inside
ADR-0029's accepted posture (it adds no content category that wasn't already
flowing) and means an operator who enables redaction loses the picking record
together with everything else — never left behind as a half-redacted orphan.

Two gaps this amendment deliberately does NOT close:

- **Which LLM call was which phase** (planner / researcher / writer). NAT names
  GENERATION rows by model id only, and the subagent-phase attribution problem
  is documented in `src/aiq_agent/tokenomics/README.md` — solving it properly
  is timing-window attribution ported into the export pipeline, not a rename.
- **The source router's pick.** Its selection rides in its own LLM output text;
  structuring it needs a contract for parsing that output, which does not exist.

## Consequences

### Positive

- Trace history outlives a pod restart, and is queryable: cost and token usage
  per model, per session, per user, per organization, over time.
- The change ADR-0029 predicted lands where it predicted — one exporter block in
  the collector config. No producer changed its endpoint.
- Prompt management, datasets and LLM-as-judge evaluations become available for
  the runtime-tunable surfaces (Platform → Models, per-org overrides) that
  currently ship with no measurement at all.
- Compose keeps authorization parity: the `grid-langfuse` identity is declared
  in both compose stacks and pinned against `s3IdentityCatalog` by the existing
  parity test, so the dev environment does not run a weaker model than
  production.

### Negative

- **Four new workloads and a new stateful technology.** ClickHouse is the first
  in this stack, with its own operational profile and failure modes. It is not
  optional: Langfuse v3 has no Postgres-only mode.
- **The trace store has no backup.** Postgres has PITR (ADR-0042) and the S3
  event archive is in SeaweedFS, but ClickHouse has neither. Its PVC is pinned
  `Retain` and `protect`ed; that is the whole of its durability story.
- **Nothing expires.** Data-retention policies are an Enterprise feature, so the
  ClickHouse PVC grows for as long as the deployment runs. `clickhouseStorageSize`
  is therefore a knob to watch rather than set once, and pruning is a manual
  operator action. This is the clearest cost of taking the free build, and it is
  a real one.
- Back-pressure is shared: both trace exporters sit on one pipeline, so a
  Langfuse outage long enough to fill its (bounded) sending queue will cost the
  dashboard spans too. Accepted — neither consumer is in a request path.
- A second redirect URI to register in WorkOS, and a second place platform
  access is effectively granted.

### Risks

- **Web and worker images must be the same version.** They are separate config
  keys because upstream publishes two images, and digests are opaque, so
  `loadConfig` cannot check it. Mitigated by documentation and by both defaults
  being pinned from the same tag (3.225.1).
- **ClickHouse must run UTC.** On any other server timezone Langfuse's queries
  return empty or shifted result sets — a dashboard reporting "no data" for a
  system that is plainly running. `TZ=UTC` is pinned on the container.
- **`CLICKHOUSE_CLUSTER_ENABLED=false` is a schema decision, not a performance
  one.** It makes the migrator emit plain `MergeTree` instead of `Replicated*`.
  Growing to a real cluster later is a migration, not a replica-count change.
- **Migration races.** Both images run migrations at startup by default; they
  contend on an advisory lock rather than corrupting anything, but the loser
  blocks until its startup probe expires, so a deploy would fail on a probe
  timeout rather than on anything naming migrations. Mitigated by giving them to
  the web tier alone and ordering the worker behind it.
- **Identity in telemetry.** Enabling this tier makes traces attributable to
  named individuals. Bounded by the same edge permission gate as the dashboard,
  and by the redaction ordering above, but it is a genuine widening of what the
  trace store contains — re-evaluate before widening access.

## Alternatives Considered

- **Langfuse Cloud (free tier)** — no infrastructure, but prompts, retrieved
  document snippets and model output would leave the cluster for a third party,
  and the free tier is trace-capped. Rejected on the first ground alone.
- **Grafana + Tempo + Loki** — the stack ADR-0029 rejected. Still the right
  answer for generic distributed tracing and still the wrong shape here: it has
  no concept of a model, a token, a cost, a prompt version or a session, so the
  three questions in Context would remain unanswerable without building that
  layer ourselves.
- **LangSmith** — closest feature match, but cloud-only on the free tier (same
  data-residency objection) and capped at 5k traces/month.
- **Extending the ADR-0015 ledger with per-span cost** — cheapest in
  infrastructure, and it addresses only question 1. The ledger is an accounting
  system whose numbers must be exact; making it also a diagnostic store would
  couple retention and schema decisions to billing correctness.
- **Keeping Aspire alone and raising the ring buffer** — moves the limit without
  changing its nature. An in-memory buffer is still lost on restart, and no
  buffer size answers "how did this change month over month".

## Open Questions / Follow-ups

- **Retention.** With no policy available in OSS, decide an operator runbook
  (manual ClickHouse partition drops) or accept unbounded growth with alerting
  on the PVC. Currently the latter, documented.
- **Media capture** is deliberately not configured
  (`LANGFUSE_S3_MEDIA_UPLOAD_*`): no producer here emits it, and wiring it would
  add a browser-facing presign path for a feature with no consumer.
- **Metrics.** The collector's metrics pipeline still exports to Aspire only,
  and nothing in the stack emits meters (ADR-0029 Amendment 3). Unchanged here.
- **Compose has no ingestion path.** The profile runs the UI and API for
  development against Langfuse itself; there is no collector locally and the
  backend's exporter is gated off, by design (ADR-0029).
- **Prompt management is deployed but not adopted.** Moving the agent's prompts
  behind Langfuse's registry is a separate decision with its own failure mode
  (a runtime dependency on the trace store for serving traffic).

## References

- ADR-0029: Aspire standalone dashboard as live telemetry pane
- ADR-0031: err2issue — ERROR telemetry becomes GitHub issues
- Langfuse self-hosting: https://langfuse.com/self-hosting
- Langfuse OTel integration: https://langfuse.com/integrations/native/opentelemetry
- Langfuse licence split: https://langfuse.com/self-hosting/license-key
- Operator guide: `docs/deployment/kubernetes.md` § Langfuse
- Implementation: `deploy/pulumi/src/platform/langfuse.ts`,
  `deploy/pulumi/src/data/clickhouse.ts`,
  `src/aiq_agent/observability/langfuse_trace_attributes.py`
