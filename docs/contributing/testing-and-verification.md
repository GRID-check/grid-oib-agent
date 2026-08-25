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

`Taskfile.yml` is the source of truth for what each check actually runs, and
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
| UI lint | `task fe:lint` |
| Backend lint | `task be:lint` |
| Backend tests | `task be:test`, or `task be:test:api` for the plugin suite |
| Pulumi and the policy pack | `task infra:types` |
| Astro landing site | `task web:verify` |

Then run `task verify:fast` before you push.

## Traps the task list cannot tell you about

**Spec type errors block the production build.** The UI `tsconfig` includes test
files, so a type error in a `.spec.tsx` fails `next build`, not just the test
run. A green `task fe:types` is what tells you the build will typecheck.

**`task db:test:rls` is a required merge check and is not part of `task
verify`.** It needs PostgreSQL server binaries, so it runs separately. Run it
whenever you touch the tenant boundary.

**Backend tests need `PYTHONPATH=src`.** Without it pytest resolves `aiq_agent`
from whatever the venv has installed, possibly another worktree, and validates
the wrong code while appearing to pass. `Taskfile.yml` sets it. Call `pytest`
directly and you own it again.

**Static green is not runtime green.** Typecheck, lint and unit tests are the
bar for most changes. Behaviour that only exists at runtime, WebSocket flows,
auth, and the deletion pipeline among them, needs the Compose stack with real
keys and a developer driving it. Smoke-test those against a running stack before
release rather than trusting a green suite.

## How CI distributes the same tasks

CI calls the Taskfile, so there is no second copy of the commands. Only the
scheduling differs: the frontend tier's lint, types and build run in one job
while the suite is sharded six ways (`fe:test:shard`) and stitched back together
by `fe:test:merge` for the coverage comment. Run in series on one runner, the
tests were about 63% of the job's wall clock. Locally `task fe:verify` runs lint,
types, tests and build in order instead.

Two required checks are not in `task verify` at all: `db:test:rls` (it needs
PostgreSQL server binaries) and the release-note gate (it needs the PR's base
and head). Run the first by hand when you touch the tenant boundary; the second
only exists on a PR.

The single required status check is **CI OK**
([`ci.yml`](../../.github/workflows/ci.yml)), which passes only when every
needed job succeeded or was skipped by the path filter.

## Security and static analysis

[`security.yml`](../../.github/workflows/security.yml) runs on push, on pull
request, and weekly. All of it is free and runs entirely in CI, with no GitHub
Advanced Security licence and no SonarQube subscription.

| Tool | Covers | Blocking |
|---|---|---|
| Semgrep | SAST for Python, TS/JS and Actions. Replaces CodeQL and Sonar's security rules | **Yes on a PR.** `semgrep ci` is diff-aware, so it blocks a *new* finding without failing on the existing backlog. Push and schedule runs stay advisory |
| OSV-Scanner | Dependency CVEs from lockfiles. Replaces Sonar SCA | No, phase 1 |
| pip-audit, bun audit, npm audit | Dependency advisories | **No.** Each step is `continue-on-error: true` *and* the command ends `\|\| true`, so findings only reach the log |
| gitleaks | Secret scan over full history | Yes |
| trivy (`image-scan`) | The digest-pinned observability and Langfuse images from `deploy/pulumi/src/config.ts` | Yes, on **fixable** HIGH and CRITICAL findings (it runs `--ignore-unfixed`) |

The dependency audits being advisory is worth knowing before you rely on them: a
vulnerable dependency passes CI today. Making them block means removing both the
`continue-on-error` and the `|| true`, not just one.

Two things about the trivy job that are not obvious:

- It asserts the exact image count (five as of ADR-0044), so a new pin fails CI
  until it is added to the scan list rather than going unscanned forever.
- The vulnerability database is downloaded once into a shared cache and the five
  scans reuse it with `--skip-db-update`. Five fresh `docker run --rm` pulls of
  `trivy-db` from GCR return 429 and fail the job with `failed=0`.

Findings inside those upstream images that no digest bump can clear go in
`.trivyignore.yaml` as time-boxed exceptions with a justification and an
`expired_at`. Never by loosening the gate.

Dependabot ([`dependabot.yml`](../../.github/dependabot.yml)) opens the
dependency fix PRs. Maintainability is covered by the native linters and the
coverage gate in `ci.yml`. That drops Sonar's clean-as-you-code gate, so the
`PLR09xx` refactor rules ruff ignores (too many arguments, branches, statements)
are no longer reported on new code.

## Visual evidence

A user-visible UI change is done only with a committed screenshot. The harness
is a registry (`frontends/ui/visual/registry.mjs`) of `/dev/*` preview routes
that render real components against fixture data with no backend, captured in
light and dark by `task fe:screenshots`.

Build a user-visible surface, add a `/dev/<name>` preview route and a registry
target, and commit the PNGs. The `visual-coverage` workflow comments when a PR
adds a component without that evidence; opt a non-visual component out with a
`// no-visual: <reason>` marker. Full playbook, including the `.dark` class,
module-scope fetch shims and the pre-installed Chromium:
[`../ux/visual-screenshots.md`](../ux/visual-screenshots.md).

## Mobile evidence

`task fe:touch-audit` loads the same registry at 390×844 with touch emulation
and reports what a screenshot cannot: regions whose `touch-action` refuses the
vertical pan (a finger lands and the page does not move), boxes that stick out
past the viewport, and interactive elements under the 44px floor — the last
measured including any `touch-target` catchment, so a control that widens its
catchment correctly does not report. Add `-- <registry id>` for one surface.

It is NOT part of `verify`, on purpose: the shape errors it exists for are held
statically by `src/components/ui/mobile-affordances.spec.ts` and
`touch-target.spec.ts`, and a browser pass over ~120 surfaces is a deliberate
run rather than a per-commit tax. Reach for it when you build a user-visible
surface, and read `SMALL` as a prompt rather than a verdict — an inline target
inside a sentence cannot reach 44px without stealing its neighbour's taps, which
is why WCAG 2.5.8 exempts it.

Both of the worst defects it has found were invisible to review, to the type
checker and to a desktop screenshot: a reasoning graph that swallowed every
swipe because a library stylesheet claimed a gesture the graph had turned off,
and a file list whose `truncate` never fired because auto table layout sized the
column to the filename. Neither looked wrong. Both were measured.

## Before opening a PR

- `task verify:fast` green.
- A release note when a customer can notice the change. See
  [release-notes.md](release-notes.md).
- Docs updated in the same pull request, per the documentation obligation in
  [`AGENTS.md`](../../AGENTS.md).
