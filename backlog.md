# Overnight Run Backlog — live ranked queue

> Loop state file. Re-triaged every cycle. Tiers: 1=Security, 2=Bugs, 3=Stability, 4=Features, 5=Docs.
> Item ids are stable (`T<tier>-<n>`). Demoted/blocked items keep their id with a note.

## Tier 1 — Security

- ~~**T1-1**~~ DONE cycle 1 — typed `NoOrganizationError` (403, isAuthzError-compatible) + `requireAuthorizedPageSession()` for the 8 page/action sites; zero API-route edits; contract spec added. Residual (accepted): ~17 bare-call API routes return JSON 500 (not 403) for no-org — strictly better than the old 307→HTML; follow-up **T3-6**.
- **T1-2** [FLAG — human] `deploy/.env` contains live API keys on disk (OpenRouter, WorkOS, Tavily…). Cannot rotate unattended. ACTION REQUIRED (human): rotate keys, move to a secret store. Logged, not fixable in-loop.
- **T1-3** [FLAG — human] `GRID_INTERNAL_API_TOKEN` compose default is `grid-internal-dev-token`. Endpoint fails closed when unset, but a well-known default in compose is weak for prod. Human should set a real value in `deploy/.env` for any shared deployment. Consider warning log when the default value is detected.

## USER-PINNED PRIORITIES (2026-07-05 ~01:00 — override tier order where stated)

- **PIN-1 Deletion pipeline must be PERFECT.** P1 (in flight) fixes the 5 audit findings. AFTER P1 lands: mandatory adversarial re-audit pass (fresh eyes, try to break the fixed pipeline: hold-race, tenancy, idempotency, partial failures, backoff) + all purger tests green. Do not call this done until the re-audit finds nothing.
- **PIN-2 Memory-system audit.** Full audit of Project/Org Memory (schema, internal endpoint token handling, tenancy on every query, digest injection bounds, remember-tool input handling, panel authz). Same rigor as the deletion audit. Schedule immediately after P1 integration.
- **PIN-3 High-quality docs for the ENTIRE app.** Beyond P3's refresh: a coherent docs set (architecture, subsystems, ops/runbook, API surfaces, onboarding). Multi-stream docs effort once P3 lands (avoid file collisions). Quality bar: a new engineer can onboard from docs alone.

## Tier 2 — Bugs

- **T2-6** [AUDITED cycle 8 — FLAGGED for human, code is YOUR UNCOMMITTED WIP so not touched] Deletion pipeline audit verdict: **needs-fixes, not dangerous**. Solid: tenancy (org from trusted DB row), SQL-enforced UTC grace period (GDPR-capped), precise MinIO prefix scoping, idempotent ordered steps, `project:manage` gate, real tests. FIX BEFORE SHIPPING: (1) legal-hold TOCTOU — hold checked only at claim time (`purger/db.js:19-38`), not re-checked inside `purgeProject` before destruction; (2) `GRID_INTERNAL_API_TOKEN` well-known default + `maintenance.py` accepts it (reject the known default outside dev); (3) non-`project` entity types poison the queue (10 futile retries, no alert); (4) deletions list omits `requestedBy` (audit-trail gap); (5) no retry backoff (outage burns all 10 attempts).

- ~~**T2-5**~~ DONE cycle 2 — added `signingS3Client` to the spec's s3 mock; suite 3/3 green; confirmed no other spec mocks `@/lib/s3`.
- ~~**T2-1**~~ CLOSED cycle 3 — already fixed before this run: `.env` no longer uses `${...}` (warning comment present) AND `config_validation.py:_read_api_key_env()` treats `${...}` literals as unset. Cycle output: ported the warning comment to `.env.example` (regression prevention for new deployments).
- ~~**T2-2**~~ DONE cycle 4 — root cause was deeper than "English-only": the structured `shallow_result.escalate_to_deep` was NEVER populated on success (always None), so escalation hinged on 10 guessed prose phrases. Fix: prompt-mandated language-independent `[ESCALATE_TO_DEEP]` marker (fail-open: absent marker = today's behavior), detected+stripped in `shallow_research_node`, populating the existing structured path; keyword tail-match extracted to a tested helper and kept as fallback. 11 new unit tests. NOTE: marker emission needs one live-run observation (LLM compliance) — added to RUNTIME-SMOKE.
- ~~**T2-3**~~ CLOSED cycle 5 — already deleted 2026-07-03 (commit `2570b1b`, `/v1/ingest` ported to aiq_api, entry point removed, tests relocated). Cycle output: corrected the stale claim in `docs/architecture/backend-deep-dive.md`. Residual: ~11 historical docs still mention the old package (informational only) → **T5-3**.
- ~~**T2-4**~~ DONE cycle 6 — summary generation stays best-effort (always 200) but is now diagnosable end-to-end: backend returns machine-readable `error` codes (`llm_not_configured` short-circuits before the doomed request / `llm_request_failed` / `llm_response_malformed`), BFF logs + forwards the code and can no longer clobber an existing summary on failure, wizard console.warns (flow unchanged). Backend tests 6/6 incl. new no-key test.

## Tier 3 — Stability

- **T3-1** ~14 pre-existing failing frontend spec files (AuthKit providers, proxy, FileUploadZone, websocket-scope/api-v1 route tests) — environment/mock issues, not regressions (noted 2026-07-04). They block a clean `vitest run` signal for every future change. Triage and fix in batches.
- **T3-2** Backend `_generate_cards` returns None on any failure with only a log — UI can't distinguish "no cards" from "generation failed". Add a `cards_generation_failed` signal on the response (additive, monkeypatch lift + schema).
- **T3-3** DRY base-agent refactor: 7 duplication patterns across 4 register.py files → `common/agent_base.py`. Deferred earlier pending runtime confirmation; safe to do with static verification + full test suite, but HIGH blast radius — keep late in the night, require all backend tests green before/after.
- **T3-4** helm-lint CI job is a no-op (always passes). Make it actually lint or remove the false signal.
- **T3-5** `frontends/ui` tsconfig typechecks test files in `next build` — spec type errors block prod builds (known foot-gun). Consider excluding specs from the build tsconfig (separate `tsconfig.typecheck.json` already exists via Dockerfile? verify) — low risk, high annoyance-prevention.
- ~~**T3-7**~~ DONE cycle 7 — backend suite 944/944 green. 1 impl fix (`prompt_utils.load_prompt` missing `encoding="utf-8"` — real bug: UTF-8 prompts mangle on cp1252 Windows locales), 2 test-cleanup fixes (Windows file-lock on cached sqlite checkpointer connections), 1 stale test (arg-order shift after project_context wiring in jobs/submit.py, `6957324`).
- **T3-6** ~17 bare-call API routes (conversations, documents, projects list/detail, members, user/preferences…) have no try/catch around `requireAuthorizedSession` → no-org case returns JSON 500 instead of 403. Uniformity follow-up from T1-1; consider a shared route wrapper instead of 17 edits.

## Tier 4 — Features (only when tiers 1–3 empty)

- **T4-1** Deep-research cards delivery landed (jobs/runner.py → SSE → ReportTab) but is runtime-unverified. Not more feature work — needs a live run; flag for human smoke test.
- **T4-2** Project memory Phase 2 (consolidation/dedup gate, RAG recall) — designed in docs/architecture/project-memory-design.md; NOT for unattended implementation (needs product eyes on quality).

## Tier 5 — Docs

- **T5-1** `AGENTS.md` — stale: no mention of the typecheck loop, project memory feature, internal API token env, or the two knowledge systems. Update contributor guide.
- **T5-2** `docs/architecture/backend-deep-dive.md` — add the internal-memory-API single-writer change (§ written pre-rework mentions grid_app direct write removal — verify accuracy).
- **T5-3** ~11 historical docs under docs/ still mention `fastapi_extensions` (deleted). Informational-only; sweep in one doc-cleanup cycle (update architecture/ingestion docs to the aiq_api-only path).

## Blocked / waiting on human

- **RESEARCH-403** — root cause traced to two candidate throw sites; needs one runtime data point (error `code`: FORBIDDEN vs BACKEND_ERROR). T1-1 may fix the latent-redirect variant of it. After T1-1, re-test needed by human.
- **RUNTIME-SMOKE** — all session fixes (WS projectId, cards sync path, MinIO presign, summary preservation, memory) verified statically; need one human-driven pass.
