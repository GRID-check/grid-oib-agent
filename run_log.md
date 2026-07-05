# Overnight Run Log — append-only, one entry per cycle

Run started: 2026-07-05 ~00:30 local. Branch: `feature/applicable-oib-standards`.
Verification harness: frontend `docker build -f Dockerfile.typecheck` + `docker run grid-tsc` (tsc) and `npx vitest run` in the same image; backend `.venv` `py_compile` + `ruff`. No live-stack testing (stack is user-managed).

## Cycle 0 — INIT / checkpoint

- Created `backlog.md` (seeded from this session's deep diagnosis + known-issues docs) and this log.
- Baseline checkpoint commit of the entire working tree (session fixes + user's in-flight design work) so every subsequent cycle commit is small, clean, and independently revertible. NOTE for human: this checkpoint includes your uncommitted design-polish edits — nothing was lost; it's all in git history on this branch.
- Flagged (not fixable unattended): **T1-2** live secrets in `deploy/.env` (rotate!), **T1-3** default internal API token in compose.

## Cycle 1 — T1 · T1-1 — auth guard redirect() inside API routes — `frontends/ui/src/lib/auth/require-auth.ts`

- **Wrong & why it mattered:** `requireAuthorizedSession()` used Next's `redirect()` for no-org sessions. In ~24 API route handlers that throw either escaped as a 307→onboarding HTML (bare routes; JSON clients fail opaquely) or was swallowed into generic 500s / `PROXY_ERROR` (catch-wrapped routes, incl. the deep-research jobs proxy — plausibly part of the user-reported research-tab failure). Auth guard misbehaving in API context.
- **Change:** typed `NoOrganizationError` (`code NO_ORGANIZATION`, `status 403`, message crafted so the existing `isAuthzError` classifier matches it — zero API-route edits) + new `requireAuthorizedPageSession()` carrying the redirect; 8 page/action call sites switched. New contract spec `require-auth.spec.ts` (4 tests) pins the message↔classifier coupling. Grep-verified no `app/app/**` file still uses the API variant.
- **Verified:** typecheck exit 0; vitest: require-auth 4/4, overview 1/1, folders 4/4 green. 1 pre-existing failure in documents/preview spec (mock missing `signingS3Client` — caused by the earlier presign fix, NOT this change) → logged as **T2-5**, next cycle.
- **Pipeline:** Sonnet: 37-call-site inventory + per-catch-shape failure semantics + no-test-coverage confirmation. Fable: chose invert-responsibility option (c) over per-route edits; set 403-not-401 semantics; accepted bare-route-500 residual as follow-up (T3-6). Opus: implemented + verified exactly to plan.
- **Human review:** none needed beyond normal PR review. Residual T3-6 noted.

## Cycle 2 — T2 · T2-5 — preview spec mock gap — `frontends/ui/src/app/api/documents/[id]/preview/route.spec.ts`

- **Wrong & why:** the earlier MinIO presign fix introduced `signingS3Client`; this spec's `vi.mock('@/lib/s3')` didn't export it → route 500s under test → 1 red test polluting every future suite run's signal.
- **Change:** added `signingS3Client: {}` to the mock (2 lines). Grep confirmed no other spec mocks `@/lib/s3`.
- **Verified:** preview suite 3/3 green (vitest in the Docker harness via bind-mount).
- **Pipeline (compressed, logged deliberately):** Sonnet stage = cycle 1's Opus diagnosis (exact root cause already in hand); Fable stage = trivial/no-alternatives; orchestrator implemented directly. Full pipeline on a 2-line mock fix would have been process theater.

## Cycle 3 — T2 · T2-1 — compose env_file interpolation hazard — CLOSED (already fixed upstream)

- **Finding (Sonnet):** the 2026-07-03 bug (`AIQ_VLM_API_KEY=${OPENROUTER_API_KEY}` literal via env_file) no longer exists: `deploy/.env` value corrected + explicit warning comment added, AND `src/aiq_agent/common/config_validation.py:_read_api_key_env()` now defensively treats `${...}` literals as unset. Verified without echoing any secret values.
- **Decision:** dead end / already resolved — per loop rules, logged as such rather than forcing a change. One residual closed to keep the cycle durable: the warning comment existed only in the private `.env`, not in `.env.example` that new deployments copy — ported it (comment-only change).
- **Verified:** comment-only diff in `.env.example`; nothing executable changed.
- **Pipeline:** Sonnet full exploration (env names only, no values); Fable stage unnecessary (no decision space); orchestrator applied the doc comment.

## Cycle 4 — T2 · T2-2 — escalation never fires on weak-but-successful shallow answers — `chat_researcher/agent.py` + `shallow_researcher/prompts/researcher.j2`

- **Wrong & why:** structured `shallow_result.escalate_to_deep` was never populated on the success path (hardcoded None) — the only real escalation signal was regex-guessing 10 EN/DE phrases against free prose. Plausible German phrasings mostly miss → users with hard questions silently get weak shallow answers instead of deep research.
- **Change (Fable decision: fail-open marker over full structured-output rewrite):** prompt now mandates a literal `[ESCALATE_TO_DEEP]` marker (language-independent by construction) when the model judges its answer insufficient; `shallow_research_node` detects + strips it (user never sees it) and populates the existing structured path; keyword tail-match extracted to `matches_escalation_keywords()` and kept as fallback. If the LLM never emits the marker, behavior is byte-identical to before.
- **Verified:** py_compile + ruff clean; `tests/.../chat_researcher/` 143 passed incl. 11 new tests; full backend suite 939 passed / 5 failed — failures PROVEN pre-existing via stash-rerun (logged as T3-7).
- **Pipeline:** Sonnet found the disconnected-structured-path root cause; Fable chose (b) fail-open marker, placed detection in the node (router can't mutate state), set single-commit coupling of prompt+code; Opus implemented + proved pre-existing failures.
- **Human review:** observe one live escalation (marker compliance) — folded into RUNTIME-SMOKE.

## Cycle 5 — T2 · T2-3 — dead fastapi_extensions package — CLOSED (already deleted upstream)

- **Finding (Sonnet):** package was deleted 2026-07-03 in commit `2570b1b` (wrong-arity registration confirmed as the reason; `/v1/ingest` ported to aiq_api; entry point removed; tests relocated). Zero code/build/test references remain — only ~11 historical doc mentions.
- **Cycle output:** corrected the now-false claim in `docs/architecture/backend-deep-dive.md` (it still described the package as present). Doc-sweep residual logged as **T5-3**.
- **Pipeline:** Sonnet verification sweep; no decision space; orchestrator applied the doc fix.

## Cycle 6 — T2 · T2-4 — silent summary-generation failure chain — `generate_summary.py` + BFF route + wizard

- **Wrong & why:** every failure mode (no LLM key, network, upstream 4xx/5xx, malformed response) returned HTTP 200 `{summary:""}`; BFF's 502 path was dead code; wizard swallowed with zero logging. Empty summaries were undiagnosable ("failed" vs "never ran" indistinguishable).
- **Change:** additive `error` field on `GenerateSummaryResponse` (`llm_not_configured` — short-circuits before sending an unauthenticated request — / `llm_request_failed` / `llm_response_malformed`); ordered exception handling replaces the blanket except; BFF logs + forwards the code and persists only non-empty summaries (an error can no longer clobber a good summary); wizard warns on rejection/!ok/error. Best-effort contract preserved everywhere (still 200, flow unchanged).
- **Verified:** py_compile + ruff clean; `test_generate_summary.py` 6/6 (2 swallow tests updated to assert codes; new no-key test asserts no outbound HTTP; success asserts error is None); frontend typecheck exit 0. Deviation (justified): test mocking switched from patching `AsyncClient.post` (which also intercepted the ASGI test client in httpx 0.28 — the ORIGINAL tests were failing in this env, proven) to patching the class.
- **Pipeline:** Sonnet re-verified the full chain + proposed options with tradeoffs; Fable stage performed by orchestrator (adopted Sonnet's Option A, pinned error-code contract + test plan); Opus implemented.

## Cycle 7 — T3 · T3-7 — 5 pre-existing backend test failures — suite restored to green

- **Wrong & why:** 5 failures polluted every full-suite run's signal, hiding future regressions. Also during re-triage: new unaudited deletion pipeline landed concurrently (purger, deletion-queue/legal-holds, migration 0009) → new item **T2-6** (tenancy audit of destructive paths).
- **Change:** (1) IMPL: `prompt_utils.load_prompt` now reads with `encoding="utf-8"` — real production bug for UTF-8 prompt templates (German umlauts!) on non-UTF-8 locales. (2) TEST: checkpointer tests now close cached aiosqlite connections before unlink (WinError 32). (3) TEST: stale arg-index after `project_context` was appended to Dask job args (`6957324`) — assertion realigned, forwarding still asserted.
- **Verified:** `pytest tests/aiq_agent -q` → **944 passed, 0 failed** (from 5/939); ruff + py_compile clean on all touched files.
- **Pipeline (single-stage, logged):** delegated diagnose+fix to one Fable agent — test-hygiene batch where per-item Sonnet/Fable/Opus split adds no value; rules enforced (no weakened assertions; impl fixed where the product was wrong).

## Cycle 8 — T2 · T2-6 — deletion-pipeline audit — FLAG-NOT-FIX (human's uncommitted WIP)

- **What & why:** re-triage caught a freshly-landed deletion pipeline (purger service, deletion-queue/legal-holds, migration 0009). Destructive + tenancy-sensitive + unreviewed → audited before it can bite.
- **Finding (Sonnet audit, file:line evidence):** verdict **needs-fixes / not dangerous**. Strong fundamentals (org scoping from trusted rows, SQL grace period, precise MinIO prefixes, idempotent steps, manage-gated enqueue, tests exist). 5 issues, top three: legal-hold TOCTOU race (hold not re-checked at purge-execution time), well-known default internal token accepted by `maintenance.py`, unimplemented entity types poison the queue.
- **Decision (guardrail):** the pipeline is another session's UNCOMMITTED work-in-progress — modifying or committing someone's in-flight WIP unattended risks clobbering active work. Findings logged verbatim in backlog (T2-6) for the author; no code changed. This is an explicit flag-not-fix cycle.
- **Pipeline:** Sonnet full audit; Fable judgment = orchestrator applying the don't-touch-WIP guardrail.
