#!/usr/bin/env bash
# =============================================================================
# make_oib_seed.sh — package the generated OIB knowledge base into a seed
# tarball for baking into the backend image.
# =============================================================================
#
# The OIB embeddings are a portable Chroma directory (chroma_data) plus a small
# registry (oib_registry.json). This script copies both out of a RUNNING backend
# container and packages them so any environment — especially ephemeral per-PR
# Coolify previews — can start with the knowledge base ready instead of
# re-embedding the whole corpus. See docs/deployment/coolify.md §7.
#
# Prerequisites:
#   - The stack has been run once and OIB ingestion has COMPLETED (check logs
#     for "OIB sync: N added/changed, M total").
#   - Docker CLI access to the host running the backend container.
#   - `tar` with gzip on this machine (standard on Linux/macOS/Git Bash).
#
# Usage:
#   scripts/make_oib_seed.sh [CONTAINER] [OUTPUT]
#     CONTAINER  running backend container name/id  (default: aiq-agent)
#     OUTPUT     output tarball path                (default: oib-seed.tar.gz)
#
# Then upload OUTPUT to object storage / a GitHub release asset and set
# OIB_SEED_URL to its URL in Coolify (Build -> Build Variables). Regenerate only
# when the OIB corpus changes.
# =============================================================================
set -euo pipefail

CONTAINER="${1:-aiq-agent}"
OUTPUT="${2:-oib-seed.tar.gz}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Copying Chroma index from '$CONTAINER:/app/data/chroma_data'..."
docker cp "$CONTAINER:/app/data/chroma_data" "$WORK/chroma_data"

echo "==> Copying registry from '$CONTAINER:/app/data/oib_registry.json'..."
if ! docker cp "$CONTAINER:/app/data/oib_registry.json" "$WORK/oib_registry.json"; then
  echo "ERROR: oib_registry.json not found in the container." >&2
  echo "       Ingestion probably has not completed yet — without the registry" >&2
  echo "       a restored seed will be re-embedded on boot. Aborting." >&2
  exit 1
fi

# Sanity check: the Chroma dir should contain the sqlite metadata store.
if [ ! -f "$WORK/chroma_data/chroma.sqlite3" ]; then
  echo "WARNING: chroma_data/chroma.sqlite3 is missing — the KB may be empty." >&2
fi

echo "==> Packaging -> $OUTPUT"
tar -C "$WORK" -czf "$OUTPUT" chroma_data oib_registry.json

echo ""
echo "Done: $(du -h "$OUTPUT" | cut -f1)  $OUTPUT"
echo ""
echo "Next steps:"
echo "  1. Upload '$OUTPUT' to durable storage (S3/MinIO/GitHub release asset)."
echo "  2. In Coolify: Build -> Build Variables -> set OIB_SEED_URL=<public url>."
echo "  3. Redeploy. The seed is baked in; previews start with the KB ready."
echo ""
echo "IMPORTANT: keep AIQ_EMBED_MODEL / AIQ_EMBED_BASE_URL identical to what"
echo "generated this seed (default: openai/text-embedding-3-large @ OpenRouter),"
echo "or query embeddings won't match the stored vectors."
