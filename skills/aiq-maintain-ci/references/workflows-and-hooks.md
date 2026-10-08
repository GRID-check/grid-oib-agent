# Workflows and hooks

Authoritative sources: the workflow files under `.github/workflows/` and
`CONTRIBUTING.md` "CI and the merge gate".

## Workflows

- `ci.yml` ("CI") — PRs and pushes to `develop` and `release/**`. Jobs:
  `changes` (path filter over `.github/filters.yml`, plus the reuse lookup on
  push), `backend-lint` (`task be:lint`: ruff check and format), `repo-lint`
  (`pre-commit run --all-files`, then `task agents:audit`), `backend-test` (the
  coverage-gated core suite, the aiq_api suite and the `sources/` suites, which
  `task be:verify` runs locally), `frontend`, `frontend-test` (six shards),
  `frontend-coverage`, `tenant-isolation`, `web`, `infra`, `packages`,
  `release-note` (note lint on every run; requiring a note only on pull
  requests), and `ci-ok`, the single required check.
- `security.yml` ("Security") — Semgrep, OSV-Scanner and trivy behind the
  `changes` filter, gitleaks on every run, and `security-ok` ("Security OK"),
  the aggregate gate. Also weekly on a schedule, always in full.
- Reuse on push: a green `pull_request` run's gate job (`ci-ok`,
  `security-ok`) uploads a `ci-green-<tree>` / `security-green-<tree>` marker,
  and on push `changes` runs `ci/reuse_green_run.py`. On a hit every tier output
  is `'false'`, every job skips and the run still concludes `success`, which is
  what `deploy.yml`'s gate reads. A new job must take its `if:` from a
  `changes` output (or `reused`), or it re-runs on every merge;
  `tests/test_ci_change_detection.py` evaluates every job's condition and fails
  on one that does not skip.
- `docker-build.yml` ("Docker Build") — builds the backend, frontend and web
  images on PRs, no push, reading the shared path filter.
- `pr.yml` ("PR") — `pull_request_target` hygiene: the Conventional PR title
  check, closing keywords, and labels. Never checks out PR code.
- `blog-preview.yml` — screenshots changed blog posts on PRs that touch
  `frontends/web/src/content/`. Informational, never blocks.
- `publish-images.yml` ("Publish Images") — builds and pushes the images to GHCR
  on pushes to `develop`, `release/**` and `v*` tags.
- `deploy.yml` ("Deploy (staging)") — chained off Publish Images on `develop`;
  requires the commit's CI and Security runs to be green first.
- `release-notes.yml` ("Release notes") — on `develop`, regenerates the
  published changelog from `releasenotes/` and commits it back.
- `labels.yml` ("Sync Labels") — syncs `.github/labels.yml` to the repo labels
  (`skip-delete`).
- Scheduled and on demand: `docs-links.yml` (weekly external link sweep),
  `turn-shapes-live.yml` (weekly live-model turn shapes), `workos-drift.yml`
  (weekly WorkOS drift check).
- `claude.yml` and `claude-code-review.yml` — the `@claude` agent and the
  automatic PR review.

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
.venv/bin/pre-commit run --all-files                  # every hook
actionlint .github/workflows/<file>.yml               # if installed
```

Expected: hooks pass (or only auto-fix), and any edited workflow is valid YAML
that `actionlint` accepts.
