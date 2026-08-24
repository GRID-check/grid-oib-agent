# LLM Usage Metering & Budgets

> Design spec for ADR-0015. Every LLM generation is metered into an
> append-only ledger; EUR budget limits are enforced at org, member, and
> project scope; the org page shows color-coded per-model spend. Built for
> auditability and trust: costs are recorded exactly as OpenRouter reports
> them, every row is attributable, and every limit change has an author.

## The OpenRouter cost contract (verified against official docs)

Source of truth: OpenRouter **usage accounting**
(https://openrouter.ai/docs/cookbook/administration/usage-accounting) and the API
reference (https://openrouter.ai/docs/api_reference/overview):

- Every chat-completion response carries a `usage` object — full usage
  details are **always included** (the old `usage: {include: true}` opt-in is
  deprecated and a no-op).
- Fields consumed here: `cost` (**USD**), `prompt_tokens`,
  `completion_tokens`, `total_tokens`,
  `prompt_tokens_details.cached_tokens`,
  `completion_tokens_details.reasoning_tokens`, `is_byok`;
  `cost_details.upstream_inference_cost` applies to BYOK only.
- **Streaming**: the usage object arrives on the **final SSE chunk**.
- The response id (`gen-…`) can be replayed against
  `GET /api/v1/generation?id=` for authoritative post-hoc stats
  (`total_cost`, native token counts) — the reconciliation path.
- langchain-openai surfaces the usage object verbatim as
  `llm_output["token_usage"]` on each `LLMResult` (provider extras like
  `cost` survive the SDK's `model_dump`).

### ⚠️ Dry-run verification status

This repo's CI/dev environment cannot reach openrouter.ai, so the contract
above is **verified against the official documentation and replayed as test
fixtures**, not against the live API:

- `tests/aiq_agent/common/test_cost_tracking.py` replays a
  documentation-exact usage object end-to-end: extraction → budget math →
  the exact JSON batch POSTed to the ledger endpoint.
- `frontends/ui/src/app/api/internal/usage/route.spec.ts` accepts exactly
  that batch shape into the ledger.
- **Live-Postgres integration tests** (opt-in via `GRID_TEST_DATABASE_URL`,
  auto-skipped in CI): `src/lib/budgets/service.integration.spec.ts` and
  `src/lib/model-config/service.integration.spec.ts` apply migrations
  0012/0013 to a real Postgres 16 and exercise the actual queries — ledger
  insert, windowed per-model aggregation, budget blocking, supersede
  validation, version lifecycle/rollback.
- Known caveat (community-reported): some streaming paths have historically
  omitted `cost`; such rows are recorded with `cost_source='missing'` and
  cost 0 rather than failing — under-counting, never blocking — and carry
  `generation_id` for reconciliation.
- **First deployment must confirm live**: run one chat turn, check a
  `llm_usage_events` row has `cost_source='usage_field'` and a plausible
  `cost_usd`.

## Capture: one handler, zero per-agent code

`src/aiq_agent/common/cost_tracking.py`:

```
track_llm_costs()  ──sets──▶  grid_cost_tracker_var (ContextVar)
                                   │ register_configure_hook(…, inheritable=True)
                                   ▼
              EVERY LangChain callback manager configured in-context
              gets GridCostTracker — all agents, all groups, automatically
```

- **Activation points (the only wiring, 3 total)**:
  - sync chat turn — `chat_researcher/register.py` around `agent.run(...)`
  - async Dask job — `aiq_api/jobs/runner.py` around `_run_agent(...)`
    (identity + budget captured at submit time via `capture_usage_context()`)
  - background memory reflection — `project_memory/reflection.py` (own
    activation; the turn's tracker is already flushed when it fires)
- `on_llm_end` extracts the usage event (model served, requested model from
  invocation params, generation id, tokens, cost); events batch (5) and
  flush to `POST /api/internal/usage` on a single background worker thread —
  the answer path never blocks on the ledger. Final flush on context exit.
- **Never breaks chat**: extraction, activation, and POST failures log and
  degrade to "not metered"; the endpoint being down loses telemetry, not
  answers.

## Storage (grid_app, migration `0013_budgets.sql`)

**`budget_policies`** — append-only limit configuration, supersede idiom:
`(organization_id, scope['organization'|'member'|'project'], subject_id,
daily_limit, monthly_limit numeric EUR, status, supersedes_id, created_by,
note)`. A hand-written partial-unique index enforces one *active* policy per
(org, scope, subject). Changing a limit supersedes the old row — full audit
lineage.

**`llm_usage_events`** — the ledger: org / user / project / conversation /
job attribution, `agent_group` (reserved), `requested_model` vs `model`
(served), `generation_id`, token detail (incl. cached + reasoning),
`cost_usd numeric(14,8)`, `cost_source
('usage_field'|'missing'|'generation_api'|'estimate')`, `is_byok`. Indexed
for `(org, time)`, `(org, user, time)`, `(org, project, time)`,
`(org, model, time)` window aggregation.

## Limits & enforcement

- **Defaults (seeded)**: €10/day, €100/month per org until an admin sets
  explicit limits (`explicit: false` in API responses). `null` limit = that
  window unlimited.
- **Scopes are independent**: a request must pass org AND (if set) member
  AND (if set) project limits; the first exhausted scope blocks.
- **Member/project ≤ org**: validated on write (422), including "cannot be
  unlimited while the org is bounded". Project limits settable by project
  admins (`project:manage`) and org admins; org/member limits org-admin-only.
- **Windows**: UTC — daily = since 00:00 UTC, monthly = since the 1st.
- **Currency**: limits EUR, ledger USD; compared via
  `GRID_BUDGET_EUR_PER_USD` (euros per 1 USD, default 0.86) at read time.

Enforcement points:

1. **WS upgrade** (`/api/auth/websocket-scope`): exhausted budget → upgrade
   refused (403 + reason). Otherwise remaining USD per scope travels as the
   base64url `x-grid-budget` header. Budget *reads* fail open (a broken
   lookup must not take chat down); the *refusal* itself fails closed.
   Totals come from the write-through `llm_usage_rollups` daily aggregate
   (ADR-0019, `getSpendTotals`), maintained transactionally with every
   ledger insert — the upgrade never scans the month's ledger. Per-model /
   per-member breakdowns (admin views) still read the ledger.
2. **In-flight** (`GridCostTracker`): cumulative turn spend ≥ remaining →
   `BudgetExceededError` **before the next LLM call starts**; the sync path
   catches it and returns a friendly "budget exhausted" chat response; an
   async job fails with the same message. A call already in flight always
   finishes → a turn can overshoot by at most one call per parallel branch
   (deliberate soft-limit semantics).
3. Async jobs get the submit-time snapshot — a long deep-research run is
   capped by the budget as it stood when it started.

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/organization/usage` | member (own) / admin (org-wide, `?userId`/`?projectId`) | day+month totals, per-model breakdown, budget status |
| GET | `/api/organization/budgets` | member (org limits + own); admin (+ all active policies) | read limits |
| PUT | `/api/organization/budgets` | org admin; project scope also project admin | set a policy (supersede) |
| POST | `/api/internal/usage` | `x-grid-internal-token` service token | ledger write path (backend tracker) |

## UI (org page → "Usage & budgets")

- **Two budget meters** (today / this month): stacked segments per model as
  share of the limit, 2px surface gaps, muted remaining track; exhausted →
  destructive badge ("new requests are blocked").
- **Color**: the validated 8-slot categorical palette (dataviz reference
  instance), separate light/dark steps under the `.dark` class; slots are
  assigned to model ids **alphabetically** (stable per entity, never by
  rank); models beyond 8 fold into a gray "Other".
- **Hoverable**: every segment and legend entry carries a tooltip (model id,
  window spend, request count); the legend below the meters shows per-model
  monthly spend — identity is never color-alone.
- **Member table**: each active member (WorkOS directory ∪ ledger spenders)
  with today/month spend (`getSpendByMember`, admin-only `perMember` in the
  usage API) and their optional individual cap, edited inline via a popover
  (set / remove). Project limits are managed the same way from a project
  picker. Mobile-first: rows and forms stack under the `sm` breakpoint and
  stats carry their own micro-labels.

## Observability & audit answers

| Question | Where |
|---|---|
| What did model X cost us this month? | `llm_usage_events` by `(org, model, time)` / usage API `perModel` |
| Who spent it? | `user_id`, `project_id`, `conversation_id`, `job_id` per row |
| Was the charge real? | `generation_id` → `GET /api/v1/generation?id=` |
| Who set this limit, and what was it before? | `budget_policies.created_by` + `supersedes_id` chain |
| Why was a chat blocked? | WS 403 reason + backend `BudgetExceededError` log (scope, org, turn cost) |
| Did an override change what ran? | `requested_model` vs `model` per event (ADR-0014) |

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GRID_BUDGET_EUR_PER_USD` | `0.86` | EUR per 1 USD for limit comparison (frontend) |
| `GRID_INTERNAL_API_TOKEN` | dev token | guards `/api/internal/usage` (both services) |
| `OPENROUTER_API_KEY` | — | frontend: catalog listing (model config); backend: LLM calls |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | catalog override for tests/self-hosting |
