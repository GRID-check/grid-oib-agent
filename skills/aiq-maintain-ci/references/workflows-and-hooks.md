# Workflows and hooks

Authoritative sources: the workflow files under `.github/workflows/` and
`CONTRIBUTING.md` "CI and the merge gate".

## Workflows

The design and the reasons: `docs/contributing/ci.md`.

- `ci.yml` ("CI") — pull requests (the merge gate) and pushes to `develop` and
  `release/**` (the release gate). Jobs: `changes` ("Plan": tier filter, last
  green commit and reuse on push, image plan, new image pins), `repo`
  (pre-commit on all files, `task agents:audit`, `task be:lint`, release-note
  lint and requirement, gitleaks), `semgrep` (PRs, diff-aware), `backend`
  (core, aiq_api and `sources/` suites), `frontend` (cards, lint, types,
  tenant isolation), `frontend-test` (four shards), `frontend-coverage` (PR
  comment, not gating), `web`, `infra`, `packages`, `trivy` (changed pins),
  `image` (PR build, no push), `image-push` and `publish` (push: build missing
  images, then tag `sha-<commit>` after every check passed), and `ci-ok`, the
  single required check.
- `deploy.yml` ("Deploy (staging)") — `workflow_run` of CI: a green push run on
  `develop` from this repository deploys staging. Also `prod` pushes (behind the
  `production` environment's reviewers) and manual dispatch (rollback).
- `security.yml` ("Security") — weekly and on demand: Semgrep full tree, OSV
  over every lockfile, gitleaks, trivy over every pin. Surveillance, not a gate.
- `pr.yml` ("PR") — `pull_request_target` hygiene: the Conventional PR title
  check, closing keywords, and labels. Never checks out PR code.
- `release-notes.yml` ("Release notes") — on `develop`, regenerates the
  published changelog from `releasenotes/` on top of the current tip and
  commits it back.
- `blog-preview.yml` — screenshots changed blog posts on PRs that touch
  `frontends/web/src/content/`. Informational, never blocks.
- `labels.yml` ("Sync Labels") — syncs `.github/labels.yml` to the repo labels
  (`skip-delete`).
- Scheduled and on demand: `docs-links.yml` (weekly external link sweep),
  `turn-shapes-live.yml` (weekly live-model turn shapes), `workos-drift.yml`
  (weekly WorkOS drift check).
- `claude.yml` and `claude-code-review.yml` — the `@claude` agent and the
  automatic PR review.

Composite actions in `.github/actions/`: `setup-python-env`, `setup-task`,
`setup-bun`, and `build-image` (one image from an entry of the image plan).

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
runs in CI's `repo` job and weekly in `security.yml`.

## Validation

```bash
.venv/bin/pre-commit run --all-files                  # every hook
actionlint .github/workflows/<file>.yml               # if installed
```

Expected: hooks pass (or only auto-fix), and any edited workflow is valid YAML
that `actionlint` accepts.
