"""Tests for per-org BYOK LLM credentials (ADR-0022)."""

from unittest.mock import patch

import pytest
from pydantic import BaseModel

from aiq_agent.common import llm_credentials
from aiq_agent.common.llm_credentials import OrgLLMCredential
from aiq_agent.common.llm_credentials import apply_org_credential
from aiq_agent.common.llm_credentials import reset_credential_cache
from aiq_agent.common.llm_credentials import resolve_org_llm_credential
from aiq_agent.common.llm_provider import LLMProvider
from aiq_agent.common.llm_provider import LLMRole

CREDENTIAL = OrgLLMCredential(
    credential_id="cred-1",
    provider="openrouter",
    base_url="https://openrouter.ai/api/v1",
    api_key="sk-tenant-key",
    key_fingerprint="deadbeef",
)


class FakeChatModel(BaseModel):
    """Mimics a langchain ChatOpenAI: credential fields + client state.

    ``client`` simulates the bound HTTP client langchain builds at
    construction — a correct credential swap must NOT carry it over.
    """

    model_name: str = "vendor/model"
    openai_api_key: str | None = "sk-platform"
    openai_api_base: str | None = None
    temperature: float = 0.2
    client: object | None = None


@pytest.fixture(autouse=True)
def _fresh_cache():
    reset_credential_cache()
    yield
    reset_credential_cache()


class TestApplyOrgCredential:
    def test_rebuilds_with_tenant_credential(self):
        llm = FakeChatModel(client=object())
        swapped = apply_org_credential(llm, CREDENTIAL)
        assert swapped is not llm
        assert swapped.openai_api_key == "sk-tenant-key"
        assert swapped.openai_api_base == "https://openrouter.ai/api/v1"
        # Non-credential settings ride along; stale clients do not.
        assert swapped.model_name == "vendor/model"
        assert swapped.temperature == 0.2
        assert swapped.client is None
        # The original stays on the platform credential.
        assert llm.openai_api_key == "sk-platform"

    def test_none_credential_is_identity(self):
        llm = FakeChatModel()
        with patch.object(llm_credentials, "get_org_llm_credential_from_context", return_value=None):
            assert apply_org_credential(llm) is llm

    def test_non_pydantic_fails_open(self):
        sentinel = object()
        assert apply_org_credential(sentinel, CREDENTIAL) is sentinel

    def test_model_without_credential_fields_fails_open(self):
        class NoCredentialModel(BaseModel):
            model_name: str = "vendor/model"

        llm = NoCredentialModel()
        assert apply_org_credential(llm, CREDENTIAL) is llm


class TestProviderWithCredential:
    def test_applies_to_all_roles_and_default(self):
        provider = LLMProvider()
        default = FakeChatModel()
        writer = FakeChatModel(model_name="vendor/writer")
        provider.set_default(default)
        provider.configure(LLMRole.REPORT_WRITER, writer)

        derived = provider.with_credential(CREDENTIAL)
        assert derived is not provider
        assert derived.get(LLMRole.ROUTER).openai_api_key == "sk-tenant-key"
        assert derived.get(LLMRole.REPORT_WRITER).openai_api_key == "sk-tenant-key"
        assert derived.get(LLMRole.REPORT_WRITER).model_name == "vendor/writer"
        # Original untouched.
        assert provider.get(LLMRole.ROUTER).openai_api_key == "sk-platform"

    def test_shared_llm_instances_stay_shared(self):
        provider = LLMProvider()
        shared = FakeChatModel()
        provider.set_default(shared)
        provider.configure(LLMRole.ROUTER, shared)
        provider.configure(LLMRole.PLANNER, shared)

        derived = provider.with_credential(CREDENTIAL)
        assert derived.get(LLMRole.ROUTER) is derived.get(LLMRole.PLANNER)

    def test_none_credential_returns_self(self):
        provider = LLMProvider()
        provider.set_default(FakeChatModel())
        assert provider.with_credential(None) is provider


class TestResolveOrgLlmCredential:
    def test_no_org_short_circuits(self):
        assert resolve_org_llm_credential(None) is None
        assert resolve_org_llm_credential("") is None

    def test_caches_positive_results(self):
        with patch.object(llm_credentials, "_fetch_credential", return_value=CREDENTIAL) as fetch:
            assert resolve_org_llm_credential("org_1") is CREDENTIAL
            assert resolve_org_llm_credential("org_1") is CREDENTIAL
            assert fetch.call_count == 1

    def test_fetch_error_fails_open_and_negative_caches(self):
        with patch.object(llm_credentials, "_fetch_credential", side_effect=RuntimeError("boom")) as fetch:
            assert resolve_org_llm_credential("org_1") is None
            assert resolve_org_llm_credential("org_1") is None
            assert fetch.call_count == 1

    def test_requires_internal_token(self, monkeypatch):
        monkeypatch.delenv("GRID_INTERNAL_API_TOKEN", raising=False)
        assert llm_credentials._fetch_credential("org_1") is None
