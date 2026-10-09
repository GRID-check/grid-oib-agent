---
name: aiq-maintain-ci
description: Use when changing AI-Q continuous integration, pre-commit, or contributor governance — editing .github/workflows/ (ci, deploy, security, pr, release-notes and the scheduled checks), .github/filters.yml, .github/actions/, ci/ scripts, .pre-commit-config.yaml hooks, or .github/CODEOWNERS — and validating those changes without breaking the gate.
license: Apache-2.0
compatibility: Claude Code, Codex, Cursor, OpenCode, and Agent Skills-compatible tools.
metadata:
  version: "0.3.0"
  source-repo: "NVIDIA-AI-Blueprints/aiq"
  tags: "aiq ci github-actions pre-commit governance"
allowed-tools: Read Bash Edit
---

# Maintain AI-Q CI and Governance

Use this skill when a developer changes AI-Q's CI, pre-commit hooks, or
contributor governance: the GitHub Actions workflows, the path filters and
`ci/` scripts they call, the pre-commit config, or CODEOWNERS. These surfaces
gate every PR, so a change must keep the gate working and must not weaken
security or review rules.

## Start Here

- Read [docs/contributing/ci.md](../../docs/contributing/ci.md) first. It says
  what each workflow is for, how CI decides what to run, and why each rule
  exists. A change that does not fit one of those purposes needs a reason.
- Identify the surface: a workflow (`.github/workflows/`), a composite action
  (`.github/actions/`), the tier filter (`.github/filters.yml`), a script a
  workflow runs (`ci/`), a pre-commit hook (`.pre-commit-config.yaml`), or
  governance (`.github/CODEOWNERS`).
- Make the smallest change; do not weaken secret detection, auth gating, or
  code-owner review without a prior design discussion (see `AGENTS.md`).
- CI runs directly on the PR (`pull_request` events). This private repo has no
  copy-pr-bot mirror and no `/ok to test`.

## Authoritative References

- [docs/contributing/ci.md](../../docs/contributing/ci.md): the design.
- [CONTRIBUTING.md](../../CONTRIBUTING.md): the merge gate (`CI OK`) and the
  secret-scan exceptions.
- `.github/workflows/ci.yml`: `changes` (Plan) answers what the change touched,
  whether a push may reuse its PR's result, which images to build and which
  image pins trivy scans. The checks (`repo`, `semgrep`, `backend`, `frontend`,
  `frontend-test`, `web`, `infra`, `packages`, `trivy`, `image`) read it;
  `image-push` and `publish` build and tag images on push; `ci-ok` is the
  required check.
- `.github/workflows/deploy.yml`: staging follows a green CI push run.
- `.github/workflows/security.yml`: the weekly full scans. Not a gate.
- `.github/filters.yml`: the test tiers. Image inputs are NOT here; they are
  read from the Dockerfiles by `ci/image_inputs.py`.
- `tests/test_ci_workflows.py`: evaluates every job's condition.

The full workflow and hook inventory:
[references/workflows-and-hooks.md](references/workflows-and-hooks.md).

## Workflow

1. Locate the exact workflow, hook, or governance file and read it plus
   `docs/contributing/ci.md`.
2. Make the smallest scoped change. A new job in `ci.yml` takes its `if:` from a
   `changes` output, or it re-runs on every merge including the reused ones. A
   new check that must pass before images are tagged goes into the `needs` of
   both `publish` and `ci-ok`. Spend a runner slot only when it shortens the
   critical path: a job that shares a toolchain with another belongs in it.
3. Lint the change: `actionlint` (install with
   `go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.7`).
4. Reproduce the affected gate locally: the pre-commit hooks, the job's
   underlying `task`, and `pytest tests/test_ci_workflows.py
   tests/test_reuse_green_run.py tests/test_last_green.py
   tests/test_image_inputs.py tests/test_pinned_images.py` for any CI change.
5. Summarize changed files and the local validation evidence.

## Validation

```bash
.venv/bin/pre-commit run --all-files                  # every hook
.venv/bin/pre-commit run --files <changed>            # faster, during iteration
actionlint                                            # every workflow
.venv/bin/pytest tests/test_ci_workflows.py tests/test_image_inputs.py -q
```

Expected: hooks pass (or only auto-fix), actionlint is silent, the tests pass.
Backend tests are not a hook: CI's `backend` job runs the core, aiq_api and
`sources/` suites; `task be:verify` runs them locally.

## Common Mistakes

- Widening the `.gitleaks.toml` allowlist, weakening auth gating, or weakening
  code-owner review to make CI pass.
- Adding a job whose `if:` ignores `needs.changes.outputs`, so it runs again on
  a push that reuses its PR's green result. `tests/test_ci_workflows.py` fails
  on it.
- Diffing a push against `github.event.before`. A push diffs against the last
  green commit (`steps.green.outputs.sha`); the previous push hides a red tier.
- Giving a pull request job `packages: write`. Only `image-push` and `publish`
  may write to GHCR, and only on push.
- Hand-listing which paths go into an image. `ci/image_inputs.py` reads the
  Dockerfile's COPY lines.
- Making a security scan block every PR for a finding the PR did not cause
  (a new CVE in an untouched pin). That belongs in the weekly run.
- Assuming `pre-commit run --all-files` reproduces the whole gate. Backend
  tests run in CI's `backend` job, not in a hook; run `task be:verify` yourself.
- Editing `.github/CODEOWNERS` without updating the paths it routes, so reviews
  go to the wrong owners.

## Related Skills

- `aiq-release-qa`
- `aiq-prepare-pr`
