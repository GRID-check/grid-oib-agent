#!/usr/bin/env bash
# SessionStart: provision the checkout before Claude's first turn.
#
# This is the mechanism; `require-preflight.sh` is only the backstop for when
# this fails. Deliberately synchronous — a session that starts while `task
# setup` is still running is exactly the race this is meant to remove.
#
# Registered in .claude/settings.json. See docs/contributing/agent-preflight.md.

set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}"

if [ "${GRID_AGENT_PREFLIGHT:-}" = "skip" ]; then
  echo "Grid preflight skipped (GRID_AGENT_PREFLIGHT=skip). 'task setup' has NOT run, so lint, tests and builds in this session are not trustworthy."
  exit 0
fi

# SessionStart cannot block a session, so a failure is reported as context
# rather than raised: the PreToolUse guard is what stops the editing.
if ! output=$("$ROOT/scripts/agent-preflight.sh" 2>&1); then
  printf 'Grid preflight FAILED — this checkout is not provisioned.\n\n%s\n\nFile edits are blocked until `scripts/agent-preflight.sh` succeeds. Fix the failure above (usually a missing toolchain or no network for a package install) before changing any code.\n' "$output"
  exit 0
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  "$ROOT/scripts/agent-preflight.sh" --print-env >> "$CLAUDE_ENV_FILE"
fi

printf 'Grid preflight OK: %s\n\n`task` is on PATH and the venv is first on PATH, so `task verify`, `pytest`, `ruff` and `pre-commit` run without activation.\n' \
  "$(printf '%s' "$output" | tail -n 1 | sed 's/^agent-preflight: //')"
