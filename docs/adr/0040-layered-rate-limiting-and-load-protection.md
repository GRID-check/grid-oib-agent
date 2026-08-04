# ADR-0040: Layered rate limiting — the edge limits traffic, the app limits consumption

- **Status:** Accepted
- **Date:** 2026-08-04
- **Deciders:** Grid Agent team (commissioned by the platform owner: "a rate limiter that plays nicely with Kubernetes and is not implemented per app")
- **Related:** ADR-0009 (WebSocket-only chat), ADR-0015 (LLM budgets & usage ledger), ADR-0020 (Dragonfly shared cache), ADR-0028 (horizontal agent scaling), ADR-0029 (Aspire telemetry), ADR-0038 (one authorization catalog + coverage gate), [`../architecture/rate-limiting-and-load-protection.md`](../architecture/rate-limiting-and-load-protection.md) (the research this decision rests on)

## Context

The stack has five independent limiters that were each added for a local reason
and know nothing about each other — the WS-upgrade IP limiter in `server.js`, the
non-atomic collaboration window in `lib/sharing/rate-limit.ts`, async-job
admission control in `jobs/submit.py`, the EUR budget system (ADR-0015), and the
per-run token ceilings. They disagree on algorithm (fixed window vs. concurrency
vs. currency), on storage (Dragonfly vs. Postgres vs. in-process), on failure
mode, and on the error the user finally sees.

The brief was to replace that with one sophisticated limiter living in the
Kubernetes layer, so no application has to implement anything. Research
(see the linked document) found that this is achievable for one half of the
problem and structurally impossible for the other:

- **Traffic** (requests/connections per unit time) is knowable at the edge before
  a request is proxied. Envoy Gateway — already the edge — enforces it with a
  `BackendTrafficPolicy` and zero application code.
- **Consumption** (LLM spend, agent slots, database load) is not, for three
  reasons that are properties of this architecture, not gaps in Envoy: the edge
  sees an **encrypted AuthKit session cookie**, not a JWT, so it cannot name the
  tenant; chat is **WebSocket-only** (ADR-0009), so an entire session of
  multi-agent runs is one HTTP request to the edge; and the expensive call is
  **egress** to OpenRouter, which never traverses the ingress Gateway.

The 2026 state of the art agrees with that split. Gateway API deliberately did
**not** standardize rate limiting (issue #326 withdrawn; GEP-713 policy
attachment standardizes the *shape* instead), so the gateway's own policy CRD is
the right vehicle. And the systems that handle variable-cost workloads well —
Netflix's prioritized load shedding, Kubernetes API Priority & Fairness, the
Gateway API Inference Extension's flow control — all treat rate limiting,
concurrency/fair-share, and cost as **three separate mechanisms**.

One correctness finding blocks the per-IP half: client-IP preservation is
unconfigured (no `externalTrafficPolicy`, no `clientIPDetection`), so it is not
currently known whether existing per-IP limits bucket real clients or the
LoadBalancer.

## Decision

We will treat rate limiting as **five layers with one job each**, not one
component:

| Layer | Mechanism | Owns | Where it is configured |
|---|---|---|---|
| **L0** connection hygiene | `ClientTrafficPolicy` | connection caps, client-IP detection | `deploy/pulumi/` |
| **L1** edge request limits | `BackendTrafficPolicy` + Envoy RLS + Redis | anonymous per-IP, per-route RPS | `deploy/pulumi/` |
| **L2** identity-scoped quota | declaration on the `apiRoute` factory | per-org / per-user / per-action | `frontends/ui/src/lib/limits/` |
| **L3** admission & fair share | job/turn concurrency, partitioned | expensive long-running work | `frontends/aiq_api/`, `src/aiq_agent/` |
| **L4** cost ceiling | ADR-0015 budgets | EUR/day, EUR/month | unchanged |

Specifically, we will:

1. **Verify client-IP preservation first**, and set `clientIPDetection` on the
   existing `ClientTrafficPolicy`. No per-IP limit is tuned before this is green.
2. **Enable Envoy Gateway global rate limiting** (`EnvoyGateway.rateLimit.backend:
   Redis`, `failClosed: false`, 250 ms timeout) against a **second, dedicated
   Dragonfly instance** — never the ADR-0020 cache, whose `cache_mode` eviction
   would silently reset counters — and add the missing
   `envoy-gateway-system → dragonfly` NetworkPolicy allow.
3. **Roll it out in `shadow_mode`**, choose limits from observed `near_limit` and
   would-block metrics on the ADR-0029 pane, and only then enforce.
4. **Give the edge the same WS-upgrade budget** (`rateLimitAppWsUpgrade`) while
   KEEPING `server.js`'s own upgrade limiter, rebuilt on the shared catalog. The
   app-side one is what still works while the edge policy is in shadow mode, and
   the only one that applies to traffic that never crossed the gateway. Removing
   it is a follow-up for after shadow mode proves the edge equivalent — not part
   of this change.
5. **Add a per-session WebSocket frame limiter in the WS proxy** — the one place
   all chat frames pass — because no gateway-only design can see past the
   upgrade.
6. **Express identity-scoped limits as a declaration on `apiRoute`**, enforced
   centrally, exactly as ADR-0038 does for authorization. Not as per-route logic,
   not as Next.js middleware, and not (yet) as an `extAuth` service.
7. **Buy the counting, own the vocabulary.** Enforcement is
   **`rate-limiter-flexible`** (MIT) against the shared cache — not an algorithm
   of ours. What we own is the rule catalog, the single `RateLimitDecision`
   type, the 429 + `Retry-After` contract and the subject convention, none of
   which a library provides. An earlier draft hand-rolled GCRA; it was cut on
   review, and the reason given for it (that CommonJS `server.js` cannot share a
   TypeScript module) did not hold, because the library loads from CommonJS.
8. **Extend admission control to interactive chat turns** and partition
   interactive from background capacity, so deep research cannot starve chat.
9. **Fail open everywhere except the ADR-0015 budget refusal**, which stays
   fail-closed. The `/api/auth/*` edge rule is the one candidate for fail-closed
   and will be decided with data.

Limits are **abuse and overload bounds**, never accounting. Anything that must be
exact — spend, quota billing — belongs in the ADR-0015 ledger.

## Consequences

### Positive

- The half of the brief that can be declarative becomes declarative: edge limits
  are CRDs in `deploy/pulumi/`, reviewed and typechecked like the rest of the
  infrastructure, with no application involvement.
- The non-atomic collaboration window is replaced by an exact, library-backed
  one, and `@/lib/sharing/rate-limit` is deleted outright — three rules that lived
  in a sharing module now sit in a catalog with everything else.
- Each layer's failure mode is written down and deliberate rather than incidental.
- The WebSocket blind spot and the client-IP question are now named problems with
  owners instead of silent assumptions.
- One 429 + `Retry-After` + error-code contract means the UI tells one story.

### Negative

- Five layers is more concepts than "a rate limiter". The cost of the split is
  that a reader must know which layer refused a request; the `Retry-After` +
  error-code contract is what keeps that answerable.
- A second Dragonfly instance and an RLS deployment are new moving parts in the
  edge path (both fail-open).
- Identity-scoped limits stay in the BFF, so the brief's "no app implementation"
  is met by *one shared module in one app*, not by zero code.

### Risks

- **Wrong limits break real users.** Mitigated by shadow mode at the edge and by
  budgets chosen above what honest use costs; no number in the design doc is
  authoritative until observed.
- **Client-IP misconfiguration makes per-IP limits meaningless or global.** This
  risk existed *before* this change and is not resolved by it: `xffNumTrustedHops`
  ships at 0 and only a live cluster can confirm that is right.
- **Envoy Gateway issue #8707** (a Gateway-attached policy landing on only one
  listener) would silently under-apply limits on a four-listener Gateway.
  Mitigated by attaching policies per HTTPRoute, as the timeout policies already
  do, and verifying against the running version.
- **Counter store eviction** would reset limits invisibly. Mitigated by the
  dedicated instance, and by near-limit metrics that would show the discontinuity.

## Alternatives Considered

- **One gateway-level rate limiter for everything** — rejected: it cannot see
  identity (sealed cookie), cannot see past the WebSocket upgrade, and cannot see
  the egress LLM call, which is where the cost is.
- **`extAuth` policy service (Kuadrant/Authorino+Limitador shape)** — the honest
  "zero app code" answer for L2, and architecturally the cleanest. Deferred, not
  rejected: it adds an always-in-path service that can take chat down and must
  duplicate AuthKit session unsealing, to serve exactly one authenticated ingress.
  Revisit when a second one appears.
- **Next.js middleware for L2** — the conventional choke point in a Next app, and
  since 15.5 it can run on the Node runtime, so `ioredis` is no longer a blocker.
  Rejected on a specific fact rather than on taste: middleware runs before
  session resolution, so it would have to unseal the AuthKit cookie itself to key
  a bucket by member, while `apiRoute` is already mandatory (ADR-0038), already
  runs after authorization, and already carries a coverage spec.
- **A managed edge in front (Cloudflare)** — would solve the client-IP question
  outright via `CF-Connecting-IP` and adds WAF/bot detection we cannot build.
  Deferred by the platform owner: the in-cluster L1 keeps the limits in the same
  repo as the rest of the infrastructure and adds no vendor. Revisit if scraping
  or bot traffic becomes an observed problem rather than a hypothetical one.
- **Arcjet for L2** — Next-native SDK combining rate limiting, bot detection and
  shield. Rejected for now: paid, and it puts a vendor SDK in the request path of
  every route to replace a free library doing the one job we need.
- **Kuadrant (`RateLimitPolicy` / `TokenRateLimitPolicy` + Limitador)** — rejected
  for now: it would add an operator and a policy plane for capability Envoy
  Gateway already has natively, when we are not multi-gateway. Its
  `TokenRateLimitPolicy` becomes interesting only if LLM traffic is ever proxied.
- **Envoy AI Gateway token-based limiting on ingress** — rejected: the LLM
  responses it meters do not pass through the ingress gateway. Retained as a
  future *egress* option (ADR-0010 makes `base_url` a config change).
- **Replacing ADR-0015 budgets with token-rate limits** — rejected: a
  tokens-per-minute bucket controls burstiness, not spend, and would trade an
  auditable ledger for an approximation.

## Open Questions / Follow-ups

- **Does the managed LoadBalancer preserve the source IP?** `xffNumTrustedHops`
  ships at 0, which is correct only if it does. Everything per-IP depends on the
  answer, and it cannot be settled from this repo — it needs a live cluster.
- Should `/api/auth/*` fail closed at L1 when the RLS is unavailable?
- What is the right cost unit for a WebSocket chat frame? Today a frame is one
  unit of `chat-turn` or `ws-control`; weighting by agent group (a deep-research
  turn is not a clarifier reply) would need the proxy to understand more of the
  payload than it currently peeks at.
- Does the running Envoy Gateway version exhibit #8707 on a four-listener Gateway?
- When L3 gains queueing, what does the UI show for queue position?

## References

- [`../architecture/rate-limiting-and-load-protection.md`](../architecture/rate-limiting-and-load-protection.md) — the research note, with the full source list
- [Envoy Gateway — Global Rate Limit](https://gateway.envoyproxy.io/docs/tasks/traffic/global-rate-limit/), [Rate Limiting concepts](https://gateway.envoyproxy.io/docs/concepts/rate-limiting/)
- [Gateway API — GEP-713 Policy Attachment](https://gateway-api.sigs.k8s.io/geps/gep-713/), [issue #326 (withdrawn)](https://github.com/kubernetes-sigs/gateway-api/issues/326)
- [Gateway API Inference Extension — Flow Control](https://gateway-api-inference-extension.sigs.k8s.io/guides/flow-control/)
- [Netflix — service-level prioritized load shedding](https://netflixtechblog.com/enhancing-netflix-reliability-with-service-level-prioritized-load-shedding-e735e6ce8f7d)
