"""Tests for the ``remember`` tool's honest failure handling.

Drives the inner ``_remember`` function (the one yielded as a NAT
``FunctionInfo``) with ``insert_memory_item`` mocked, so the tool's user-facing
result strings can be asserted without a real internal API.
"""

from unittest.mock import MagicMock

import pytest

import aiq_agent.knowledge.project_memory as pm
import aiq_agent.project_context as pc
from aiq_agent.agents.project_memory.register import ProjectMemoryRememberConfig
from aiq_agent.agents.project_memory.register import project_memory_remember


def _patch_context(monkeypatch, *, project_id="p1", organization_id="o1", conversation_id="c1"):
    monkeypatch.setattr(pc, "get_project_id_from_context", lambda: project_id)
    monkeypatch.setattr(pc, "get_organization_id_from_context", lambda: organization_id)
    monkeypatch.setattr(pc, "get_conversation_id_from_context", lambda: conversation_id)


async def _remember(monkeypatch, insert, **kwargs):
    """Enter the NAT registration, call _remember once, return its string result."""
    monkeypatch.setattr(pm, "insert_memory_item", insert)
    params = {"kind": "derived_fact", "content": "The roof load is 2 kN/m2.", "scope": "project"}
    params.update(kwargs)
    async with project_memory_remember(ProjectMemoryRememberConfig(), MagicMock()) as info:
        # NAT wraps the inner fn behind a pydantic input schema; call it the same
        # way the framework does — with a validated input model instance.
        return await info.single_fn(info.input_schema(**params))


@pytest.mark.asyncio
async def test_success_path_reports_recorded(monkeypatch):
    _patch_context(monkeypatch)
    insert = MagicMock(return_value="item-1")
    result = await _remember(monkeypatch, insert)
    assert result == "Recorded derived_fact in project memory."
    assert insert.called


@pytest.mark.asyncio
async def test_org_memory_disabled_returns_honest_message(monkeypatch):
    _patch_context(monkeypatch)
    insert = MagicMock(side_effect=pm.OrgMemoryDisabledError("disabled"))
    result = await _remember(monkeypatch, insert)
    assert "NOT saved" in result
    assert "organization memory panel" in result
    # Must not claim it was noted, and must tell the model not to retry.
    assert "Do not retry" in result


@pytest.mark.asyncio
async def test_generic_failure_returns_not_saved_message(monkeypatch):
    _patch_context(monkeypatch)
    insert = MagicMock(side_effect=RuntimeError("boom"))
    result = await _remember(monkeypatch, insert)
    assert "NOT saved" in result
    # The generic path is distinct from the org-deny path.
    assert "organization memory panel" not in result


@pytest.mark.asyncio
async def test_unknown_project_returns_none_result(monkeypatch):
    _patch_context(monkeypatch)
    insert = MagicMock(return_value=None)
    result = await _remember(monkeypatch, insert)
    assert result == "Error: unknown project — nothing recorded."


@pytest.mark.asyncio
async def test_org_deny_with_card_registry_emits_confirmation(monkeypatch):
    # With a card channel bound, an org-write denial must surface a confirmation
    # card (so the user can complete the write from their own session) instead of
    # the dead-end error string.
    from aiq_agent.cards.registry import CardRegistry
    from aiq_agent.cards.registry import reset_card_registry
    from aiq_agent.cards.registry import set_card_registry

    _patch_context(monkeypatch)
    insert = MagicMock(side_effect=pm.OrgMemoryDisabledError("disabled"))

    reg = CardRegistry()
    token = set_card_registry(reg)
    try:
        result = await _remember(monkeypatch, insert, scope="organization")
    finally:
        reset_card_registry(token)

    # The tool result makes clear nothing was saved and the user decides.
    assert "NOT been saved yet" in result
    assert "org-wide" in result
    # Exactly one memory_proposal card was added to the registry.
    cards = reg.snapshot()
    assert len(cards) == 1
    assert cards[0]["type"] == "memory_proposal"
    assert cards[0]["kind"] == "derived_fact"
    assert cards[0]["content"] == "The roof load is 2 kN/m2."


@pytest.mark.asyncio
async def test_org_deny_without_card_registry_falls_back_to_error(monkeypatch):
    # No card channel bound -> the honest org-disabled error string is unchanged.
    _patch_context(monkeypatch)
    insert = MagicMock(side_effect=pm.OrgMemoryDisabledError("disabled"))
    result = await _remember(monkeypatch, insert, scope="organization")
    assert "NOT saved" in result
    assert "organization memory panel" in result
    assert "Do not retry" in result


@pytest.mark.asyncio
async def test_generic_org_failure_emits_confirmation_card(monkeypatch):
    # A generic write failure on an ORG-scoped write also offers the card.
    from aiq_agent.cards.registry import CardRegistry
    from aiq_agent.cards.registry import reset_card_registry
    from aiq_agent.cards.registry import set_card_registry

    _patch_context(monkeypatch)
    insert = MagicMock(side_effect=RuntimeError("boom"))

    reg = CardRegistry()
    token = set_card_registry(reg)
    try:
        result = await _remember(monkeypatch, insert, scope="organization")
    finally:
        reset_card_registry(token)

    assert "NOT been saved yet" in result
    assert [c["type"] for c in reg.snapshot()] == ["memory_proposal"]


@pytest.mark.asyncio
async def test_generic_project_failure_keeps_error_even_with_registry(monkeypatch):
    # A PROJECT-scoped generic failure keeps the existing honest error string —
    # the confirmation card is only for org writes the agent token can't make.
    from aiq_agent.cards.registry import CardRegistry
    from aiq_agent.cards.registry import reset_card_registry
    from aiq_agent.cards.registry import set_card_registry

    _patch_context(monkeypatch)
    insert = MagicMock(side_effect=RuntimeError("boom"))

    reg = CardRegistry()
    token = set_card_registry(reg)
    try:
        result = await _remember(monkeypatch, insert, scope="project")
    finally:
        reset_card_registry(token)

    assert "NOT saved" in result
    assert "organization memory panel" not in result
    assert reg.snapshot() == []
