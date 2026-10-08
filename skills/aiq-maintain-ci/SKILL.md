---
name: aiq-maintain-ci
description: Use when changing AI-Q continuous integration, pre-commit, or contributor governance — editing .github/workflows/ (ci, security, docker-build, pr, publish-images, deploy and the scheduled checks), .github/filters.yml, ci/ scripts, .pre-commit-config.yaml hooks, or .github/CODEOWNERS — and validating those changes without breaking the gate.
license: Apache-2.0
compatibility: Claude Code, Codex, Cursor, OpenCode, and Agent Skills-compatible tools.
metadata:
  version: "0.2.0"
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

- Identify the surface: a workflow (`.github/workflows/`), the shared path
  filter (`.github/filters.yml`), a script a workflow runs (`ci/`), a pre-commit
  hook (`.pre-commit-config.yaml`), or governance (`.github/CODEOWNERS`).
- Read the authoritative files below and `CONTRIBUTING.md` "CI and the merge
  gate" before editing.
- Make the smallest change; do not weaken secret detection, auth gating, or
  code-owner review without a prior design discussion (see `AGENTS.md`).
- CI runs directly on the PR (`pull_request` events). This private repo has no
  copy-pr-bot mirror and no `/ok to test`.

## Authoritative References

- [CONTRIBUTING.md](../../CONTRIBUTING.md): the merge gate (`CI OK`), security
  scanning and secret-scan exceptions.
- [AGENTS.md](../../AGENTS.md): "Obligations" and the `task verify` gate CI
  mirrors.
- `.github/workflows/ci.yml`: jobs `changes`, `backend-lint` (`task be:lint`),
  `repo-lint` (`pre-commit run --all-files`, then `task agents:audit`),
  `backend-test` (the coverage-gated core suite), `backend-test-plugins` (the
  aiq_api suite and the `sources/` suites), `frontend`, `frontend-test`, `frontend-coverage`,
  `tenant-isolation`, `web`, `infra`, `packages` and `release-note`. `ci-ok` is
  the required check.
- `.github/workflows/security.yml`: Semgrep, OSV-Scanner, gitleaks and trivy,
  gated by `security-ok`.
- `.github/filters.yml`: the path families `ci.yml` and `docker-build.yml`
  both read.
- `.pre-commit-config.yaml`: the hook set, all at the default stage.
- `.github/CODEOWNERS`: review routing.

The full workflow and hook inventory:
[references/workflows-and-hooks.md](references/workflows-and-hooks.md).

## Workflow

1. Locate the exact workflow, hook, or governance file and read it plus the
   relevant `CONTRIBUTING.md` section.
2. Make the smallest scoped change; keep job names, triggers, and the `changes`
   path gate intact unless that is the change. A new job in `ci.yml` or
   `security.yml` takes its `if:` from a `changes` output (or `reused`), or it
   re-runs on every merge.
3. Lint the change: validate YAML and, for workflows, run `actionlint` if it is
   installed.
4. Reproduce the affected gate locally: run the pre-commit hooks, the job's
   underlying `task`, and `pytest tests/test_ci_change_detection.py
   tests/test_reuse_green_run.py` for any workflow change.
5. Summarize changed files and the local validation evidence.

## Validation

```bash
.venv/bin/pre-commit run --all-files                  # every hook
.venv/bin/pre-commit run --files <changed>            # faster, during iteration
actionlint .github/workflows/<file>.yml               # if actionlint is installed
```

Expected: hooks pass (or only auto-fix) and any edited workflow is valid YAML.
Backend tests are not a hook: CI's `backend-test` job runs the core suite and
`backend-test-plugins` the aiq_api and `sources/` suites; `task be:verify` runs
all three (plus `be:lint`) locally.

## Common Mistakes

- Widening the `.gitleaks.toml` allowlist, weakening auth gating, or weakening
  code-owner review to make CI pass.
- Adding a job whose `if:` ignores `needs.changes.outputs`, so it runs again on
  a push that reuses its PR's green result.
  `tests/test_ci_change_detection.py` fails on it.
- Assuming `pre-commit run --all-files` reproduces the whole gate. Backend tests
  run in CI's `backend-test` jobs, not in a hook; run `task be:verify` yourself.
- Editing `.github/CODEOWNERS` without updating the paths it routes, so reviews
  go to the wrong owners.

## Related Skills

- `aiq-release-qa`
- `aiq-prepare-pr`
