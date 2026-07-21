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

<!-- Sprint entries appended below as they complete. -->
