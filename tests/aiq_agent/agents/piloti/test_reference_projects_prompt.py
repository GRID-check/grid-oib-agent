"""The office's reference projects: turn context → state → prompt.

The catalog is what lets the agent look into past projects UNASKED
(docs/design/cross-project-escalation.md): the closed projects most like this
one, one line each, rendered below the KV-cache boundary because they vary per
office. It renders only when the turn can act on it: a catalog without
``project_lookup`` bound promises a door the model does not have.
"""

from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.agents.piloti.prompt import render_system_prompt
from aiq_agent.agents.piloti.prompt import system_prompt_template

BOUNDARY_ANCHOR = "## Context"
HEADING = "## Referenzprojekte des Büros"
CATALOG = "- Wohnbau Graz (id p1): 2019–2021, steiermark, GK 4, holzbau · gemeinsam: GK 4"
LOOKUP = {"name": "project_lookup", "description": "Schlägt in anderen Projekten nach."}
SEARCH = {"name": "knowledge_search", "description": "Search the knowledge base."}


def _render(tools, **overrides) -> str:
    state = ResearchAgentState(messages=[HumanMessage(content="Wie haben wir die Fluchttreppe gelöst?")], **overrides)
    return render_system_prompt(system_prompt_template(), state, tools)


def test_the_catalog_reaches_the_model_below_the_cache_boundary_with_the_rule_to_look_unasked():
    rendered = _render([SEARCH, LOOKUP], reference_projects=CATALOG)

    assert HEADING in rendered
    assert CATALOG in rendered
    assert rendered.index(BOUNDARY_ANCHOR) < rendered.index(HEADING)
    block = rendered.split(HEADING)[1]
    assert "ohne gefragt zu werden" in block
    assert "`project_lookup`" in block
    assert "Präzedenzfall, nicht als Norm" in block


def test_no_catalog_without_the_tool_to_act_on_it():
    assert HEADING not in _render([SEARCH], reference_projects=CATALOG)


def test_no_catalog_renders_no_section():
    assert HEADING not in _render([SEARCH, LOOKUP])


def test_the_conversation_state_hands_the_catalog_to_the_research_state():
    """The graph edge the field has to survive: a catalog that stops at the
    conversation state is one the answering agent never reads."""
    from aiq_agent.agents.piloti.conversation import ConversationGraph
    from aiq_agent.agents.piloti.models.conversation import ConversationState

    state = ConversationState(messages=[HumanMessage(content="Wie?")], reference_projects=CATALOG)
    research = ConversationGraph._research_input(object.__new__(ConversationGraph), state, list(state.messages))

    assert research.reference_projects == CATALOG
