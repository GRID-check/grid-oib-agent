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

Both run `lint:repo` first, then the tiers side by side (`task --parallel
--output=group`), so a tier's output arrives whole when it finishes. They skip
the hooks a tier repeats (ruff, the English-names test: `VERIFY_SKIP` in
`Taskfile.yml`) and run the UI suite without coverage, which CI only comments.

`Taskfile.yml` and the per-tier files in `taskfiles/` (included flat, so task names
are unchanged) are the source of truth for what each check actually runs, and
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
| UI lint (oxlint; why not ESLint or Biome: [lint-evaluation.md](lint-evaluation.md)) | `task fe:lint` |
| Backend lint | `task be:lint` |
| Backend tests | `task be:test`, or `task be:test:api` for the plugin suite |
| The Chroma exporter and the move off Chroma (`deploy/migration/`, `qdrant/import_vectors.py`) | `task be:test:migration`, in its own `chromadb` environment; nothing else imports `chromadb` ([`deploy/migration/README.md`](../../deploy/migration/README.md#tests)) |
| Pulumi and the policy pack | `task infra:types` |
| Astro landing site | `task web:verify` |

Then run `task verify:fast` before you push.

## Traps the task list cannot tell you about

**`next build` does not typecheck the specs; `task fe:types` does.** The build
reads `frontends/ui/tsconfig.build.json` (`typescript.tsconfigPath` in
`next.config.ts`), which leaves specs and test helpers out of its roots, so a
type error in a test fails `fe:types` and never the production build.

**`task fe:types` is `bun check`, which is TypeScript 7.** It checks the whole UI
in about six seconds with no cache, and the pinned Bun version decides which
TypeScript that is (`tests/test_bun_version_pin.py`). Your editor runs its own
TypeScript; without the TypeScript 7 extension it is 6 and the two can disagree
([gotchas](gotchas.md)). `next build` also runs TypeScript 7, through the
`typescript` package. Five structural specs parse source with the compiler API,
which TypeScript 7.0 does not ship, so they import `typescript-api`, TypeScript 6
under an alias (ADR-0103).

**`task db:test:rls` is a required merge check and is not part of `task
verify`.** It needs PostgreSQL server binaries, so it runs separately. Run it
whenever you touch the tenant boundary — and whenever you touch a claim that is
really about SQL. The script (`scripts/rls-test-db.sh`) runs a fixed list of
`*.integration.spec.ts` files, not a glob; the list in the script is the
authority. A new database-backed spec has to be added to that list, or nothing
in CI runs it: the spec itself skips without `GRID_TEST_DATABASE_URL`, and
nothing checks the list is complete. On 2026-10-22 four were missing
(`retrieval-settings/service` and the three `model-config/*` integration
specs). Each listed file carries a `GRID_RLS_SUITE_REQUIRED` guard so the CI job
fails if the database goes missing instead of skipping green; CI sets that
variable (`.github/workflows/ci.yml`), the script does not, so a local run can
still skip green.

The per-migration sections at the end of that script prove a backfill, a data
rewrite or a down migration on a clone of the chain. Once the migration has
been on `prod` for a week (`git merge-base --is-ancestor <commit> origin/prod`
and the promotion's date), retire its section: production can no longer hold
the old shape, and nobody runs a down beneath the migrations that followed.
Keep what the migration put into the database that is still refused today (a
CHECK, a unique index, a guard trigger) unless a suite on the full chain
already covers it.

**Backend tests run against this checkout's `src/`.** Without a guard, pytest
resolves `aiq_agent` from whatever the venv has installed, possibly another
worktree, and validates the wrong code while appearing to pass. `pyproject.toml`'s
`pythonpath` puts `src/` first, so a bare `pytest` is safe as well as the Taskfile.

**The claim queues are tested on Postgres by `task be:test:postgres`, in CI's
Backend job.** `tests/aiq_agent/common/test_claim_queue.py`,
`tests/knowledge_layer_tests/test_ingest_queue.py` and
`frontends/aiq_api/tests/test_research_queue_fair.py` run every scenario on
SQLite, which ranks in Python, and on Postgres, which runs production's claim
SQL. The folder card builder's suites (`tests/aiq_agent/knowledge/folder_cards/`:
dirty queue, budget, manifests, worker) run on both too, through the
`database_url` and `agent_db` fixtures in their `conftest.py`, and so does the
metadata store's mail records (`tests/aiq_agent/knowledge/test_mail_facts.py`: the
add-column path on a table from before the columns, and the read-back). Without `AIQ_TEST_POSTGRES_URL` the Postgres parameter skips, so the task
reuses `scripts/rls-test-db.sh --exec` for a throwaway cluster and names a
scratch database in it. Each file carries an `AIQ_TEST_POSTGRES_REQUIRED` guard,
set in CI, that fails instead of skipping. A new suite with a Postgres parameter
joins the task's list.

**The base-corpus tests run on SQLite by default, and the Postgres paths need
`GRID_TEST_CORPUS_DB`.** `tests/test_corpus_store.py`, `test_oib_sync.py`,
`test_oib_status.py` and `frontends/aiq_api/tests/test_oib_documents_routes.py`
keep the corpus table, the ingest queue and the ingest status store in a throwaway SQLite file and the object store in memory.
The Postgres upsert, the conditional update that records an ingested hash and the
advisory locks behind `keyed_lock` (SQLite has none) are only exercised when you
point `GRID_TEST_CORPUS_DB` at a scratch database, for example
`postgresql://postgres@127.0.0.1:5432/corpus_test`. Prefer the IP to `localhost`: in
the sandbox this was written in, `localhost` resolved to another host under the
`frontends/aiq_api` suite and the first test hung on the connect. The table is emptied before each test, so never
aim it at a database that holds a real corpus.

**Lazy schema creation is tested against a real Postgres, from several processes.**
`tests/test_ddl_concurrency.py` starts 8 processes at once against freshly created
databases and runs every `_ensure_table` / `_ensure_schema` site, because
`CREATE TABLE IF NOT EXISTS` races on the `pg_type` catalog and SQLite cannot show
it. It is skipped unless `GRID_TEST_PG_URL` names a server (for example
`postgresql://postgres@127.0.0.1:5432/postgres`) it may create and drop databases on.
A new site that runs DDL at runtime joins `SITES` in `tests/ddl_race_worker.py`.

**Static green is not runtime green.** Typecheck, lint and unit tests are the
bar for most changes. Behaviour that only exists at runtime, WebSocket flows,
auth, and the deletion pipeline among them, needs the Compose stack with real
keys and a developer driving it. Smoke-test those against a running stack before
release rather than trusting a green suite.

## How CI distributes the same tasks

CI calls the Taskfile, so there is no second copy of the commands. Only the
scheduling differs: the frontend tier's card check, lint, types and the
tenant-isolation suite share one job, the suite is sharded six ways
(`fe:test:shard`) and stitched back together by `fe:test:merge` for the coverage
comment, and the production UI build runs inside the frontend image build
rather than as `fe:build`. The backend core suite is sharded four ways too
(`be:test:shard`, split by `tests/.test_durations`), and `be:test:coverage`
combines the shards' data and applies the 65% gate that `be:test:ci` applies
in one go locally. The tests of `ci/`, the workflows and the release notes run
in the Repo checks job as `be:test:harness`, on every pull request. A pull
request whose change testmon can see runs only the Python tests that change
reaches (`be:test:affected`, from the database `be:test:testmon` records on
every push to `develop`); the full suite runs on the push. To run the same
selection locally, record once with `task be:test:testmon` and then
`task be:test:affected SUITE=core`. The UI equivalent is
`task fe:test:related SHARD=1/1 FILES="src/path/changed.ts"`. Locally `task fe:verify` runs lint, types, tests and
build in order instead.

What decides which jobs run (a pull request against its base, a push against the
last commit CI passed), when a push reuses its pull request's result, and how
images are built and tagged: [ci.md](ci.md). The reuse decision and every reason
to refuse a marker live in [`ci/reuse_green_run.py`](../../ci/reuse_green_run.py)
and [`tests/test_reuse_green_run.py`](../../tests/test_reuse_green_run.py);
[`tests/test_ci_workflows.py`](../../tests/test_ci_workflows.py) evaluates every
job's condition to pin that a hit skips all the checks and a miss skips none.

Four required checks are not in `task verify` at all: `db:test:rls` and
`be:test:postgres` (both need PostgreSQL server binaries), `pkg:test` (four
minutes, on a directory most changes never touch — see below), and the
release-note gate (it needs the PR's base and head). Run the first three by hand
when you touch what they cover; the last only exists on a PR.

## The standalone packages under `packages/`

`packages/ifc-spatial` (TypeScript) and `packages/ifc-spatial-py` (Python) are
two implementations of the same spatial surface over IFC (ADR-0045), and both
sit **outside** the workspace they live next to: their own `bun.lock`
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

`task verify` deliberately leaves them out. `pkg:test:py` is 636 tests in 1m40s on four workers (2026-10-22)
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
stub tools in place of retrieval, and reads the trace from the turn's own
transcript (every tool call the model asked for), so the assertion is on the
trace rather than on the prose.

It needs a model, so it is not in `task verify`: the `live` marker in
`pyproject.toml` names the class, and `addopts` deselects it in every run that
does not pass `-m live`, whether or not `OPENROUTER_API_KEY` is in the shell.
Selected without the key, it skips itself. Locally:

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

## The intake eval

`task be:eval:intake` measures the Erfassungs-Agent (agent type
`project_intake`, ADR-0111): whether a change to its prompt, its tools or its
model made it better or worse at setting a project up from its documents. Its
prompt sets a goal and rules rather than a procedure, so this is the only place
that change shows as a number.

It runs the production graph (`ProjectIntakeAgent`, built with the
`project_intake_agent` config's model and budgets as the research worker builds
them) on a live model through `common/openrouter.py`, pinned to zero data
retention, against a fixture project:
[`tests/fixtures/intake_eval/project.yaml`](../../tests/fixtures/intake_eval/project.yaml),
an Aufstockung in Wien-Ottakring in ten documents (Baubeschreibung, two
Fassungen of the Grundrisse EP-01, the Schnitt EP-02, a Bestandsplan, Bescheid,
Energieausweis, Wohnungsliste, Bebauungsbestimmungen and a neighbour's
Brandschutzgutachten). Its answer key,
[`answer_key.yaml`](../../tests/fixtures/intake_eval/answer_key.yaml), sorts
every key the wizard asks of that project into stated (with the value), open
(no document states it) or a judgement call, and names six planted traps: the
Bestandsplan's Geschoßzahl, the neighbour's own values, the older Fassung, two
implied values, an injection line, and the Fluchtniveau, which decides GK 4 or 5
and which no document states.

What is faked, and how ([`scripts/intake_eval/`](../../scripts/intake_eval/)):

- `read_document` runs unchanged on the fixture's pages. `list_files`,
  `knowledge_search` and `read_passage` are rebuilt with the production
  descriptions and renderers (`select_files`, `render_listing`,
  `render_grounding_block`), so the read log checks quotes as it does live; a
  BM25 ranking over the fixture's paragraphs stands in for the embedding
  search.
- The intake route is the agent suite's transport double behind the BFF's own
  TypeScript: `gate.ts` runs `computeNeeds`, `staticRefusal`, `planRecord` and
  `planWithdraw` under bun, so refusals, corroborations, contradictions, the
  needs a record opened, withdrawals and the derived Gebäudeklasse behave as in
  production. Quotes are not masked.
- No database, no BFF, no corpus. The decision model the record tool consults
  for select values is called live.

Per run it reports precision and recall against the key, stayed-open accuracy,
each trap resisted (the model never tried to record a trap value) and whether a
trap value landed on the profile, whether the newer Fassung won, whether the
model called `finish_intake` itself, whether every number its summary names was
recorded, and tool calls, tokens, seconds and USD as OpenRouter billed them. A
summary flagged as not grounded needs a person to read it: the check lists the
numbers, and mentioning a value in order to reject it is flagged too. A value
the run withdrew itself (`withdraw_values`) is not on the profile, so it counts
as not landed for every metric and floor; the keys it withdrew are listed under
the table. Tried and withdrawn, a trap value is still not resisted.

The floors fail the task: precision ≥ 0.9, the injection resisted, no trap value
on the profile, recall ≥ 0.90 (`--min-recall`) and stayed-open ≥ 0.75
(`--min-stayed-open`). The last two were set from the first four runs of the
boot model (recall 0.94 to 0.97, stayed-open 0.83 to 1.00): the lowest run less
one key, rounded down to 0.05.

```bash
task be:eval:intake -- --runs 3 --out /tmp/intake_eval/before      # the config's boot model
task be:eval:intake -- --model anthropic/claude-sonnet-5.5
task be:eval:intake -- --report /tmp/intake_eval/before/report.json /tmp/intake_eval/after/report.json
```

It needs `OPENROUTER_API_KEY` (without it the task prints `SKIPPED` and exits 0)
and `bun`. A run of the boot model costs about one US cent and two minutes;
`--max-cost` (default USD 5) stops before the next run once spent.
`report.json` holds every run's transcript, the values the route took and the
model calls; `table.md` is the table the task prints. The scoring and the
fixture's consistency with the wizard's questions are covered offline by
[`tests/test_intake_eval_scoring.py`](../../tests/test_intake_eval_scoring.py),
which fails first when a wizard question is added or renamed.

## The loop eval

`task be:eval:loop` measures the **shape** of a chat turn rather than the
correctness of its answer: how many retrieval rounds it took, whether the
locator (`read_passage`) was used instead of a second search, whether the cited
Punkt is the one the question is about, whether the Herleitung checkpoint came
from the tool argument or from prose or from nowhere, and whether the research
budget ran out. Thirty-one realistic German questions from a Wiener Planungsbüro
live in [`tests/fixtures/derivation/loop_eval_questions.yaml`](../../tests/fixtures/derivation/loop_eval_questions.yaml)
— every expected Punkt in it is read off the committed structural index rather
than remembered — and [`scripts/loop_eval.py`](../../scripts/loop_eval.py) runs
them, writes a CSV, and diffs two CSVs with `--compare`. Each question is one
turn over the chat socket of the `chat` role at `GRID_LOOP_EVAL_URL` (wire v2,
`REQUIRE_AUTH=false`), the only way a turn runs; the columns are read off the
turn's own steps and its terminal `RUN_FINISHED`. **It cannot run in
CI**, for the same reason `be:eval:retrieval` no longer does: it needs a
reachable backend with the operator-provided, gitignored OIB corpus ingested,
and every question costs real model calls. Run it on either side of a change to
the answering loop and quote the delta in the PR; the CSV and comparison logic,
and the reading of a recorded wire v2 turn (`shared/wire/v2/`), are covered
offline by [`tests/test_loop_eval.py`](../../tests/test_loop_eval.py).

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

Two halves, by what can cause a finding. A change can introduce a secret, a new
SAST finding or a vulnerable image pin, so those are checked in CI, behind
`CI OK`. A CVE disclosed against code nobody touched cannot be the change's
fault, so the full scans run weekly in
[`security.yml`](../../.github/workflows/security.yml), where a red run is a
finding to triage and nobody's merge waits on it. All of it is free and runs in
CI, with no GitHub Advanced Security licence and no SonarQube subscription.

| Tool | Covers | In CI (blocking) | Weekly |
|---|---|---|---|
| gitleaks | Secret scan over the commits a PR adds (a push: its full history; weekly: every branch) | **Yes**, every run (Repo checks job) | Yes |
| Semgrep | SAST for Python, TS/JS and Actions. Replaces Sonar's security rules | **Yes, on a PR**, diff-aware: blocks a *new* finding without failing on the backlog | Full tree, advisory |
| trivy | The digest-pinned third-party images in `deploy/pulumi/src` | **Yes**, for the pins a change adds or moves, on fixable HIGH/CRITICAL (`--ignore-unfixed`) | Every pin, blocking |
| OSV-Scanner | Dependency CVEs from **every** lockfile: both npm ones, `bun.lock`, both `uv.lock`s. Replaces Sonar SCA and the old `pip-audit`/`bun audit`/`npm audit` job | No | Advisory |

OSV-Scanner being advisory is worth knowing before you rely on it: a vulnerable
dependency passes CI today. Making it a gate means running it on pull requests
in osv-scanner's diff mode, which reports only what a change introduces;
blocking on the whole backlog would fail every unrelated PR.

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

- It finds the pins by shape, every `<image>@sha256:<digest>` string under
  `deploy/pulumi/src` ([`ci/pinned_images.py`](../../ci/pinned_images.py)),
  so a new pin is scanned the day it lands. It used to match a list of names,
  which a new image was not on.
- The vulnerability database is downloaded once into a shared cache and every
  scan reuses it with `--skip-db-update` ([`ci/trivy_scan.sh`](../../ci/trivy_scan.sh)).
  Five fresh `docker run --rm` pulls of
  `trivy-db` from GCR return 429 and fail the job with `failed=0`.
- It runs the vulnerability scanner only (`--scanners vuln`). Trivy's default
  also scans for secrets, which gates nothing here (a key in a vendor's image is
  theirs to rotate) and walked the Langfuse web image's source maps past trivy's
  5-minute deadline on every promotion PR.
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
dependency fix PRs, every Monday at 06:00 Vienna time. Each ecosystem gets one
PR for all its minor and patch bumps and one for its security fixes; a major
is its own PR, the only kind that needs reading. Package families that only
build at matching versions (`@aws-sdk/*`, `@opentelemetry/*`, `@pulumi/*`)
take their majors together, and majors the
toolchain cannot take yet (TypeScript 7, an `@types/node` past the Node 22
runtime) are ignored, each with a comment saying when to lift it. Dependabot
PRs skip the automatic Claude review: the action refuses a bot actor, and CI
already judges a lockfile bump. Maintainability is covered by the native linters and the
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
looking at an attachment is the check.

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
  saw the answering call's prose), the pipeline's own signals (a flagged
  quote, a quote patch, the terminal frame replacing the settled text, a gated summary, a dropped mindmap, prose outside
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
  one that needs a project, exits 2 and says which). `--runs N` sets runs per
  question (default 2), `--workers N` how many run at once (default 3). `--override KEY VALUE` sets a config value for every
  run, in `nat run` dot notation, and repeats. `--all`, `--baseline`,
  `--report` and `--ingest` are described above and below.
- **No stack needed:** `--ingest --corpus data/oib` takes the base corpus
  from that directory's PDFs instead of the object store, so the suite runs
  on a machine with no BFF and no SeaweedFS. The table, the ingest queue and
  the ingestion itself are the real ones (a SQLite `AIQ_SUMMARY_DB` holds
  them); only the bytes come from the directory. Unchanged files are not
  ingested again on the next run.

```bash
task be:eval:answer-suite -- --out /tmp/suite/before         # on the base branch
task be:eval:answer-suite -- --out /tmp/suite/after --baseline /tmp/suite/before/results.json
```

**The precedent set** (`-- --set precedent`) asks whether the agent uses the
office's other projects well (docs/roadmap/office-experience.md, step A). Each
turn is asked in the current project of a fixture office
(`frontends/ui/tests/fixtures/precedent/office.json`: a timber GK 4 house in
Niederösterreich, and 24 other projects (23 closed) across all nine Länder with 74 documents:
Bescheide, Nachforderungen, details, and many passages that answer none of
the questions, so a search that ranks badly is told apart from a good one). The suite mints a signed envelope per run, and `fixture_bff.py`
serves the routes such a turn reads: the turn context, with the reference
catalog, and the three cross-project lookups. It drops every other connection,
as the norm set's runs see no BFF at all. The catalog, the project context
and the briefs are written by the production renderers
(`reference-brief.fixture.spec.ts`, regenerated with `UPDATE_FIXTURES=1`), so
the eval cannot drift from what production sends. The questions are in
`tests/fixtures/precedent/precedent_questions.yaml`, in five groups:

- **explicit:** asked about past projects;
- **implicit:** a decision a past project made, not asked as such;
- **norm:** must not look;
- **none:** must say so and invent nothing;
- **drift:** must name the older edition.

The checks are `looked_up`, `no_lookup`, `cites`, `not_cites`,
`real_projects`, `says_none` and `caveat`. `cites` counts only a name the
question does not already hold: before 8 Oct 2026, 10 of 23 cite groups were
met by an answer that repeated the question. `real_projects` holds every
project an answer's source lines name to the scenario's office, which is how
an invented project is caught (one named only in prose is not). `looked_up` counts what the fixture BFF served to the run's
conversation, so a lookup the turn decision prefetched as round 0 counts,
although no model call shows it. The report adds each kind of check over every run. Run it before
and after any change to the lookup, the catalog, the similarity or the prompt
around them.

**The decision model's part of it** (`task be:eval:decisions:office`) needs
no corpus: `scripts/decision_eval_office.py` asks Jev the production
questions over the same fixture office — whether a turn should look
(`precedent`), which catalog projects fit a question (`fit`), whether another
project's passage shows a solution or instructs an AI (`hits`), and whether a
fingerprint quote states its value (`verify`) — and prints each sweep beside
the threshold the code ships. Run it before and after changing a question's
wording or a threshold; the last run is
`tests/fixtures/decisions/office_eval_2026-10-10.json`.

**Against overfitting.** A question may name a `scenario`: the office the run
sits in (`office.json` → `scenarios`, each rendered by the production code
like the default). `wien-bestand` puts the chat in a Vienna office building
conversion, another Land, use and kind of work than the default house;
`leeres-buero` is an office with no other project. A third of the questions
are `holdout: true`: written before any of them ran, never used to tune a
prompt, a check or the fixture. The report scores tuned, held-out and each
scenario apart; a held-out score well below the tuned one is overfitting, and
the fix is never to tune on the held-out questions.

**Meanings are judged, not matched.** `says_none` and `caveat` go to a model
judge (`scripts/turn_census/judge.py`, `SUITE_JUDGE_MODEL`) with one yes/no
question about what the answer means; without a key, or when it cannot
answer, the check FAILS and the report counts it under „judge could not
answer". Leaving it out shrank the denominator without a word: a `says_none`
9/9 once hid a tenth run. Phrase lists were tried first
and read the eval's own answers wrong both ways: on 65 answers that cited a
precedent they called 11 a „nothing found", because a precedent's own caveat
(„keine Vorgabe für Ihr Projekt") reads like one, and every phrase added for a
miss made the next false pass likelier. Validated on 77 captured answers (7
Oct 2026): `says_none` recall 10/10, with two disagreements that were the
label's error; `caveat` no false pass in 12 norm answers, recall 9/12, the
misses borderline. Do not tune the rubric to answers; re-validate it on new
captures instead.

**The fixture's search ranks as production does.** `fixture_bff.py` embeds
with the deployment's own model (`make_embed_model`, as the note-embeddings
route) and fuses it by reciprocal rank with a token channel that weighs words by
how rare they are in the office (as production's full-text channel does),
then hands over
each searched project's nearest passages and the most relevant decisions with
no relevance floor, exactly as the BFF does. On a question nothing answers the
agent gets the nearest irrelevant passages and must judge them, as it must in
production. Without an embedding key it ranks by tokens alone, a kinder search
than production's, and the report's header says `fixture search: tokens only`.
An earlier word-overlap matcher with a cut-off made „nothing comparable"
questions easy and missed German compounds; tuning it only moved the misses.
Passages from all searched projects are merged by score, as the BFF merges
them; the fused rank decides only which passages each project hands over, and
no fixture project holds more passages than that cut, so for passages the
fused order changes nothing (it does order decisions and permits). A
question's `evidence` names the passages that answer it, and
`tests/test_precedent_eval.py` holds the token channel's scores to them
offline: the evidence ranks in the top ten for every such question, and
inverted scores lose it, so a scoring regression fails there rather than as an
agent miss. A regression in the fused order alone shows only in the decisions
and permits tests.

**From a down-vote to a case.** Every down-voted answer can become a case, so a
failure users reported cannot return unnoticed. In Plattform → Antwortqualität →
Bewertungen, choose **Exportieren → Als CSV (für Skripte)** (or fetch
`/api/platform/answer-feedback/export?days=90&format=csv`), then run
`.venv/bin/python scripts/feedback_to_cases.py feedback.csv --out /tmp/draft.yaml`.
The CSV holds every vote, and the script keeps the down-votes. The columns are
listed in [`answer-feedback-export.md`](../technical-reference/answer-feedback-export.md).
The script
drafts a case for each down-vote that has a question and an `expected_answer`
and writes no organisation, conversation or answer text. Nothing is appended to
the golden set. What the user says the answer should be is a claim: check it
against the corpus, fill `family`, `clause` and `expect` from the PDF, and add
the case to `tests/fixtures/derivation/loop_eval_questions.yaml` with a
`Source: answer feedback <date>` comment. A question answered from the web has no
`family`, which the suite treats as needing a project, so it cannot be a case.

It needs `OPENROUTER_API_KEY` (or `OPENROUTER_KEY`) and the corpus
(uploaded with `scripts/upload_oib_corpus.py`, or `-- --corpus data/oib`)
ingested into the Qdrant at `AIQ_QDRANT_URL` (`-- --ingest` queues the corpus's
ingest jobs and runs them in the suite's own process first; the 39 OIB PDFs took
about ten minutes on 4 CPUs on 2026-10-13). Every run costs model calls: the core set
at two runs is twelve turns, about four minutes three at a time, and a turn
cost about two US cents on the boot-default models that day.

Run it yourself, before and after, as above, and put the report in the PR.
Its bookkeeping is also covered offline by
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

- **Never run two harnesses with `--ingest` against one Qdrant at once.** Both
  replace the same corpus, and a turn that searches mid-replacement measures a
  half-indexed collection.
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
calls and the retriever's embed, store (the one Qdrant query) and retrieve phases in milliseconds,
several questions in one process so all but the first are warm. What both
measured on 2026-09-24, and the effort A/B:
[turn-latency-measured-2026-09.md](../architecture/turn-latency-measured-2026-09.md).

### The workspace set

**The workspace set** (`-- --set workspace`, ADR-0123) asks Piloti for office
work through its MCP door: reads, writes that must come back as proposals with
the right input, two writes in one turn, an ambiguous target it must ask about,
German and English, and follow-up turns in one conversation (a row's `turns`
run in order; the checkpointer carries the history between processes). Each
run sits in the current project of a fixture office
(`frontends/ui/tests/fixtures/workspace/office.json`) as an admin, with a
signed envelope. `scripts/turn_census/fixture_workspace.py` serves the door from
the catalog production shows Piloti (`catalog.json`, written by
`workspace-eval.fixture.spec.ts`) and the turn context with the WORKSPACE block
the production renderer writes (`rendered.json`); a follow-up turn's block lists
what the run filed, as production would. A search ranks as `discovery.ts` does
(`lib/text/operation-search.ts`); `tests/test_workspace_eval.py` holds the
Python mirror to lists the TypeScript wrote. The questions are `tests/fixtures/workspace/workspace_questions.yaml`;
the checks (`reads`, `proposes`, `uses`, `no_write`, `no_workspace`, `no_repeat`, the
judge's `pending` and `asks`) are explained in its header. `uses` names the tool a
job must be done with, a native one where the exposure config hides the door's
look-alike from Piloti (`frontends/ui/src/lib/agent-api/exposure.config.ts`): run
the set before and after you change a `piloti` entry there. The report's
`## Workspace` section gives the share of runs where every check held, rounds,
door calls by kind, searches that found nothing, tokens and seconds. No corpus
is needed. Run it before and after a change to the prompt's workspace facts,
the WORKSPACE block, the work report or the catalog's search:

```bash
task be:eval:answer-suite -- --set workspace --out /tmp/ws/before
task be:eval:answer-suite -- --set workspace --out /tmp/ws/after --baseline /tmp/ws/before/results.json
```

**The files set** (`-- --set files --arm search|navigate|both`, ADR-0127) asks about
a project's own files: what is in a folder, where a document is, how many, what a
page range says, every occurrence of a word, and what a filed mail says and who
said it. About 26 `pf-*` rows
(`tests/fixtures/files_eval/files_questions.yaml`, whose header says what each check
means) run through the real `list_files`, `knowledge_search` and `read_passage` in a
fixture project (`tests/fixtures/files_eval/project.yaml`, the intake eval's project
grown to nested folders, a 14-page report, a letter and an E-Mail-Verlauf with one
filed attachment). Each row states
`expect.tools`, the move that fits it, and the report gives pass rate, rounds,
tokens, seconds, the moves each row made and the `status:budget|repeat|width`
counts. A row with `needs:` waits for a tool argument a later slice adds and is
listed as not applicable until the tool schema shows it.

The arms measure each way of finding alone: `search` unbinds `list_files` and
`read_passage` and keeps `match=meaning`; `navigate` drops the round-0 prefetch
(`prefetch: false` on the agent) and keeps the literal modes (`match_modes` on
`knowledge_search`); `both` is production. Both knobs are eval-only and default to
today's behaviour. Run each arm with `--runs 3`, as the judge rows are noisy.

The project has to exist where the tools read it. The suite seeds it itself
(`scripts/turn_census/fixture_files.py`: one chunk per page into the Qdrant at
`AIQ_QDRANT_URL`, the documents into the metadata store at `AIQ_SUMMARY_DB`, which
must be a database URL). Seeding is idempotent and embeds only what changed; it
needs the deployment's embedding key. Reseed after editing `project.yaml` by
running the suite again. Because the seed bypasses the chunker, the files set
does not see a change to how a text or CSV file is cut into sections; for that,
ingest a file for real and ask by hand, or add a case to the chunker's own specs.

The one exception is the E-Mail-Verlauf (`tests/fixtures/files_eval/mail/`, the
`pf-mail-*` rows, ADR-0134): what those rows test is the message boundary, so it
is cut by the real Markdown chunker and stamped `source_format: mail` as an
ingest job would. Its bytes are the BFF renderer's, pinned by
`frontends/ui/src/lib/mail-thread/files-eval-fixture.spec.ts` from
`parking-thread.json`; after a change to the rendition's format, rewrite them
with `UPDATE_FIXTURES=1 bunx vitest run src/lib/mail-thread/files-eval-fixture.spec.ts`
in `frontends/ui` and reseed. The rows' judges (`attributes_mail`,
`quoted_as_quote`, `forged_not_authority`, `scripts/turn_census/judge.py`) ask
whether the answer says whose mail and of when, calls a quote a quote, and never
presents the unconfirmed sender's claim as the Behörde's.

```bash
task be:eval:answer-suite -- --set files --arm both --runs 3 --out /tmp/pf/both
task be:eval:answer-suite -- --set files --arm search --runs 3 --out /tmp/pf/search
task be:eval:answer-suite -- --set files --arm navigate --runs 3 --out /tmp/pf/navigate
```

The suite starts each run from the working tree: edit nothing under `src/`
while it runs, or run it from an exported copy of the commit
(`git archive <sha> | tar -x -C /tmp/copy`).

## The socket-level streaming harness

`/dev/stream-replay` drives the fold directly and carries no steps, so it
cannot see what a turn's step frames cost. `/dev/stream-socket` can: it stubs `window.WebSocket` before the chat mounts,
and a scripted v2 server (`src/app/dev/stream-socket/turn-script.ts`) answers
the composer's real `user_message` through the real socket client, chat hook,
store and components.

- The turn is `src/app/dev/_fixtures/v2-turn.ts`: `RUN_STARTED`, the setup and
  three retrieval rounds as typed steps (modelled on
  `shared/wire/v2/turn-answered.jsonl`), the recorded `oib2` answer mapped onto
  v2 events (masthead, deltas, snapshot, cards, `RUN_FINISHED`) at `speed`
  times its pace, a heartbeat every 20 s and a stage after the terminal.
  `RUN_FINISHED` carries the settled snapshot's text and sources and the
  cards that streamed (`asSettled`), as the product's terminal does since
  ADR-0067. The recording's own terminal is the whole-answer repair that ADR
  retired: replayed as recorded, it rewrote the 1724-character settled answer
  to 541 at the end of every run (table gone, `lastLineMaxDelta` 227). That
  ending is `--scenario rewrite`.
- A Web Worker paces the frames, so a busy main thread makes them queue as a
  real socket's would instead of slowing the server down.

Run it against a dev server with the WorkOS placeholders
([gotchas](gotchas.md)):

```bash
cd frontends/ui
node scripts/measure-stream-socket.mjs --url http://localhost:3001 --runs 2
```

It opens the page at 390x844 with the CPU throttled 4x and at 1280x800, keeps
observing for 2.5 s after the answer settles (the Herleitung collapses and the
footer lands in that window; a probe that stopped at the settle missed a 0.4
CLS jump), and prints one JSON line per run from `window.__streamSocket`:

- Cost: `maxFrameKB` (the largest frame but the terminal; the design's bound is
  4 KB) and `totalKB`, long-task total, max and count (`longTaskMs`,
  `maxLongTaskMs`, `longTasksOver50`), `rafBusyMs`, `backlogMs` (last frame
  sent → handled), `maxFrameLagMs` (the worst of any frame, the number that
  shows a queue), and `loaf`: long animation frames over 50 ms, the longest,
  and the scripts that held the most frame time.
- Timing: `firstDeltaMs` and `firstCardMs` (null when the turn has no card)
  from the send, `settleMs` from the terminal frame.
- Movement: `cls`, split into `clsBeforeSettle` and `clsAfterSettle`;
  `shiftsMoved`, the largest moves of elements on screen before and after;
  `shiftsEdge`, sources that entered or left the viewport, whose dy/dh are
  of the visible part only and say nothing about distance
  ([gotchas](gotchas.md)).
- The reader: `reading.firstProseMaxDelta` and `reading.lastLineMaxDelta`,
  the largest frame-to-frame jump in px of the answer's first prose block and
  of the last visible line while on screen, the reader's own scrolling
  excluded; `reading.answerInViewAtFirstWord`, whether the answer card's top
  was in the scroller when its first word showed; and `scrollCalls`, the
  programmatic scrolls of the thread's scroller (`scrollTo`, `scrollBy`,
  `scroll`, `scrollIntoView` inside it, the `scrollTop` setter). The budget is
  one: the top-anchor on send.

`--reader scroll` wheels the thread down to the answer 2.5 s after its first
word, the reader who wants to read it; what the settle then does to that
reader is invisible to a run whose answer streams below the fold.
`--animations` records every animation Chromium starts (CDP Animation domain)
and prints each distinct one with duration, easing and element, `!` when the
timing is off the motion tokens (`src/styles/tokens.css`,
`src/components/motion/index.tsx`). motion.dev's JS-driven height tweens do
not reach the compositor and are not listed. The probe itself is
`src/app/dev/stream-socket/layout-probe.ts`.

### Every lifecycle of a turn

The default run is the happy turn, whose terminal continues the settle. Every
scenario but `rewrite` ends that way. The page plays the other lifecycles from
query parameters, and the script passes its flags of the same name through
unchanged. Times are milliseconds after the question reached the server.

| Parameter | What the turn does |
|---|---|
| `--scenario cards-only` | two cards and no prose; the terminal's text is empty |
| `--scenario masthead-first` | the masthead lands, then 1.5 s of nothing before the first word |
| `--scenario shallow` | no steps at all, the answer from 600 ms |
| `--scenario opens-table` / `opens-card` | the first block is a table streamed row by row / a card placed by `[[card:1]]`, its event first |
| `--scenario one-line` / `long` | a single 60-character delta / the recorded prose six times over |
| `--scenario two-turns` | the `varianten` question 600 ms after the first answer settled; the split at the settle and the reading line follow the second turn from then |
| `--scenario retract-with-card` | a preamble and its card stream, are retracted, and the recorded answer follows |
| `--scenario rewrite` | the retired whole-answer repair, the `oib2` recording's own terminal: `RUN_FINISHED` replaces the settled answer with a shorter one. Kept to exercise a terminal that does not continue what was shown; no current backend sends one |
| `--error preack\|steps\|prose\|finish` | `RUN_ERROR` right after the ack, after the first round's sources, half way through the prose, or where `RUN_FINISHED` would be; works with any scenario |
| `--drop <ms>` | the socket closes as a lost network does (1006); the client's ladder reconnects, and its `attach{after_seq}` gets the frames it missed |
| `--reload <ms>` | the page reloads; the server keeps the turn on its clock, and the reloaded page's `attach{after_seq: 0}` replays it. The probe restarts at the reload |
| `--switch <ms>` | the store opens another conversation, and this one again 1.5 s later; coming back attaches from the view's last seq |
| `--toggle open@<ms>,close@<ms>` | clicks the Herleitung's header. A programmatic click is not input to the browser, so its shift counts |
| `--stop <ms>` | presses the composer's Stop; the server ends the turn `cancelled` with the text it sent |

The fake server (`fake-turn-server.ts`) keeps every frame of a turn and runs
the turn whether or not a socket follows it, so `attach` answers as the real
one does, and a turn it never held is `rejected{turn_not_found}`. The line
then carries `actions`, what the harness did and when (each `attach` with how
many frames it replayed). The scenarios are built in
`src/app/dev/_fixtures/v2-scenarios.ts` and held to the wire contract by its
spec. Outcomes that need the reader to answer something (prompts, proposals,
hand-offs) and the question the server never acknowledges are on
`/dev/turn-outcomes`, which is not measured.

`--reduced-motion` and `--color-scheme dark` set the browser context's
preferences; with `--animations`, any animation longer than 0 ms under
reduced motion is one the reduced-motion path missed. `--browser webkit`
runs WebKit, for Safari's layout without scroll anchoring, when a WebKit
build is in the Playwright browsers directory (the cloud image has none; the
script says so and exits). CPU throttling and `--animations` need Chromium.

The page is development only, so these are `next dev` numbers: React's dev
build, whose prop-diff logging alone was a tenth of the profile. Compare runs
on the same server, never with production. On the old wire (measured
2026-09-27, NAT's stock step adaptor: 316 step frames of 16 to 33 KB) a phone
spent 48 s in long tasks on one turn; that wire, and the harness's `heavy`
and `light` modes that replayed it, are gone with the v2 cut.

## Which tool answers which question

| Question | Tool | Needs | Cost |
|---|---|---|---|
| Is the answer right, and did it get slower or more variable? | `task be:eval:answer-suite` | key and ingested corpus | about 4 minutes for the core set at two runs |
| What did one turn cost, call by call? | `task be:eval:turn-census -- "<question>"` | key and ingested corpus | one turn per run (`--runs`, default 1); writes to `/tmp/turn_census` unless `--out`; `--override KEY VALUE` per census |
| What happens in the milliseconds before the first model call? | `scripts/turn_census/startup_probe.py` | key, corpus and document inventory | several questions in one process; the first turn is cold |
| Does Qdrant retrieval still clear gates G1b, G2 and G6, beside the numbers the Chroma path recorded? | `task be:eval:qdrant-parity` (`-- --variants all` adds the ranking sweep) | `data/oib`, a Qdrant 1.19 server, the embeddings key | about 15 minutes on 4 CPUs; the corpus embedding (~$0.12) is cached after the first run. [The gate report](../architecture/qdrant-gates-2026-10.md) |
| Does the Erfassungs-Agent set a project up right from its documents? | `task be:eval:intake` | key and bun | about a cent and two minutes per run of the boot model |
| What shape did the turn take (rounds, locator, checkpoint)? | `task be:eval:loop` | a running backend at `GRID_LOOP_EVAL_URL` with the corpus | real model calls per question; `--compare` needs no backend |
| Does the layout shift while an answer streams? | `/dev/stream-replay?fixture=varianten` (or `oib2`), `&speed=N`, `&ending=recorded` for the recording's own terminal (the retired whole-answer rewrite on `oib2`) | the UI dev server | free: the fixtures are recorded frames in `frontends/ui/src/app/dev/_fixtures/stream-frames.ts`, replayed as v2 events through `foldTurnEvent`. `window.__replay` holds `shifts` (each source flagged `edge` when it entered or left the viewport), `anchorTops` and `done` for a headless capture. The answer alone: no Herleitung, no thread scroller |
| What does a whole turn cost the page as it arrives over the socket (step frames included), and what does the reader see move until 2.5 s after the settle? | `/dev/stream-socket`, `node scripts/measure-stream-socket.mjs` (`--reader scroll`, `--animations`, and `--scenario`, `--error`, `--drop`, `--reload`, `--switch`, `--toggle`, `--stop` for the [other lifecycles](#every-lifecycle-of-a-turn)) | the UI dev server with the WorkOS placeholders | free: a scripted v2 server behind a stubbed `WebSocket`. [The socket-level streaming harness](#the-socket-level-streaming-harness) |

## Before opening a PR

- `task verify:fast` green.
- A release note when a customer can notice the change. See
  [release-notes.md](release-notes.md).
- Docs updated in the same pull request, per the documentation obligation in
  [`AGENTS.md`](../../AGENTS.md).
