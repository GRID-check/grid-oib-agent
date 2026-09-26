#!/usr/bin/env bash
# Fail unless ghcr.io/<owner>/grid-oib-{backend,frontend,web}:<tag> all exist.
#
# Usage: verify-image-tag.sh <owner> <tag>
# Needs GITHUB_ACTOR and GH_TOKEN (a token with `packages: read`).
#
# Asks GHCR itself, not the packages REST API: there is no
# `/repos/{owner}/{repo}/packages/...` endpoint (it 404s), the org/user variants
# differ by owner type, and listing versions would need pagination over every
# sha ever published. A manifest HEAD is exactly the lookup the kubelet will
# perform, so a tag that passes here is a tag a pod can pull.
#
# Both deploy jobs call this. Prod used not to: it pinned tags that
# publish-images had never built (a changelog-only commit builds only
# grid-oib-web), the new pods sat in ImagePullBackOff behind maxUnavailable: 0,
# and the old pods kept serving a pre-fix image while the fixes were marked
# shipped (#653's traceback on 09-18 and 09-21 still had the old line numbers).
set -euo pipefail

owner="$(printf '%s' "${1:?owner}" | tr '[:upper:]' '[:lower:]')"
tag="${2:?tag}"

case "$tag" in
  sha-[0-9a-f]*|v[0-9]*|latest) ;;
  *) echo "::error::refusing to look up image tag '$tag': not sha-<hex>, v* or latest"; exit 1 ;;
esac

for service in backend frontend web; do
  image_path="${owner}/grid-oib-${service}"
  pull_token="$(curl -sSL -u "${GITHUB_ACTOR}:${GH_TOKEN}" \
    "https://ghcr.io/token?service=ghcr.io&scope=repository:${image_path}:pull" \
    | jq -r '.token // empty')"
  [ -n "$pull_token" ] || {
    echo "::error::could not obtain a GHCR pull token for ${image_path} — the job token needs 'packages: read'."
    exit 1
  }
  status="$(curl -sSL -o /dev/null -w '%{http_code}' --head \
    -H "Authorization: Bearer ${pull_token}" \
    -H 'Accept: application/vnd.oci.image.index.v1+json' \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/${image_path}/manifests/${tag}")"
  [ "$status" = "200" ] || {
    echo "::error::image tag '${tag}' is not published for grid-oib-${service} (ghcr.io/${image_path} returned HTTP ${status}). Pick a tag from a fully-built commit, or dispatch Publish Images for it."
    exit 1
  }
done
echo "image tag '${tag}' verified for backend, frontend and web"
