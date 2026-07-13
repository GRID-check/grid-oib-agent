#!/bin/sh
# Phase-1 storage substrate: rclone-mount the S3 bucket (server-side FUSE), then
# run the gateway. Phase 2 (native aws-sdk-go-v2 backend) removes this entirely
# and with it the SYS_ADMIN/FUSE requirement -- the gateway binary is unchanged.
set -e

BUCKET="${BUCKET:-grid-nas}"
DATA_DIR="${GATEWAY_DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"

echo "entrypoint: rclone mount grids3:${BUCKET} -> ${DATA_DIR}"
rclone mount "grids3:${BUCKET}" "$DATA_DIR" \
  --config /etc/rclone/rclone.conf \
  --dir-cache-time 3s --vfs-cache-mode writes --vfs-write-back 1s --daemon

i=0
while [ "$i" -lt 40 ]; do
  mountpoint -q "$DATA_DIR" && break
  i=$((i + 1)); sleep 0.25
done
mountpoint -q "$DATA_DIR" || { echo "entrypoint: rclone mount failed" >&2; exit 1; }
echo "entrypoint: S3 mounted; starting gateway"
exec /usr/local/bin/gateway
