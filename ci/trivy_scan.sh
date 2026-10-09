#!/usr/bin/env bash
# Scan pinned third-party images with trivy; fail on a fixable HIGH or CRITICAL.
#
# Usage: trivy_scan.sh <file with one image@sha256:... per line>
# Environment: TRIVY_VERSION (the aquasec/trivy image tag).
# Reads .trivyignore.yaml from the working directory, and caches in .trivy-cache.
#
# Used twice: CI scans the pins a change adds (ci/pinned_images.py new), the
# weekly Security run scans all of them (ci/pinned_images.py list).
#
# The vulnerability DB is downloaded ONCE and every scan reuses it with
# --skip-db-update: one `docker run --rm` per image each pulling trivy-db from
# GCR returns 429 and fails the job. The layer analysis under .trivy-cache/fanal
# is safe to cache across runs (a digest cannot change); the DB is not, because
# the advisories about a digest do.
set -euo pipefail

pins="${1:?usage: trivy_scan.sh <pins file>}"
: "${TRIVY_VERSION:?}"
[ -s "$pins" ] || { echo "no images to scan"; exit 0; }

cache="$PWD/.trivy-cache"
mkdir -p "$cache"
trivy() {
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    --env HOME=/tmp \
    -v "$cache:/cache" \
    -v "$PWD/.trivyignore.yaml:/config/.trivyignore.yaml:ro" \
    "aquasec/trivy:${TRIVY_VERSION}" \
    --cache-dir /cache \
    "$@"
}

downloaded=0
for attempt in 1 2 3 4 5; do
  if trivy image --download-db-only --db-repository 'mirror.gcr.io/aquasec/trivy-db:2' \
    || trivy image --download-db-only --db-repository 'ghcr.io/aquasecurity/trivy-db:2'; then
    downloaded=1
    break
  fi
  echo "trivy DB download failed (attempt ${attempt}/5); retrying"
  sleep $((attempt * 15))
done
[ "$downloaded" -eq 1 ] || { echo "::error::trivy DB download failed after retries"; exit 1; }

failed=0
while read -r image; do
  [ -n "$image" ] || continue
  echo "=== trivy: $image"
  trivy image \
    --skip-db-update \
    --ignorefile /config/.trivyignore.yaml \
    --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 "$image" || failed=1
done < "$pins"
exit "$failed"
