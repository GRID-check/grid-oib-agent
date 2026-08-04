# Rate limiting & load protection — state of the art, and what Grid should build

> Research note + design proposal. Commissioned as "a sophisticated rate limiter
> that plays nicely with Kubernetes and doesn't need requirements implemented in
> each app." This document answers three questions in order: **does that ask hold
> up** (partly — §1), **what the state of the art actually is in 2026** (§2), and
> **what to build here, in what order** (§3–§5).
>
> Decision record: ADR-0040 (Proposed).

---

## 1. Does the premise hold up?

**Half of it is exactly right, and half of it cannot work in this architecture.**

The ask splits cleanly into two problems that look like one:

| | Problem A — *traffic* | Problem B — *consumption* |
|---|---|---|
| Threat | Someone floods the front door: scrapers, credential stuffing, a reconnect storm, a runaway client loop | One tenant eats the shared expensive resources: LLM spend, agent worker slots, Postgres, Chroma |
| Unit | requests / connections per second | euros, tokens, concurrent long-running jobs |
| Knowable at the edge? | **Yes** — before the request is proxied | **No** — cost is only known *after* the model answers |
| Zero app code? | **Yes** | **No, not in this topology** |

Problem A is a solved, declarative, infrastructure-layer problem, and the
instinct that it belongs in Kubernetes rather than in application code is
correct. Envoy Gateway is already the edge (`deploy/pulumi/src/platform/gateway.ts`),
and it can enforce this with a CRD and no application change at all.

Problem B is the one that actually costs money — and three properties of this
system put it structurally out of the edge's reach:

1. **The edge cannot see who the caller is.** Browser traffic authenticates with
   the AuthKit **encrypted session cookie** (`multitenancy-and-auth-spec.md`
   §"API call with JWT"): the BFF unseals it and only *then* mints a Bearer JWT
   for the Python agent. Envoy Gateway's `SecurityPolicy` can validate a JWT and
   project claims into headers (`claimToHeaders`) — the standard way to get
   `org_id` into a rate-limit descriptor — but there is no JWT on the wire at the
   edge, only an opaque sealed cookie. Identity-scoped limits at the edge
   therefore require an **`extAuth` hop** (§3, L2), not a config flag.
2. **The expensive path is a WebSocket.** ADR-0009 makes chat WebSocket-only. To
   the edge, an entire chat session — hundreds of turns, each triggering a
   multi-agent research run — is **one HTTP request**: the upgrade. HTTP-level
   rate limiting counts it once and then goes blind. This is a general property
   of gateway rate limiting, not an Envoy gap.
3. **The costly call is *outbound*, not inbound.** The LLM spend happens on
   `backend → OpenRouter` egress. It never traverses the ingress Gateway, so no
   ingress policy can meter it. (There *is* a way to bring it back under
   declarative control — an egress AI gateway — see §5.)

There is also a fourth, less structural but more immediate finding:

4. **You do not have "no rate limiter". You have five, and none of them know
   about each other.** They disagree on algorithm, storage, failure mode and
   error shape:

| # | Where | Scope | Algorithm | Store | On failure |
|---|---|---|---|---|---|
| 1 | `frontends/ui/server.js` (WS upgrade) | per client IP | fixed window, atomic `INCR` | Dragonfly | fail open |
| 2 | `frontends/ui/src/lib/sharing/rate-limit.ts` | per subject/action | fixed window, **non-atomic** read-modify-write | Dragonfly via cache | fail open |
| 3 | `frontends/aiq_api/.../jobs/submit.py` | global + per org | **concurrency** (`MAX_ACTIVE_JOBS` 8 / `…_PER_ORG` 3) | Postgres count | fail open |
| 4 | `common/cost_tracking.py` + ADR-0015 | org / member / project | EUR budget, daily+monthly | Postgres ledger + rollups | read fails open, refusal fails closed |
| 5 | `GRID_MAX_RUN_COMPLETION_TOKENS`, `GRID_MAX_QUERY_SUBMISSIONS` | per run | hard ceilings | in-process | n/a |

So the real project is **not greenfield**. It is: *push what belongs at the edge
to the edge, give the rest one vocabulary, and stop the five from drifting.*

### One correctness finding, worth acting on regardless

**Client-IP preservation is unconfigured.** There is no `externalTrafficPolicy`,
no proxy protocol, and no `clientIPDetection` on the `ClientTrafficPolicy`
(`gateway.ts:234`). If the managed LoadBalancer SNATs, then Envoy's downstream
address — and the `x-forwarded-for` that `server.js:210` keys its limiter on — is
**the LB's IP for every user**. In that case limiter #1 is not "30 upgrades per
minute per client"; it is *30 upgrades per minute for the entire product*, and
the fail-open default is the only reason it has not been noticed. Any per-IP
limit, at the edge or in the app, is worthless until this is verified. **Verify
before tuning any number in this document.**

---

## 2. State of the art, 2026

### 2.1 Kubernetes has no standard rate-limit API — and won't soon

The Gateway API proposal to standardize rate limiting
([kubernetes-sigs/gateway-api#326](https://github.com/kubernetes-sigs/gateway-api/issues/326))
is **closed / withdrawn**. What was standardized instead is the *shape* of
extension: [GEP-713 Policy Attachment](https://gateway-api.sigs.k8s.io/geps/gep-713/) —
metaresources that attach to a Gateway/Route by `targetRefs`. Every
implementation ships its own policy CRD in that shape.

Practical consequence: **pick the policy CRD of the gateway you already run.**
Portability comes from the attachment pattern, not from a shared schema. Choosing
a "neutral" rate limiter to stay portable buys nothing and costs a component.

### 2.2 Envoy Gateway — the native fit here

Two modes, composable on the same route
([concepts](https://gateway.envoyproxy.io/docs/concepts/rate-limiting/)):

- **Local** — per Envoy process, token bucket, no dependencies. Cheap first line;
  with 2 proxy replicas the effective limit is ~2× the configured one.
- **Global** — every proxy consults the external **Rate Limit Service** (Envoy
  RLS protocol) backed by Redis, so the limit is fleet-wide and survives scaling
  the edge. Enabled in the `EnvoyGateway` config, not per route
  ([task docs](https://gateway.envoyproxy.io/docs/tasks/traffic/global-rate-limit/)).

Both are expressed as `BackendTrafficPolicy` — the **same CRD already in use**
for the 3600s streaming timeouts and the retry policy (`app/httproutes.ts:85`).
Descriptors come from `clientSelectors`: `headers` (with `type: Distinct` for
one bucket per unique value, and `invert` to carve out exemptions), `sourceCIDR`
(`Distinct` = per IP, `Exact` = one shared bucket for the range), `path`,
`methods`. `shared: true` pools one bucket across routes. Over-limit returns
**429** with `x-envoy-ratelimited: true`.

**Cost-based limiting** (v1.3+) is the important recent addition: a rule may
deduct a variable amount rather than 1 per request —

```yaml
cost:
  request:  { from: Number, number: 0 }          # check budget, consume nothing
  response: { from: Metadata,
              metadata: { namespace: ext_proc, key: token_count } }
```

This is what makes *usage*-based limiting possible at a proxy: charge the budget
after the fact, from dynamic metadata an external processor wrote.

Caveats to design around: limits are **per route even when the policy attaches to
a Gateway** (no aggregate-across-routes bucket without `shared`); there is an open
report that a Gateway-attached policy only lands on one listener
([#8707](https://github.com/envoyproxy/gateway/issues/8707)) — verify against the
running version, since this Gateway has four listeners; and `failClosed` defaults
to **false** (RLS down ⇒ traffic flows).

The RLS itself ([envoyproxy/ratelimit](https://github.com/envoyproxy/ratelimit))
is **fixed-window counters in Redis** — not a sliding window, not a token bucket.
It offers a `freecache` local cache for already-over-limit keys, `near_limit`
metrics at an 80% ratio, and — the feature that should govern the rollout —
**`shadow_mode`**, which evaluates rules and reports what *would* have been
blocked while always returning OK.

### 2.3 The AI-specific line of work

- **[Envoy AI Gateway usage-based rate limiting](https://aigateway.envoyproxy.io/docs/capabilities/usage-based-ratelimiting/)** —
  extracts `InputToken` / `OutputToken` / `CachedInputToken` / `TotalToken` from
  OpenAI-schema responses into dynamic metadata, then feeds them to the
  `cost.response` hook above; CEL lets you weight cached tokens differently.
  Descriptors are typically `x-tenant-id` × `x-ai-eg-model`, i.e. per-tenant
  per-model token budgets **enforced in the proxy**. It requires the LLM traffic
  to *pass through the gateway*.
- **[Kuadrant](https://docs.kuadrant.io/) — `RateLimitPolicy` + `TokenRateLimitPolicy`,
  enforced by [Limitador](https://github.com/Kuadrant/limitador)** (Rust, speaks
  the Envoy RLS protocol) with **Authorino** for identity. This is the
  reference "policy plane" decomposition: *authn/authz service* → *limiter
  service* → *gateway*, all as Gateway-API-attached CRDs, portable across Istio
  and Envoy Gateway. `TokenRateLimitPolicy` reads token counts out of the
  inference response body. Worth knowing as the architecture even if you never
  install it, because §3's L2 is a hand-rolled subset of it.
- **[Gateway API Inference Extension](https://gateway-api-inference-extension.sigs.k8s.io/guides/flow-control/)** —
  the most interesting signal about *direction*. Instead of rejecting excess
  load, the gateway **queues** it: a Saturation Detector decides when the backend
  pool is full, and priority-and-fairness-aware queues hold requests at the
  gateway rather than letting them pile onto model servers. Reported effect is
  materially lower p90/tail latency past ~400–500 QPS versus reject-on-overload.

### 2.4 Where the industry moved: from RPS to concurrency, priority and utilization

Static requests-per-second is no longer considered sufficient for workloads whose
per-request cost varies by orders of magnitude — which is exactly a research agent
(a one-line question vs. a 40-step deep run).

- **[Netflix, service-level prioritized load shedding](https://netflixtechblog.com/enhancing-netflix-reliability-with-service-level-prioritized-load-shedding-e735e6ce8f7d)
  (QCon SF 2025)** — shed by *request criticality*, not by rate; move the decision
  from a central gateway into the services that know their own saturation; use
  **adaptive concurrency limits** and latency-SLO utilization rather than fixed
  thresholds. `Netflix/concurrency-limits` **partitions** capacity: the
  user-initiated partition is guaranteed 100% throughput, prefetch gets only
  surplus. That partition idea maps almost directly onto interactive chat vs.
  background deep-research jobs here.
- **Kubernetes' own API Priority & Fairness** is the canonical in-cluster design
  for this: priority levels with reserved concurrency shares, plus **fair queuing
  with shuffle sharding** so one noisy tenant cannot starve the rest. It is the
  right mental model for the agent worker pool.
- **Envoy circuit breakers** (`BackendTrafficPolicy.circuitBreaker`:
  `maxParallelRequests`, `maxPendingRequests`, `maxConnections`) provide the
  crude version for free: bound in-flight requests per backend, queue a little,
  shed the rest with 503.

**The synthesis:** rate limits protect against *abuse*; concurrency limits,
priority and fair queuing protect against *overload*; budgets protect against
*cost*. They are three different mechanisms and a design that uses one for all
three will be wrong in at least two ways.

### 2.5 Algorithms, honestly

| Algorithm | Burst behaviour | Cost | Where it fits here |
|---|---|---|---|
| **Fixed window** | 2× the limit across a boundary | 1 `INCR` | Envoy RLS (not your choice); fine for coarse abuse bounds |
| **Sliding window (counter)** | smooth | 2 reads + weighting | app-side, when the boundary spike matters |
| **Token bucket / GCRA** | configurable burst + steady rate, one key, exact | 1 Lua eval | the right choice for anything app-side and identity-scoped |
| **Concurrency (semaphore)** | n/a | count/CAS | expensive long-running work — jobs, agent turns |
| **Adaptive concurrency** | self-tuning from latency | more moving parts | later, once L3 exists and is measured |

Note the honesty already in `sharing/rate-limit.ts:8-15` about its non-atomic
read-modify-write. That is the correct instinct and the right fix is not more
prose — it is a Lua GCRA script against Dragonfly, which makes it exact for the
same round-trip count.

---

## 3. What to build: five layers, each with one job

Nothing below is "the rate limiter". Each layer answers a different question, and
the value of the design is that each layer's failure mode is understood.

```
 L0  connection hygiene      ClientTrafficPolicy         per-IP conns, TLS, header caps
 L1  edge request limits     BackendTrafficPolicy        per-IP/route RPS  ← zero app code
 L2  identity-scoped quota   extAuth OR apiRoute limits  per-org/user/action
 L3  admission & fair share  job/turn concurrency        per-org slots, priority, queue
 L4  cost ceiling            ADR-0015 budgets            EUR/day, EUR/month  ← already built
```

**L0 — connection hygiene (edge, declarative).** Extend the existing
`ClientTrafficPolicy`: `connection.connectionLimit` per proxy, and — first —
`clientIPDetection` so the layers above it key on a real client. Cheap, and it is
the prerequisite for everything per-IP.

**L1 — edge request rate limits (edge, declarative, the part the premise gets
right).** Turn on the global RLS and attach `BackendTrafficPolicy` rate limits
per route. This is genuinely zero application code and it covers: scraping the
landing site, hammering presigned S3 URLs, login/credential stuffing, reconnect
storms, and any unauthenticated flood. Deliberately **anonymous** — no identity
needed, per-IP `Distinct` buckets only.

**L2 — identity-scoped quota.** This is where "no per-app implementation" has to
be argued rather than assumed. Two options:

- **(a) `extAuth` policy service** — a `SecurityPolicy` with `extAuth` pointing at
  a small service that unseals the session, resolves org/user, checks a quota in
  Dragonfly, and returns either 429 or `x-grid-org-id` headers that L1 rules can
  then use as `Distinct` descriptors. This is the Kuadrant (Authorino+Limitador)
  shape and it is the *true* "no app code" answer. Cost: a new service, a new hop
  on every request including the WS upgrade, and it must duplicate the session
  unsealing logic that today lives only in `authkit-nextjs`.
- **(b) One declaration in the existing route factory** — extend `apiRoute` so a
  route declares its limit class next to the `authz` option it already cannot
  compile without (ADR-0038), enforced centrally in `lib/authz/decide.ts`'s
  sibling. Coverage is provable the same way `authz-coverage.spec.ts` proves
  authorization coverage.

**Recommendation: (b), for now.** The premise's real goal is *"I don't want to
re-implement this in every app"* — and that is already satisfied, because there is
exactly **one** user-facing app. `frontends/web` is a static Astro site (L1 covers
it), `frontends/aiq_api` is not publicly routed (no HTTPRoute), and the workers
have no ingress. Option (a) buys architectural purity for the price of a new
always-in-path service that can take chat down; revisit it if and when a second
authenticated ingress appears.

**L3 — admission control & fair share.** `MAX_ACTIVE_JOBS_PER_ORG = 3` is already
the most valuable limiter you have, because it limits the *right unit*. Three
upgrades, in value order: extend the same admission idea to **interactive chat
turns** (today unbounded per org — a shared conversation with ten members
triggers ten concurrent multi-agent runs, and only the EUR budget stops it);
**partition** the pool à la `concurrency-limits` so interactive chat cannot be
starved by background deep research; and **queue with position feedback** instead
of rejecting ("you are 2nd in queue" beats "queue is full, try later"), which is
where the Inference Extension's flow control is heading.

**L4 — cost ceiling.** Built (ADR-0015). No change beyond making its refusal
share the 429 vocabulary of L1–L3 so the UI has one story.

### Failure-mode policy (decide once, write it down)

| Layer | On its store/dependency failing | Why |
|---|---|---|
| L0/L1 | **fail open** (`failClosed: false`, RLS timeout 250 ms) | a Redis blip must not be an outage; these are abuse bounds |
| L2 | fail open | same |
| L3 | fail open (already is) | protective, not load-bearing |
| L4 budget **refusal** | **fail closed** | it is the money gate — already correct |

One exception worth considering: fail *closed* on L1 for the **unauthenticated**
login/signup routes only, where the cost of letting a flood through exceeds the
cost of refusing legitimate traffic during a Redis outage.

---

## 4. Implementation plan for this repo

Phased so each step is independently valuable and reversible.

### Phase 0 — measure before limiting (do this first)

1. **Verify client-IP preservation** (§1 finding). Check the LoadBalancer's
   `externalTrafficPolicy` and whether Envoy's downstream address is the real
   client; set `clientIPDetection` on the `ClientTrafficPolicy` accordingly.
   Until this is green, every per-IP number is fiction.
2. Turn on the RLS in **`shadow_mode`** and dashboard `near_limit` + would-block
   counts against the existing Aspire/OTel pane (ADR-0029). Pick limits from the
   observed p99, not from intuition.

### Phase 1 — edge limits (`deploy/pulumi/`, no app change)

Enable the rate limit service in the chart values (`platform/gateway.ts`, which
today passes `values: {}` — note its comment forbids touching `values.crds`, not
`config.envoyGateway`):

```ts
values: {
  config: {
    envoyGateway: {
      rateLimit: {
        backend: { type: "Redis", redis: { url: "dragonfly-ratelimit.grid.svc.cluster.local:6379" } },
        failClosed: false,
        timeout: "250ms",
      },
    },
  },
},
```

Then per-route policies alongside the existing timeout policies in
`app/httproutes.ts`:

```ts
const webRateLimit: IBackendTrafficPolicySpec["rateLimit"] = {
  type: "Global",
  global: {
    rules: [{
      clientSelectors: [{ sourceCIDR: { value: "0.0.0.0/0", type: "Distinct" } }],
      limit: { requests: 120, unit: "Minute" },
    }],
  },
};
```

Three repo-specific things this must get right:

- **Do not point the RLS at the existing Dragonfly.** ADR-0020's instance runs
  `cache_mode` with eviction under memory pressure and one replica; evicted
  counters silently reset a limit. Deploy a **second, small Dragonfly** for
  rate-limit counters (same manifest, different name, no eviction), or accept
  documented sloppiness. Counters are ephemeral either way — no persistence
  needed.
- **A NetworkPolicy rule is missing.** `grid` is default-deny ingress and the
  allow-list (`platform/network-policies.ts` rules 4–9) has no entry for
  `envoy-gateway-system → dragonfly`. The RLS pod lives in
  `envoy-gateway-system`; without a new rule it will silently fail every lookup
  and — fail-open — enforce nothing.
- **Set the WS upgrade limit here, and delete limiter #1 from `server.js`** once
  it is proven equivalent. That is one real reduction in app-level code, and the
  clearest single win the premise asks for.

Starting numbers (per client IP, to be replaced by Phase 0 data):

| Route | Limit | Rationale |
|---|---|---|
| `grid-web` (landing/blog) | 120/min | static site; anything above is a scraper |
| `grid-s3` (presigned) | 300/min | a document preview fans out to many object GETs |
| `grid-app` — WS upgrade path | 30/min | matches today's `GRID_WS_UPGRADE_RATE_LIMIT` |
| `grid-app` — `/api/auth/*` | 20/min | credential stuffing; the one candidate for fail-closed |
| `grid-app` — rest | 600/min | a chat session is chatty; do not clip real use |

### Phase 2 — the WebSocket blind spot (`frontends/ui/server.js`, one file)

The edge counts the upgrade once and then sees nothing. Add a per-session token
bucket on inbound WS frames in the proxy — the single place all chat traffic
passes — keyed by session, not IP, with the message *class* (chat turn vs.
typing/presence) as the cost. This is the layer that actually bounds "how many
agent runs can one open tab start", and no gateway-only design can supply it.

### Phase 3 — one vocabulary (`frontends/ui/src/lib/`)

Introduce `lib/limits/` with a single `RateLimitDecision` type, an atomic Lua
**GCRA** implementation against Dragonfly, and a declaration on `apiRoute`
mirroring ADR-0038's `authz` requirement. Migrate `sharing/rate-limit.ts`'s three
rules onto it (fixing the non-atomic window) and give L1–L4 one 429 + `Retry-After`
+ error-code contract so the UI renders one consistent message.

### Phase 4 — fair share for the expensive path (`frontends/aiq_api/`, `src/aiq_agent/`)

Extend admission control to interactive turns; partition interactive vs.
background capacity; report queue position. Measure with the same near-limit
dashboards before tuning.

---

## 5. Two things not to do (and one to keep in your back pocket)

**Don't put token-cost rate limiting on the ingress gateway.** The Envoy AI
Gateway pattern (§2.3) meters LLM traffic *flowing through* the proxy. Here the
LLM call is `backend → OpenRouter` **egress**; it never touches the ingress
Gateway, so there is nothing for `cost.response` to observe. Building it there
would mean an ext_proc that parses responses that do not pass through it.

**Don't replace the budget system with token rate limits.** ADR-0015 is already
the correct mechanism for the cost question — auditable, attributable, per-scope,
with supersede lineage. A token-per-minute limit is a *smoothness* control, not a
spend control. If bursty spend is the actual complaint, add a per-org
tokens-per-minute bucket at L2/L3; do not move the ceiling.

**Keep in your back pocket: an egress AI gateway.** If the goal ever becomes
"enforce model/token policy for every LLM call with zero backend code", the
declarative answer is to route `backend → OpenRouter` through an **Envoy AI
Gateway as an egress proxy** — provider-agnostic token accounting, per-tenant
per-model limits, all as CRDs. It is a real option because the backend is already
LLM-agnostic via `base_url` (ADR-0010), so pointing it at an in-cluster egress
gateway is a config change. It is *not* needed today: `cost_tracking.py`'s
ContextVar hook already achieves "every LLM call metered, zero per-agent code" in
about 3 wiring points, which is the same property this document keeps asking for.

---

## Sources

- [Gateway API — GEP-713 Policy Attachment](https://gateway-api.sigs.k8s.io/geps/gep-713/) ·
  [issue #326, rate limiting (withdrawn)](https://github.com/kubernetes-sigs/gateway-api/issues/326)
- [Envoy Gateway — Rate Limiting concepts](https://gateway.envoyproxy.io/docs/concepts/rate-limiting/) ·
  [Global Rate Limit task](https://gateway.envoyproxy.io/docs/tasks/traffic/global-rate-limit/) ·
  [BackendTrafficPolicy](https://gateway.envoyproxy.io/docs/concepts/gateway_api_extensions/backend-traffic-policy/) ·
  [Circuit Breakers](https://gateway.envoyproxy.io/docs/tasks/traffic/circuit-breaker/) ·
  [issue #8707 (Gateway-attached policy, one listener)](https://github.com/envoyproxy/gateway/issues/8707)
- [envoyproxy/ratelimit](https://github.com/envoyproxy/ratelimit) ·
  [Envoy global rate limiting](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/other_features/global_rate_limiting) ·
  [local rate limit filter](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/local_rate_limit_filter)
- [Envoy Gateway 1.3 — rate limiting with cost](https://dev.to/reoring/envoy-gateway-130-overview-of-the-new-rate-limiting-with-cost-feature-252j) ·
  [Envoy AI Gateway — usage-based rate limiting](https://aigateway.envoyproxy.io/docs/capabilities/usage-based-ratelimiting/)
- [Kuadrant RateLimitPolicy](https://docs.kuadrant.io/1.3.x/kuadrant-operator/doc/overviews/rate-limiting/) ·
  [TokenRateLimitPolicy](https://docs.kuadrant.io/1.3.x/kuadrant-operator/doc/overviews/token-rate-limiting/) ·
  [Manage AI resource use with TokenRateLimitPolicy](https://developers.redhat.com/articles/2026/02/18/manage-ai-resource-use-tokenratelimitpolicy)
- [Gateway API Inference Extension — Flow Control](https://gateway-api-inference-extension.sigs.k8s.io/guides/flow-control/) ·
  [Introducing the Inference Extension](https://kubernetes.io/blog/2025/06/05/introducing-gateway-api-inference-extension/)
- [Netflix — service-level prioritized load shedding](https://netflixtechblog.com/enhancing-netflix-reliability-with-service-level-prioritized-load-shedding-e735e6ce8f7d) ·
  [InfoQ coverage](https://www.infoq.com/news/2025/11/netflix-prioritized-loadshedding/)
- [WebSocket rate limiting — connection vs. message level](https://websocket.org/guides/security/)
