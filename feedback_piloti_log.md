# Piloti Feedback Loop — Sprint Log

> Human-readable log of the feedback-triage loop that works `feedback_piloti_backlog.md`.
> Captain/architect model: orchestrator plans + reviews + verifies; subagents
> explore and implement. Every "done" claim is backed by observed evidence
> (pytest / tsc / logs) per the `definition-of-done` skill.

## Baseline (2026-07-21, branch `claude/app-feedback-triage-fyvgtn`)
- Backend: `pytest tests/ -q` → **2 failed, 2019 passed, 5 skipped**.
  - Both failures: `AgentEventCallback._emit_artifact() got multiple values for
    argument 'content'` (`frontends/aiq_api/.../jobs/callbacks.py:723`).
    → This is PB-1 (deep-research citation emission crash). Pre-existing on
    `develop`; NOT introduced by this loop. It is a real product bug, so it is
    fixed here rather than ignored.
- Frontend: host `node_modules` is bare (no vitest/tsc bins); frontend checks run
  via the sanctioned `grid-tsc` Docker image (`frontends/ui/Dockerfile.typecheck`).

## Sprint 0 — triage & discovery (in progress)
- Read feedback, wrote `feedback_piloti_backlog.md` (PB-1..PB-16 + deferred).
- Discovery agents dispatched (Sonnet/general): trust-chain, deep-research job
  path, researcher pipeline, RAG document lifecycle, localization/prompt, and a
  mandatory web-research agent (anti-hallucination / latest LangGraph+NAT).
- Confirmed PB-1 by code reading (see baseline).

### Discovery findings — prompt/i18n/behavior (agent report, verified by reading)
- **PB-10 clarifier — REAL BUG.** Clarifier is enabled + wired but only reachable
  from the **deep** path (`chat_researcher/agent.py` `route_after_orchestration`
  routes to `clarifier` only when `depth==deep`; shallow goes straight to
  `shallow_research`). Most single Baurecht questions are shallow → never asks
  Rückfragen. Prior "done" claim is technically true (works for deep) but
  misleading. Low-risk fix: instruct shallow `researcher.j2` to ask a Rückfrage
  when a hard-required project fact is `unknown:` (prompt-level, no graph surgery).
- **PB-15 briefing i18n — PARTIAL.** Generation pipeline is fully locale-aware
  (`project-brief.tsx`→route→`profile-service.ts`→`generate_summary.py:95` writes
  "Write the summary in {language}"). Real gap: summary persisted once with no
  stored locale; auto-generate fires only `if (!hasSummary)`, so a later DE switch
  never regenerates → stale English persists. Fix: store `summaryLocale`,
  regenerate/prompt on mismatch.
- **PB-8 verbosity/Empfehlung — PROMPT + SCHEMA.** (a) `shallow_researcher/.../
  researcher.j2` has no brevity rule and no "don't restate project params" →
  verbose + repetitive. (b) "Empfehlung" invited by `cards/models.py:576`
  `ComparisonTableCard.recommendation` + catalog example `catalog.py:191`; Baurecht
  liability. Reframe toward neutral "objektive Einschätzung".
- **PB-14 identity — PROMPT (careful).** 6 sites; broaden 5 non-compliance prompts
  + widen topic guardrail (`researcher.j2:9`) + intent-classifier research bucket.
  CAUTION: `tests/.../deep_researcher/test_agent.py:683-710` hard-asserts the
  `"Grid OIB"` substring — keep it or update tests in lockstep.

## Sprint 1 — COMPLETE (2026-07-21). Landed PB-1, PB-6, PB-15.
- **PB-1** `fix(deep-research): stop citation-source emit crashing on every source`.
  Root cause: `on_tool_end` passed `content` positionally AND spread `**wire`
  (which always carries a `content` key) into `_emit_artifact` → `TypeError` on
  every real source → citation SSE feed crashed (regression from `29ddece`,
  3 days old, shipped with 2 red tests). Fix: drop `content` from the wire spread;
  updated the test that had frozen the buggy single-emit. **Backend suite now
  2021 passed / 0 failed** (baseline was 2 failed). Directly addresses "DeepResearch
  bricht ab" + "Quellen fehlen in der Output-Card".
- **PB-6** `feat(documents): allow deleting uploaded project documents`. Mirrored
  the Archiv delete end-to-end (route→service authz `project:edit`→repo SQL scoped
  by org+project, storage delete via `storageKey`, best-effort chunk purge, audit)
  + two-step design-system delete button + i18n + tests + docs. tsc clean, specs green.
- **PB-15** `fix(projects): regenerate AI briefing when the UI language changes`.
  Store `profile_display.summaryLocale` (JSON, no migration); regenerate once on
  locale mismatch; legacy rows fail-open; loop-guarded. tsc clean, specs green.

### Tooling note (executive call, user-authorized "don't fight the tooling")
- The managed Docker daemon was reclaimed mid-session; a manual `dockerd` restart
  left a memory-constrained build sandbox where `npm ci` OOMs ("Exit handler never
  called!"). Switched to a **native host toolchain** (`npm ci` on host, 14 GB free)
  — `node_modules/.bin/tsc` + `vitest` now run directly, no Docker needed. This is
  the frontend verification path for the rest of the session.

### Sprint 1 verification (native toolchain)
- Backend `pytest tests/`: **2021 passed / 5 skipped / 0 failed**.
- Frontend `tsc --noEmit`: clean. Targeted vitest (documents + projects specs):
  53/53 green. Full vitest: **2605 passed / 3 skipped / 0 test failures**.
- One failed test *file* (`src/lib/request-context.spec.ts`) throws
  `TypeError: The URL must be of scheme file` at import — a
  `fileURLToPath(import.meta.url)` quirk under native vitest (vs the Docker
  image); it imports nothing this loop touched. Pre-existing env artifact, not a
  regression. Left as-is.
- Pushed: `5cbbb27` (PB-1), `bad267c` (PB-6), `1bf3590` (PB-15), docs.

## Sprint 2 — IN PROGRESS
- **PB-18 (file-browser semantic search)** — signed off by user (explicit-run +
  *transparent* UX; pure-vector v1, no LLM). Backend impl agent running (retriever
  singleton + `POST /v1/collections/{c}/search` + aggregation + tests + docs).
  BFF+UI to follow.
- **PB-18 backend** — DONE & committed (`feat(search): document-centric semantic
  search endpoint`); 2385 backend tests pass. **PB-18 frontend** — implementing
  (BFF routes + services + transparent explicit-run search UI, user-signed-off).
- **PB-7 (fabricated quotes)** — implementing. Deterministic difflib quote-vs-chunk
  verification (whole-registry, threshold 0.90, fail-open inline annotation
  `[nicht wörtlich in der Quelle belegt]`, no stripping). Wires through the
  confidence machinery to cap to "low" with reason `quote_unverified` — **this also
  delivers PB-9** (confidence needs a visible reason). Backend-only; runs parallel
  to the frontend agent. Design mapped the exact plumbing gap: chunk text IS in the
  tool-result string but `_parse_knowledge_layer` discarded it — now captured onto
  `SourceEntry.chunk_text`.

### Errors-are-not-excused (per new AGENTS.md rule)
- Fixed `request-context.spec.ts` (was crashing the whole suite at import via
  `fileURLToPath(new URL(..., import.meta.url))` — non-file scheme under vitest;
  36 tests silently not running). Now a direct JSON import. `fix(test)` committed.
- Persisted the rule into AGENTS.md Conventions: fix errors you find (even
  pre-existing), never dismiss them.

### Prompt cluster (Sprint 4, queued — held to avoid prompt-file conflicts with PB-7)
- PB-10 clarifier-in-shallow, PB-8a brevity/no-restate, PB-14 identity broadening,
  PB-8b "Empfehlung"→neutral. Mapped by earlier agent (see above). All touch the
  researcher `.j2` prompts (+ 1 identity test assertion) — run as ONE agent after
  PB-7 lands.

<!-- Sprint entries appended below as they complete. -->
