#!/usr/bin/env bash
# Grid agent preflight — the one command that runs before anything edits this repo.
#
# Why this exists
# ---------------
# `task setup` is the documented first step and nothing enforced it. An agent
# that skips it works in a checkout where `task` is not on PATH, `.venv/` does
# not exist, `node_modules/` is empty and `.claude/skills/` was never published.
# Every check it might run to validate its own change then fails for reasons
# that have nothing to do with the change, so it debugs the environment instead
# of the task — or pushes something it never managed to verify.
#
# Harness-neutral on purpose. Claude Code runs it from hooks
# (`.claude/settings.json`), other agents run it because `AGENTS.md` says to,
# the devcontainer runs it on create, and a human runs it the same way. One
# definition, no per-harness copy of what "set up" means.
#
#   scripts/agent-preflight.sh              provision if needed, then verify
#   scripts/agent-preflight.sh --check      verify only, exit 1 if not provisioned
#   scripts/agent-preflight.sh --print-env  emit the `export` lines for this checkout
#
# Full mechanism, escape hatch and how to wire another harness:
# docs/contributing/agent-preflight.md

set -euo pipefail

REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO_ROOT"

STAMP="$REPO_ROOT/.agent-preflight.stamp"
TOOLS_DIR="$REPO_ROOT/.tools"
TOOLS_BIN="$TOOLS_DIR/node_modules/.bin"

# go-task is the one dependency nothing in this repo installs, and `task setup`
# cannot bootstrap the tool that runs it. Pinned so every machine and every
# session resolve the same binary; bump deliberately.
GO_TASK_VERSION=3.53.1

# What a provisioned checkout has. Each entry is a directory or file `task
# setup` creates, so a missing one names the install step that did not run.
MARKERS=(
  "frontends/ui/node_modules:task fe:install (bun)"
  "frontends/web/node_modules:task web:install (npm)"
  "deploy/pulumi/node_modules:npm --prefix deploy/pulumi ci"
  "deploy/pulumi/policy/node_modules:npm --prefix deploy/pulumi/policy ci"
  ".claude/skills:task agents:setup (apm install)"
)

# Hashed into the stamp. AGENTS.md tells you to re-run setup "after any pull
# that moves a lockfile"; this is that sentence, mechanised.
LOCKFILES=(
  uv.lock
  apm.lock.yaml
  frontends/ui/bun.lock
  frontends/web/package-lock.json
  deploy/pulumi/package-lock.json
  deploy/pulumi/policy/package-lock.json
)

MODE=ensure
case "${1:-}" in
  ""|--ensure)  MODE=ensure ;;
  --check)      MODE=check ;;
  --print-env)  MODE=print-env ;;
  -h|--help)    sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "usage: $0 [--check|--print-env]" >&2; exit 64 ;;
esac

log() { printf '  %s\n' "$*"; }

# A virtualenv puts its executables in `Scripts/` on Windows and `bin/`
# everywhere else — the same fact `Taskfile.yml` states once in VENV_BIN.
venv_bin() {
  if [ -d "$REPO_ROOT/.venv/Scripts" ]; then
    printf '%s' "$REPO_ROOT/.venv/Scripts"
  else
    printf '%s' "$REPO_ROOT/.venv/bin"
  fi
}

venv_exe() {
  local name=$1 bin
  bin=$(venv_bin)
  if [ -x "$bin/$name" ]; then printf '%s' "$bin/$name"
  elif [ -x "$bin/$name.exe" ]; then printf '%s' "$bin/$name.exe"
  fi
}

# Fails loudly rather than returning an empty digest: a silent one makes every
# fingerprint match every other, and the checkout reports "a lockfile moved"
# forever with nothing naming the real cause.
hash_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -d' ' -f1
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 | sed 's/.*= *//'
  else
    cat >/dev/null
    echo "agent-preflight: no sha256 tool found (sha256sum, shasum or openssl)." >&2
    exit 1
  fi
}

# Names as well as contents, so deleting a lockfile also invalidates the stamp.
fingerprint() {
  {
    for f in "${LOCKFILES[@]}"; do
      printf '\n== %s\n' "$f"
      [ -f "$f" ] && cat "$f"
    done
  } | hash_stdin
}

# Prints why the checkout is not provisioned; silent and 0 when it is.
check() {
  local ok=0 entry marker desc

  if [ -z "$(venv_exe python)" ]; then
    log "missing .venv — 'uv venv .venv && uv sync --group dev' has not run"
    ok=1
  fi

  for entry in "${MARKERS[@]}"; do
    marker=${entry%%:*}
    desc=${entry#*:}
    if [ ! -e "$marker" ]; then
      log "missing $marker — '$desc' has not run"
      ok=1
    fi
  done

  if [ ! -f "$STAMP" ]; then
    log "no preflight stamp — setup has never completed in this checkout"
    ok=1
  elif [ "$(cat "$STAMP")" != "$(fingerprint)" ]; then
    log "a lockfile moved since setup last ran — dependencies are stale"
    ok=1
  fi

  return $ok
}

# `task setup` runs everything else, but nothing installs go-task itself. npm is
# already a hard requirement of this repo (deploy/pulumi, frontends/web), so the
# bootstrap borrows it and installs locally rather than writing to a global
# prefix an agent may not own.
ensure_go_task() {
  if command -v task >/dev/null 2>&1; then return; fi
  if [ -x "$TOOLS_BIN/task" ]; then
    PATH="$TOOLS_BIN:$PATH"; export PATH
    return
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "agent-preflight: go-task is missing and npm is not available to install it." >&2
    echo "  Install go-task yourself (https://taskfile.dev/installation/) and re-run." >&2
    exit 1
  fi
  log "installing @go-task/cli@$GO_TASK_VERSION into .tools/ (go-task is not on PATH)"
  mkdir -p "$TOOLS_DIR"
  npm install --prefix "$TOOLS_DIR" --no-audit --no-fund --loglevel=error \
    "@go-task/cli@$GO_TASK_VERSION"
  PATH="$TOOLS_BIN:$PATH"; export PATH
}

# CONTRIBUTING.md calls this the single most important setup step, and it is the
# one thing `task setup` deliberately leaves out. An agent that commits without
# it re-discovers repo-wide lint debt in CI instead.
install_git_hooks() {
  local pre_commit hook_path
  pre_commit=$(venv_exe pre-commit)
  [ -n "$pre_commit" ] || return 0
  hook_path=$(git rev-parse --git-path hooks/pre-commit 2>/dev/null) || return 0
  [ -f "$hook_path" ] && return 0
  log "installing pre-commit hooks"
  "$pre_commit" install >/dev/null
}

provision() {
  echo "agent-preflight: provisioning this checkout"
  ensure_go_task
  task setup
  install_git_hooks
  fingerprint > "$STAMP"
}

print_env() {
  # `eval "$(scripts/agent-preflight.sh --print-env)"` in a shell, or appended to
  # $CLAUDE_ENV_FILE by the session hook. Puts the venv's pytest/ruff/pre-commit
  # and the bootstrapped `task` on PATH without anyone remembering to activate.
  local paths=()
  [ -d "$TOOLS_BIN" ] && paths+=("$TOOLS_BIN")
  [ -d "$(venv_bin)" ] && paths+=("$(venv_bin)")
  if [ ${#paths[@]} -gt 0 ]; then
    printf 'export PATH="%s:$PATH"\n' "$(IFS=:; printf '%s' "${paths[*]}")"
  fi
  # The documented footgun: without this, pytest resolves `aiq_agent` from
  # whatever the venv installed rather than from this worktree.
  printf 'export PYTHONPATH="%s${PYTHONPATH:+:$PYTHONPATH}"\n' "$REPO_ROOT/src"
}

case "$MODE" in
  print-env)
    print_env
    ;;
  check)
    if check; then
      exit 0
    fi
    exit 1
    ;;
  ensure)
    if check; then
      echo "agent-preflight: this checkout is provisioned and current."
    else
      provision
      if ! check; then
        echo "agent-preflight: setup ran but the checkout still looks incomplete (above)." >&2
        exit 1
      fi
      echo "agent-preflight: done."
    fi
    ;;
esac
