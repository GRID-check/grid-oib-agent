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

<!-- Sprint entries appended below as they complete. -->
