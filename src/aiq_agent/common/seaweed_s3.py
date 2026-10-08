"""The backend's read-only SeaweedFS client, built in one place.

The backend holds a READ-only object-store credential (ADR-0039): it only ever
calls ``get_object``. Writes go through the BFF's presigned URLs. Two readers
need that client, ``view_knowledge_image`` (project and Archiv files) and the
base-corpus store (``aiq_agent.corpus_store``, ADR-0082), and they must build it
the same way, so the endpoint, path-style addressing and credential names are
settled here and nowhere else.

Everything is read from the environment at call time, never at import, so a
deployment that never reads an object (no ``SEAWEED_*``) imports this cleanly.
"""

from __future__ import annotations

import os

ENDPOINT_ENV = "SEAWEED_ENDPOINT"
ACCESS_KEY_ENV = "SEAWEED_ACCESS_KEY"
SECRET_KEY_ENV = "SEAWEED_SECRET_KEY"  # pragma: allowlist secret (env-var name constant, not a credential)
BUCKET_ENV = "SEAWEED_BUCKET"
DEFAULT_BUCKET = "grid-documents"


def default_bucket() -> str:
    """The deployment's shared bucket (``SEAWEED_BUCKET``)."""
    return os.environ.get(BUCKET_ENV, DEFAULT_BUCKET).strip() or DEFAULT_BUCKET


def s3_client():
    """A path-style boto3 S3 client on the read credential, or ``None`` without one.

    ``None`` means ``SEAWEED_ENDPOINT``, ``SEAWEED_ACCESS_KEY`` or
    ``SEAWEED_SECRET_KEY`` is unset, so callers can degrade instead of raising.
    boto3 is imported lazily; constructing the client may still raise, which
    each caller handles in its own way (fail-open for the viewer, a typed error
    for the corpus store).
    """
    endpoint = os.environ.get(ENDPOINT_ENV, "").strip()
    access_key = os.environ.get(ACCESS_KEY_ENV, "").strip()
    secret_key = os.environ.get(SECRET_KEY_ENV, "").strip()
    if not endpoint or not access_key or not secret_key:
        return None

    import boto3
    from botocore.config import Config as _BotoConfig

    return boto3.client(
        "s3",
        endpoint_url=endpoint,
        region_name="us-east-1",
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=_BotoConfig(s3={"addressing_style": "path"}),
    )
