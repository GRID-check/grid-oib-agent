"""A turn whose scope holds a restricted folder offers nothing the whole project reads (ADR-0084).

The BFF refuses a deep-research run, a task, a profile patch and a filing into
an open folder from such a conversation. These pin the agent's half: the model
is told which doors are shut and why, the per-tenant "not in this workspace"
blocks give way to that reason, and a ``project_profile_patch`` card the model
composes anyway is refused at the one validator every model card passes.
"""

from __future__ import annotations

from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.agents.piloti.prompt import render_system_prompt
from aiq_agent.agents.piloti.prompt import system_prompt_template
from aiq_agent.cards import envelope
from aiq_agent.cards.catalog import CARD_EXAMPLES
from aiq_agent.cards.catalog import CHAT_ONLY_CARD_TYPES
from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
from aiq_agent.cards.envelope import REFUSED_CONFINED
from aiq_agent.cards.envelope import validate_model_card
from aiq_agent.knowledge import scoping
from aiq_agent.knowledge.restricted_use import RestrictedUse
from aiq_agent.knowledge.restricted_use import bind_restricted_use
from aiq_agent.knowledge.restricted_use import reset_restricted_use

TOOLS = [{"name": "knowledge_search", "description": "Search the knowledge base."}]
CONFINED_TAG = "<eingeschraenkter_ordner>"
PATCH = {
    "type": "project_profile_patch",
    "title": "Projektkontext aktualisieren: Honorar",
    "rationale": "Laut Honorarvertrag.",
    "patch": [{"op": "add", "path": "/facts/gebaeudeklasse", "value": "GK4"}],
}


def _render(**overrides) -> str:
    state = ResearchAgentState(messages=[HumanMessage(content="Was ist vereinbart?")], **overrides)
    return render_system_prompt(system_prompt_template(), state, TOOLS)


class TestThePromptSaysWhichDoorsAreShutAndWhy:
    def test_a_confined_turn_names_the_four_doors_and_the_reason(self):
        rendered = _render(confined=True, deep_research_allowed=False, tasks_allowed=False)

        assert CONFINED_TAG in rendered
        for door in ("escalate_to_deep", "create_task", "project_profile_patch", "file_draft"):
            assert door in rendered.split(CONFINED_TAG, 1)[1]
        # Not the per-tenant reason: the capability exists, this thread may not use it.
        assert "<tiefenrecherche_aus>" not in rendered
        assert "<auftraege_aus>" not in rendered

    def test_an_open_turn_renders_no_such_block(self):
        rendered = _render()
        assert CONFINED_TAG not in rendered

    def test_a_tenant_without_the_capabilities_still_hears_its_own_reason(self):
        rendered = _render(deep_research_allowed=False, tasks_allowed=False)
        assert CONFINED_TAG not in rendered
        assert "<tiefenrecherche_aus>" in rendered
        assert "<auftraege_aus>" in rendered


class TestAProfilePatchCardIsRefusedInAConfinedTurn:
    def test_refused_when_the_scope_holds_a_restricted_collection(self, monkeypatch):
        monkeypatch.setattr(scoping, "get_collection_scope_from_context", lambda: ["proj_p1", "proj_p1_r0123456789ab"])

        card, refusal = validate_model_card(dict(PATCH))

        assert card is None
        assert refusal is not None and refusal.kind == REFUSED_CONFINED
        assert "restricted access" in refusal.message

    def test_accepted_in_an_open_turn(self, monkeypatch):
        monkeypatch.setattr(scoping, "get_collection_scope_from_context", lambda: ["proj_p1"])

        card, refusal = validate_model_card(dict(PATCH))

        assert refusal is None
        assert card is not None and card["type"] == "project_profile_patch"

    def test_refused_when_the_conversation_already_drew_on_a_restricted_folder(self, monkeypatch):
        """Nothing restricted is drawable this turn, but the conversation's record stands (ADR-0085)."""
        monkeypatch.setattr(scoping, "get_collection_scope_from_context", lambda: ["proj_p1"])
        use = RestrictedUse(organization_id="org", user_id="u1", conversation_id="c1", project_id="p1", confined=True)
        token = bind_restricted_use(use)
        try:
            card, refusal = validate_model_card(dict(PATCH))
        finally:
            reset_restricted_use(token)

        assert card is None
        assert refusal is not None and refusal.kind == REFUSED_CONFINED

    def test_other_cards_are_untouched_in_a_confined_turn(self, monkeypatch):
        monkeypatch.setattr(scoping, "get_collection_scope_from_context", lambda: ["proj_p1", "proj_p1_r0123456789ab"])
        example = next(
            dict(card)
            for card_type, card in CARD_EXAMPLES.items()
            if card_type not in envelope.CONFINED_CARD_TYPES
            and card_type not in SYSTEM_CARD_TYPES
            and card_type not in CHAT_ONLY_CARD_TYPES
        )

        card, refusal = validate_model_card(example)

        assert refusal is None
        assert card is not None

    def test_an_unreadable_scope_refuses_rather_than_lets_it_through(self, monkeypatch):
        def broken():
            raise RuntimeError("envelope unreadable")

        monkeypatch.setattr(scoping, "get_collection_scope_from_context", broken)

        card, refusal = validate_model_card(dict(PATCH))

        assert card is None
        assert refusal is not None and refusal.kind == REFUSED_CONFINED


class TestTheReflectionStageSeesWhatEarlierTurnsWereShown:
    """The join: `_finished` hands the registries' record to the stage facts."""

    def test_finished_passes_the_shown_notes_on(self, monkeypatch):
        import types

        from aiq_agent.agents.piloti import conversation_register as cr
        from aiq_agent.cards.registry import CardRegistry
        from aiq_agent.memory.restriction import RestrictedNote
        from aiq_agent.memory.shown_notes import ShownNotes
        from aiq_agent.turn.admission import TurnOutcome
        from aiq_agent.turn.registries import TurnRegistries

        seen: dict = {}

        def facts(_request_facts, **kwargs):
            seen.update(kwargs)
            return "facts"

        monkeypatch.setattr(cr, "post_answer_turn_facts", facts)
        monkeypatch.setattr(cr, "schedule_post_answer_stages", lambda *_a, **_k: None)
        monkeypatch.setattr(cr, "get_turn_documents", lambda: ())
        monkeypatch.setattr(cr, "build_result", lambda *_a: "result")
        monkeypatch.setattr(cr, "finished", lambda result: result)
        shown = ShownNotes(notes=(RestrictedNote("Honorar 48.000", ("proj_1_r0123456789ab",)),))

        cr._finished(
            TurnOutcome(state=object(), refusal=None),
            TurnRegistries(cards=CardRegistry(), shown_notes=shown),
            types.SimpleNamespace(stage_facts="request facts"),
            types.SimpleNamespace(query_text="q"),
            message_id="m1",
            stage_llms={},
        )

        assert seen["earlier_restricted_notes"] is shown

    async def test_setup_loads_the_record_for_the_thread(self, monkeypatch):
        import types

        from aiq_agent.agents.piloti import conversation_register as cr
        from aiq_agent.memory.shown_notes import ShownNotes

        shown = ShownNotes(overflowed=("proj_1_r0123456789ab",))
        asked: list = []

        async def value(result):
            return result

        async def load_shown(thread_id):
            asked.append(thread_id)
            return shown

        monkeypatch.setattr(cr, "load_turn_context", lambda *_a, **_k: value("context"))
        monkeypatch.setattr(cr, "load_inventory", lambda *_a, **_k: value("inventory"))
        monkeypatch.setattr(cr, "load_session_registry", lambda *_a, **_k: value("registry"))
        monkeypatch.setattr(cr, "load_subject_document", lambda *_a, **_k: value(None))
        monkeypatch.setattr(cr, "load_turn_shown_notes", load_shown)

        result = await cr._load_setup(
            types.SimpleNamespace(organization_id="org", user_id="u1"),
            types.SimpleNamespace(query_text="q", subject=None),
            [],
            conversation_id="c1",
            thread_id="t1",
            resolve_stages=False,
        )

        assert result[4] is shown
        assert asked == ["t1"]
