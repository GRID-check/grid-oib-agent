#!/usr/bin/env python3
"""Seed the S3 bucket with test documents laid out by the OIB knowledge layering.

Uses the plain S3 API (boto3), so it works identically against SeaweedFS, AWS S3,
or Cloudflare R2 -- only the endpoint/keys change.
"""
import os
import time
import boto3
from botocore.client import Config

ENDPOINT = os.environ.get("S3_ENDPOINT", "http://s3:8333")
BUCKET = os.environ.get("BUCKET", "grid-nas")
KEY = os.environ.get("AWS_ACCESS_KEY_ID", "gridkey")
SECRET = os.environ.get("AWS_SECRET_ACCESS_KEY", "gridsecret")

OBJECTS = {
    "oib-core/standards.md": "# OIB Core Standards\nRead-only shared ground truth for every org.\n",
    "org-acme/handbook.md": "# ACME org handbook\nVisible to all ACME members.\n",
    "org-acme/project-atlas/plan.pdf": "%PDF-1.4 (fake) Atlas project plan -- ACME/atlas members only\n",
    "org-acme/project-zenith/design.pdf": "%PDF-1.4 (fake) Zenith design -- ACME/zenith members only\n",
}


def main():
    s3 = boto3.client(
        "s3",
        endpoint_url=ENDPOINT,
        aws_access_key_id=KEY,
        aws_secret_access_key=SECRET,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        region_name="us-east-1",
    )
    # Wait for S3 to be ready.
    for attempt in range(60):
        try:
            s3.list_buckets()
            break
        except Exception as e:  # noqa: BLE001
            print(f"waiting for s3 ({attempt}): {e}", flush=True)
            time.sleep(1)
    else:
        raise SystemExit("s3 never became ready")

    try:
        s3.create_bucket(Bucket=BUCKET)
        print(f"created bucket {BUCKET}", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"bucket exists or: {e}", flush=True)

    for key, body in OBJECTS.items():
        s3.put_object(Bucket=BUCKET, Key=key, Body=body.encode())
        print(f"put s3://{BUCKET}/{key}", flush=True)

    print("--- objects in bucket ---", flush=True)
    for obj in s3.list_objects_v2(Bucket=BUCKET).get("Contents", []):
        print(f"  {obj['Key']} ({obj['Size']} B)", flush=True)
    print("seed complete", flush=True)


if __name__ == "__main__":
    main()
