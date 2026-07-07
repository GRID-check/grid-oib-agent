# ADR-0015: LLM spend limits and the auditable usage ledger

- **Status**: Accepted
- **Date**: 2026-07-07
- **Deciders**: Grid Agent team
- **Related**: ADR-0008 (single-writer grid_app), ADR-0013 (base64url context headers), ADR-0014 (runtime model configuration), `docs/architecture/usage-budgets.md`

## Context

LLM spend is unbounded by default: any member can start deep-research runs
that cost real money, and nobody can see where the money went. Organizations
need spend limits (org-wide, per member, per project), visibility per model,
and an audit trail they can trust.

Facts that shape the solution:

- OpenRouter's **usage accounting** puts a `usage` object on **every**
  chat-completion response — `cost` (USD), token counts,
  `prompt_tokens_details.cached_tokens`,
  `completion_tokens_details.reasoning_tokens`; for streaming it arrives on
  the final SSE chunk. The response id (`gen-…`) can be replayed against
  `GET /api/v1/generation?id=` for authoritative stats (`total_cost`, native
  token counts) after the fact.
- langchain-openai passes that usage object through verbatim as
  `llm_output["token_usage"]` on every `LLMResult`.
- The `grid_app` database has exactly one writer, the BFF (ADR-0008); the
  backend reaches it only via token-guarded internal endpoints.
- LLM calls happen in many places (six agent groups, sync WS turns, async
  Dask jobs, background reflection) — per-agent capture code would be
  repetitive and would silently miss newly added agents.
- WorkOS is an identity provider, not a billing/config store.

## Decision

We will meter every LLM generation into an **append-only usage ledger** in
Postgres, enforce **EUR-denominated budget limits** at three independent
scopes, and capture costs through **one** LangChain callback handler.

1. **Storage: Postgres, not WorkOS.** Two tables
   (`0013_budgets.sql`): `budget_policies` — append-only with the repo's
   supersede idiom (changing a limit supersedes the previous active row; a
   partial-unique index enforces one active policy per org/scope/subject) —
   and `llm_usage_events` — one row per generation with org / user / project
   / conversation / job attribution, requested vs served model, token
   detail, `cost_usd` exactly as OpenRouter reported it, `cost_source`, and
   the OpenRouter `generation_id` for reconciliation.
2. **Seeded defaults**: an org with no explicit policy is limited to
   **€10/day and €100/month** (constants, reported as `explicit: false`).
   Org admins change them; member and project limits are optional extras
   that must not exceed the org limits (validated on write, HTTP 422).
   Project limits can also be set by that project's admins.
3. **One capture point (DRY)**: `GridCostTracker`
   (`src/aiq_agent/common/cost_tracking.py`) is installed via LangChain's
   `register_configure_hook` ContextVar seam, which attaches it to every
   callback manager configured inside the active request context. Activation
   happens at exactly three request entry points (sync chat turn, Dask job
   runner, background reflection task) — individual agents contain **no**
   cost code and future agents are covered automatically.
4. **Write path**: the tracker batches events and POSTs them to the
   token-guarded internal endpoint `POST /api/internal/usage`
   (single-writer rule preserved). Best-effort: ledger failures never break
   the answer path; rows carry `generation_id` so gaps are reconcilable
   against OpenRouter.
5. **Enforcement**: the BFF computes remaining budget (ledger spend vs
   effective limits, UTC day/month windows) at the WS upgrade. Exhausted →
   the upgrade is refused (403 with reason). Otherwise the remaining amounts
   travel as the base64url `x-grid-budget` header; the tracker accumulates
   in-flight spend and raises `BudgetExceededError` **before the next LLM
   call would start** once the remaining budget is used up. A call already
   in flight finishes — deliberate soft-limit semantics at call granularity.
6. **Currency**: the ledger stores USD (OpenRouter's unit); limits are EUR;
   comparison converts at a deployment-configured rate
   (`GRID_BUDGET_EUR_PER_USD`, default 0.86) at read time, so a rate change
   applies uniformly to history.

## Consequences

### Positive

- Complete, tenant-scoped audit trail: every generation attributable to org,
  member, project, conversation, job, and model; every limit change carries
  author + supersede lineage.
- Runaway protection at three scopes, including mid-run for long deep
  research jobs — not just at conversation start.
- Zero per-agent code; the DRY seam is proven by a unit test that checks the
  handler lands on a freshly configured LangChain callback manager.
- Trust surface in the UI: per-model color-coded spend against limits, with
  the exact figures OpenRouter reported.

### Negative

- A turn can overshoot its budget by at most one in-flight call per branch —
  hard-real-time cutoffs would require canceling streams mid-token.
- Spend aggregation reads the ledger on every WS upgrade; fine at current
  volume (indexed, month-bounded), a rollup table is the known scale-up.
- The EUR/USD rate is static per deployment, not market-driven; budgets are
  guardrails, not accounting-grade FX.

### Risks

- If OpenRouter omits `cost` on some responses (observed historically on
  some streaming paths), those rows record `cost_source='missing'` and 0
  cost until reconciled via the generation API — under-counting, never
  blocking. The reconciliation job is a follow-up.
- Anonymous deployments (REQUIRE_AUTH=false) have no org; their events are
  deliberately skipped (documented in the internal endpoint).

## Alternatives Considered

- **WorkOS org metadata for limits**: no transactional writes, no history,
  wrong system of record for money-adjacent data.
- **Per-agent callbacks** (extend each `callbacks=[...]` list): repetitive,
  and every future agent is a silent metering gap — rejected on the DRY
  requirement.
- **Proxying all LLM traffic through the BFF** to meter at the network
  layer: single choke point and latency for streaming; the callback seam
  achieves the same coverage without moving the data path.
- **OpenRouter provisioned-key limits**: caps the whole deployment key, not
  per-tenant scopes; no member/project granularity.
- **Hard mid-stream cancellation** on budget breach: kills answers users are
  reading for cents of overshoot; call-granular stop is the better tradeoff.

## Open Questions / Follow-ups

- Reconciliation worker: replay `cost_source='missing'` rows against
  `GET /api/v1/generation?id=` (needs outbound OpenRouter access from the
  frontend container or a backend relay).
- Daily/monthly rollup table when ledger scans show up in p95s.
- Notify admins (email/webhook) when spend crosses e.g. 80% of a limit.
- Populate `agent_group` on events (see ADR-0014 follow-ups).

## References

- `docs/architecture/usage-budgets.md` (design spec, incl. verification/dry-run notes)
- OpenRouter usage accounting: https://openrouter.ai/docs/guides/guides/usage-accounting
- OpenRouter generation stats: https://openrouter.ai/docs/api/reference/overview
