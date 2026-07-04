# Overnight Run Backlog — live ranked queue

> Loop state file. Re-triaged every cycle. Tiers: 1=Security, 2=Bugs, 3=Stability, 4=Features, 5=Docs.
> Item ids are stable (`T<tier>-<n>`). Demoted/blocked items keep their id with a note.

## Tier 1 — Security

- ~~**T1-1**~~ DONE cycle 1 — typed `NoOrganizationError` (403, isAuthzError-compatible) + `requireAuthorizedPageSession()` for the 8 page/action sites; zero API-route edits; contract spec added. Residual (accepted): ~17 bare-call API routes return JSON 500 (not 403) for no-org — strictly better than the old 307→HTML; follow-up **T3-6**.
- **T1-2** [FLAG — human] `deploy/.env` contains live API keys on disk (OpenRouter, WorkOS, Tavily…). Cannot rotate unattended. ACTION REQUIRED (human): rotate keys, move to a secret store. Logged, not fixable in-loop.
- **T1-3** [FLAG — human] `GRID_INTERNAL_API_TOKEN` compose default is `grid-internal-dev-token`. Endpoint fails closed when unset, but a well-known default in compose is weak for prod. Human should set a real value in `deploy/.env` for any shared deployment. Consider warning log when the default value is detected.

## Tier 2 — Bugs

- ~~**T2-5**~~ DONE cycle 2 — added `signingS3Client` to the spec's s3 mock; suite 3/3 green; confirmed no other spec mocks `@/lib/s3`.
- ~~**T2-1**~~ CLOSED cycle 3 — already fixed before this run: `.env` no longer uses `${...}` (warning comment present) AND `config_validation.py:_read_api_key_env()` treats `${...}` literals as unset. Cycle output: ported the warning comment to `.env.example` (regression prevention for new deployments).
- **T2-2** `src/aiq_agent/agents/chat_researcher/` — escalation heuristic (`should_escalate`) sniffs English phrases; product domain is German. Escalation likely never fires for German conversations. Scope + fix (language-neutral signal or German patterns).
- **T2-3** `src/aiq_agent/fastapi_extensions/` — dead, broken duplicate front-end (register.py calls route fns with wrong arity). Dead code that can be imported by mistake. Delete after confirming nothing references it.
- **T2-4** `frontends/ui/src/app/api/projects/[id]/generate-summary/route.ts` + backend `generate_summary.py` — silent failure chain: missing LLM key → blanket except → `summary: ""` with zero errors anywhere. Add visible error logging / non-200 so the summary being empty is diagnosable.

## Tier 3 — Stability

- **T3-1** ~14 pre-existing failing frontend spec files (AuthKit providers, proxy, FileUploadZone, websocket-scope/api-v1 route tests) — environment/mock issues, not regressions (noted 2026-07-04). They block a clean `vitest run` signal for every future change. Triage and fix in batches.
- **T3-2** Backend `_generate_cards` returns None on any failure with only a log — UI can't distinguish "no cards" from "generation failed". Add a `cards_generation_failed` signal on the response (additive, monkeypatch lift + schema).
- **T3-3** DRY base-agent refactor: 7 duplication patterns across 4 register.py files → `common/agent_base.py`. Deferred earlier pending runtime confirmation; safe to do with static verification + full test suite, but HIGH blast radius — keep late in the night, require all backend tests green before/after.
- **T3-4** helm-lint CI job is a no-op (always passes). Make it actually lint or remove the false signal.
- **T3-5** `frontends/ui` tsconfig typechecks test files in `next build` — spec type errors block prod builds (known foot-gun). Consider excluding specs from the build tsconfig (separate `tsconfig.typecheck.json` already exists via Dockerfile? verify) — low risk, high annoyance-prevention.
- **T3-6** ~17 bare-call API routes (conversations, documents, projects list/detail, members, user/preferences…) have no try/catch around `requireAuthorizedSession` → no-org case returns JSON 500 instead of 403. Uniformity follow-up from T1-1; consider a shared route wrapper instead of 17 edits.

## Tier 4 — Features (only when tiers 1–3 empty)

- **T4-1** Deep-research cards delivery landed (jobs/runner.py → SSE → ReportTab) but is runtime-unverified. Not more feature work — needs a live run; flag for human smoke test.
- **T4-2** Project memory Phase 2 (consolidation/dedup gate, RAG recall) — designed in docs/architecture/project-memory-design.md; NOT for unattended implementation (needs product eyes on quality).

## Tier 5 — Docs

- **T5-1** `AGENTS.md` — stale: no mention of the typecheck loop, project memory feature, internal API token env, or the two knowledge systems. Update contributor guide.
- **T5-2** `docs/architecture/backend-deep-dive.md` — add the internal-memory-API single-writer change (§ written pre-rework mentions grid_app direct write removal — verify accuracy).

## Blocked / waiting on human

- **RESEARCH-403** — root cause traced to two candidate throw sites; needs one runtime data point (error `code`: FORBIDDEN vs BACKEND_ERROR). T1-1 may fix the latent-redirect variant of it. After T1-1, re-test needed by human.
- **RUNTIME-SMOKE** — all session fixes (WS projectId, cards sync path, MinIO presign, summary preservation, memory) verified statically; need one human-driven pass.
