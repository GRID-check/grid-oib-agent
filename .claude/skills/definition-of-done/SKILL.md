---
name: definition-of-done
description: >
  The Grid repo's definition of done — the verification bar every change must
  clear before anyone (human or agent) may claim it is finished. Use this skill
  whenever you are about to say a task is done, complete, fixed, or ready;
  before committing, pushing, or opening a PR; when summarizing implementation
  work; or when reviewing whether someone else's change is actually finished.
  Also use it at the START of a work session to capture the test baseline that
  "done" will later be measured against.
---

# Definition of Done

"Done" in this repository is an evidence-backed state, not a feeling. A change
is done when every claim about it is backed by something you actually observed
in this environment: a test run, a log line, a screenshot, a live API response.
If you did not observe it, do not claim it — say what remains unverified and why.

## 1. Capture a baseline first

Before changing anything, record the current failure state so pre-existing
breakage is not attributed to your change (and your change cannot hide behind it):

```bash
source .venv/bin/activate && python3 -m pytest tests/ -q | tail -5
cd frontends/ui && npx vitest run --reporter=dot 2>&1 | tail -5
cd frontends/ui && npm run type-check 2>&1 | tail -20
```

Write the failing test names down. Only NEW failures block your change; but a
baseline failure caused by a genuine product bug should be reported, not ignored.

## 2. Verification matrix — run what your change touches

| You changed… | You must run and show output of… |
|---|---|
| Python backend (`src/`, `sources/`, `frontends/aiq_api/`) | targeted pytest for the touched area, then the full `python3 -m pytest tests/ -q`; `ruff check` and `ruff format --check` on touched files |
| Frontend (`frontends/ui/`) | targeted `npx vitest run <specs>`, then the full suite; `npm run type-check` (no new errors vs. baseline) |
| WS/SSE protocol or any message schema | both sides: backend emitter tests AND frontend Zod/parser tests for the same field names |
| LLM behavior (prompts, models, structured output) | a live smoke call against the configured provider (OpenRouter key in env) proving the contract parses — or an explicit note that live validation was not possible and why |
| User-visible UI | a screenshot (Playwright/Chromium is available) or, if truly infeasible, the rendered component's test output — plus the exact user-visible copy quoted in the summary |
| Anything long-running / a service | the actual logs showing the behavior, not an inference from code reading |

New behavior needs a test that fails without the change. A bug fix needs a
regression test that would have caught it — if the existing test suite passed
while the bug existed, the suite was wrong too; fix both.

## 3. Documentation is part of the change

Per AGENTS.md this is not a follow-up. In the SAME change, update whichever
applies: `docs/architecture/backend-deep-dive.md` (subsystems/data flows), an
ADR under `docs/adr/` (hard-to-reverse decisions), the env-var tables
(AGENTS.md + `docs/deployment/environment-variables.md`), `docs/api/*` (routes,
WS messages, tool contracts), `docs/database/*` (schema), `docs/user-guides/*`
(user-facing behavior), README (setup/run flow). Stale docs are a bug.

## 4. Independent verification of claims

For substantive claims ("the bug is fixed", "no regressions", "the profile now
reaches the prompt"), have someone who did not write the change check it — in
agent workflows, spawn a separate verification sub-agent that re-runs the
evidence commands and tries to refute the claim rather than confirm it. A claim
that survives an attempted refutation is done; a claim that was only re-asserted
is not.

## 5. Git hygiene before "done"

- One logical change per Conventional Commit (`type(scope): summary`), on a
  feature branch cut from `develop` (or the session's designated branch).
- No secrets in the diff. No commented-out scaffolding, no narrate-the-change
  comments.
- Pushed, with the push output shown (retry with backoff on network errors).

## 6. The closing checklist

Copy this into your final summary and fill every line with evidence or an
explicit "not verified because …":

```
- Baseline captured: <failing tests before work>
- Tests: <suite results after change, new failures = 0>
- Lint/typecheck: <ruff / tsc results>
- New/regression tests added: <names>
- Live/LLM validation: <what was called, result | n/a because …>
- UI evidence: <screenshot path / quoted copy | n/a because …>
- Docs updated: <files | none needed because …>
- Independent verification: <who/what re-checked which claims>
- Committed & pushed: <commit hashes, branch>
```

An honest "not done — X remains unverified" is compliant with this skill.
Claiming done without the evidence is the only failure mode.
