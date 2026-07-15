"""Unit tests for the centralized VLM key resolver (the derived image-upload capability).

``resolve_vlm_api_key`` is the single source of truth both the ingestion path
and the capability endpoint consult, so the advertised ``vlm_available`` bit can
never drift from what ingestion will actually attempt. These tests pin the
resolution chain (explicit ``AIQ_VLM_API_KEY`` → ``NVIDIA_API_KEY`` fallback) and
the derived ``vlm_configured`` boolean.
"""

import pytest
from knowledge_layer.llamaindex.adapter import resolve_vlm_api_key
from knowledge_layer.llamaindex.adapter import vlm_configured


@pytest.fixture(autouse=True)
def _clear_vlm_env(monkeypatch):
    monkeypatch.delenv("AIQ_VLM_API_KEY", raising=False)
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)


def test_resolves_explicit_vlm_key(monkeypatch):
    monkeypatch.setenv("AIQ_VLM_API_KEY", "vlm-secret")
    assert resolve_vlm_api_key() == "vlm-secret"
    assert vlm_configured() is True


def test_falls_back_to_nvidia_key(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "nvidia-secret")
    assert resolve_vlm_api_key() == "nvidia-secret"
    assert vlm_configured() is True


def test_explicit_key_wins_over_nvidia_fallback(monkeypatch):
    monkeypatch.setenv("AIQ_VLM_API_KEY", "vlm-secret")
    monkeypatch.setenv("NVIDIA_API_KEY", "nvidia-secret")
    assert resolve_vlm_api_key() == "vlm-secret"


def test_no_key_configured_reports_unavailable():
    assert resolve_vlm_api_key() == ""
    assert vlm_configured() is False


def test_unresolved_placeholder_is_treated_as_unset(monkeypatch):
    # docker compose env_file does not interpolate ${VAR}; a literal placeholder
    # must not read as a configured key (else vlm_available lies).
    monkeypatch.setenv("AIQ_VLM_API_KEY", "${OPENROUTER_API_KEY}")
    assert resolve_vlm_api_key() == ""
    assert vlm_configured() is False
