#!/usr/bin/env bash
# Print the first of the given tags that GHCR has for grid-oib-<service>.
#
# Usage: find-published-tag.sh <owner> <service> <tag> [<tag>...]
# Needs GITHUB_ACTOR and GH_TOKEN (a token with `packages: read`).
#
# Exit status is the contract, and it has three values on purpose:
#   0  a tag was found; it is printed on stdout
#   1  none of the tags is published (every lookup answered 404)
#   2  the registry did not answer: no token, a network error, or any status
#      other than 200 and 404
# A lookup that failed must never read as "not built". The caller walking
# develop's history would otherwise step past the newest image to an older one,
# which is how staging's backend was silently pinned to a two-week-old image.
#
# Asks GHCR itself, not the packages REST API: there is no
# `/repos/{owner}/{repo}/packages/...` endpoint (it 404s), the org/user variants
# differ by owner type, and listing versions would need pagination over every
# sha ever published. A manifest HEAD is exactly the lookup the kubelet will
# perform, so a tag found here is a tag a pod can pull. One pull token serves
# every tag in the call, so a history walk costs one request per commit.
set -euo pipefail

owner="$(printf '%s' "${1:?owner}" | tr '[:upper:]' '[:lower:]')"
service="${2:?service}"
shift 2
[ "$#" -gt 0 ] || { echo "usage: find-published-tag.sh <owner> <service> <tag>..." >&2; exit 2; }

image_path="${owner}/grid-oib-${service}"
pull_token="$(curl -sSL -u "${GITHUB_ACTOR}:${GH_TOKEN}" \
  "https://ghcr.io/token?service=ghcr.io&scope=repository:${image_path}:pull" \
  | jq -r '.token // empty' || true)"
[ -n "$pull_token" ] || {
  echo "::error::could not obtain a GHCR pull token for ${image_path} — the job token needs 'packages: read'." >&2
  exit 2
}

for tag in "$@"; do
  status="$(curl -sSL -o /dev/null -w '%{http_code}' --head \
    -H "Authorization: Bearer ${pull_token}" \
    -H 'Accept: application/vnd.oci.image.index.v1+json' \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/${image_path}/manifests/${tag}" || echo 000)"
  case "$status" in
    200) printf '%s\n' "$tag"; exit 0 ;;
    404) ;;
    *)
      echo "::error::GHCR answered HTTP ${status} for ${image_path}:${tag}; cannot tell whether it is published." >&2
      exit 2
      ;;
  esac
done
exit 1
