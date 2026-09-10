"""Tests for the ``remember`` tool's honest failure handling.

Drives the inner ``_remember`` function (the one yielded as a NAT
``FunctionInfo``) with ``insert_memory_item`` mocked, so the tool's user-facing
result strings can be asserted without a real internal API.
"""

from unittest.mock import MagicMock

import pytest
from pydantic import ValidationError

import aiq_agent.knowledge.project_memory as pm
import aiq_agent.project_context as pc
from aiq_agent.memory import register
from aiq_agent.memory.register import ProjectMemoryRememberConfig
from aiq_agent.memory.register import project_memory_remember


class _RefusingAdapter:
    """A card adapter that rejects everything, standing in for a card the schema
    has moved on from."""

    def validate_python(self, value):
        raise ValidationError.from_exception_data("GridCard", [])


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


@pytest.mark.asyncio
async def test_supersedes_reports_a_replacement_without_claiming_it_landed(monkeypatch):
    # The frontend ignores a quote it cannot resolve, or one naming a
    # human-curated entry, and this call never learns which happened.
    _patch_context(monkeypatch)
    result = await _remember(monkeypatch, MagicMock(return_value="item-1"), supersedes="An older note")
    assert result == "Recorded derived_fact in project memory, replacing the earlier note where it still matched."


@pytest.mark.asyncio
async def test_empty_content_is_refused_without_a_write(monkeypatch):
    _patch_context(monkeypatch)
    insert = MagicMock(return_value="item-1")
    result = await _remember(monkeypatch, insert, content="   ")
    assert result == "Error: content must not be empty."
    assert not insert.called


@pytest.mark.asyncio
async def test_content_is_truncated_to_the_configured_cap(monkeypatch):
    _patch_context(monkeypatch)
    insert = MagicMock(return_value="item-1")
    monkeypatch.setattr(pm, "insert_memory_item", insert)
    async with project_memory_remember(ProjectMemoryRememberConfig(max_content_chars=10), MagicMock()) as info:
        await info.single_fn(info.input_schema(kind="decision", content="x" * 50))
    assert insert.call_args.kwargs["content"] == "x" * 10


@pytest.mark.asyncio
async def test_a_project_call_without_a_project_escalates_to_the_organization(monkeypatch):
    # The finding is still worth keeping; the org path then hits the frontend's
    # default deny and comes back as a confirmation card (audit finding S1).
    _patch_context(monkeypatch, project_id=None)
    insert = MagicMock(return_value="item-1")
    monkeypatch.setattr(pm, "insert_memory_item", insert)
    async with project_memory_remember(ProjectMemoryRememberConfig(), MagicMock()) as info:
        result = await info.single_fn(info.input_schema(kind="decision", content="Firm-wide rule.", scope="project"))
    assert result == "Recorded decision in organization memory."
    assert insert.call_args.kwargs["scope"] == "organization"
    assert insert.call_args.kwargs["project_id"] is None


@pytest.mark.asyncio
async def test_no_project_and_no_organization_is_a_dead_end(monkeypatch):
    _patch_context(monkeypatch, project_id=None, organization_id=None)
    insert = MagicMock()
    result = await _remember(monkeypatch, insert)
    assert "no project in scope" in result
    assert "Do not retry" in result
    assert not insert.called


@pytest.mark.asyncio
async def test_org_scope_without_an_organization_is_a_dead_end(monkeypatch):
    _patch_context(monkeypatch, organization_id=None)
    insert = MagicMock()
    result = await _remember(monkeypatch, insert, scope="organization")
    assert "organization unknown" in result
    assert not insert.called


@pytest.mark.asyncio
async def test_a_vocabulary_disagreement_with_the_client_is_not_dressed_up_as_an_outage(monkeypatch):
    """``ValueError`` out of the client means this tool's vocabulary and
    ``knowledge.project_memory``'s have drifted apart. Reporting that as "memory
    is unavailable" is how a defect ships quietly."""
    _patch_context(monkeypatch)
    insert = MagicMock(side_effect=ValueError("Invalid kind 'decision'"))
    with pytest.raises(ValueError, match="Invalid kind"):
        await _remember(monkeypatch, insert)


@pytest.mark.asyncio
async def test_an_unbuildable_card_falls_back_to_the_error_string(monkeypatch):
    from aiq_agent.cards.registry import CardRegistry
    from aiq_agent.cards.registry import reset_card_registry
    from aiq_agent.cards.registry import set_card_registry

    _patch_context(monkeypatch)
    insert = MagicMock(side_effect=pm.OrgMemoryDisabledError("disabled"))
    # A card the adapter refuses must not take the turn down with it.
    monkeypatch.setattr(
        register,
        "grid_card_adapter",
        _RefusingAdapter(),
    )

    reg = CardRegistry()
    token = set_card_registry(reg)
    try:
        result = await _remember(monkeypatch, insert, scope="organization")
    finally:
        reset_card_registry(token)

    assert "organization memory panel" in result
    assert reg.snapshot() == []


class TestToolVocabulary:
    """The tool advertises its enums in its own JSON schema, so a provider
    constrains the argument before it is ever sent. Nothing checks those spellings
    against the write client's, so a rename on either side would start rejecting
    every call — pin them."""

    def test_kinds_match_the_write_clients_vocabulary(self):
        assert set(register.Kind.__args__[0].__args__) == pm.VALID_KINDS

    def test_confidences_match_the_write_clients_vocabulary(self):
        assert set(register.Confidence.__args__[0].__args__) == pm.VALID_CONFIDENCES

    def test_scopes_match_the_write_clients_vocabulary(self):
        assert set(register.Scope.__args__[0].__args__) == pm.VALID_SCOPES

    @pytest.mark.asyncio
    async def test_the_enums_reach_the_tool_schema(self):
        async with project_memory_remember(ProjectMemoryRememberConfig(), MagicMock()) as info:
            schema = info.input_schema.model_json_schema()
        assert set(schema["properties"]["kind"]["enum"]) == pm.VALID_KINDS
        assert set(schema["properties"]["scope"]["enum"]) == pm.VALID_SCOPES

    @pytest.mark.asyncio
    async def test_case_and_whitespace_are_folded_rather_than_rejected(self, monkeypatch):
        _patch_context(monkeypatch)
        insert = MagicMock(return_value="item-1")
        result = await _remember(monkeypatch, insert, kind=" Derived_Fact ", confidence="HIGH")
        assert result == "Recorded derived_fact in project memory."
        assert insert.call_args.kwargs["confidence"] == "high"

    @pytest.mark.asyncio
    async def test_a_value_outside_the_vocabulary_is_a_correctable_validation_error(self):
        """It used to be rewritten in silence for ``scope`` and ``confidence``,
        which moved a finding into a scope nobody asked for. The tool loop hands
        the validation error back for the model to correct instead."""
        async with project_memory_remember(ProjectMemoryRememberConfig(), MagicMock()) as info:
            with pytest.raises(ValidationError):
                info.input_schema(kind="decision", content="x", scope="global")
