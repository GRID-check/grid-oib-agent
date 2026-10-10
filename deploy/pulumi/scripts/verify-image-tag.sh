#!/usr/bin/env bash
# Fail unless ghcr.io/<owner>/grid-oib-{backend,frontend,web}:<tag> all exist.
#
# Usage: verify-image-tag.sh <owner> <tag>
# Needs GITHUB_ACTOR and GH_TOKEN (a token with `packages: read`).
#
# The registry lookup itself is `find-published-tag.sh` beside this, which the
# staging resolver (`resolve-image-refs.sh`) shares.
#
# Both deploy jobs call this. Prod used not to: it pinned tags that the old
# incremental publish had never built (a changelog-only commit built only
# grid-oib-web), the new pods sat in ImagePullBackOff behind maxUnavailable: 0,
# and the old pods kept serving a pre-fix image while the fixes were marked
# shipped (#653's traceback on 09-18 and 09-21 still had the old line numbers).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
owner="${1:?owner}"
tag="${2:?tag}"

case "$tag" in
  sha-[0-9a-f]*|v[0-9]*|latest) ;;
  *) echo "::error::refusing to look up image tag '$tag': not sha-<hex>, v* or latest"; exit 1 ;;
esac

for service in backend frontend web; do
  rc=0
  "$here/find-published-tag.sh" "$owner" "$service" "$tag" >/dev/null || rc=$?
  case "$rc" in
    0) ;;
    1)
      echo "::error::image tag '${tag}' is not published for grid-oib-${service}. Pick the sha- tag of a develop commit whose CI run passed: CI tags all three images only then."
      exit 1
      ;;
    *)
      echo "::error::could not check image tag '${tag}' for grid-oib-${service} (see the registry error above)."
      exit 1
      ;;
  esac
done
echo "image tag '${tag}' verified for backend, frontend and web"
