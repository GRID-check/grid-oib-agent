# Contributing to grid-oib-agent

Canonical entry point for developing on Grid. The deep references live elsewhere
and are linked below; this file ties them together so the workflow is discoverable
from one place.

- Everything written down about this project, grouped by the question you
  arrived with: [docs/README.md](docs/README.md)
- How the system works: [docs/architecture/system-overview.md](docs/architecture/system-overview.md)
- How we work, in detail: [docs/contributing/README.md](docs/contributing/README.md)
- What an agent must act on while working: [AGENTS.md](AGENTS.md)
- The bar every change must clear before it is "done":
  [docs/contributing/definition-of-done.md](docs/contributing/definition-of-done.md)

## Setup (run once)

Install the git hooks so every check below runs automatically on each commit —
this is the single most important step for not re-discovering repo-wide hygiene
debt in CI:

```bash
pre-commit install
```

**Why it matters:** CI runs `pre-commit run --all-files` — it lints **every file
in the repo**, not just your diff. So pre-existing drift in files you never
touched (trailing whitespace, missing final newlines, dead markdown links) will
block your PR the moment your change triggers the lint job. Keeping the hooks
installed keeps the tree clean and stops that debt from accumulating one
untouched file at a time. If the whole-repo run flags pre-existing issues, fix
them in your PR (they are cheap and mechanical) rather than leaving the next
person to trip over them.

## Branching

- Cut feature branches from `develop` (the integration branch). `develop` and
  `release/**` are the protected branches CI runs against. CI and the security
  scan also run on a pull request whose base is a `claude/**` branch, so every
  PR of a stack gets its gate before the one below it merges.
- One logical change per branch.
- One logical change per commit. When a feature trips over **correlated
  substrate debt** (an extension point that is not actually generic), lift
  that defect in its own commit *in the same change* — do not bolt the
  feature onto the broken substrate and do not file the lift as later.
  YAGNI does not cover known defects on your path. The rule:
  [AGENTS.md](AGENTS.md) (“Correlated substrate debt…”) and
  [adding a shareable resource type](docs/architecture/adding-a-shareable-resource-type.md) §5.

## Release notes

Every change a customer can notice ships with a release note in the same PR —
this is an obligation, enforced by CI's **Repo checks** job, not a
convention. Notes are written with [reno](https://docs.openstack.org/reno/latest/)
and published automatically to piloti.at/changelog (German and English) when the
PR merges.

```bash
task release:note -- re-index-projects   # creates releasenotes/notes/<slug>-<hash>.yaml
task release:lint                        # the same check CI runs
```

Write it for the architect using Piloti: plain sentences, no issue numbers, no
file or component names. A PR that genuinely changes nothing a user can observe
carries the `no-release-note` label instead.

Full playbook: [docs/contributing/release-notes.md](docs/contributing/release-notes.md).

## Local validation

Run what your change touches before pushing (what you must be able to show
for each kind of change is in the
[definition of done](docs/contributing/definition-of-done.md)):

All commands live in the root [`Taskfile.yml`](Taskfile.yml) and are run with
[go-task](https://taskfile.dev) (`npm i -g @go-task/cli`). CI calls the same
tasks, so there is no second copy to drift:

- First time here: `task setup` (backend venv, UI deps, Pulumi deps).
- Python backend: `task be:lint`, `task be:test`.
- Frontend: `task fe:lint`, `task fe:types`, `task fe:test`, `task fe:build` —
  or all four as `task fe:verify`.
- Infra: `task infra:types`.
- Everything at once: `task verify` — this is the merge gate: repo lint plus the
  same per-tier groups CI runs (`be:verify` with its coverage gate, `fe:verify`,
  `infra:types`). `task verify:fast` omits only the production build.
- Repo-wide hooks: `task lint:repo` (`pre-commit run --all-files`) — ruff,
  markdown-link-check and more, configured in
  [`.pre-commit-config.yaml`](.pre-commit-config.yaml).

`task --list` shows everything with descriptions.

## Commits and PR titles

Grid uses Conventional Commits. The repo **squash-merges the PR title**, so the
PR title itself must be a valid Conventional Commit subject — the `Conventional
PR title` check ([`.github/workflows/pr.yml`](.github/workflows/pr.yml)) blocks
the PR otherwise. Allowed types:

`feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `ci`, `build`, `chore`, `revert`.

Example: `ci: replace SonarQube + CodeQL with a free in-CI security stack`. A PR
opened from the GitHub UI keeps whatever title it was given — fix the title, not
just the commits.

## Opening a pull request

- Base it on `develop`, carrying only the files this change needs.
  `git diff --name-only origin/develop...HEAD` is the list a reviewer will see.
- Fill every section of the
  [template](.github/pull_request_template.md). **Validation** holds the
  commands you ran and their output, or the closing checklist from the
  [definition of done](docs/contributing/definition-of-done.md); "ran the
  tests" is not evidence. A UI change carries its captures as attachments
  ([docs/ux/visual-screenshots.md](docs/ux/visual-screenshots.md)).
- CI runs on the pull request itself, and every push updates its checks.

## CI and the merge gate

- The single required status check is **CI OK**
  ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): it passes only when
  every needed job succeeded or was skipped because the change could not affect
  it. How CI decides what to run, and why:
  [docs/contributing/ci.md](docs/contributing/ci.md).
- Security checks a change can fail are part of CI: gitleaks on every run,
  Semgrep on the findings a PR introduces, trivy on the image pins it adds.
  The weekly [`.github/workflows/security.yml`](.github/workflows/security.yml)
  scans everything else that can turn red without a code change (OSV-Scanner
  over every lockfile, every pin, the whole tree). What each tool blocks on:
  [docs/contributing/testing-and-verification.md](docs/contributing/testing-and-verification.md).
- Dependency-update PRs are opened by Dependabot
  ([`.github/dependabot.yml`](.github/dependabot.yml)).

## Secret scanning

Gitleaks scans full history on every PR and push (CI's **Repo checks** job),
plus a weekly run ([`.github/workflows/security.yml`](.github/workflows/security.yml)). Its
allowlist is [`.gitleaks.toml`](.gitleaks.toml): test, doc, mock and fixture
paths, lockfiles and `.env.example`, one regex for placeholder words (`example`,
`dummy`, `changeme` and the like), and one exact literal, Pulumi's public secret
sentinel.

- Mark a one-off false positive inline with a `gitleaks:allow` comment on the
  flagged line, in the same commit that adds the line. The scan reads every
  commit, so a marker added later leaves the original commit flagged.
- For a finding already pushed, copy the `Fingerprint:` line from the job log
  into `.gitleaksignore` at the repo root.
- For fixtures that are re-recorded, add a path entry to `.gitleaks.toml`. Add a
  real exception there rather than weakening the scan globally.

## Documentation hygiene

Docs are part of the change — stale docs are a bug. Markdown links are checked in
CI by `markdown-link-check`, so:

- Use repo-relative links that resolve on disk (e.g. `../adr/0001-use-architecture-decision-records.md`),
  not guessed paths.
- Heading anchors must match GitHub's generated slug (lowercase, spaces →
  hyphens, punctuation dropped). Do **not** use non-breaking hyphens (U+2011) in
  headings — they silently break `#anchor` links written with a normal hyphen.
- **Internal** links and anchors are enforced in CI. **External** (`http(s)://`)
  links are intentionally *not* validated — `ci/markdown-link-check-config.json`
  ignores them, because third-party sites move, rate-limit, and block link
  checkers, which used to break CI on unrelated PRs. Keep external links correct
  anyway, but a stale external link will not fail the build.
