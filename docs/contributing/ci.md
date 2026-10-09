# CI: what it is for, and how it decides what to run

This page is the design of the GitHub Actions setup. The workflow files carry
the details next to the code they explain; this is the map, and the reasons.

## What CI is for

| Job to do | When | Where | Gate? |
|---|---|---|---|
| Prove a pull request, applied to its base, keeps every check its change could break | every push to a PR | `ci.yml` | **Yes: `CI OK`** is the one required status check |
| Prove the merged result, build its images, tag them for the commit | every push to `develop` and `release/**` | `ci.yml` | It is what the deploy waits for |
| Put a green `develop` commit on staging | after a green push run of CI | `deploy.yml` | Staging only ever runs a commit CI passed |
| Put the pinned commit on production | push to `prod`, with reviewers | `deploy.yml` | The `production` environment's reviewers |
| Notice what turns red without a code change: new CVEs, a secret in history, external links, model drift, WorkOS drift | weekly | `security.yml`, `docs-links.yml`, `turn-shapes-live.yml`, `workos-drift.yml` | No. A red run is a finding to triage |
| PR hygiene: Conventional title, closing keywords, labels | PR events | `pr.yml` | The title check |
| Publish the changelog | merge touching `releasenotes/` | `release-notes.yml` | No |

Everything else (`claude.yml`, `claude-code-review.yml`, `blog-preview.yml`,
`labels.yml`) is assistance, not verification.

## How a CI run decides what to run

The `changes` job (named **Plan**) answers three questions before any check
starts, and every other job reads its answers.

**1. What did this change touch?** `dorny/paths-filter` over
[`.github/filters.yml`](../../.github/filters.yml), against a base:

- a pull request diffs against its base branch, the whole PR on every push;
- a push diffs against the **last commit CI passed on that branch**
  ([`ci/last_green.py`](../../ci/last_green.py)), never against the previous
  push. When there is no such commit, or the lookup fails, it diffs against the
  root commit and everything runs.

The second rule is what makes the rest safe. A push that diffed only against
its parent let a red commit's tier stop running as soon as an unrelated commit
landed on top of it, and the deploy shipped the broken code under a green run.

**2. Was this exact tree already tested?** A squash merge onto a `develop` that
did not move lands the tree the PR's last run tested. If that run was green
*and* the pushed commit's parent is the last green commit, every check skips
([`ci/reuse_green_run.py`](../../ci/reuse_green_run.py)). The parent condition
matters: a PR run that skipped the backend because it did not touch it proves
nothing about a backend that was already red on `develop`.

**3. Which images does this run build?** Each image is named by a hash of the
files its Dockerfile copies, plus the ISO week
([`ci/image_inputs.py`](../../ci/image_inputs.py)). A PR builds the images
whose hash its change moves, and pushes nothing. A push builds the images GHCR
does not have yet under `inputs-<hash>`, and re-tags the rest. The week is in
the hash because base images (`node:22-slim`, `debian:bookworm-slim`) are
floating tags: every image is rebuilt at least weekly, so a patched base
reaches production without anyone asking.

It also lists the third-party image pins the change adds or moves
([`ci/pinned_images.py`](../../ci/pinned_images.py)), for trivy.

## The jobs

| Job | Runs when | What it does |
|---|---|---|
| Plan (`changes`) | always | the three answers above |
| Repo checks (`repo`) | unless reused | pre-commit on all files, the agent-skill lockfile, ruff, release-note lint and (PRs) the release-note requirement, gitleaks over full history |
| SAST (`semgrep`) | PRs touching code | Semgrep, diff-aware: blocks findings the PR introduces |
| Backend tests (`backend`) | backend tier | core suite with the 65% coverage gate, the aiq_api suite, the `sources/` suites |
| Frontend (`frontend`) | frontend tier | card schema check, lint, types, and the tenant-isolation suite against a real Postgres |
| Frontend tests (`frontend-test`) | frontend tier | the vitest suite in 4 shards |
| Frontend coverage | PRs, frontend tier | merges the shards' coverage into the PR comment. Not in `CI OK` |
| Web, Infra, Standalone packages | their tier | `task web:verify`; `task infra:types` + `infra:test`; `task pkg:test:*` |
| Image vulns (`trivy`) | a pin added or moved | trivy on those pins |
| Image build (`image`) | PRs that change an image's inputs | builds it, read-only token, no push. For the UI this IS the production build check: `fe:build` is not run separately |
| Image build + push (`image-push`) | pushes, image not in GHCR | builds and pushes `inputs-<hash>` and the layer cache |
| Tag images (`publish`) | pushes, after every check passed | `sha-<commit>` on all three images, and `latest` on `develop` |
| `CI OK` (`ci-ok`) | always | fails unless every needed job passed or was skipped; on a green PR, records the tested tree for reuse |

`task verify` runs the same checks locally, minus the image builds, the RLS
suite and `packages/` (see
[testing-and-verification.md](testing-and-verification.md)).

## Images and deploys

The contract, end to end:

1. A push builds content-addressed images (`inputs-<hash>`) beside its checks.
   An image tag of that kind claims nothing about any commit.
2. Only when every check on the push has passed does `publish` put
   `sha-<commit>` on **all three** images. A commit CI failed has no `sha-` tag.
3. `CI OK` needs `publish`, so a push run concludes `success` only with the
   tags in place.
4. `deploy.yml` runs on `workflow_run` of CI, for a successful **push** run of
   this repository on `develop`, and pins all three services to
   `sha-<commit>`. No polling, no per-service guessing.
5. A prod promotion pins any `develop` commit CI passed. All of them have all
   three images.

What this replaced, and why it had to go: Publish Images rebuilt each image
only when its own paths changed since the previous push, from two hand-written
path lists that disagreed with the Dockerfiles. On 2026-10-09 a merge train of
nine commits ran Publish Images nine times; seven runs were dropped as
superseded while queued, and the last one diffed only against its own parent,
a changelog commit. It built the web image. The frontend and backend changes of
five merged pull requests were never built, and staging kept running the old
images until someone dispatched a rebuild by hand.

`GRID_GIT_SHA` inside an image is the commit that *built* it. An image whose
inputs did not change is re-tagged, not rebuilt, so a container reports the
commit its code came from.

## Quick merges one after another

A branch has one concurrency group. A running push run is never cancelled; a
queued one is replaced when a newer push arrives. A train of nine merges
therefore costs the run in progress plus one more, and the survivor diffs
against the last green commit, so it covers every commit that was dropped. A
dropped run concludes `cancelled`, which the deploy reads as superseded.

A pull request's newer push cancels its older run, since every PR run diffs
the whole PR.

What this does not give you is a test of each PR against the PR merged just
before it. GitHub's merge queue does that, by testing the merge group before it
lands; the push run here is what catches a semantic conflict after the fact,
and it does catch it before staging. Enabling the queue is a repository setting
(and for a private repository, a plan question); `ci.yml` would need a
`merge_group` trigger, and the reuse marker would then hit on every merge.

## Runner slots are the budget

The repository's runners are capped. Before this design, a full-stack PR push
started about 33 jobs across CI (19), Security (6), Docker Build (4), PR (3) and
CodeQL (3), and a merge train ran a full CI per commit. Measured on
2026-10-08/09 over 100 PR runs of CI: the median successful run took **43
minutes** from push to green (p90 53) for about five minutes of work. One run's
jobs sat queued for 20 to 29 minutes, and its three-second `CI OK` job waited
nine minutes for a runner.

So the rule is: work that shares a toolchain shares a job, unless splitting it
shortens the critical path. Lint, the release-note checks and gitleaks share the
Python job; the aiq_api and `sources/` suites ride with the core suite; tenant
isolation rides with UI lint and types; the UI has four shards, not six, because
with four the slowest shard (194s) already fits inside the backend lane. Security
scans that cannot be caused by a change moved to the weekly run.

One duplicate remains outside this repository's files: GitHub's **CodeQL
default setup** runs three analysis jobs on every PR push and a five-to-ten
minute analysis on every `develop` push, beside Semgrep, which was adopted to
replace CodeQL. Turning one of them off is a setting
(Settings → Code security), and it is the largest remaining cost per push.

## Repository settings this design expects

- Required status checks on `develop`: **`CI OK`** and **`Conventional PR
  title`**. Not `Security OK`: that job no longer exists, and a required check
  that never reports blocks every PR.
- The `staging` and `production` environments as in
  [cd.md](../deployment/cd.md).

## Changing CI

The surfaces are the workflows (`.github/workflows/`), the composite actions
(`.github/actions/`), the tier filter (`.github/filters.yml`), the scripts the
workflows run (`ci/`), the hooks (`.pre-commit-config.yaml`) and review routing
(`.github/CODEOWNERS`). Every one of them gates every pull request, so a change
that does not serve one of the jobs in the first table needs a reason.

- A new job takes its `if:` from a `changes` output, or it runs on every merge
  including the reused ones. [`tests/test_ci_workflows.py`](../../tests/test_ci_workflows.py)
  evaluates every job's condition and fails on one that does not skip.
- A new job that must pass before images are tagged goes into `publish`'s
  `needs` as well as `CI OK`'s; the same test checks that.
- A push diffs against the last green commit (`steps.green.outputs.sha`), never
  `github.event.before`: the previous push hides a red tier.
- Only `image-push` and `publish` write to GHCR, and only on a push. No pull
  request job gets `packages: write`.
- Image inputs come from the Dockerfiles' `COPY` lines
  ([`ci/image_inputs.py`](../../ci/image_inputs.py)). Do not hand-list paths.
- A finding the change did not cause (a new CVE in an untouched pin) belongs in
  the weekly run, not in a check that blocks every pull request.
- Make CI pass by fixing the cause. Widening the `.gitleaks.toml` allowlist,
  loosening auth gating or code-owner review is a design discussion first.
- A `CODEOWNERS` change goes with the paths it routes, or reviews go to the
  wrong people.

Verify a change before you push it:

```bash
actionlint                                  # go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
.venv/bin/pre-commit run --files <changed>
.venv/bin/pytest tests/test_ci_workflows.py tests/test_reuse_green_run.py \
  tests/test_last_green.py tests/test_image_inputs.py tests/test_pinned_images.py -q
```

`pre-commit` is not the whole gate: the backend suites run in the `backend` job,
not in a hook, so run `task be:verify` when you touch what they cover. Run the
job's own `task` too, and `bash -n` any `run:` block you edited. When a run
fails, read the job's log for the failing line rather than the summary, and
exercise an external call (a registry, an API) against the real service before
saying the fix works. Some paths only run after the merge, on a push; say
plainly which ones your change could not prove.
