#!/usr/bin/env bash
# Resolve the image each service deploys to staging, and refuse a downgrade.
#
# Usage: resolve-image-refs.sh   (run inside the checkout, stack selected)
# Prints BACKEND_IMAGE_REF=, FRONTEND_IMAGE_REF= and WEB_IMAGE_REF= lines on
# stdout, for $GITHUB_ENV. Everything else, including one
# `<service>: <deployed ref> -> <resolved ref>` line per service, goes to stderr.
#
# Environment:
#   GITHUB_REPOSITORY_OWNER  registry owner; folded to lowercase
#   DEPLOY_SHA               the develop commit being deployed (40 hex)
#   RUN_ID                   the green CI run that triggered this deploy; empty on dispatch
#   EXPLICIT_TAG             the operator's rollback tag; empty otherwise
#   RESOLVE_DEPTH            first-parent commits to search (default 200)
#   FIND_PUBLISHED_TAG       registry lookup; default find-published-tag.sh here
# Needs `git` with history back to the deployed commit (checkout
# `fetch-depth: 0`), `pulumi` with the stack selected, and `jq`.
#
# Where each service's tag comes from:
#   1. a green CI run triggered the deploy: sha-<DEPLOY_SHA>, for all three.
#      CI tags every image for a commit only once all its checks passed
#      (ci.yml, `publish`), so a green run means all three tags exist;
#   2. operator rollback (dispatch with EXPLICIT_TAG): that tag, for all three;
#   3. otherwise the newest commit on develop's first-parent history, at or
#      before DEPLOY_SHA, whose sha-<commit> tag GHCR actually has.
#
# Case 3 used to read the Actions run index
# (`/actions/workflows/publish-images.yml/runs?branch=develop&status=success`).
# GitHub serves those filters from a search index with limits, and on 09-28 it
# twice returned a list without the newest backend build: a docs-only commit's
# deploy pinned the backend to a 09-11 image, the new UI spoke wire v2 to it,
# and every chat hung on "Denkt nach…". Git history and the registry are the
# two facts that decide what can be deployed, so the walk reads only those. A
# commit whose publish failed has no tag and is stepped over.
#
# The guard: the resolved commit must descend from (or equal) the one the stack
# last deployed, read from the stack output `deployedImages`. Nothing else ever
# compared the two, which is why that downgrade was silent. Only an explicit
# rollback may go backwards, and it says so.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
find_published_tag="${FIND_PUBLISHED_TAG:-$here/find-published-tag.sh}"
depth="${RESOLVE_DEPTH:-200}"
owner="$(printf '%s' "${GITHUB_REPOSITORY_OWNER:?}" | tr '[:upper:]' '[:lower:]')"
registry="ghcr.io/${owner}"
: "${DEPLOY_SHA:?}"
RUN_ID="${RUN_ID:-}"
EXPLICIT_TAG="${EXPLICIT_TAG:-}"

rollback=""
[ -z "$RUN_ID" ] && [ -n "$EXPLICIT_TAG" ] && rollback=1

log() { printf '%s\n' "$*" >&2; }

# The commit a ref was built at, when its tag is sha-<40 hex>; empty otherwise.
commit_of() {
  local tag="${1##*:}"
  [[ "$tag" =~ ^sha-([0-9a-f]{40})$ ]] && printf '%s' "${BASH_REMATCH[1]}"
  return 0
}

# What the stack last deployed. The committed stack file cannot say: CI's
# `pulumi config set` never reaches git, so `pulumi config get` on a fresh
# checkout reads `imageTag: latest` whatever is running. The stack output is
# written by the update itself.
deployed_json="$(pulumi stack output --json)" || {
  log "::error::could not read the stack outputs, so the deployed images are unknown."
  exit 1
}

deployed_ref() {
  jq -r --arg s "$1" '.deployedImages[$s] // empty' <<<"$deployed_json"
}

# Newest sha-<commit> tag GHCR has for the service on develop's first-parent
# history, at or before DEPLOY_SHA.
newest_published_tag() {
  local service="$1" rc=0 tag
  local -a candidates
  mapfile -t candidates < <(git rev-list --first-parent --max-count="$depth" "$DEPLOY_SHA" | sed 's/^/sha-/')
  [ "${#candidates[@]}" -gt 0 ] || { log "::error::git knows no history for $DEPLOY_SHA."; return 2; }
  tag="$("$find_published_tag" "$owner" "$service" "${candidates[@]}")" || rc=$?
  case "$rc" in
    0) printf '%s' "$tag" ;;
    1) return 1 ;;
    *) log "::error::${service}: the registry lookup failed; refusing to guess an older image."; return 2 ;;
  esac
}

resolve_ref() {
  local service="$1" deployed="$2" tag rc=0
  if [ -n "$RUN_ID" ]; then
    tag="sha-${DEPLOY_SHA}"
  elif [ -n "$rollback" ]; then
    tag="$EXPLICIT_TAG"
  else
    tag="$(newest_published_tag "$service")" || rc=$?
    if [ "$rc" -eq 1 ]; then
      [ -n "$deployed" ] || {
        log "::error::${service}: no image in the last ${depth} develop commits and no deployed ref to keep."
        return 1
      }
      log "::warning::${service}: no image in the last ${depth} develop commits; keeping the deployed ${deployed}"
      printf '%s' "$deployed"
      return 0
    fi
    [ "$rc" -eq 0 ] || return 1
  fi
  printf '%s' "${registry}/grid-oib-${service}:${tag}"
}

# Fail when `new` would move the service back past what is deployed, unless
# an operator asked for exactly that.
guard() {
  local service="$1" deployed="$2" new="$3" old_commit new_commit
  old_commit="$(commit_of "$deployed")"
  new_commit="$(commit_of "$new")"
  if [ -z "$old_commit" ] || [ -z "$new_commit" ]; then
    log "::warning::${service}: deployed ref '${deployed:-none}' or resolved ref '${new}' is not a sha-<40 hex> tag; cannot check it is not a downgrade."
    return 0
  fi
  if ! git cat-file -e "${old_commit}^{commit}" 2>/dev/null; then
    log "::warning::${service}: the deployed commit ${old_commit} is not in this checkout; cannot check it is not a downgrade."
    return 0
  fi
  git merge-base --is-ancestor "$old_commit" "$new_commit" && return 0
  if [ -n "$rollback" ]; then
    log "::warning::${service}: operator rollback from ${deployed} to ${new}, an older commit. Allowed because imageTag was set by hand."
    return 0
  fi
  log "::error::${service}: refusing to downgrade. Deployed ${deployed} is not an ancestor of resolved ${new}. If the registry lookup is right and you want the older image, dispatch Deploy (staging) with imageTag=sha-${new_commit}."
  return 1
}

failed=0
out=""
for service in backend frontend web; do
  deployed="$(deployed_ref "$service")"
  new="$(resolve_ref "$service" "$deployed")" || { failed=1; continue; }
  log "${service}: ${deployed:-unknown} -> ${new}"
  guard "$service" "$deployed" "$new" || failed=1
  out+="$(printf '%s' "$service" | tr '[:lower:]' '[:upper:]')_IMAGE_REF=${new}"$'\n'
done

[ "$failed" -eq 0 ] || exit 1
printf '%s' "$out"
