# Workflows and hooks

Authoritative sources: the workflow files under `.github/workflows/` and
`CONTRIBUTING.md` "CI and Bot Workflow".

## Workflows

- `ci.yml` ("AIQ CI") — jobs: `pre-commit`, `test` (pytest with a coverage gate),
  `helm-lint` (deploy charts), `test-scripts`. The `pre-commit` job does **not**
  run the full hook set: it runs `ruff check .` / `ruff format --check .`
  separately and `SKIP=ruff-check,ruff-format,pytest,helm-lint pre-commit run
  --all-files`, leaving pytest/helm-lint to their own jobs.
- `ui.yml` — jobs `install`, `lint`, `type-check`, `unit-test`, `build` for
  `frontends/ui/`.
- `skills-eval.yml` ("Skills Eval") — runs on `push` and `workflow_dispatch`. A
  `detect-changes` job path-gates the run; the trigger deliberately does not use a
  `paths:` filter (see the comment in the file). See the skill-eval-harness
  reference for the stages.
- `request-nvskills-ci.yml` — comment-triggered NVSkills CI request.

## CI trigger flow

This repo is private: CI runs **directly on the PR** (`pull_request` events on
`.github/workflows/ci.yml`). There is no copy-pr-bot mirror, no `/ok to test`,
and no `/merge` bot — those were upstream NVIDIA AI-Q conventions and were
removed here (see the header comment in `ci.yml`). Pushing the branch updates
the PR checks automatically.

## Pre-commit hooks

`.pre-commit-config.yaml` is the source of truth. Default-stage hooks (run by a
plain `pre-commit run`) include: `ruff-check`, `ruff-format`, `uv-lock`,
`check-merge-conflict`, `check-added-large-files`, `check-yaml`,
`end-of-file-fixer`, `trailing-whitespace`, `detect-secrets`, `validate-skills`,
`clear-notebook-output-cells`, and `markdown-link-check`.

Two hooks — `pytest` and `helm-lint` — are `stages: [push]`, so a default
`pre-commit run` / `pre-commit run --all-files` **skips them**. Include them
explicitly with `pre-commit run --all-files --hook-stage push`. CI does not run
them via the `pre-commit` job either (it `SKIP=`s them); they run as the dedicated
`test` and `helm-lint` jobs in `ci.yml`.

## Validation

```bash
uv run pre-commit run --all-files                     # default-stage hooks
uv run pre-commit run --all-files --hook-stage push   # + pytest, helm-lint
actionlint .github/workflows/<file>.yml               # if installed
```

Expected: hooks pass (or only auto-fix), and any edited workflow is valid YAML
that `actionlint` accepts.
