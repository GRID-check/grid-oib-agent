#!/usr/bin/env bash
# PreToolUse guard: refuse file edits until the checkout is provisioned.
#
# The backstop, not the mechanism — `session-start.sh` normally provisions the
# checkout before the first turn, and this only fires when that failed or was
# skipped. Blocking edits is the honest place to stop: an edit made against an
# unprovisioned checkout cannot be linted, typechecked or tested, so it ships
# unverified.
#
# Registered in .claude/settings.json. See docs/contributing/agent-preflight.md.

set -uo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}"

[ "${GRID_AGENT_PREFLIGHT:-}" = "skip" ] && exit 0

payload=$(cat)

field() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$payload" | jq -r "$1 // \"\"" 2>/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    printf '%s' "$payload" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
i = d.get("tool_input") or {}
print(i.get("file_path") or i.get("notebook_path") or "")
' 2>/dev/null
  fi
}

target=$(field '.tool_input.file_path // .tool_input.notebook_path')

# No path to judge (or no JSON reader available): let the normal permission flow
# decide rather than blocking on a parse failure.
[ -n "$target" ] || exit 0

case "$target" in
  "$ROOT"/*) rel=${target#"$ROOT"/} ;;
  /*)        exit 0 ;;   # outside the repo — not this repo's business
  *)         rel=$target ;;
esac

# The machinery itself stays editable, so a bug in the gate is never a lockout.
case "$rel" in
  scripts/agent-preflight.sh|.claude/hooks/*|.claude/settings.json) exit 0 ;;
esac

if reason=$("$ROOT/scripts/agent-preflight.sh" --check 2>&1); then
  exit 0
fi

cat >&2 <<MSG
Edit blocked: this checkout has not been set up, so nothing you write here can be verified.

$reason

Run this first, then retry the edit:

  scripts/agent-preflight.sh

It bootstraps go-task if needed and runs \`task setup\` (backend venv, UI, web,
Pulumi deps, agent skills). If it cannot succeed here — no network, a missing
toolchain — say so rather than editing around it. To override for one session,
export GRID_AGENT_PREFLIGHT=skip, and expect lint, tests and builds to fail for
reasons unrelated to your change.
MSG
exit 2
