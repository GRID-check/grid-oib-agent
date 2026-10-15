#!/usr/bin/env bash
# Refuse a backend image built for another vector store than the program runs.
#
# Usage: vector-store-floor.sh <backend image ref>   (run inside the checkout)
# Environment:
#   DEPLOY_SHA   the commit whose program is about to be deployed (40 hex)
# Exits 0 when the image and the program agree, or when the image's commit
# cannot be read (a tag that is not sha-<40 hex>, a commit this checkout lacks:
# a warning says so); 1, with an ::error::, when they disagree.
#
# ADR-0113 removed Chroma, and with it `deploy/pulumi/src/data/chroma.ts`, the
# file that deployed the server. A backend image built while that file existed
# reads AIQ_CHROMA_URL, which a program without it no longer sets, and falls
# back to an embedded Chroma in each pod's /tmp: retrieval answers from nothing,
# without an error, and every upload is lost with the pod. The reverse, an image
# built after the removal under a program that still deploys Chroma (after a
# revert), has no Qdrant to talk to. A rollback by image tag deploys the CURRENT
# program with an OLD image, so it is the move that crosses this line; the way
# back across it is a git revert on develop. Staging runs this from
# resolve-image-refs.sh, prod on the tag Pulumi.prod.yaml pins.
set -euo pipefail

ref="${1:?usage: vector-store-floor.sh <backend image ref>}"
: "${DEPLOY_SHA:?}"
CHROMA_TIER="deploy/pulumi/src/data/chroma.ts"

log() { printf '%s\n' "$*" >&2; }

store_of() {
  if git cat-file -e "${1}:${CHROMA_TIER}" 2>/dev/null; then echo chroma; else echo qdrant; fi
}

tag="${ref##*:}"
if ! [[ "$tag" =~ ^sha-([0-9a-f]{40})$ ]] || ! git cat-file -e "${BASH_REMATCH[1]}^{commit}" 2>/dev/null; then
  log "::warning::backend: cannot tell which vector store '${ref}' was built for; not checked against the program."
  exit 0
fi
image="$(store_of "${BASH_REMATCH[1]}")"
program="$(store_of "$DEPLOY_SHA")"
[ "$image" = "$program" ] && exit 0
log "::error::backend: refusing ${ref}. It was built for ${image}, and the program at ${DEPLOY_SHA} deploys ${program} (ADR-0113). An image from before Chroma's removal falls back to an empty per-pod store and loses every upload. Roll back across that change with a git revert on develop, not an older image tag: docs/deployment/qdrant-runbook.md, \"Rollback\"."
exit 1
