"""Encrypt DB-claimed research-job payloads at rest (ADR-0021, security).

The claimable queue row (``research_job_queue.payload``) persists the full
``run_agent_job`` payload durably in Postgres. That payload carries the user's
auth token plus identity/budget context — unlike the old Dask path, which held
it only transiently in worker memory, this is at-rest exposure (table, WAL,
backups, replicas).

When ``GRID_JOB_PAYLOAD_KEK`` (32 bytes, base64) is set the payload is
AES-256-GCM encrypted; the worker decrypts it in-process to run the job. Without
a KEK the payload is stored as plaintext JSON (dev/compat) with a one-time
warning, so single-node/dev keeps working. Set the KEK in any multi-node or
production deployment.

Read path is fail-closed: when a KEK is configured, ``deserialize`` accepts
*only* ``enc:`` payloads and rejects ``json:``/raw-JSON rows with
``PayloadKeyError``. Otherwise a DB-write attacker could insert a plaintext row
carrying a forged auth token/usage context and the worker would execute it.
The write path keeps its plaintext fallback for dev (no KEK, single node).

Migration path for enabling the KEK on an existing deployment: queue rows are
transient dispatch state (deleted on completion), so drain before setting the
KEK — stop submitters, let workers empty ``research_job_queue``, then set the
KEK and restart. Any plaintext row still present afterwards is rejected, never
executed, and ages out through the normal claim-retry/reap path.

Longer term, minting a short-lived, narrowly-scoped job token at submit (instead
of forwarding the user's token) would remove the credential from the payload
entirely; encryption-at-rest is the proportionate fix until then.
"""

from __future__ import annotations

import base64
import json
import logging
import os
from typing import Any

logger = logging.getLogger(__name__)

_ENC_PREFIX = "enc:"
_PLAIN_PREFIX = "json:"
_warned_plaintext = False


class PayloadKeyError(RuntimeError):
    """Raised when an encrypted payload cannot be decrypted (missing/invalid KEK)."""


def _kek() -> bytes | None:
    raw = os.environ.get("GRID_JOB_PAYLOAD_KEK", "").strip()
    if not raw:
        return None
    try:
        key = base64.b64decode(raw)
    except Exception as exc:  # noqa: BLE001
        raise PayloadKeyError("GRID_JOB_PAYLOAD_KEK is not valid base64") from exc
    if len(key) != 32:
        raise PayloadKeyError("GRID_JOB_PAYLOAD_KEK must decode to 32 bytes (AES-256)")
    return key


def serialize(payload: dict[str, Any]) -> str:
    """Serialize a payload for storage — encrypted when a KEK is configured."""
    data = json.dumps(payload).encode("utf-8")
    kek = _kek()
    if kek is None:
        global _warned_plaintext
        if not _warned_plaintext:
            logger.warning(
                "GRID_JOB_PAYLOAD_KEK is not set — research-job payloads (including the user auth "
                "token) are stored as PLAINTEXT in Postgres. Set a 32-byte base64 KEK to encrypt "
                "them at rest before running multi-node/production."
            )
            _warned_plaintext = True
        return _PLAIN_PREFIX + base64.b64encode(data).decode("ascii")

    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    nonce = os.urandom(12)
    ciphertext = AESGCM(kek).encrypt(nonce, data, None)
    return _ENC_PREFIX + base64.b64encode(nonce + ciphertext).decode("ascii")


def deserialize(stored: str) -> dict[str, Any]:
    """Inverse of :func:`serialize`. Handles encrypted, wrapped-plaintext, and
    legacy raw-JSON forms — except when a KEK is configured, where only
    encrypted (``enc:``) payloads are accepted and anything else is rejected
    (fail closed; see module docstring)."""
    if stored.startswith(_ENC_PREFIX):
        kek = _kek()
        if kek is None:
            raise PayloadKeyError("payload is encrypted but GRID_JOB_PAYLOAD_KEK is not set")
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        blob = base64.b64decode(stored[len(_ENC_PREFIX) :])
        nonce, ciphertext = blob[:12], blob[12:]
        data = AESGCM(kek).decrypt(nonce, ciphertext, None)
        return json.loads(data)
    if _kek() is not None:
        # KEK configured: a plaintext row is either pre-KEK legacy (drain before
        # enabling the KEK) or forged by a DB-write attacker — either way it
        # must never be executed.
        raise PayloadKeyError("payload is not encrypted but GRID_JOB_PAYLOAD_KEK is set; refusing plaintext")
    if stored.startswith(_PLAIN_PREFIX):
        return json.loads(base64.b64decode(stored[len(_PLAIN_PREFIX) :]))
    # Back-compat: a raw JSON object written before this wrapper existed.
    # Dev/no-KEK only — unreachable when a KEK is set (rejected above).
    return json.loads(stored)
