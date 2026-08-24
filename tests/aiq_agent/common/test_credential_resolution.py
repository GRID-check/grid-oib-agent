"""Tests for the unified LLM credential resolver (credential_resolution.py)."""

from unittest.mock import patch

import pytest

from aiq_agent.common.credential_resolution import ResolvedCredential
from aiq_agent.common.credential_resolution import read_api_key_env
from aiq_agent.common.credential_resolution import resolve_llm_credential
from aiq_agent.common.llm_credentials import OrgLLMCredential

_NVIDIA = "https://integrate.api.nvidia.com/v1"
_OPENROUTER = "https://openrouter.ai/api/v1"

# Every env var any of these tests touches — cleared before each so the host's
# real environment can never leak in.
_ALL_ENVS = (
    "AIQ_VLM_API_KEY",
    "NVIDIA_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "LLM_API_KEY",
    "PRIMARY_KEY",
    "FALLBACK_A",
    "FALLBACK_B",
    "SOME_BASE_URL",
    "SOME_MODEL",
)


@pytest.fixture(autouse=True)
def _clear_env(monkeypatch):
    for name in _ALL_ENVS:
        monkeypatch.delenv(name, raising=False)


# ---------------------------------------------------------------------------
# read_api_key_env — the promoted ${...} placeholder guard
# ---------------------------------------------------------------------------


def test_read_api_key_env_returns_value(monkeypatch):
    monkeypatch.setenv("PRIMARY_KEY", "sk-real")
    assert read_api_key_env("PRIMARY_KEY") == "sk-real"


def test_read_api_key_env_missing_is_empty():
    assert read_api_key_env("PRIMARY_KEY") == ""


def test_read_api_key_env_treats_unresolved_placeholder_as_unset(monkeypatch):
    # docker compose env_file does not interpolate ${VAR}.
    monkeypatch.setenv("PRIMARY_KEY", "${OPENROUTER_API_KEY}")
    assert read_api_key_env("PRIMARY_KEY") == ""


# ---------------------------------------------------------------------------
# Resolution order
# ---------------------------------------------------------------------------


def test_primary_env_wins(monkeypatch):
    monkeypatch.setenv("PRIMARY_KEY", "primary")
    monkeypatch.setenv("FALLBACK_A", "fallback")
    result = resolve_llm_credential(
        primary_env="PRIMARY_KEY",
        fallback_envs=("FALLBACK_A",),
        default_base_url=_NVIDIA,
        default_model="m",
    )
    assert result == ResolvedCredential(api_key="primary", base_url=_NVIDIA, model="m", source="env")


def test_fallback_envs_in_order(monkeypatch):
    monkeypatch.setenv("FALLBACK_B", "b")
    result = resolve_llm_credential(
        primary_env="PRIMARY_KEY",
        fallback_envs=("FALLBACK_A", "FALLBACK_B"),
        default_base_url=_NVIDIA,
        default_model="m",
    )
    assert result.api_key == "b"
    assert result.source == "env"


def test_first_fallback_beats_later_fallback(monkeypatch):
    monkeypatch.setenv("FALLBACK_A", "a")
    monkeypatch.setenv("FALLBACK_B", "b")
    result = resolve_llm_credential(
        primary_env="PRIMARY_KEY",
        fallback_envs=("FALLBACK_A", "FALLBACK_B"),
        default_base_url=_NVIDIA,
        default_model="m",
    )
    assert result.api_key == "a"


def test_nothing_resolves_reports_none_source():
    result = resolve_llm_credential(
        primary_env="PRIMARY_KEY",
        fallback_envs=("FALLBACK_A",),
        default_base_url=_NVIDIA,
        default_model="m",
    )
    assert result == ResolvedCredential(api_key="", base_url=_NVIDIA, model="m", source="none")


def test_placeholder_primary_falls_through_to_fallback(monkeypatch):
    monkeypatch.setenv("PRIMARY_KEY", "${OPENROUTER_API_KEY}")
    monkeypatch.setenv("FALLBACK_A", "real")
    result = resolve_llm_credential(
        primary_env="PRIMARY_KEY",
        fallback_envs=("FALLBACK_A",),
        default_base_url=_NVIDIA,
        default_model="m",
    )
    assert result.api_key == "real"
    assert result.source == "env"


# ---------------------------------------------------------------------------
# base_url / model resolution
# ---------------------------------------------------------------------------


def test_base_url_and_model_from_env(monkeypatch):
    monkeypatch.setenv("PRIMARY_KEY", "k")
    monkeypatch.setenv("SOME_BASE_URL", "https://gw.example.com/v1/")
    monkeypatch.setenv("SOME_MODEL", "vendor/model-x")
    result = resolve_llm_credential(
        primary_env="PRIMARY_KEY",
        default_base_url=_NVIDIA,
        default_model="default-model",
        base_url_env="SOME_BASE_URL",
        model_env="SOME_MODEL",
    )
    # Trailing slash trimmed; env overrides the defaults.
    assert result.base_url == "https://gw.example.com/v1"
    assert result.model == "vendor/model-x"


def test_base_url_env_placeholder_falls_back_to_default(monkeypatch):
    monkeypatch.setenv("PRIMARY_KEY", "k")
    monkeypatch.setenv("SOME_BASE_URL", "${AIQ_VLM_BASE_URL}")
    result = resolve_llm_credential(
        primary_env="PRIMARY_KEY",
        default_base_url=_NVIDIA,
        default_model="m",
        base_url_env="SOME_BASE_URL",
    )
    assert result.base_url == _NVIDIA


# ---------------------------------------------------------------------------
# Provider inference by resolved base-URL host
# ---------------------------------------------------------------------------


def test_provider_inference_openrouter(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
    result = resolve_llm_credential(
        primary_env="AIQ_VLM_API_KEY",
        fallback_envs=("NVIDIA_API_KEY",),
        default_base_url=_OPENROUTER,
        default_model="m",
    )
    assert result.api_key == "or-key"
    assert result.source == "provider-default"


def test_provider_inference_nvidia(monkeypatch):
    monkeypatch.setenv("NVIDIA_API_KEY", "nv-key")
    result = resolve_llm_credential(
        primary_env="AIQ_VLM_API_KEY",
        default_base_url=_NVIDIA,
        default_model="m",
    )
    assert result.api_key == "nv-key"
    assert result.source == "provider-default"


def test_provider_inference_openai(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "oai-key")
    result = resolve_llm_credential(
        primary_env="PRIMARY_KEY",
        default_base_url="https://api.openai.com/v1",
        default_model="m",
    )
    assert result.api_key == "oai-key"
    assert result.source == "provider-default"


def test_provider_inference_only_picks_key_never_changes_base(monkeypatch):
    # Base URL stays exactly as configured; inference selects the KEY only.
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
    result = resolve_llm_credential(
        primary_env="PRIMARY_KEY",
        default_base_url=_OPENROUTER,
        default_model="m",
    )
    assert result.base_url == _OPENROUTER


def test_unknown_host_has_no_inference():
    result = resolve_llm_credential(
        primary_env="PRIMARY_KEY",
        default_base_url="https://unknown.example.com/v1",
        default_model="m",
    )
    assert result.source == "none"
    assert result.api_key == ""


def test_explicit_env_beats_provider_inference(monkeypatch):
    # An explicit primary key must win even when the base URL would infer another.
    monkeypatch.setenv("PRIMARY_KEY", "explicit")
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
    result = resolve_llm_credential(
        primary_env="PRIMARY_KEY",
        default_base_url=_OPENROUTER,
        default_model="m",
    )
    assert result.api_key == "explicit"
    assert result.source == "env"


# ---------------------------------------------------------------------------
# BYOK (org credential)
# ---------------------------------------------------------------------------

_BYOK = OrgLLMCredential(
    credential_id="cred-1",
    provider="openrouter",
    base_url="https://tenant.openrouter.ai/api/v1/",
    api_key="sk-tenant",
    key_fingerprint="abc123",
)


def test_byok_hit_swaps_key_and_base_url_not_model(monkeypatch):
    monkeypatch.setenv("PRIMARY_KEY", "env-key")
    # The resolver imports resolve_org_llm_credential lazily from its source
    # module, so patch it there.
    with patch("aiq_agent.common.llm_credentials.resolve_org_llm_credential", return_value=_BYOK):
        result = resolve_llm_credential(
            primary_env="PRIMARY_KEY",
            default_base_url=_NVIDIA,
            default_model="platform-model",
            organization_id="org-1",
        )
    assert result.api_key == "sk-tenant"
    # base_url swapped (trailing slash trimmed); model left untouched.
    assert result.base_url == "https://tenant.openrouter.ai/api/v1"
    assert result.model == "platform-model"
    assert result.source == "byok"


def test_byok_miss_falls_through_to_env(monkeypatch):
    monkeypatch.setenv("PRIMARY_KEY", "env-key")
    with patch("aiq_agent.common.llm_credentials.resolve_org_llm_credential", return_value=None):
        result = resolve_llm_credential(
            primary_env="PRIMARY_KEY",
            default_base_url=_NVIDIA,
            default_model="m",
            organization_id="org-1",
        )
    assert result.api_key == "env-key"
    assert result.source == "env"


def test_byok_fail_open_falls_through_to_env(monkeypatch):
    # resolve_org_llm_credential fails open (returns None) on any error; the
    # resolver must then continue down the env chain, never raise.
    monkeypatch.setenv("OPENROUTER_API_KEY", "or-key")
    with patch("aiq_agent.common.llm_credentials.resolve_org_llm_credential", return_value=None):
        result = resolve_llm_credential(
            primary_env="PRIMARY_KEY",
            default_base_url=_OPENROUTER,
            default_model="m",
            organization_id="org-1",
        )
    assert result.api_key == "or-key"
    assert result.source == "provider-default"


def test_no_org_id_skips_byok(monkeypatch):
    # With no org id the BYOK lookup must not even be attempted.
    monkeypatch.setenv("PRIMARY_KEY", "env-key")
    with patch("aiq_agent.common.llm_credentials.resolve_org_llm_credential") as mock_resolve:
        result = resolve_llm_credential(
            primary_env="PRIMARY_KEY",
            default_base_url=_NVIDIA,
            default_model="m",
            organization_id=None,
        )
    mock_resolve.assert_not_called()
    assert result.source == "env"
