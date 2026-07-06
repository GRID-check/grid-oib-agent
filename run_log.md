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

## Cycle 9 — MODE CHANGE (user instruction, ~00:5x): parallel streams + deletion pipeline authorized

- User override: "fix the deletion pipeline, high priority" (lifts the don't-touch-WIP guardrail for T2-6) and "work in parallel".
- Launched 3 concurrent streams with disjoint file scopes, no-commit policy (orchestrator integrates + commits per stream):
  - **P1** deletion-pipeline fixes (all 5 audit findings + hold-race test) — purger/*, maintenance.py, internal memory route, deletions route.
  - **P2** frontend failing-spec batch (T3-1) — spec files only.
  - **P3** docs/CI batch (T5-1 AGENTS.md, T5-3 stale mentions, T5-2 deep-dive accuracy, T3-4 helm-lint) — docs + CI only.
- Deferred to avoid collisions: T3-6 (route wrapper) until P2 lands.

## Cycle 10 — T1/CRITICAL · memory-audit C1 — multi-line context headers crash the WS gateway — `server.js` + `project_context.py`

- **Wrong & why (found by P4 memory audit, reproduced against real deps):** `x-grid-project-context` and `x-grid-project-memory` carry MULTI-LINE text; Node rejects `\n` in header values (`ERR_INVALID_CHAR`); `backendProxy.ws()` throws SYNCHRONOUSLY outside any try/catch → uncaught exception → gateway process crash = chat DoS for everyone. Very plausibly the user's observed "WebSocket closed before connection established": once the projectId fix made the handshake carry a project, the multi-line profile header would kill every upgrade.
- **Change:** both headers are now base64url-encoded in server.js (same scheme as the collection-scope header) and decoded in `project_context.py` (`_read_encoded_header`, raw fallback for backward compat); `backendProxy.ws` wrapped in try/catch → 502 instead of process death.
- **Verified:** `node --check server.js` OK; py_compile + ruff clean; encode/decode round-trip proven incl. multi-line + German umlauts.
- **Pipeline:** P4 (Fable audit) found + reproduced; orchestrator implemented immediately (critical path, no free agent owned these files).

## Cycle 11 — PIN-1 · deletion-pipeline fixes (P1 stream) — all 5 audit findings

- **Changes (P1, Fable):** (1) legal-hold TOCTOU closed — hold re-checked INSIDE the purge transaction before any destructive step; `LEGAL_HOLD_ACTIVE` releases the row back to pending with attempt refunded; (2) well-known dev default token rejected outside dev in BOTH `maintenance.py` and the internal memory route (503 + loud log, fails closed on unset env); (3) unknown entity types marked permanently failed on first claim (no 10-retry poison loop; enqueue is project-only by construction); (4) `requestedBy` in the admin deletions list; (5) exponential claim backoff 2m→64m cap via `claimed_at + 2^attempts` in SQL.
- **Verified:** purger suite 5/5 incl. new TOCTOU test (asserts NO backend/MinIO/WorkOS/SQL destruction when a hold appears post-claim); frontend tsc exit 0; maintenance.py py_compile + ruff clean.
- **Next per PIN-1:** adversarial re-audit before the item is called done.

## Cycles 12-15 — parallel stream integration (commits 363ef72, 90eed84, 8d4e175; re-audit P6)

- **P5 UI/UX sweep (363ef72):** BLACK-BORDER ROOT CAUSE = Tailwind v4 sub-imports were UNLAYERED → preflight's currentColor border reset beat the app's @layer base rule (cascade-layer precedence). Fixed by adding layer() assignments to the imports — root fix, no per-class patching. Plus full Nielsen sweep: route loading skeletons, error-states-with-retry replacing silent/lying empty states, focus-visible everywhere, keyboard reach for hover actions, reduced-motion fallback. tsc 0; features/projects+documents+layout suites 640/640.
- **P2 spec batch (90eed84):** frontend suite → 1320 passed / 100 files (was 8 failing across 3 files — all stale expectations after intentional refactors, no source touched). The 2026-07-04 "~14 failing" list had largely self-resolved.
- **P7 memory hardening (8d4e175, PIN-2):** M1/L2 org-defensive queries, M3 digest tag-forgery escaping (pure formatDigestLines extracted+tested), M4 internal-endpoint org validation, L1 constant-time token compare, H1 22 new tests. Deferred as product decisions: M1 anonymous-mode gating, M2 org-admin permission for org-wide writes (BACKLOG for human).
- **P6 deletion re-audit (PIN-1 GATE) → FINDINGS REMAIN, not perfect.** Held up: backoff, releaseHeld, restore/claim race, partial unique index, SQLi, token guard. BROKE IT: **F1 (HIGH)** restore offered after partial-failed purge → hollow restore + orphaned state (restore matches status='pending' but markFailed returns non-terminal failures to 'pending'); **F2** silent partial failures (MinIO .Errors + backend collection_deleted:false ignored) then pointer deleted → unrecoverable orphans; **F3** TOCTOU re-check single-shot + docstrings over-claim a lock that isn't held; F4/F5/F6 lower. → launched **P8** to fix round 2. PIN-1 stays OPEN until a re-audit is clean.
- Full-tree typecheck after all integrations: grid-tsc-main exit 0.

## Cycle 16 — LOOP CLOSED (user instruction) + deletion round-2 fixes

- User: "we can be done with the loop"; after finishing in-flight work → commit, push, PR to dev. Background fix agents (P8 deletion round-2, D1/D2 docs) had died on the 3:20pm-Vienna session limit, so orchestrator implemented the round-2 deletion fixes directly.
- **Deletion round-2 (this cycle):** DEL-F1 MinIO `.Errors` inspected → throw (no more silent orphaned objects / GDPR gap); DEL-F2 restore now requires `claimed_at IS NULL` (409 `PURGE_IN_PROGRESS`) so a partially-purged project can't resurrect gutted; DEL-F3 backend `/purge-project-resources` returns `status` (deleted/not_found/failed) and the purger throws on `failed` (no orphaned Chroma), plus per-step hold re-checks and a corrected docstring (the old "row stays locked" claim was false); DEL-F6 LIKE metacharacters escaped + `ESCAPE '\'` (closes cross-org job-row wipe via `collection_name="%"`); DEL-F7 `isNotFound` = HTTP 404 only (WorkOS "Organization not found" no longer swallowed).
- **Verified:** frontend tsc exit 0; purger tests 5/5; maintenance.py py_compile + ruff clean; backend wiring (plugin.py/routes) py_compile OK; compose YAML valid.
- **Deferred (documented, follow-up PR):** DEL-F4 (unreclaimable 'purging' row after a 10th-attempt crash), DEL-F5/F8 (surface last_error), DEL-F9 (backend constant-time token), DEL-F10 (db.js SQL tests).

## Cycle 17 (RE-ENTRY) — PIN-1/T1 · DEL-F4 + DEL-F10 — stranded-'purging' row reaper + db.js SQL tests — `purger/db.js` + `purger/index.js` + `purger/db.spec.mjs`

- **Context:** loop was closed at cycle 16, then re-entered on a NEW branch `fix/agent-e2e-memory-cards` with fresh uncommitted WIP (chat_researcher intent-classification, auth validators, cards models, project_memory, json_utils). Re-triage treated that WIP as off-limits; the deletion `purger/*` files are committed+clean on this branch, so PIN-1's open items were actionable in disjoint scope. Model routing: Fable agents unavailable → Sonnet explores, Opus decides+implements.
- **Wrong & why (DEL-F4, #1 human-review item from the cycle-16 closing summary):** `claimNext`'s `attempts < MAX_ATTEMPTS` guard is ANDed across BOTH the pending-backoff and the stale-'purging'-reclaim branches. A worker bumps `attempts` to MAX at claim time; a crash during that FINAL purge leaves the row `status='purging', attempts=MAX`, which the stale branch can no longer re-select (`MAX < MAX` false). The admin deletions list filters `['pending','failed']` and restore requires `'pending' AND claimed_at IS NULL`, so the row is stranded forever AND invisible/unrecoverable — orphaned external state (Chroma/MinIO/WorkOS) + GDPR-erasure gap. Sonnet confirmed the exact mechanism against current code (postgres.js, MAX_ATTEMPTS=10, STALE=15min, attempts incremented on claim).
- **Change (Opus decision — safe unattended):** added `reapStranded(sql)` to `db.js` — one UPDATE marking `status='purging' AND attempts >= MAX_ATTEMPTS AND claimed_at < now()-15min` → `'failed'` with `COALESCE(last_error, '…presumed purger crash')` (preserves the real prior error). Wired into `index.js` `tick()` before the drain loop, with its own try/catch + a warn log on non-zero reap. Chose terminalize-to-'failed' over an 11th destructive re-attempt: the row already consumed its attempt budget, and 'failed' is already surfaced to admins — fixes both stranding AND invisibility with no new destructive action. Left claimNext's below-MAX stale reclaim untouched (already correct). Deliberately did NOT add 'purging' to the admin list filter (transient-purge visibility = a product UX call, logged for human).
- **DEL-F10:** new `db.spec.mjs` (9 tests) covering claimNext (backoff/stale/holds/attempt-cap/lock + null path), reapStranded (SQL shape, count, no re-attempt), releaseHeld refund, markPurged, markFailed CASE + 2000-char truncation, markFailedPermanent — matching purge-project.spec.mjs's faked-tagged-template + assert-on-rendered-SQL harness exactly.
- **Verified:** `node --check` on db.js + index.js OK; purger Vitest suite **14/14 passed** (9 new + 5 existing) run in the `grid-tsc` Docker image (host node_modules install is incomplete — no vitest package.json/bin — so local/npx/vpx runners all fail; Docker with `npm ci` is the only working runner here) with the current `purger/` bind-mounted over the 4h-old image copy.
- **Pipeline:** Sonnet — full file:line confirmation of DEL-F4 mechanism + test-harness reconnaissance (ground truth, no fix proposed). Opus (orchestrator) — chose reaper-terminalize approach, implemented db.js/index.js/db.spec.mjs, ran Docker verification.
- **Commit:** `frontends/ui/purger/{db.js,index.js,db.spec.mjs}` only — branch WIP left untouched.

## CLOSING SUMMARY

- **Cycles run:** 16. **Commits:** 11 (through the deletion round-2 + wiring commits this cycle).
- **By tier:** Security/critical — T1-1 (API auth redirect), C1 (WS multi-line header crash, likely the real chat-DoS), deletion tenancy/GDPR hardening (2 rounds), memory hardening (org-defensive, tag-forgery, org-validation, constant-time). Bugs — T2-2 escalation marker, T2-4 summary diagnosability, T2-1/T2-3 closed-as-already-fixed. Stability — T3-7 backend suite 944 green (incl. a real UTF-8 prompt-loading bug), P2 frontend suite 1320 green. Docs/CI — P3 accuracy sweep + removed false-green helm-lint. UI — P5 full Nielsen sweep + black-border root fix.
- **#1 thing for a human to look at first:** the deletion pipeline's remaining DEL-F4 (a crashed 10th purge attempt strands a row in 'purging', invisible to admins) + add DEL-F10 db.js tests before trusting the pipeline in production.
- **Security items FLAGGED not fixed (need human):** T1-2 rotate live secrets in deploy/.env; T1-3 set a real GRID_INTERNAL_API_TOKEN (dev default now refused outside dev, but still must be set); M2 org-admin permission for org-wide memory writes.
- **Needs one live runtime pass (RUNTIME-SMOKE):** WS project-knowledge + shallow cards + PDF preview/download + research-tab 403 code + escalation-marker compliance + deletion end-to-end.
