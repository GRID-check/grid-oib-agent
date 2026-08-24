#!/bin/bash

# Pre-commit fails when a hook modifies files. We clear outputs then stage the
# modified notebooks so the commit includes the cleared version and the hook passes.
set -euo pipefail
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

clear_one() {
    local f="$1"
    [ -n "$f" ] || return 0
    jupyter nbconvert --clear-output --inplace "$f"
    git add "$f"
}

if [ $# -gt 0 ]; then
    for NOTEBOOK_FILE in "$@"; do
        clear_one "$NOTEBOOK_FILE"
    done
else
    git ls-files "*.ipynb" | while IFS= read -r NOTEBOOK_FILE; do
        clear_one "$NOTEBOOK_FILE"
    done
fi
