# Contributing to grid-oib-agent

Canonical entry point for developing on Grid. The deep references live elsewhere
and are linked below; this file ties them together so the workflow is discoverable
from one place.

- Full engineering guide (architecture, subsystems, env vars): [AGENTS.md](AGENTS.md)
- The bar every change must clear before it is "done":
  [definition-of-done skill](.claude/skills/definition-of-done/SKILL.md)
- System design overview: [docs/architecture/overview.md](docs/architecture/overview.md)

## Setup (run once)

Install the git hooks so every check below runs automatically on each commit —
this is the single most important step for not re-discovering repo-wide hygiene
debt in CI:

```bash
pre-commit install
```

**Why it matters:** CI runs `pre-commit run --all-files` — it lints **every file
in the repo**, not just your diff. So pre-existing drift in files you never
touched (trailing whitespace, missing final newlines, a stale detect-secrets
baseline, dead markdown links) will block your PR the moment your change triggers
the lint job. Keeping the hooks installed keeps the tree clean and stops that
debt from accumulating one untouched file at a time. If the whole-repo run flags
pre-existing issues, fix them in your PR (they are cheap and mechanical) rather
than leaving the next person to trip over them.

## Branching

- Cut feature branches from `develop` (the integration branch). `develop` and
  `release/**` are the protected branches CI runs against.
- One logical change per branch.
- One logical change per commit. When a feature trips over **correlated
  substrate debt** (an extension point that is not actually generic), lift
  that defect in its own commit *in the same change* — do not bolt the
  feature onto the broken substrate and do not file the lift as later.
  YAGNI does not cover known defects on your path. The rule:
  [AGENTS.md](AGENTS.md) (“Correlated substrate debt…”) and
  [adding a shareable resource type](docs/architecture/adding-a-shareable-resource-type.md) §5.

## Local validation

Run what your change touches before pushing (the full matrix is in the
[definition-of-done skill](.claude/skills/definition-of-done/SKILL.md)):

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
  detect-secrets, markdown-link-check and more, configured in
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

## CI and the merge gate

- The single required status check is **CI OK**
  ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): it passes only when
  every needed lint/test/build job succeeded or was skipped by the path filter.
- Security scanning runs in
  [`.github/workflows/security.yml`](.github/workflows/security.yml): Semgrep
  (SAST), OSV-Scanner (dependency CVEs), pip-audit / npm audit, and gitleaks —
  fully in-CI, no paid licence. See the "Security & static analysis" section of
  [AGENTS.md](AGENTS.md) for the rationale.
- Dependency-update PRs are opened by Dependabot
  ([`.github/dependabot.yml`](.github/dependabot.yml)).

## Secret scanning

`detect-secrets` (pre-commit + CI) guards against committed credentials, using
[`.secrets.baseline`](.secrets.baseline) as the allowlist of acknowledged
non-secrets (test fixtures, `.env.example` placeholders, doc examples).

- Mark a one-off false positive inline: append `pragma: allowlist secret` as a
  comment on the flagged line.
- After adding legitimate secret-shaped test data, refresh the baseline:
  `detect-secrets scan --baseline .secrets.baseline` (preserves audited entries),
  then `git add .secrets.baseline`.
- Lockfiles (`pnpm-lock.yaml`) and skill signatures are excluded in
  [`.pre-commit-config.yaml`](.pre-commit-config.yaml) — their integrity hashes
  are not secrets and would otherwise flood the baseline.

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
