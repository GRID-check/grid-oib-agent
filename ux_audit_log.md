# UX System Audit — Run Log (append-only, one entry per round)

Run started: 2026-07-10. Branch: `claude/ux-system-audit-taqedy`.

**Mandate (user):** holistic UX audit — not just visual design; every user path,
value-driven. Add new value where found, improve existing patterns, iterate in
rounds until no further improvements are found. Log every round.

**Method:** Round 0 maps every user-facing surface (UI journeys, chat, project
lifecycle, auth/org/admin, CLI/debug/docs/operator path) via parallel deep-read
audits. Findings are merged, deduped, and ranked by user value. Each subsequent
round takes the top-ranked slice, implements, verifies, and logs. The round
loop terminates when the remaining findings are below the value bar (cosmetic,
speculative, or requiring product decisions flagged for humans).

**Verification harness (this environment):** Docker registry egress is
policy-blocked, so the repo's `grid-tsc` Docker loop is unavailable. Native
substitutes, validated this run: `npm ci` + `npx tsc --noEmit` + `npx vitest run`
in `frontends/ui`; backend `uv sync --extra dev` + `.venv/bin/python -m pytest`
+ `ruff check` / `ruff format --check`. No live-stack testing.

**Baselines (pre-change):**
- Frontend `tsc --noEmit`: exit 0.
- Frontend `vitest run`: 1531 passed / 3 skipped, 0 failed.
- Backend `pytest tests/`: 1187 passed / 3 skipped, 3 failed — 2× helm-render
  tests (no `helm` binary in this env: environment noise, not code), 1×
  `test_layered_retrieval.py::TestResolveTargetCollections::test_dedup_preserves_order`
  (pre-existing real failure: session collection `s_oib_knowledge` appears in the
  resolved list but the test doesn't expect it — triage in a round).
- Note: repo venv must be ≥3.12 (`typing.override` in `aiq_api/plugin.py:41`)
  even though `pyproject.toml` says `>=3.11` — logged as a finding.

---

## Round 0 — system map + merged, ranked findings

Five parallel deep-read audits covered: (1) UI pages/journeys, (2) chat end-to-end,
(3) project lifecycle, (4) auth/org/admin, (5) non-UI surfaces (CLI, debug console,
skills, operator path, REST docs, user guides). Full per-surface reports are in the
session transcripts; below is the merged backlog that drives the rounds. IDs are
stable (`UX-n`). Verdict on the system overall: the first-run funnel
(landing → onboarding → create → intake → overview) and the files/memory/intake
surfaces are genuinely strong; the gaps concentrate in (a) chat's incomplete
migration into the project-centric IA, (b) terminal failure handling everywhere
(swallowed errors → dead spinners/"Ready" lies), (c) localization leaks exactly at
failure moments, and (d) satellite surfaces (CLI/skills/deploy docs) drifted from
the maintained path.

### Ranked backlog

**Tier A — broken core affordances (user clicks X, X does not happen):**
- **UX-1 (HIGH)** Document "Download" navigates to a JSON blob, not the file — `file-preview-pane.tsx:117` is a bare `<a>` but `documents/[id]/download/route.ts` returns `{downloadUrl}` JSON.
- **UX-2 (HIGH)** "Ask Grid" deep link (`?ask=`) silently discards the question (`chat/page.tsx:24-32` voids it); chat welcome "suggestion chips" are non-clickable decoration with pre-project-era copy (`ChatArea.tsx:436-503`).
- **UX-3 (HIGH)** Ingest dispatch failure leaves a document in status `uploaded`, which both status maps render as green "Ready" — the UI affirmatively lies that an unsearchable PDF is searchable (`documents/service.ts:171-189`, `reconcile-status.ts:20`, `document-status.tsx:41,55`).
- **UX-4 (CRITICAL)** Backend exception mid-turn emits no error/complete WS frame (`websocket_reconnect.py:552-556`) while streaming locks the composer, session list, and New Session — permanent spinner, page-refresh-only escape, no overall turn timeout (`use-websocket-chat.ts:127-135,763`).
- **UX-5 (MED)** Delete-success toast promises "restore from Recently deleted" to every project-admin, but that panel is org-compliance-gated; grace period/purge date never shown (`en/projects.ts:77`, `api/deletions/route.ts:13`, `project-danger-zone.tsx:24-33`).
- **UX-6 (HIGH)** Documented quick-start step 3 (`exec aiq-agent python scripts/ingest_oib.py`) fails — `scripts/` is never copied into the image; auto-sync-on-boot and `/v1/admin/oib/sync` are documented nowhere (README:119, `deploy/Dockerfile:53-64`, `entrypoint.py:238`).
- **UX-7 (HIGH)** Bare `aiq-research` CLI fails silently with exit 0 — default config path doesn't exist and `finally: os._exit(0)` forces success on every failure (`cli.py:294,457-458`).

**Tier B — trust breakers on the product's stated promise:**
- **UX-8 (HIGH)** Chat sessions are org-wide, not project-scoped — sessions panel shows other projects' conversations; continuing one runs it under the wrong project corpus; "Delete ALL" wipes across projects (`api/conversations/route.ts:19`, `MainLayout.tsx:124-127`).
- **UX-9 (HIGH)** Citations invisible where the user reads: Report tab renders no sources UI; inline `[N]` markers not linkified; zero-valid-citation reports ship silently stripped (`ReportTab.tsx`, `deep_researcher/agent.py:258-264`, `citation_verification.py:910-914`).
- **UX-10 (HIGH)** Mid-stream WS drop discards the completed answer as "stale" with no error card (`use-websocket-chat.ts:600-607,1018-1027`; backend drops frames for disconnected convos `websocket_reconnect.py:461-474`).
- **UX-11 (MED)** Deep-research stall detection is dead code (`isTimedOut`/`reconnect` computed, never consumed — `MainLayout.tsx:80`); SSE retry exhaustion disables Stop for a job still spending budget (`use-deep-research.ts:523-564`).
- **UX-12 (MED)** Composer permanently locked after ANY terminal deep-research status incl. failure — user can't retry or follow up (`InputArea.tsx:106-126,215`); failure banner's "View Thinking" CTA renders for success only (`DeepResearchBanner.tsx:93-100 vs 169-179`).
- **UX-13 (MED)** Embedding key requirement (`NVIDIA_API_KEY` default) undocumented; empty knowledge base is silent — stack healthy, answers uncited (`adapter.py:583-591`, `config_validation.py:24-31`, `entrypoint.py:152`).

**Tier C — role/permission-aware UI honesty:**
- **UX-14 (MED)** Danger zone rendered for viewers who'll 403 (`project-overview.tsx:208`); Members nav hidden from exactly the users the read-only members page was built for (`app-sidebar.tsx:62-66` vs `members/page.tsx:19-23`).
- **UX-15 (MED)** Budget-capped members pointed at an admin-only page; member self-usage view is dead code (`websocket-scope/route.ts:87`, `organization/page.tsx:213-227`); WS 403 collapses to generic "connection failed" (`server.js:353-359`).
- **UX-16 (MED)** Granular org roles (e.g. budgets-only) can't discover the org page they're entitled to — nav flag is `isOrgAdmin` only (`authz/nav.ts:23-25`).
- **UX-17 (HIGH)** Invite-only onboarding is a hard dead end: no sign-out, no user menu, form hidden (`onboarding/organization/page.tsx:153-167`); wrong-account users are trapped.
- **UX-18 (MED)** Prod error redaction defeats the friendly access screen — `error.tsx:28` regexes `error.message`, redacted in production (digest only).

**Tier D — failure-state surfacing:**
- **UX-19 (MED)** Failed document ingestion after refresh: no reason shown (errorMessage dropped, `project-file-workspace.tsx:60-68`), no retry, no delete.
- **UX-20 (MED)** Platform overview fetch failure = permanent skeleton (`platform-overview.tsx:66-81`); org page `getOrgSettings` unguarded (crashes whole page); recently-deleted fetch errors swallowed (`recently-deleted.tsx:37-39`).
- **UX-21 (LOW)** Auth error page: "Try again" and "Go home" both go `/` (`auth/error/page.tsx:49-55`); `?new=1` sticky re-opens dialog; no loading.tsx for org/platform/profile.

**Tier E — localization (German target users get English at key moments):**
- **UX-22 (MED)** Error registry, backend fallback strings, clarifier envelope, job-cap messages all hardcoded English (`error-registry.ts:25-91`, `intent_classifier.py:42-46`, `cost_tracking.py:82-88`, `clarifier/agent.py:300-307`).
- **UX-23 (MED)** Shell hardcoded English: project-switcher, org-topbar aria, brief provenance tooltips, research empty states (`project-switcher.tsx:42-84` etc.); dates formatted `en`/`en-GB` regardless of locale (`project-overview.tsx:61`, `project-card.tsx:17`, `recently-deleted.tsx:19`, `research-runs-list.tsx:45`); OIB standards lead with English titles (`applicable-standards.tsx:70-71`).

**Tier F — value adds (backend capability exists, UI missing):**
- **UX-24 (MED)** Project rename: PATCH endpoint + service exist, zero UI (`service.ts:98-107`) — typo'd names permanent and they're the delete-confirm phrase.
- **UX-25 (MED)** Research runs are anonymous rows (id-hash + time, no query/topic) (`research-runs-list.tsx:192-199`).
- **UX-26 (MED)** Summary regeneration: route exists, wizard fires once, silent failure, no overview affordance (`project-intake-wizard.tsx:247-259`).
- **UX-27 (HIGH, larger)** No document delete at all (no DELETE route, no UI; GDPR-positioned product) — needs backend Chroma/MinIO cleanup path; scope carefully.
- **UX-28 (MED, larger)** Server chat history is write-only — `listMessages` client exists with zero call sites; new device = empty shells; quota pressure wipes all local history (`sessions-store.ts:264-273,143-157`).

**Tier G — operator/docs/satellite surfaces:**
- **UX-29 (MED)** `.env.example` stale: Kimi-first, `OPENROUTER_API_KEY` commented out, `GRID_INTERNAL_API_TOKEN` missing; dead env knobs never passed to frontend service (`GRID_ENFORCE_FEATURE_FLAGS`, `GRID_ALLOW_AGENT_ORG_MEMORY`, `MEMORY_REFLECTION_ENABLED`) (`docker-compose.yaml:151-197`).
- **UX-30 (LOW-MED)** User-guide fixes (Milvus→Chroma `chat.md:96`, `processed`→`completed` `projects.md:41`, link guides from README); REST docs omit 7 endpoints incl. destructive maintenance purge; compose README is upstream boilerplate; FreshQA configs use unregistered `tavily_internet_search`; skill poller misses `interrupted` terminal status (`aiq.py:84-86`).
- **UX-31 (LOW)** `pyproject.toml` says `>=3.11` but code requires 3.12 (`typing.override`, `aiq_api/plugin.py:41`).
- **UX-32 (LOW)** Pre-existing test failure `test_dedup_preserves_order` (session collection now included in resolution; test not updated) — triage impl-vs-test.

**Flagged for humans (product/security decisions, not unattended-fixable):**
- **FLAG-1** Anonymous mode (`REQUIRE_AUTH=false`, the documented default) is broken at every server-rendered page/apiRoute — client fakes a Default User, server throws. Either restore an anonymous server path or retire the mode from README/landing. Needs product decision.
- **FLAG-2** Backend port 8000 published with `REQUIRE_AUTH=false` default + fail-open `/v1/admin/oib/sync` when `GRID_ADMIN_TOKEN` unset + job ownership checks off → any network peer can spend LLM budget and read any job. Security posture decision (compose default hardening) — recommend not publishing 8000 or defaulting auth on.
- **FLAG-3** No stop/interrupt for normal chat turns; true cancel is blocked upstream (`_running_workflow_task` always None, NeMo-Agent-Toolkit#1744). Frontend-side unlock/timeout is done in-loop (UX-4); real cancellation needs upstream.
- **FLAG-4** Org switcher / multi-org membership selection absent product-wide (only set at org creation). Design decision.
- **FLAG-5** Legal-hold invisibility: held projects show "purged after {date}" sailing past forever. Needs product copy/state decision.

### Round plan
- **Round 1:** Tier A (UX-1..7) — broken promises.
- **Round 2:** UX-8, UX-14..17 — project scoping + role-aware honesty.
- **Round 3:** UX-11, UX-12, UX-19, UX-20, UX-21 — failure-state surfacing + research unlock.
- **Round 4:** UX-22, UX-23 — localization sweep.
- **Round 5:** UX-24, UX-25, UX-26 — value adds (small); assess UX-27/28 feasibility.
- **Round 6:** UX-29..32 — operator/docs/satellites; UX-13 validation warning.
- **Round 7:** UX-9, UX-10 — citation presentation + stale-frame recovery (highest-care chat changes last, with full-suite gates).
- **Round 8+:** re-audit; continue until below the value bar.

---

## Round 1 — Tier A: broken core affordances (UX-1..7)

Three parallel implementation agents (disjoint file sets). First wave died on a
session limit mid-work; relaunched (per user directive: Opus for implementation,
Sonnet for exploration, Fable only for hardest) and completed from the partial
trees. Committed in three slices as each verified.

- **UX-6/7** (`1e11e7d`): `deploy/Dockerfile` now copies `scripts/` (documented
  ingest exec works); README/AGENTS step 3 tells the truth (auto-sync on boot,
  manual exec + `/v1/admin/oib/sync` as re-runs); `ingest_oib.py` logs progress;
  CLI defaults to the config that exists, `prog=aiq-research`, and failures exit
  non-zero with stderr output instead of `os._exit(0)`. Verified: ruff/format
  clean, py_compile ok, live failure path exit 1, pytest -k 'cli or ingest or
  oib' 6/6.
- **UX-1/3/5** (`2055a6f`): Download button fetches `{downloadUrl}` and
  navigates to the presigned URL (was: browser showed raw JSON); ingest-dispatch
  failure persists `failed`+errorMessage instead of green "Ready" (new
  `service.spec.ts`, 3 paths); delete toast shows the real purge date in the
  active locale and no longer promises the compliance-gated "Recently deleted"
  panel (EN+DE, `deleteSuccessNoDate` fallback). Verified: tsc 0, vitest
  documents+projects 241/241.
- **UX-2/4** (this commit): store-backed composer prefill (`?ask=` now lands in
  the composer, param cleaned from URL; welcome "chips" are real buttons that
  prefill; legacy welcome copy replaced with project-aware "Review the brief" /
  "Upload files", EN+DE). Backend `_run_workflow` catch-all now emits a terminal
  `workflow_error` ERROR frame (same builder as the auth path, send guarded);
  frontend maps it to a new `agent.workflow_error` registry entry; plus a 180s
  streaming-inactivity watchdog (armed on send, reset on every frame, cleared on
  terminal states) that unlocks the composer/session list and surfaces the
  existing interrupted banner instead of an eternal spinner. Tests: backend
  error-frame cases, 3 watchdog + 4 prefill frontend tests.
- Full-suite gates for this round recorded below the commit.

Residual for later rounds: ERROR_REGISTRY is still EN-only (UX-22); true
mid-turn cancel still blocked upstream (FLAG-3).

---

## Round 2 — project scoping + role-aware honesty (UX-8, UX-14..17)

Three parallel agents (session scoping on the highest-capability model; the
rest per the user's model policy). Committed in three slices.

- **UX-14/16/17** (`9365f08`): danger zone only renders for project-admins
  (matching the DELETE gate); Members nav shown to all project members (the
  read-only roster page existed but was hidden from its audience);
  Organization menu entry visible to every org member via a new
  `canViewOrganization` nav flag; onboarding/no-org page shows the signed-in
  email and offers Sign out in both self-serve and invite-only modes, and the
  invite-only alert now says what to do (EN+DE). Verified: tsc 0,
  project-overview spec 9/9.
- **UX-15** (`cc9d6af`): members get a "Your usage" section on the org page
  (the member self-view API path was dead code); new read-only
  `GET /api/auth/connection-diagnostics` (deliberately not the gateway-only
  websocket-scope route, which exposes the access token) lets chat
  distinguish budget exhaustion from a network outage — distinct localized
  banner with member vs admin guidance (EN+DE); ErrorBanner gains optional
  titleKey localization. Verified: touched suites green.
- **UX-8** (this commit): conversations API takes `?projectId` (service
  enforces `project:view` on the filter; SQL scopes `org AND (projectId = X
  OR projectId IS NULL)`); new sessions are stamped with their project;
  sessions panel lists only the active project's sessions; delete-all is
  project-scoped with copy that says so (EN+DE + confirmation scopeNote).
  Null-projectId legacy rows fail OPEN (visible everywhere) so pre-scoping
  history is never hidden — rule centralized in
  `features/chat/lib/project-scope.ts` and applied consistently to display,
  selection/URL-restore guards (stale `?session=` from another project
  auto-clears), `setProjectId` rehydration guard, and delete-all ("delete
  exactly what the panel shows"). Tests: +4 route spec, +12 store spec,
  MainLayout scoping test. Also threads `canViewOrganization` into the org
  page's own topbar (cross-slice follow-up from UX-16).
- Full-suite gate: tsc 0; vitest 1568 passed / 3 skipped (was 1531 at
  baseline; +37 from new round-1/2 tests); backend unchanged this round.

---
