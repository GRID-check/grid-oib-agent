"""Tests for the ``remember`` tool's honest failure handling.

Drives the inner ``_remember`` function (the one yielded as a NAT
``FunctionInfo``) with ``insert_memory_item`` mocked, so the tool's user-facing
result strings can be asserted without a real internal API.
"""

import json
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
@pytest.mark.parametrize("failure", [RuntimeError("500 from the BFF"), TimeoutError("timed out")])
async def test_an_org_write_that_failed_otherwise_offers_no_card(monkeypatch, failure):
    # Only the refusal offers the card. The BFF audits the memory judge's
    # verdict before it refuses; a 500 or a timeout reached no audit, and a card
    # accepted then would write open memory whose verdict the trail never saw.
    from aiq_agent.cards.registry import CardRegistry
    from aiq_agent.cards.registry import reset_card_registry
    from aiq_agent.cards.registry import set_card_registry

    _patch_context(monkeypatch)
    insert = MagicMock(side_effect=failure)

    reg = CardRegistry()
    token = set_card_registry(reg)
    try:
        result = await _remember(monkeypatch, insert, scope="organization")
    finally:
        reset_card_registry(token)

    assert "NOT saved" in result
    assert "NOT been saved yet" not in result
    assert reg.snapshot() == []


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


# ADR-0084: a turn whose scope holds a restricted folder's collection still
# remembers; what it writes is restricted memory, never organization memory, and
# never a confirmation card (an accepted card is an open write by another door).
_RESTRICTED = "proj_abc_r0123456789ab"
_RESTRICTED_SCOPE = ["oib_knowledge", "proj_abc", _RESTRICTED, "s_c1"]
_CONTRACT_ROW = {"collection": _RESTRICTED, "file_name": "Honorarvertrag.pdf", "summary": "Honorar 184.000 EUR"}


def _patch_scope(monkeypatch, scope):
    from aiq_agent.knowledge import scoping

    monkeypatch.setattr(scoping, "get_collection_scope_from_context", lambda: scope)


def _patch_turn(monkeypatch, *, read=(), rows=(_CONTRACT_ROW,), judge=None):
    """Bind what the turn read and could list, and the judge model it resolves."""
    from aiq_agent.common import citation_verification as cv
    from aiq_agent.knowledge import inventory

    monkeypatch.setattr(cv, "get_turn_captures", lambda: [cv.SourceEntry(collection=name) for name in read])
    monkeypatch.setattr(cv, "get_session_registry", lambda: None)
    monkeypatch.setattr(inventory, "get_turn_documents", lambda: tuple(rows))
    monkeypatch.setattr(register, "_turn_judge_llm", lambda _base: judge)


class _Judge:
    def __init__(self, documents_per_note):
        self._reply = json.dumps({"notes": [{"note": 1, "documents": documents_per_note}]})

    def bind(self, **_kwargs):
        return self

    async def ainvoke(self, _messages):
        return type("_R", (), {"content": self._reply})()


@pytest.mark.asyncio
async def test_a_finding_from_a_read_restricted_folder_is_restricted_memory(monkeypatch):
    _patch_context(monkeypatch)
    _patch_scope(monkeypatch, _RESTRICTED_SCOPE)
    _patch_turn(monkeypatch, read=[_RESTRICTED])
    insert = MagicMock(return_value="item-1")
    result = await _remember(monkeypatch, insert)
    assert insert.call_args.kwargs["restricted_collections"] == (_RESTRICTED,)
    assert insert.call_args.kwargs["scope"] == "project"
    assert result.startswith("Recorded derived_fact in project memory.")
    assert "restricted" in result


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("judge", "expected", "verdict"),
    [(_Judge([1]), (_RESTRICTED,), "drawn"), (_Judge([]), None, "none"), (None, (_RESTRICTED,), "failed")],
)
async def test_a_listed_but_unread_folder_is_judged(monkeypatch, judge, expected, verdict):
    """Yes restricts, no leaves it open, no judge at all fails closed."""
    _patch_context(monkeypatch)
    _patch_scope(monkeypatch, _RESTRICTED_SCOPE)
    _patch_turn(monkeypatch, judge=judge)
    insert = MagicMock(return_value="item-1")
    await _remember(monkeypatch, insert)
    assert insert.call_args.kwargs["restricted_collections"] == expected
    # AI Act: the verdict goes with the write, for the BFF's audit trail.
    assert insert.call_args.kwargs["restriction_judge"] == {
        "verdict": verdict,
        "judgedCollections": [_RESTRICTED],
        "drawnCollections": [_RESTRICTED] if verdict == "drawn" else [],
    }


@pytest.mark.asyncio
async def test_a_finding_no_judge_decided_sends_no_verdict(monkeypatch):
    _patch_context(monkeypatch)
    _patch_scope(monkeypatch, _RESTRICTED_SCOPE)
    _patch_turn(monkeypatch, read=[_RESTRICTED])
    insert = MagicMock(return_value="item-1")
    await _remember(monkeypatch, insert)
    assert insert.call_args.kwargs["restriction_judge"] is None


@pytest.mark.asyncio
async def test_a_paraphrase_of_restricted_memory_in_the_digest_is_restricted(monkeypatch):
    """The judge sees the digest's restricted lines; drawing on one restricts to all of the scope."""
    _patch_context(monkeypatch)
    _patch_scope(monkeypatch, _RESTRICTED_SCOPE)
    _patch_turn(monkeypatch, rows=({"collection": "proj_abc", "file_name": "Plan.pdf"},), judge=_Judge([1]))
    token = pm.begin_turn_memory_log('- [restricted | decision | high | unverified] "Honorar pauschal 184.000"')
    try:
        insert = MagicMock(return_value="item-1")
        await _remember(monkeypatch, insert, content="Das Honorar ist pauschal.")
    finally:
        pm.end_turn_memory_log(token)
    assert insert.call_args.kwargs["restricted_collections"] == (_RESTRICTED,)


@pytest.mark.asyncio
async def test_a_restricted_organization_finding_is_kept_as_restricted_project_memory(monkeypatch):
    _patch_context(monkeypatch)
    _patch_scope(monkeypatch, _RESTRICTED_SCOPE)
    _patch_turn(monkeypatch, read=[_RESTRICTED])
    insert = MagicMock(return_value="item-1")
    result = await _remember(monkeypatch, insert, scope="organization")
    kwargs = insert.call_args.kwargs
    assert (kwargs["scope"], kwargs["project_id"], kwargs["restricted_collections"]) == (
        "project",
        "p1",
        (_RESTRICTED,),
    )
    assert "not organization-wide" in result


@pytest.mark.asyncio
async def test_a_restricted_organization_finding_without_a_project_is_not_saved(monkeypatch):
    _patch_context(monkeypatch, project_id=None)
    _patch_scope(monkeypatch, _RESTRICTED_SCOPE)
    _patch_turn(monkeypatch, read=[_RESTRICTED])
    insert = MagicMock(return_value="item-1")
    result = await _remember(monkeypatch, insert, scope="organization")
    assert "NOT saved" in result
    insert.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("scope", ["project", "organization"])
async def test_a_failed_restricted_write_never_becomes_a_card(monkeypatch, scope):
    from aiq_agent.cards.registry import CardRegistry
    from aiq_agent.cards.registry import reset_card_registry
    from aiq_agent.cards.registry import set_card_registry

    _patch_context(monkeypatch)
    _patch_scope(monkeypatch, _RESTRICTED_SCOPE)
    _patch_turn(monkeypatch, read=[_RESTRICTED])
    insert = MagicMock(side_effect=pm.OrgMemoryDisabledError("disabled"))
    reg = CardRegistry()
    token = set_card_registry(reg)
    try:
        result = await _remember(monkeypatch, insert, scope=scope)
    finally:
        reset_card_registry(token)
    assert "NOT saved" in result
    assert reg.snapshot() == []


@pytest.mark.asyncio
async def test_an_open_scope_still_records(monkeypatch):
    _patch_context(monkeypatch)
    _patch_scope(monkeypatch, ["oib_knowledge", "proj_abc", "s_c1"])
    insert = MagicMock(return_value="item-1")
    assert await _remember(monkeypatch, insert) == "Recorded derived_fact in project memory."
    insert.assert_called_once()
    assert insert.call_args.kwargs["restricted_collections"] is None


@pytest.mark.asyncio
async def test_a_restricted_note_an_earlier_turn_was_shown_still_restricts(monkeypatch):
    """ADR-0084: the note is gone from this turn's digest and no restricted row is
    listable; what earlier turns were shown (bound by `turn_registries`) is still
    evidence, and a copy of it is restricted to the note's own collection."""
    from aiq_agent.memory.restriction import RestrictedNote
    from aiq_agent.memory.shown_notes import ShownNotes
    from aiq_agent.memory.shown_notes import bind_shown_notes
    from aiq_agent.memory.shown_notes import unbind_shown_notes

    _patch_context(monkeypatch)
    _patch_scope(monkeypatch, _RESTRICTED_SCOPE)
    # The judge answers "nothing": only the deterministic copy check can restrict.
    _patch_turn(monkeypatch, rows=({"collection": "proj_abc", "file_name": "Plan.pdf"},), judge=_Judge([]))
    token = bind_shown_notes(ShownNotes(notes=(RestrictedNote("Honorar pauschal 184.000 EUR netto", (_RESTRICTED,)),)))
    try:
        insert = MagicMock(return_value="item-1")
        await _remember(monkeypatch, insert, content="Honorar pauschal 184.000 EUR netto")
    finally:
        unbind_shown_notes(token)
    assert insert.call_args.kwargs["restricted_collections"] == (_RESTRICTED,)
