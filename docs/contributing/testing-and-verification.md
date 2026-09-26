# Testing and verification

`task verify` is the local gate, and the closest single command to what CI
requires. It is not literally what CI runs: CI calls the same Taskfile
definitions but schedules them differently, and two required checks sit outside
`verify` entirely. Green locally is strong evidence, not a guarantee.

```bash
task verify        # everything CI runs
task verify:fast   # the same, minus the slow production build
task setup         # first-time toolchain install
```

`Taskfile.yml` is the source of truth for what each check actually runs, and
`task --list` prints the full set with descriptions. This page holds only what
the Taskfile cannot say about itself.

Host-native is the default. Docker is not required to verify a change, and the
project venv lives at `.venv` with its executables under `bin/` (`Scripts/` on
Windows); the Taskfile handles that difference so no command you type has to.

## What to run while iterating

Reach for the narrow task rather than the whole gate:

| Working on | Task |
|---|---|
| UI types | `task fe:types` |
| UI tests | `task fe:test` |
| UI lint | `task fe:lint` |
| Backend lint | `task be:lint` |
| Backend tests | `task be:test`, or `task be:test:api` for the plugin suite |
| Pulumi and the policy pack | `task infra:types` |
| Astro landing site | `task web:verify` |

Then run `task verify:fast` before you push.

## Traps the task list cannot tell you about

**Spec type errors block the production build.** The UI `tsconfig` includes test
files, so a type error in a `.spec.tsx` fails `next build`, not just the test
run. A green `task fe:types` is what tells you the build will typecheck.

**`task db:test:rls` is a required merge check and is not part of `task
verify`.** It needs PostgreSQL server binaries, so it runs separately. Run it
whenever you touch the tenant boundary — and whenever you touch a claim that is
really about SQL. The script (`scripts/rls-test-db.sh`) runs a fixed list of
`*.integration.spec.ts` files, not a glob: tenant isolation, the two BIM query
suites, and the memory service's "one fact, one live row" consolidation suite.
A new database-backed spec has to be added to that list, or it only ever runs
on a developer's machine. Each of those files also carries a
`GRID_RLS_SUITE_REQUIRED` guard so the CI job fails if the database goes
missing instead of skipping green.

**Backend tests need `PYTHONPATH=src`.** Without it pytest resolves `aiq_agent`
from whatever the venv has installed, possibly another worktree, and validates
the wrong code while appearing to pass. `Taskfile.yml` sets it. Call `pytest`
directly and you own it again.

**Static green is not runtime green.** Typecheck, lint and unit tests are the
bar for most changes. Behaviour that only exists at runtime, WebSocket flows,
auth, and the deletion pipeline among them, needs the Compose stack with real
keys and a developer driving it. Smoke-test those against a running stack before
release rather than trusting a green suite.

## How CI distributes the same tasks

CI calls the Taskfile, so there is no second copy of the commands. Only the
scheduling differs: the frontend tier's lint, types and build run in one job
while the suite is sharded six ways (`fe:test:shard`) and stitched back together
by `fe:test:merge` for the coverage comment. Run in series on one runner, the
tests were about 63% of the job's wall clock. Locally `task fe:verify` runs lint,
types, tests and build in order instead.

Three required checks are not in `task verify` at all: `db:test:rls` (it needs
PostgreSQL server binaries), `pkg:test` (four minutes, on a directory most
changes never touch — see below), and the release-note gate (it needs the PR's
base and head). Run the first two by hand when you touch what they cover; the
third only exists on a PR.

## The standalone packages under `packages/`

`packages/ifc-spatial` (TypeScript) and `packages/ifc-spatial-py` (Python) are
two implementations of the same spatial surface over IFC (ADR-0045), and both
sit **outside** the workspace they live next to: their own `package-lock.json`
and `uv.lock`, their own toolchains. Nothing the frontend or backend tier
installs can run them, which is how 830 tests behind a default-ON feature that
renders OIB compliance verdicts ended up with no gate at all — no Taskfile
target, no CI job, no pre-commit hook. The same shape as `sources/` before it.

They now run as CI's `packages` job, behind a `packages/**` paths filter, and
`CI OK` requires it. Locally:

```bash
task pkg:install    # both toolchains (`task setup` does this too now)
task pkg:test       # both suites
```

`task verify` deliberately leaves them out. `pkg:test:py` is 636 tests in 3m55s
(measured 2026-09-10) against its own IfcOpenShell/shapely environment; adding
that to every local gate run is the fastest way to get people to stop running
the gate. `pkg:test:ts` is ~10 seconds and runs **both** tsconfigs, the source
one and `tsconfig.test.json` — a test file that no longer type-checks is how an
operator contract silently stops being asserted.

The single required status check is **CI OK**
([`ci.yml`](../../.github/workflows/ci.yml)), which passes only when every
needed job succeeded or was skipped by the path filter.

## The live turn-shape eval

ADR-0052 deleted the intent router, so two things that used to be code are now
Piloti's reading of its own prompt: a greeting or a question
about the assistant answers without calling a search tool, and a commissioned
report („erstelle mir einen vollständigen Prüfbericht …") escalates to deep
research before it retrieves anything.
[`tests/benchmarks/test_turn_shapes_live.py`](../../tests/benchmarks/test_turn_shapes_live.py)
pins both, plus a control question that must still search. It runs the real
agent on the real prompt against Piloti's own model through OpenRouter, with
stub tools that record every call, so the assertion is on the trace rather
than on the prose.

It needs a model, so it is not in `task verify` and skips itself without
`OPENROUTER_API_KEY` (the `live` marker in `pyproject.toml` names the class).
Locally:

```bash
OPENROUTER_API_KEY=… task be:eval:turn-shapes
```

`GRID_DEFAULT_MODEL` moves the model under test, the same way it moves the
config's boot floor. In CI,
[`turn-shapes-live.yml`](../../.github/workflows/turn-shapes-live.yml) runs
it weekly and on `workflow_dispatch`, never on a pull request, and fails
rather than skips when the secret is missing. The assertions are strict: a
transport failure gets one rerun, a behaviour miss does not. A red run means
the prompt no longer holds the model on one of the two shapes; the ADR's
"More Information" section says what to do about that.

## The loop eval

`task be:eval:loop` measures the **shape** of a chat turn rather than the
correctness of its answer: how many retrieval rounds it took, whether the
locator (`read_passage`) was used instead of a second search, whether the cited
Punkt is the one the question is about, whether the Herleitung checkpoint came
from the tool argument or from prose or from nowhere, and whether the research
budget ran out. Twenty-nine realistic German questions from a Wiener Planungsbüro
live in [`tests/fixtures/herleitung/loop_eval_questions.yaml`](../../tests/fixtures/herleitung/loop_eval_questions.yaml)
— every expected Punkt in it is read off the committed structural index rather
than remembered — and [`scripts/loop_eval.py`](../../scripts/loop_eval.py) runs
them, writes a CSV, and diffs two CSVs with `--compare`. **It cannot run in
CI**, for the same reason `be:eval:retrieval` no longer does: it needs a
reachable backend with the operator-provided, gitignored OIB corpus ingested,
and every question costs real model calls. Run it on either side of a change to
the answering loop and quote the delta in the PR; the CSV and comparison logic
themselves are covered offline by
[`tests/test_loop_eval.py`](../../tests/test_loop_eval.py).

## Cross-service contract fixtures

Where a wire format has a producer in one language and a consumer in another,
the contract is a JSON fixture under `tests/fixtures/` that **both** suites read,
never two assertions that each pin their own side. Two tests that agree with
themselves prove nothing about a boundary: ADR-0046 records the internal-token
header spelled one way by every caller and read the other way by the guard,
which 403'd every scheduled run in a real deployment while both sides' tests
stayed green.

Two of these exist:

| Fixture | Producer side | Consumer side |
|---|---|---|
| `grid_request_context.json` | `request-context.spec.ts` builds the headers | `test_project_context.py` parses them back |
| `job_fire_headers.json` | `tests/lib/jobs/fire-headers.test.ts` fires a real submit and captures what went out | `test_fire_path_contract.py` asserts each backend-required set is a subset |

Each is duplicated verbatim into `frontends/ui/tests/fixtures/`, because
`frontends/ui/Dockerfile.typecheck`'s build context is scoped to `frontends/ui`
and cannot `COPY` from outside it. **Copy the repo-root file over the twin when
you change it** — `test_fire_path_contract.py` compares the two byte for byte,
so drift fails a test rather than splitting the contract in half.

## Security and static analysis

[`security.yml`](../../.github/workflows/security.yml) runs on push, on pull
request, and weekly. All of it is free and runs entirely in CI, with no GitHub
Advanced Security licence and no SonarQube subscription.

| Tool | Covers | Blocking |
|---|---|---|
| Semgrep | SAST for Python, TS/JS and Actions. Replaces CodeQL and Sonar's security rules | **Yes on a PR.** `semgrep ci` is diff-aware, so it blocks a *new* finding without failing on the existing backlog. Push and schedule runs stay advisory |
| OSV-Scanner | Dependency CVEs from **every** lockfile in the tree — the two npm ones, `bun.lock`, and both `uv.lock`s. Replaces Sonar SCA, and as of Sep 2026 the `pip-audit`/`bun audit`/`npm audit` job too | No, phase 1 |
| gitleaks | Secret scan over full history | Yes |
| trivy (`image-scan`) | The digest-pinned observability and Langfuse images from `deploy/pulumi/src/config.ts` | Yes, on **fixable** HIGH and CRITICAL findings (it runs `--ignore-unfixed`) |

OSV-Scanner being advisory is worth knowing before you rely on it: a vulnerable
dependency passes CI today. Making it block means removing its
`continue-on-error`.

There is deliberately **no** second dependency scanner. A `Dependency audit` job
ran `pip-audit`, `bun audit` and `npm audit` until it was measured: it was the
whole difference between a 2m36s Security run and a 9m53s one, and two of its
three steps reported nothing (a registry 503 and a pip-audit abort), both
swallowed by `|| true`, while OSV-Scanner found 23 advisories in the same commit
in 4 seconds. `npm audit` and `bun audit` query
the GitHub Advisory Database and pip-audit's PyPI service is fed by the PyPA
one; OSV ingests both, so "complementary sources" was never true. The rationale
sits in [`security.yml`](../../.github/workflows/security.yml) where the job
used to be, so it is read before anyone adds it back.

Three things about the trivy job that are not obvious:

- It asserts the exact image count (five as of ADR-0044), so a new pin fails CI
  until it is added to the scan list rather than going unscanned forever.
- The vulnerability database is downloaded once into a shared cache and the five
  scans reuse it with `--skip-db-update`. Five fresh `docker run --rm` pulls of
  `trivy-db` from GCR return 429 and fail the job with `failed=0`.
- What trivy learns by *walking* the images is cached across runs
  (`actions/cache`, keyed on the pin set and the trivy version). The
  vulnerability database is not, and the split is the point: a digest cannot
  change, but the advisories about it do, so only the immutable half is reused
  and a CVE disclosed this morning is still caught on the next run. That half
  was nearly the whole job — 199s of a 245s step went into walking the Langfuse
  web image, 192s of it secret-scanning the npm cache and Next.js source maps
  baked into that image. Restored, it is 0s with every scanner still on.
  Moving a digest costs one full walk, once.

Findings inside those upstream images that no digest bump can clear go in
`.trivyignore.yaml` as time-boxed exceptions with a justification and an
`expired_at`. Never by loosening the gate.

Dependabot ([`dependabot.yml`](../../.github/dependabot.yml)) opens the
dependency fix PRs. Maintainability is covered by the native linters and the
coverage gate in `ci.yml`. That drops Sonar's clean-as-you-code gate, so the
`PLR09xx` refactor rules ruff ignores (too many arguments, branches, statements)
are no longer reported on new code.

## Visual evidence

A user-visible UI change is done only with visual evidence, and that evidence
goes **in the pull request as an attachment**. No image files are committed.

Build a user-visible surface, add a `/dev/<name>` preview route that renders it
against fixture data with no backend, capture it with the `agent-browser` skill
against a running dev server, and attach it with the `before-and-after` skill
(`gh --attach`, GitHub CLI 2.99+). Full playbook, including the two-part dark
mode and the dev-indicator badge that lands in your shot:
[`../ux/visual-screenshots.md`](../ux/visual-screenshots.md).

There is no coverage workflow and no committed gallery. Both were removed: the
gallery was 348 MB of git history that nothing ever compared, and the workflow
only checked that a PNG file had appeared, never what was in it. A reviewer
looking at an attachment is the check. The **Visual evidence** workflow that
asked for the block in the PR body is paused (its check step is commented out
in `.github/workflows/visual-evidence.yml`).

## Mobile evidence

Held statically, by `frontends/ui/src/components/ui/mobile-affordances.spec.ts`
and `frontends/ui/src/components/ui/touch-target.spec.ts`. Capture a 390x844
viewport alongside the desktop shot when you ship a surface — the playbook above
has the command.

**The browser measurement is gone.** `task fe:touch-audit` loaded the screenshot
registry at a phone viewport and reported what neither a spec nor a screenshot
can: regions whose `touch-action` refuses the vertical pan (a finger lands and
the page does not move), boxes that stick out past the viewport, and interactive
elements under the 44px floor, measured including any `touch-target` catchment.
It imported `SCREENSHOT_TARGETS`, so it could not outlive the registry that was
deleted with the harness.

That is a real loss, recorded here rather than quietly dropped. Both of the
worst defects it ever found were invisible to review, to the type checker and to
a desktop screenshot: a reasoning graph that swallowed every swipe because a
library stylesheet claimed a gesture the graph had turned off, and a file list
whose `truncate` never fired because auto table layout sized the column to the
filename. Neither looked wrong; both were measured. Bringing it back means
writing it again against `src/app/dev/` rather than against a registry — and it
should not be part of `verify` when it returns, because a browser pass over ~120
surfaces is a deliberate run rather than a per-commit tax.

## The smoke

`task be:smoke` asks the real agent one question ("Was weißt du über die
OIB-Richtlinie 2?") through `nat run` with the shipped config, prompt, model and
tools, waits through the post-answer stages, and fails on what production would
have filed as an issue: any log record at ERROR or CRITICAL, a traceback, a
RuntimeWarning (an unawaited coroutine is one), or no answer. With the OIB corpus
ingested it also checks the answer is a real one: none of the canned
non-answers, at least one `[KB]` source in its Quellen, and (for the default
question) about Brandschutz. Without the corpus only that gate runs, and the
output says so; in CI that lasts only until a corpus snapshot is published,
after which a missing corpus fails the job (`--require-corpus`).

It exists because the unit suites fake the seams where September 2026's issues
lived: a tool schema the model's arguments did not fit (#656), a reply shape a
parser did not expect (#653), a payload a dependency's callback could not read
(#635). Each of those logged at ERROR, and ERROR is the level the collector
forwards to err2issue, so "no ERROR on a real turn" is the same test production
runs, taken before merge. Run against `develop` as it stood before it existed,
it fails on an unawaited coroutine per trace event.

`.github/workflows/smoke-live.yml` runs it on pull requests that touch the
agent, on pushes to `develop`, and on demand, with the repository secret
`OPENROUTER_API_KEY`. Its offline half, the reading of the log, is
`tests/test_smoke.py`.

### The corpus snapshot

The corpus is ingested once, not per run. `scripts/corpus_snapshot.py` keeps
what an ingest writes (the PDFs, the vectors in `AIQ_CHROMA_DIR`,
`summaries.db`, `data/oib_registry.json`) as a private OCI artifact,
`ghcr.io/grid-check/grid-oib-corpus`, tagged `format-<CHUNK_FORMAT_VERSION>`.
`task be:corpus:pull` restores it; `oib_sync.sync()` afterwards is a no-op
unless a PDF or the chunk format changed, which the registry already decides.
Measured on a two-page fixture: 34 s to ingest, 3 s to restore and sync, and
the real corpus's ingest is minutes and model calls.

**Where it comes from: staging.** Upload the Richtlinien in staging's
Platform → Knowledge and let it sync, as for any deployment. The workflow
*Corpus snapshot from staging* (`.github/workflows/corpus-snapshot.yml`)
copies those uploads out of the backend pod, runs `corpus_snapshot.py mirror`
(a new or changed PDF is ingested, a removed one is deleted from the index),
and publishes the snapshot. Two refusals keep a bad run from publishing: the
copy must match a `sha256sum` list taken inside the pod before anything is
deleted, and every PDF must have ingested before anything is pushed. A refused
run leaves the last good snapshot in place. It runs nightly, on a `develop` push that changes
ingestion, and from its *Run workflow* button when a new upload should reach
the tests now. It is the only job that reaches the cluster, through the dev
stack's kubeconfig in the `staging` environment; the smoke on a pull request
only pulls. A branch that bumps the chunk format re-ingests for its own run
and publishes nothing.

Locally, `task be:corpus:pull` restores the same snapshot (the `oras` CLI and
`oras login ghcr.io` with a token that can read packages). It makes the answer
suite, the turn census and the loop eval runnable without ingesting.

It is one question, not a suite: its job is to catch what breaks every turn.
Whether answers are right and how long they take is the answer suite's job.

## The answer suite

`task be:eval:answer-suite` is the end-to-end check: the reference questions
through the real agent, several runs each, timed call by call and checked
against what the answer must say. The loop eval asks how the turn looked for
its passage; this asks what the reader waited for and what they got.

- **Questions:** the loop eval's set, the ones tagged `suite: core` by
  default (`--all` for every question without a project; a question about an
  office's own files needs a project and is skipped, and the report says so;
  so is one about a Richtlinie the ingested corpus lacks, since the corpus is
  the operator's and a missing OIB-RL 5 is not the agent's failure).
  A question's optional `expect` block names values that must appear, claims
  that must not, and an acceptable shape (variant tabs, a table, a drawing,
  in the prose or in a card), each read off the corpus, never remembered.
- **Per run:** wall seconds, the answering call's seconds, research calls
  (up to and including the call that wrote the answer; a repair after it is
  counted apart, in `post_answer_calls`, though its tokens and seconds stay in
  the totals), tool calls, reasoning tokens and the largest single-call
  spike (seconds follow reasoning tokens at ~85 tok/s, and the spike is where
  run-to-run variance comes from), `first_text_s` (seconds until the reader
  saw the answering call's prose), the pipeline's own signals (a flagged quote, a quote patch, the terminal frame
  replacing the settled text, a gated summary, a dropped mindmap, prose outside
  the envelope, a salvaged envelope, an escalation to deep research), and
  every check. The signals are `_LOG_SIGNALS` in
  [`scripts/turn_census/suite.py`](../../scripts/turn_census/suite.py).
- **Output:** `report.md` and `results.json` in `--out`. `--baseline` adds,
  in brackets after the wall-seconds and reasoning-token medians, the change
  against an earlier `results.json`'s median for the same question, when it is
  1 or more; nothing else is compared. `--report` re-renders a `results.json`
  and re-checks it against the question set as it is now, re-reading each
  run's recording beside it, without paying for the runs again.
- **Flags:** `--only <id> …` runs the named questions (an unknown id, or
  one that needs a project, exits 2 and says which). `--runs N` sets runs per question (default 2), `--workers N` how many run
  at once (default 3). `--override KEY VALUE` sets a config value for every
  run, in `nat run` dot notation, and repeats. `--all`, `--baseline`,
  `--report` and `--ingest` are described above and below.

```bash
task be:eval:answer-suite -- --out /tmp/suite/before         # on the base branch
task be:eval:answer-suite -- --out /tmp/suite/after --baseline /tmp/suite/before/results.json
```

It needs `OPENROUTER_API_KEY` (or `OPENROUTER_KEY`) and the corpus in
`data/oib` ingested into `AIQ_CHROMA_DIR`: `task be:corpus:pull` restores it
without ingesting ([the corpus snapshot](#the-corpus-snapshot)), and `-- --ingest`
runs the sync first. Every run costs model calls: the core set at two runs is twelve
turns, about four minutes three at a time. It cannot run in CI for the same
reason as the loop eval; its bookkeeping is covered offline by
[`tests/test_answer_suite.py`](../../tests/test_answer_suite.py). The
September 2026 measurements it grew out of are in
[turns-per-answer-audit-2026-09.md](../architecture/turns-per-answer-audit-2026-09.md).

Measure a committed, clean tree, where the document inventory is. Each
question starts a fresh process from the working tree, so editing code
mid-run measures two codebases (the report marks the commit `-dirty`). And
`AIQ_SUMMARY_DB` defaults to a relative `./summaries.db`, so a `git worktree`
reads an empty inventory and runs every turn ~7 s slower without family
overviews; the suite refuses to start on an empty one.

Traps that cost a run:

- **Never run two harnesses against one `AIQ_CHROMA_DIR` at once.** Chroma
  errors, and the runs that hit it measure nothing.
- **A second or two between single runs is noise.** Compare medians over
  several runs, never one run against one run.
- **Which checkout a run measures.** The suite and the census now put this
  checkout's `src/` and `sources/` packages first on each run's `PYTHONPATH`,
  and run it with this checkout's venv interpreter; the suite refuses to start
  when a run would still import another checkout. Before that, a run from a
  `git worktree` measured the main checkout's code while its report named the
  worktree's commit.

For the seconds BEFORE the first model call, which the suite reports only as
a slice, `scripts/turn_census/startup_probe.py` prints each turn's provider
calls and the retriever's embed, lexical and retrieve phases in milliseconds,
several questions in one process so all but the first are warm. What both
measured on 2026-09-24, and the effort A/B:
[turn-latency-measured-2026-09.md](../architecture/turn-latency-measured-2026-09.md).

## Which tool answers which question

| Question | Tool | Needs | Cost |
|---|---|---|---|
| Does a real turn run without logging an error? | `task be:smoke` | key (corpus optional) | one turn, about two minutes |
| Is the answer right, and did it get slower or more variable? | `task be:eval:answer-suite` | key and ingested corpus | about 4 minutes for the core set at two runs |
| What did one turn cost, call by call? | `task be:eval:turn-census -- "<question>"` | key and ingested corpus | one turn per run (`--runs`, default 1); writes to `/tmp/turn_census` unless `--out`; `--override KEY VALUE` per census |
| What happens in the milliseconds before the first model call? | `scripts/turn_census/startup_probe.py` | key, corpus and document inventory | several questions in one process; the first turn is cold |
| What shape did the turn take (rounds, locator, checkpoint)? | `task be:eval:loop` | a running backend at `GRID_LOOP_EVAL_URL` with the corpus | real model calls per question; `--compare` needs no backend |
| Does the layout shift while an answer streams? | `/dev/stream-replay?fixture=varianten` (or `oib2`), `&speed=N` | the UI dev server | free: the fixtures are recorded frames in `frontends/ui/src/app/dev/_fixtures/stream-frames.ts`. `window.__replay` holds `shifts`, `anchorTops` and `done` for a headless capture |
| What does a streaming answer cost the page (re-renders, localStorage writes, long tasks)? | `/dev/stream-chat?history=40`, `&shell=1` for the whole `MainLayout` | the UI dev server with the WorkOS placeholders (see [gotchas](gotchas.md)) | free: the recorded `varianten` frames driven through the real chat store. `window.__streamChat` holds `commits`, `storageWrites`, `longTasks` and `done`; profile it with a CDP CPU profile for the per-component split |

## Before opening a PR

- `task verify:fast` green.
- A release note when a customer can notice the change. See
  [release-notes.md](release-notes.md).
- Docs updated in the same pull request, per the documentation obligation in
  [`AGENTS.md`](../../AGENTS.md).
