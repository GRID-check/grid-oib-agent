# Workflows and hooks

Authoritative sources: the workflow files under `.github/workflows/` and
`CONTRIBUTING.md` "CI and Bot Workflow".

## Workflows

- `ci.yml` ("CI") — jobs: `changes` (path filter), `backend-lint` (`task be:lint`:
  ruff check and format), `repo-lint` (`pre-commit run --all-files`, then
  `task agents:audit`), `backend-test` (the coverage-gated core suite, the
  aiq_api suite and the `sources/` suites), the frontend, tenant-isolation, web,
  infra and packages jobs, `release-note` (pull requests only), and `ci-ok`, the
  single required check.
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

`.pre-commit-config.yaml` is the source of truth. A plain `pre-commit run` runs
every hook, all at the default stage: ruff-check and ruff-format, uv-lock, the
pre-commit-hooks set (check-merge-conflict, check-added-large-files, check-yaml,
end-of-file-fixer, trailing-whitespace), the repo's own checks (sync-platform-skills,
card-schemas, wire-schemas, agent-docs, adr-check, hidden-unicode, doc-paths,
validate-skills), and markdown-link-check. Secret scanning is not a hook: gitleaks
runs in `security.yml`.

## Validation

```bash
uv run pre-commit run --all-files                     # every hook
actionlint .github/workflows/<file>.yml               # if installed
```

Expected: hooks pass (or only auto-fix), and any edited workflow is valid YAML
that `actionlint` accepts.
