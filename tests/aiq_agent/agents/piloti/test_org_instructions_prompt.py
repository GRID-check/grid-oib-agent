"""The office's standing instructions: header → state → prompt, and where they land.

This block is what replaced forcing a skill onto a turn. A standing
instruction — "Antworten kurz", "immer die Bauordnung zuerst" — is prompt text:
always present, costing no tool call, and impossible to half-apply, which is
exactly what a forced `use_skill` call could not promise.

Three things about it are load-bearing and each has a test here:

* it reaches the model at all (the lift, which is where `research_truncated`
  was once set, declared by the frontend and read by nobody for months);
* it sits BELOW the KV-cache boundary, because it varies per tenant and
  everything above the marker is the same bytes for every organization on the
  deployment;
* it is framed as a preference and never as a source, and the STATIC half of
  the prompt says so too — a rule that lives only next to the tenant's own text
  is a rule the tenant's own text sits beside rather than under.
"""

from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.agents.piloti.prompt import render_system_prompt
from aiq_agent.agents.piloti.prompt import system_prompt_template

BOUNDARY_ANCHOR = "## Context"
HEADING = "## Anweisungen des Büros"
TOOLS = [{"name": "knowledge_search", "description": "Search the knowledge base."}]
INSTRUCTIONS = "Antworten kurz halten.\nImmer die Wiener Bauordnung zuerst prüfen."


def _render(**overrides) -> str:
    state = ResearchAgentState(messages=[HumanMessage(content="Wie hoch darf das Gebäude sein?")], **overrides)
    return render_system_prompt(system_prompt_template(), state, TOOLS)


class TestTheBlockReachesTheModel:
    def test_the_office_text_is_rendered_under_its_own_heading(self):
        rendered = _render(org_instructions=INSTRUCTIONS)

        assert HEADING in rendered
        assert "Antworten kurz halten." in rendered
        assert "Immer die Wiener Bauordnung zuerst prüfen." in rendered

    def test_no_instructions_renders_no_section(self):
        """An empty heading is a worse answer than no heading: it tells the
        model the office said something and then shows it nothing."""
        rendered = _render()

        assert HEADING not in rendered
        assert "org_instructions" not in rendered

    def test_the_block_is_framed_as_a_preference_and_never_as_a_source(self):
        rendered = _render(org_instructions=INSTRUCTIONS)
        block = rendered.split(HEADING)[1]

        assert "never supply a normative value" in block
        assert "never override the rules above" in block
        assert "bounded" in block


class TestWhereItSits:
    def test_it_is_below_the_kv_cache_boundary(self):
        """Tenant-varying text above the marker would break prompt caching for
        every turn of every other organization on the deployment."""
        rendered = _render(org_instructions=INSTRUCTIONS)

        assert rendered.index(HEADING) > rendered.index(BOUNDARY_ANCHOR)

    def test_the_project_brief_keeps_its_place_at_the_bottom(self):
        """`<project_grounding>` says the Project Context is "at the bottom",
        and the office block must not have quietly taken that position."""
        rendered = _render(org_instructions=INSTRUCTIONS, project_context="Wien, Neubau, GK 4.")

        assert rendered.index(HEADING) < rendered.index("## Project Context")

    def test_the_static_half_says_the_rules_win(self):
        """The precedence rule is in the CACHED half, above the boundary.

        Stated only beside the office's own text, it would be a sentence the
        tenant's instructions sit next to; stated in `<conduct>`, it is one the
        model has read before it reaches them — and it is there whether or not
        this organization sent anything.
        """
        for rendered in (_render(), _render(org_instructions=INSTRUCTIONS)):
            conduct = rendered.split("<conduct>")[1].split("</conduct>")[0]
            assert "the rules win" in conduct
            assert "never a source" in conduct
            assert rendered.index("</conduct>") < rendered.index(BOUNDARY_ANCHOR)


class TestTheLift:
    def test_the_turn_context_carries_it_from_the_request(self):
        from aiq_agent.project_context import GridRequestContext
        from aiq_agent.turn.context import TurnContext

        assert "org_instructions" in TurnContext.__dataclass_fields__
        assert "org_instructions" in GridRequestContext.__dataclass_fields__

    def test_the_conversation_state_hands_it_to_the_research_state(self):
        """The graph edge the field has to survive: a value that stops at the
        conversation state is a value the answering agent never reads."""
        from aiq_agent.agents.piloti.conversation import ConversationGraph
        from aiq_agent.agents.piloti.models.conversation import ConversationState

        state = ConversationState(
            messages=[HumanMessage(content="Wie hoch?")],
            org_instructions=INSTRUCTIONS,
        )
        research = ConversationGraph._research_input(object.__new__(ConversationGraph), state, list(state.messages))

        assert research.org_instructions == INSTRUCTIONS
