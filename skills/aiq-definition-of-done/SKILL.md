---
name: aiq-definition-of-done
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
cd frontends/ui && npx --no-install vitest run --reporter=dot 2>&1 | tail -5
cd frontends/ui && npm run type-check 2>&1 | tail -20
```

Write the failing test names down. Only NEW failures block your change; but a
baseline failure caused by a genuine product bug should be reported, not ignored.

## 2. Verification matrix — run what your change touches

| You changed… | You must run and show output of… |
|---|---|
| Python backend (`src/`, `sources/`, `frontends/aiq_api/`) | targeted pytest for the touched area, then the full `python3 -m pytest tests/ -q`; `ruff check` and `ruff format --check` on touched files |
| Frontend (`frontends/ui/`) | targeted `npx --no-install vitest run <specs>`, then the full suite; `npm run type-check` (no new errors vs. baseline); **`npm run lint` must exit clean — zero problems, not "no new ones"** (see §2a) |
| WS/SSE protocol or any message schema | both sides: backend emitter tests AND frontend Zod/parser tests for the same field names |
| LLM behavior (prompts, models, structured output) | a live smoke call against the configured provider (OpenRouter key in env) proving the contract parses — or an explicit note that live validation was not possible and why |
| User-visible UI | a screenshot from the screenshot harness (`cd frontends/ui && npm run screenshots [-- <id>]`, output in `frontends/ui/visual/screenshots/`) — add a `/dev/*` preview route + a `visual/registry.mjs` target for the new surface; see `docs/ux/visual-screenshots.md`. **A NEW component without that evidence is not done** (the `visual-coverage` workflow nudges on the PR); opt genuinely non-visual components out with a `// no-visual: <reason>` marker. Quote the exact user-visible copy in the summary too. |
| Anything long-running / a service | the actual logs showing the behavior, not an inference from code reading |
| Anything a customer can notice (backend, API, UI, CLI) | a reno release note in the same change — `task release:note -- <slug>`, then `task release:lint`. The **Release note** CI job fails the PR without one; the `no-release-note` label is the only exemption and it claims no user can observe the change. See AGENTS.md, "Release notes are mandatory". |

New behavior needs a test that fails without the change. A bug fix needs a
regression test that would have caught it — if the existing test suite passed
while the bug existed, the suite was wrong too; fix both.

## 2a. `any` is never done

**`any` is not an accepted type anywhere in this repo — not in production code,
not in test doubles, not "just for now".** `@typescript-eslint/no-explicit-any`
is an **error** in `frontends/ui/eslint.config.mjs` and the suite is at zero.
A change that adds one is not done, however green the tests are.

This is not style. A test double typed `(s: any) => any` switches off checking
for the *fixture* as well as the selector, so the fixture silently stops
matching the code it stands in for. Clearing the original backlog turned up an
`error` field and an `addStatusCard` action fixtured in a spec that exist
nowhere in production, two `session` fixtures missing required members, and
several DB-row fixtures missing `notNull` columns — none of which any test
could have caught while the casts were there.

Reach for, in order of preference:

1. **The real type.** Usually it already fits — several `as any`s in the
   backlog were simply unnecessary.
2. **A narrowing of it** — `Partial<T>`, `Pick<T, …>`, `Omit<T, …>`, or a
   documented wire type when the JSON shape genuinely differs from the
   server type (dates arrive as strings).
3. **`unknown`** plus a type guard, when the value really is unknown.
4. **`as unknown as T` at ONE documented boundary**, named and commented, when
   a stand-in cannot be fully typed (a drizzle query-builder stub, a mock
   module with added test hooks). Never sprinkled at call sites.

For spec fixtures, use the shared helpers rather than inventing a cast:

- `@/test-utils/store-fixtures` — `DeepPartial<TState>` keeps a zustand fixture
  partial while still checking every field against the real store;
  `asStoreState<TState>()` confines the widening to one audited place;
  `StoreSelector<TState>` types the mock with the hook's real signature.
- `@/test-utils/db-fixtures` — `makeProject` / `makeDocument` /
  `makeMemoryItem` return complete repository rows, so a repository mock
  resolves to something the service can actually read; `asDb()` is the single
  boundary where a partial drizzle query-builder stub widens to the `getDb`
  handle, so that cast is not re-derived per spec.

When typing a fixture surfaces an error, that is the point of the exercise:
**fix the fixture, do not widen the type back.** If the fixture was wrong, the
test was asserting against a shape that never existed — say so in the summary.

`no-console` is the same deal: `warn`, `error` and `debug` are allowed
(`console.debug` is the dev-only diagnostic channel, and its call sites are
`NODE_ENV`-gated). A stray `console.log` shipping to production logs is a
finding, not a warning to wave through.

## 2b. Prove the test fails without the fix

Do not assert that your test would have caught the bug. **Remove the fix, run
the test, watch it fail, put the fix back, and report the numbers** ("reverting
the wiring fails 3 of its 4 cases"). Restore byte-for-byte and say that you did.

A test written against a bug you have already fixed is written blind. It passes,
which feels like proof, and the only question that matters — *would it have gone
red before?* — is the one thing a passing run cannot answer.

This is not hypothetical here. A committed test named
`…_stripped_is_never_announced` asserted that a fabricated URL never reaches the
cited-source stream. It never did — but it never could have, fix or no fix: the
callback rejects any URL absent from the registry, so the invented one failed an
unrelated check first. The test passed identically against the code it was
written to pin. It read as coverage of the announce-before-verify bug and was
coverage of nothing.

That is worse than an absent test. An absent test is a known hole; a vacuous one
occupies the hole's place in the suite, so nobody looks again. Fixing it meant
finding an input the code path would otherwise have accepted — a *genuinely
retrieved* document whose citation verification strips — which is exactly the
thinking the revert-check forces and the green run does not.

If a test cannot be made to fail, one of two things is true: the fix is not doing
what you think, or the test is aimed at the wrong thing. Both are findings. Say
which.

## 2c. An implementation nobody calls is not done

**Grep for a caller of every symbol you add, and test the JOIN, not just the
parts.** A module with no importer, a prop no parent passes, a setter with no
producer — each is dead code wearing a passing suite.

Three times in one work session a complete, correct implementation shipped
imported by nobody, and every test on both sides of the gap stayed green,
because each side was genuinely correct in isolation:

- A WinAnsi transliteration table — written, reviewed, tested, imported by
  nobody. `≤ 40 m` kept printing as `d 40 m` in compliance PDFs: the comparator
  inverted while the number beside it stayed right, and nothing went red.
- A three-tier source-registry resolver with a full API and its own tests — no
  producer ever handed it a registry.
- `truncation_reason` / `degraded_reasons` — wire schema, sanitizer, storage,
  reload decoder, German and English strings, and a renderer with matching
  props that **no caller passed**.

The pattern is structural, not careless: whoever owns the parts cannot see the
join, so the join is the thing that needs the test. Prefer a choke point over a
convention — the transliteration is wired by making the renderers import a
wrapping `Text`, because applying a function at twenty call sites works exactly
until the twenty-first, and that failure is silent.

When a lane is split across agents or PRs, name the joining field or symbol up
front and have both sides pin it; a test that reads the *other* side's source
for the expected name is cheap and catches a rename that two green suites will
not.

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
- **The PR title must itself be a valid Conventional Commit subject** — the repo
  squash-merges the PR title, and the `Conventional PR title` check
  (`.github/workflows/pr.yml`, `amannn/action-semantic-pull-request`) blocks the
  PR otherwise. Use only the allowed types: `feat`, `fix`, `docs`, `refactor`,
  `perf`, `test`, `ci`, `build`, `chore`, `revert` (e.g. `ci: …` for a
  workflow-only change). A PR opened from the UI keeps whatever title it was
  given — fix the title, not just the commits.
- No secrets in the diff. No commented-out scaffolding, no narrate-the-change
  comments.
- **Run `pre-commit run --all-files` before pushing** (or keep `pre-commit
  install` active). CI runs it across the WHOLE repo, not just your diff, so
  pre-existing drift in files you never touched — trailing whitespace, missing
  final newlines, a stale `.secrets.baseline`, dead markdown links — will block
  the PR the moment your change triggers the lint job. Fix it in the same PR;
  it is cheap and mechanical. Lockfile hashes / generated files that trip
  detect-secrets belong in the hook's `exclude` (see `.pre-commit-config.yaml`),
  not stuffed into the baseline. See `CONTRIBUTING.md`.
- Pushed, with the push output shown (retry with backoff on network errors).

## 6. The closing checklist

Copy this into your final summary and fill every line with evidence or an
explicit "not verified because …":

```
- Baseline captured: <failing tests before work>
- Tests: <suite results after change, new failures = 0>
- Lint/typecheck: <ruff / tsc results; `npm run lint` exit code>
- `any` introduced: NONE <or name each site and why no real type was reachable>
- New/regression tests added: <names>
- Revert-check: <"removed <fix>, N of M cases failed, restored" | why not possible>
- Caller exists for every new symbol: <grep evidence | n/a — nothing new added>
- Live/LLM validation: <what was called, result | n/a because …>
- UI evidence: <screenshot path / quoted copy | n/a because …>
- Docs updated: <files | none needed because …>
- Independent verification: <who/what re-checked which claims>
- Committed & pushed: <commit hashes, branch>
```

## 7. Gotchas — don't re-learn these the hard way

Environment quirks that repeatedly cost time. Each points to the doc that owns
the detail — read the doc, don't guess.

- **`any` fails the build, and a spec is not exempt.** `no-explicit-any` is an
  eslint **error** and the suite sits at zero — §2a has the ladder to reach for
  instead (real type → narrowing → `unknown` → one documented
  `as unknown as T`) and the `@/test-utils/{store,db}-fixtures` helpers that
  cover the common spec cases. Do not reach for a cast because a fixture is
  awkward to build; the awkwardness is usually the fixture being wrong.
- **Frontend checks need `node_modules`.** Host `npm install` is flaky but works
  here; if `type-check` / `vitest` / generators fail with `ERR_MODULE_NOT_FOUND`,
  run `cd frontends/ui && npm install` first. The card generators also need it
  (`npm run generate:cards`).
- **Screenshots + dark mode + dev previews.** The full playbook — dark mode is a
  `.dark` class on `<html>` (not `data-theme`; `src/app/providers.tsx` +
  `globals.css`), dev preview routes 404 outside development, fetch shims must be
  installed at module scope (not a `useEffect`) or they lose the child-effect
  race, thumbnails 404 to a deterministic SVG sketch, and Chromium is
  pre-installed at `PLAYWRIGHT_BROWSERS_PATH` (never download it) — lives in
  **`docs/ux/visual-screenshots.md`**. Read it before capturing UI evidence.
- **Grid cards are generated backend→frontend.** Editing `src/aiq_agent/cards/models.py`
  is not enough: run `uv run python scripts/generate_card_schema.py` then
  `cd frontends/ui && npm run generate:cards`, and add the renderer branch in
  `features/grid-cards/components/GridCards.tsx`. You must also classify the new
  type in `CARD_INTERACTIVITY` (`features/grid-cards/card-decision.ts`) — that
  map is exhaustive, so `type-check` fails until you do. Full recipe:
  **`docs/architecture/cards.md`**.
- **A card with a button that writes something is not done until its answer
  persists.** `project_profile_patch` and `memory_proposal` authorize a real
  write, so the decision must be recorded on the `ChatMessage`
  (`cardInteractions` via `useCardDecision`), never in component-local
  `useState`. A lost decision re-offers a button that applies the patch / writes
  the memory a second time — neither endpoint is idempotent. **ADR-0030.**
- **CI workflows have their own traps, and they fail at deploy time, not review
  time.** A shallow checkout with `persist-credentials: false` cannot diff a
  push (paths-filter needs `fetch-depth: 0`); `/repos/{owner}/{repo}/packages/…`
  is not a REST endpoint and 404s; GHCR paths are lowercase while
  `$GITHUB_REPOSITORY_OWNER` is `GRID-check`, and a mixed-case image ref reaches
  the cluster as an unpullable image rather than a workflow error. Details and
  the reasons the current code looks the way it does: **`docs/deployment/cd.md`
  § Workflow gotchas**.
- **A workflow-only change is still verifiable — verify it.** Load the run's
  actual logs (not the summary) to find the failing line, `yaml.safe_load` the
  file, `bash -n` any `run:` block you edited, and exercise external calls
  (registry/API) against the real service before claiming the fix works. Say
  plainly which paths only run post-merge and are therefore unproven.
- **Raw `sql<T>` results aren't runtime-validated** — coerce at the repository
  boundary (`new Date(...)`, `Number(...)`). See the AGENTS.md Conventions note.

When you hit a fresh environment quirk worth remembering, add it here (one line
+ a pointer) and put the detail in the relevant doc — future runs should find
it, not rediscover it.

An honest "not done — X remains unverified" is compliant with this skill.
Claiming done without the evidence is the only failure mode.
