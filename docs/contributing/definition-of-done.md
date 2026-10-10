# Definition of done

"Done" is a state you can show, not a feeling. A change is done when every
claim about it rests on something you observed in this environment: a test run,
a log line, a capture, a live API response. What you did not observe, you do
not claim; you say what remains unverified and why. An honest "not done, X is
unverified" meets this bar. Claiming done without the evidence is the only way
to fail it.

The bar is the same for a person and for an agent. Read it before you say a
change is finished, before you open a pull request, and when you review whether
someone else's change is.

## Capture a baseline first

Before changing anything, record what already fails, so a pre-existing failure
is not blamed on your change and your change cannot hide behind one:

```bash
task be:test 2>&1 | tail -5
task fe:test 2>&1 | tail -5
task fe:types 2>&1 | tail -20
```

Write the failing test names down. Only new failures block your change, but a
baseline failure caused by a real product bug is reported, not ignored.

## Run what your change touches

The narrow tasks for iterating are in
[testing-and-verification.md](testing-and-verification.md#what-to-run-while-iterating).
This table is what you must have run, and be able to show, when you call the
change done.

| You changed | Show the output of |
|---|---|
| Python under `src/`, `sources/` or `frontends/aiq_api/` | the targeted tests (`.venv/bin/pytest <path> -q`), then the suite they belong to (`task be:test`, `task be:test:sources`, `task be:test:api`), and `task be:lint` |
| The UI (`frontends/ui/`) | the targeted specs, then `task fe:test`; `task fe:types` with no new errors against the baseline; `task fe:lint` exiting clean, with zero problems rather than "no new ones" |
| A WebSocket or SSE message, or any schema two services share | both sides: the producer's tests and the consumer's parser tests, over the same field names. Where a fixture under `tests/fixtures/` is the contract, both suites read it ([cross-service contract fixtures](testing-and-verification.md#cross-service-contract-fixtures)) |
| What shapes an answer: prompt, model, structured output, retrieval | the answer suite before and after (the obligation in [`AGENTS.md`](../../AGENTS.md#obligations)), or at least a live call proving the contract parses, with a note saying why the suite could not run |
| Something a user can see | a capture attached to the pull request, never committed ([visual-screenshots.md](../ux/visual-screenshots.md)), and the exact user-visible copy quoted in your summary. A new component without it is not done |
| Something that runs as a service or for a long time | the logs showing the behaviour, not an inference from reading the code |
| Something a customer can notice | a release note in the same change (`task release:note -- <slug>`, then `task release:lint`) |
| The tenant boundary, or `packages/` | `task db:test:rls`, or `task pkg:test`. Neither is in `task verify` |

New behaviour needs a test that fails without it. A bug fix needs a regression
test that would have caught the bug; if the suite passed while the bug existed,
the suite was wrong too, so fix both.

`any` is never done, however green the tests are. The ladder to reach for
instead, and the fixture helpers that make it cheap:
[code-conventions.md](code-conventions.md#any-is-not-a-type-we-accept-in-production-code-or-in-tests).
When typing a fixture surfaces an error, fix the fixture rather than widening
the type back, and say in the summary that the test was asserting a shape that
never existed.

## Prove the test fails without the fix

Do not assert that your test would have caught the bug. Remove the fix, run the
test, watch it fail, restore the fix byte for byte, and report the numbers
("reverting the wiring fails 3 of its 4 cases").

A test written after the fix is written blind: it passes, and the only question
that matters, whether it would have gone red before, is the one a passing run
cannot answer. A committed test named `…_stripped_is_never_announced` asserted
that a fabricated URL never reaches the cited-source stream. It never did, and
never could have, fix or no fix: the callback rejects any URL absent from the
registry, so the invented one failed an unrelated check first. The test read as
coverage of the announce-before-verify bug and covered nothing. A vacuous test
is worse than an absent one, because it occupies the hole's place and nobody
looks again.

If a test cannot be made to fail, either the fix is not doing what you think or
the test is aimed at the wrong thing. Both are findings; say which.

## An implementation nobody calls is not done

Grep for a caller of every symbol you add, and test the join rather than only
the parts. A module with no importer, a prop no parent passes, a setter with no
producer: each is dead code with a passing suite.

Three times in one session a complete, correct implementation shipped with
nobody calling it, and every test on both sides of the gap stayed green:

- a WinAnsi transliteration table, so `≤ 40 m` kept printing as `d 40 m` in
  compliance PDFs;
- a three-tier source-registry resolver that no producer ever handed a registry;
- `truncation_reason` and `degraded_reasons`, carried through wire schema,
  sanitizer, storage, reload decoder and both languages' strings to a renderer
  that no caller passed them to.

Whoever owns the parts cannot see the join, so the join needs the test. Prefer a
choke point over a convention: the transliteration is wired by making the
renderers import a wrapping `Text`, because a function applied at twenty call
sites works until the twenty-first. When work is split across people, agents or
pull requests, name the joining field up front and have both sides pin it.

## Documentation is part of the change

Update the docs your change makes wrong in the same change:
[documentation.md](documentation.md) says which doc goes with which kind of
change.

## Have the claim checked by someone who did not make it

For a substantive claim ("the bug is fixed", "no regressions", "the profile now
reaches the prompt"), have someone who did not write the change try to refute
it by re-running the evidence. An agent spawns a separate verification subagent
for this. A claim that survived an attempted refutation is done; a claim that
was only repeated is not.

## Before you push

- Conventional Commits, one logical change per commit, and a Conventional PR
  title ([CONTRIBUTING.md](../../CONTRIBUTING.md#commits-and-pr-titles)).
- No secrets, no commented-out scaffolding, no comments narrating the change.
- `task lint:repo` green. CI lints every file in the repo, not only your diff,
  so drift in a file you never touched blocks your pull request; fix it in the
  same change.
- Pushed, with the push output shown.

## The closing checklist

Put this in your final summary or the pull request, with every line filled by
evidence or by "not verified because …":

```text
- Baseline captured: <failing tests before work>
- Tests: <suite results after the change, new failures = 0>
- Lint and types: <task be:lint / task fe:types results; task fe:lint exit code>
- `any` introduced: NONE <or each site, and why no real type was reachable>
- New or regression tests: <names>
- Revert-check: <"removed <fix>, N of M cases failed, restored" | why not possible>
- Caller exists for every new symbol: <grep evidence | n/a, nothing new added>
- Live or LLM validation: <what was called, result | n/a because …>
- UI evidence: <PR attachment, quoted copy | n/a because …>
- Docs updated: <files | none needed because …>
- Independent verification: <who or what re-checked which claims>
- Committed and pushed: <commit hashes, branch>
```
