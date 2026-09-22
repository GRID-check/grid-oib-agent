"""The Piloti turn honours both Platform → Models dials: the model and the thinking level.

Regression: the thinking level was applied only inside ``apply_model_override``,
which the chat agent never calls, so a platform owner dialling
``shallow_research`` down saw the YAML value on every turn.
"""

import pytest
from pydantic import BaseModel

from aiq_agent.agents.piloti import register
from aiq_agent.common import AgentGroup
from aiq_agent.common import LLMProvider
from aiq_agent.common import LLMRole


class _ChatModel(BaseModel):
    model_name: str = "yaml/model"
    reasoning_effort: str | None = "medium"


def _boot_provider() -> LLMProvider:
    provider = LLMProvider()
    provider.set_default(_ChatModel(), group=AgentGroup.RESEARCH)
    return provider


@pytest.fixture
def readers(monkeypatch):
    """The four per-turn lookups, answered without a BFF."""
    values = {"overrides": {}, "efforts": {}, "credential": None, "zdr": False}
    monkeypatch.setattr(register, "get_model_overrides_from_context", lambda: values["overrides"])
    monkeypatch.setattr(register, "get_reasoning_efforts", lambda: values["efforts"])
    monkeypatch.setattr(register, "get_org_llm_credential_from_context", lambda: values["credential"])
    monkeypatch.setattr(register, "get_zdr_only_from_context", lambda: values["zdr"])
    return values


class TestATurnCarriesBothDials:
    async def test_nothing_pinned_keeps_the_boot_provider(self, readers):
        boot = _boot_provider()
        assert await register._active_provider(boot) is boot

    async def test_effort_alone_derives_the_turn_provider(self, readers):
        readers["efforts"] = {"shallow_research": "low"}
        boot = _boot_provider()
        active = await register._active_provider(boot)
        assert active is not boot
        assert active.get(LLMRole.RESEARCHER).reasoning_effort == "low"
        assert boot.get(LLMRole.RESEARCHER).reasoning_effort == "medium"

    async def test_model_and_effort_compose(self, readers):
        readers["overrides"] = {"shallow_research": "vendor/fast"}
        readers["efforts"] = {"shallow_research": "none"}
        llm = (await register._active_provider(_boot_provider())).get(LLMRole.RESEARCHER)
        assert (llm.model_name, llm.reasoning_effort) == ("vendor/fast", "none")

    async def test_a_broken_effort_lookup_costs_only_the_effort(self, readers, monkeypatch):
        def boom():
            raise RuntimeError("bff down")

        monkeypatch.setattr(register, "get_reasoning_efforts", boom)
        readers["overrides"] = {"shallow_research": "vendor/fast"}
        llm = (await register._active_provider(_boot_provider())).get(LLMRole.RESEARCHER)
        assert (llm.model_name, llm.reasoning_effort) == ("vendor/fast", "medium")
