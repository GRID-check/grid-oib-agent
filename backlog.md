# Overnight Run Backlog — live ranked queue

> Loop state file. Re-triaged every cycle. Tiers: 1=Security, 2=Bugs, 3=Stability, 4=Features, 5=Docs.
> Item ids are stable (`T<tier>-<n>`). Demoted/blocked items keep their id with a note.

## Tier 1 — Security

- ~~**T1-1**~~ DONE cycle 1 — typed `NoOrganizationError` (403, isAuthzError-compatible) + `requireAuthorizedPageSession()` for the 8 page/action sites; zero API-route edits; contract spec added. Residual (accepted): ~17 bare-call API routes return JSON 500 (not 403) for no-org — strictly better than the old 307→HTML; follow-up **T3-6**.
- **T1-2** [FLAG — human] `deploy/.env` contains live API keys on disk (OpenRouter, WorkOS, Tavily…). Cannot rotate unattended. ACTION REQUIRED (human): rotate keys, move to a secret store. Logged, not fixable in-loop.
- **T1-3** [FLAG — human] `GRID_INTERNAL_API_TOKEN` compose default is `grid-internal-dev-token`. Endpoint fails closed when unset, but a well-known default in compose is weak for prod. Human should set a real value in `deploy/.env` for any shared deployment. Consider warning log when the default value is detected.

## USER-PINNED PRIORITIES (2026-07-05 ~01:00 — override tier order where stated)

- **PIN-1 Deletion pipeline must be PERFECT.** Round-1 fixes DONE (commit 3727a69). Adversarial re-audit ran (P6) → NOT perfect; round-2 fix agent (P8) DIED on session limit before implementing. **REMAINING FINDINGS (round 2, do next — these are real data-safety/GDPR-erasure bugs):**
  - **DEL-F1 (HIGH) MinIO silent partial delete.** `frontends/ui/purger/minio.js:36-44` — `DeleteObjectsCommand` (Quiet:true) returns 200 even when individual keys fail; `.Errors` never inspected → orphaned objects + pointer deleted = unrecoverable + GDPR compliance failure. FIX: throw if `response.Errors?.length > 0`.
  - **DEL-F2 (HIGH) restore-after-partial-purge → hollow restore.** `frontends/ui/src/app/api/projects/[id]/restore/route.ts:30` matches `status='pending'` only, but `markFailed` returns non-terminal failures to 'pending'. Admin restores a project whose Chroma/MinIO were already destroyed → gutted resurrection, purge never resumes. FIX: restore requires `status='pending' AND claimed_at IS NULL` (or attempts=0); 409 `PURGE_IN_PROGRESS` otherwise; recently-deleted.tsx shows purge-state not Restore for attempted rows.
  - **DEL-F3 (MEDIUM) backend collection_deleted:false ignored.** `purge-project.js:55` only checks res.ok; `maintenance.py:126-130` returns 200 with `collection_deleted:false` on real failure → orphaned Chroma collection. FIX: maintenance.py returns an unambiguous status (deleted/not_found/failed); caller throws on failed.
  - **DEL-F4 (MEDIUM) unreclaimable 'purging' row on 10th-attempt crash.** `db.js:34-36` stale-reclaim ANDs `attempts < MAX_ATTEMPTS`; a crash after the 10th claim strands the row in 'purging' forever, and `deletions/route.ts:36` filters `['pending','failed']` so it's invisible to admins. FIX: reclaim/surface terminal 'purging' rows.
  - **DEL-F5 (MEDIUM) TOCTOU single-shot + FALSE docstring.** `purge-project.js:2-6` claims the queue row "stays locked" across the purge — false (Phase-A claim tx commits, releasing FOR UPDATE; Phase B is a new tx; only 'purging' status guards). Hold re-checked once before first external step; residual window = full duration of external calls, undocumented. FIX: rewrite docstring to the real guarantee; re-check hold before EACH external step (backend/MinIO/WorkOS); document residual window.
  - **DEL-F6 (LOW-MED) unescaped LIKE wildcards in backend job purge.** `maintenance.py:67-71` `pattern=f"%{collection_name}%"` — token holder can send `collection_name="%"` to wipe ALL orgs' job_events/job_access/job_info. FIX: escape `%_\` or validate `^proj_[0-9a-f-]+$`.
  - **DEL-F7 (LOW) isNotFound regex too broad.** `purge-project.js:13-15` `/not found/i` treats "Organization not found"/"upstream host not found" as successful WorkOS delete → FGA resource leak. FIX: match only `status===404`.
  - **DEL-F8 (LOW) last_error stored but never surfaced** (deletions/route.ts omits it; recently-deleted.tsx shows generic copy). **DEL-F9 (LOW) backend token compare `!=` not constant-time** (maintenance.py:47). **DEL-F10 (LOW) db.js SQL entirely untested** (claimNext backoff/NOT EXISTS, stale-reclaim, releaseHeld refund, markFailed CASE) — F4's bug is exactly what this gap hides.
  - Attacks that HELD (do NOT re-fix): releaseHeld loop, backoff collapse/overflow, restore-vs-claim race, partial unique index, SQLi, token-guard env matrix, retry idempotency. Round-1 fixes are sound.
  - **ROUND-2 STATUS (done directly by orchestrator after P8 died on session limit):** DEL-F1 (MinIO .Errors → throw), DEL-F2 (restore requires claimed_at IS NULL + 409 PURGE_IN_PROGRESS), DEL-F3 (backend returns status deleted/not_found/failed; purger throws on failed) + per-step hold re-check + corrected false docstring, DEL-F6 (LIKE wildcards escaped + ESCAPE clause — closes cross-org job wipe via "%"), DEL-F7 (isNotFound = status===404 only). Verified: tsc 0, purger 5/5, py_compile+ruff clean.
  - **STILL OPEN (lower severity, for follow-up PR):** DEL-F4 (unreclaimable 'purging' row on 10th-attempt crash + invisible to admin), DEL-F5/F8 (surface last_error in deletions list + UI), DEL-F9 (backend token compare constant-time), DEL-F10 (db.js SQL untested — add db.spec.mjs for claimNext backoff/NOT-EXISTS, releaseHeld refund, markFailed CASE).
  - PIN-1: HIGH/MED findings fixed; a final clean re-audit + DEL-F4/F10 remain before "perfect".
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

## Docs overhaul (PIN-3) — remaining after this session

DONE: enterprise system-overview (SSOT, `docs/architecture/system-overview.md`); ADRs 0008-0013 + flipped 0002-0007 to Accepted; purge 79→44 (35 removed, 4 relocated); new docs cards.md, llm-providers.md, contributing/testing-and-verification.md; AGENTS.md doc-obligation rule; README rewrite.
REMAINING (per triage plan):
- **De-stale ~25 reference docs** — kill the two systemic lies: (a) dead SSE-chat framing (chat is WS-only) across technical-reference/{chat-flow,architecture-overview,authentication-flow,bff-proxy-pattern,collection-scoping}, api/{bff-routes,python-endpoints,websocket-protocol}, user-guides/chat; (b) Kimi-as-default across deployment/{docker-compose,environment-variables,security-config,startup-flow} — make config_oib_openrouter the default, add missing env vars (MINIO_PUBLIC_ENDPOINT, GRID_INTERNAL_API_TOKEN, FRONTEND_INTERNAL_URL).
- **DB truth:** database/schema.md → 9 tables (add project_memory, deletion_queue, legal_holds, project_folders); database/migrations.md → through 0009.
- **Add x-grid-project-memory** to header tables (websocket-gateway, collection-scoping, api/websocket-protocol).
- **4 new docs:** api/internal-memory-api.md, user-guides/memory.md, deployment/runbook.md (purger/legal-holds/backups), and polish architecture/deletion-pipeline.md (relocated raw).
- **Reconcile auth-state contradiction** (architecture/multitenancy-and-auth-spec.md REQUIRE_AUTH=false vs technical-reference auth docs) — needs a code check.
- **Rewrite docs/README.md** as a single-tree index (was three overlapping trees).
- **project-memory-design.md** header still says "Status: DESIGN (not built)" — flip to shipped.

## Backend rough edges (from 2026-07-05 backend inventory — new)
- Duplicate card-gen logic: `cards/generate.py` vs inline `ChatResearcherAgent._generate_cards` — consolidate.
- `websocket_reconnect.py` `_running_workflow_task` always None (blocked on NeMo-Agent-Toolkit#1744) → cancel/set no-ops.
- `otel_header_redaction_exporter.py` raises at import if OTel extra missing (only partially guarded).
- Unused back-compat aliases in runner.py/submit.py; duplicate get_all_sources import in routes/jobs.py.

## Tier 5 — Docs

- **T5-1** `AGENTS.md` — stale: no mention of the typecheck loop, project memory feature, internal API token env, or the two knowledge systems. Update contributor guide.
- **T5-2** `docs/architecture/backend-deep-dive.md` — add the internal-memory-API single-writer change (§ written pre-rework mentions grid_app direct write removal — verify accuracy).
- **T5-3** ~11 historical docs under docs/ still mention `fastapi_extensions` (deleted). Informational-only; sweep in one doc-cleanup cycle (update architecture/ingestion docs to the aiq_api-only path).

## Blocked / waiting on human

- **RESEARCH-403** — root cause traced to two candidate throw sites; needs one runtime data point (error `code`: FORBIDDEN vs BACKEND_ERROR). T1-1 may fix the latent-redirect variant of it. After T1-1, re-test needed by human.
- **RUNTIME-SMOKE** — all session fixes (WS projectId, cards sync path, MinIO presign, summary preservation, memory) verified statically; need one human-driven pass.
