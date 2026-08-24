"""Tests for at-rest encryption of DB-claimed job payloads (security).

The queue row persists the run_agent_job payload (which carries the user auth
token) durably in Postgres, so with a KEK set it must be AES-256-GCM encrypted
and round-trip exactly; without a KEK it falls back to plaintext (dev).
"""

from __future__ import annotations

import base64
import os

import pytest

from aiq_api.jobs import payload_crypto

_PAYLOAD = {"auth_token": "secret-bearer", "input_text": "hi", "usage_context": {"organization_id": "org"}}


def test_plaintext_roundtrip_without_kek(monkeypatch):
    monkeypatch.delenv("GRID_JOB_PAYLOAD_KEK", raising=False)
    stored = payload_crypto.serialize(_PAYLOAD)
    assert stored.startswith("json:")  # not encrypted
    assert payload_crypto.deserialize(stored) == _PAYLOAD


def test_encrypted_roundtrip_with_kek(monkeypatch):
    monkeypatch.setenv("GRID_JOB_PAYLOAD_KEK", base64.b64encode(os.urandom(32)).decode())
    stored = payload_crypto.serialize(_PAYLOAD)
    assert stored.startswith("enc:")
    assert "secret-bearer" not in stored  # token not present in ciphertext
    assert payload_crypto.deserialize(stored) == _PAYLOAD


def test_encrypted_payload_unreadable_without_key(monkeypatch):
    monkeypatch.setenv("GRID_JOB_PAYLOAD_KEK", base64.b64encode(os.urandom(32)).decode())
    stored = payload_crypto.serialize(_PAYLOAD)
    monkeypatch.delenv("GRID_JOB_PAYLOAD_KEK", raising=False)
    with pytest.raises(payload_crypto.PayloadKeyError):
        payload_crypto.deserialize(stored)


def test_invalid_kek_length_rejected(monkeypatch):
    monkeypatch.setenv("GRID_JOB_PAYLOAD_KEK", base64.b64encode(os.urandom(16)).decode())
    with pytest.raises(payload_crypto.PayloadKeyError):
        payload_crypto.serialize(_PAYLOAD)


def test_legacy_raw_json_still_readable(monkeypatch):
    monkeypatch.delenv("GRID_JOB_PAYLOAD_KEK", raising=False)
    # A row written before the wrapper existed is bare JSON.
    assert payload_crypto.deserialize('{"input_text": "x"}') == {"input_text": "x"}
