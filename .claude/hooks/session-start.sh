#!/bin/bash
#
# Everything `task setup` does, for a session that has no `task`.
#
# WHY THIS EXISTS. A Claude Code on the web container arrives with the repo
# cloned and nothing installed, and go-task is not on its PATH — nothing in this
# repo installs it. So an agent that means to follow CONTRIBUTING.md runs the
# underlying commands by hand, gets the two toolchains it happens to need, and
# works a whole session without the rest. The half that goes missing silently is
# `agents:setup`: `.claude/skills/` stays empty, so THIS REPO'S OWN SKILLS never
# load, and the agent works to the general rules while `aiq-definition-of-done`
# and `aiq-prepare-pr` sit unread on disk. That is not a thing to remember. It
# is a thing to make impossible, which is what a SessionStart hook is for.
#
# Mirrors `Taskfile.yml`'s `setup` target step for step, deliberately: when that
# target changes this file has to change with it, and a reader comparing the two
# should see the same list in the same order.
#
# IDEMPOTENT and cheap on a warm container: every installer here no-ops when its
# lockfile already matches what is on disk, so a `resume`/`clear`/`compact`
# start costs seconds rather than minutes.
set -euo pipefail

# Local runs already have whatever the developer set up, and this would fight
# their tooling. The web container is the one that starts from nothing.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

# Pinned in one place, as the Taskfile does it: `uvx` runs the CLI without a
# global install, so the version is this line rather than whatever is on PATH.
APM_VERSION="$(awk '/^  APM_VERSION:/ {print $2; exit}' Taskfile.yml)"

step() { echo "[session-start] $*"; }

# Copy, never hardlink, on every path: nltk pathsec refuses hard-linked corpora
# (docs/contributing/gotchas.md), and the Taskfile and Dockerfile do the same.
export UV_LINK_MODE=copy

step "backend venv (uv sync --group dev)"
uv venv .venv
uv sync --group dev

# The container's uv (0.8.x) knows no 3.14 newer than 3.14.0rc2, and pydantic
# does not import on that release candidate, so every backend test dies at
# collection (docs/contributing/gotchas.md, `prefer_fwd_module`). A current uv
# from PyPI, which the proxy allows where the GitHub API is not, installs 3.14
# final and the venv is rebuilt on it.
if ! .venv/bin/python -c 'import sys; sys.exit(sys.version_info.releaselevel != "final")'; then
  step "backend venv is on a pre-release Python; rebuilding on 3.14 final"
  UV_CURRENT="${TMPDIR:-/tmp}/uv-current"
  python3 -m venv "$UV_CURRENT"
  "$UV_CURRENT/bin/pip" install --quiet --upgrade uv
  "$UV_CURRENT/bin/uv" python install 3.14
  # Copy, as the Dockerfile does: uv's default hardlinks every package file,
  # and the ingest path's pathsec guard refuses a multiply-linked file (the
  # NLTK stopword list llama-index reads), so every PDF ingest fails.
  UV_LINK_MODE=copy "$UV_CURRENT/bin/uv" sync --group dev --python '>=3.14.1,<3.15'
fi

step "UI dependencies (bun)"
# Bun is the INSTALLER and script runner only, never the runtime — see
# `fe:install`. Do not add `--bun`.
(cd frontends/ui && bun install --frozen-lockfile)

step "web/landing dependencies (npm)"
# npm, not bun: the Astro toolchain ships its own lockfile and bundler.
(cd frontends/web && npm ci)

step "Pulumi program and policy pack"
# Two Node programs, each with its own lockfile. Installing only the policy pack
# leaves `task verify` failing at `infra:types`.
npm --prefix deploy/pulumi ci
npm --prefix deploy/pulumi/policy ci

step "agent skills (apm install --frozen)"
# The step whose absence is invisible. `--frozen` refuses to install when the
# lockfile is out of sync, which is what makes this reproducible.
uvx --from "apm-cli==${APM_VERSION}" apm install --frozen

# `PYTHONPATH=src` is mandatory for pytest and the Taskfile sets it. A session
# that calls pytest directly — which is exactly what an agent without `task`
# does — otherwise tests whatever the venv installed, possibly another
# worktree, while everything passes. tests/AGENTS.md calls this "the trap".
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo 'export PYTHONPATH="src"' >> "$CLAUDE_ENV_FILE"
fi

step "done"
