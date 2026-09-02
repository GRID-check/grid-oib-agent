"""Tests for retrieval-based tool narrowing (LangGraph-level tool search).

The invariant every one of these guards is the BUDGET. This agent force-
synthesizes after five tool calls; the Keller failure spent all five on
model-opening, briefings and a storey table and never reached the measurement.
Tool search is only worth having if it is free in that currency — so the tests
below assert not just that the right tool is picked, but that picking it costs
no turn, adds no node, and can never leave the model with nothing to call.
"""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from aiq_agent.agents.shallow_researcher.agent import ShallowResearcherAgent
from aiq_agent.agents.shallow_researcher.models import ShallowResearchAgentState
from aiq_agent.agents.shallow_researcher.tool_search import QueryPart
from aiq_agent.agents.shallow_researcher.tool_search import ToolSearchIndex
from aiq_agent.agents.shallow_researcher.tool_search import ToolSearchSettings
from aiq_agent.agents.shallow_researcher.tool_search import build_query_parts
from aiq_agent.common import LLMProvider
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry

# ---------------------------------------------------------------------------
# A tool surface shaped like the production one (configs/config_oib_openrouter.yml):
# two capability-dense BIM tools with long descriptions, three RIS tools, web and
# knowledge search, and the interaction tools. Descriptions are abridged but keep
# the vocabulary the real ones carry — that vocabulary IS what the ranking reads.
# ---------------------------------------------------------------------------


@tool
def web_search_tool(query: str) -> str:
    """Search the web for real-time information from the public internet."""
    return query


@tool
def knowledge_search(query: str) -> str:
    """Search the uploaded project documents and the OIB knowledge base.

    Covers Richtlinien, Leitfaeden and uploaded PDFs — passages relevant to a
    question about a regulation rather than about this building.
    """
    return query


@tool
def ris_search_tool(suchworte: str) -> str:
    """Search the Austrian legal information system RIS.

    The authoritative, always-current source for Bundesrecht, Landesrecht and
    Judikatur: what a Gesetz, a Verordnung or a Bauordnung actually SAYS —
    exact wording, scope, thresholds, obligations, validity.
    """
    return suchworte


@tool
def ris_fetch_tool(document_number: str) -> str:
    """Fetch the ENTIRE text of an Austrian law or court decision from RIS.

    Always after ris_search, before citing or quoting any legal provision:
    search snippets are references only.
    """
    return document_number


@tool
def ris_catalog_lookup_tool(topic: str) -> str:
    """Look up an Austrian building-law topic in the curated RIS catalog.

    First stop for Bauordnungen, Bautechnikgesetze and Bautechnikverordnungen:
    maps a topic to verified RIS pointers.
    """
    return topic


@tool
def remember(finding: str) -> str:
    """Store a durable project finding in the project memory.

    Use when the user states a fact about their project that later turns must
    not have to be told again (Gebaeudeklasse, Hauptnutzung, Bauherr).
    """
    return finding


@tool
def emit_card(kind: str) -> str:
    """Emit a structured UI card to the frontend.

    Project profile patch, checklist or comparison table — a structured
    artefact for the user, never prose.
    """
    return kind


@tool
def surface_documents(scope: str) -> str:
    """List the documents currently uploaded to this project."""
    return scope


@tool
def ifc_query(operation: str) -> str:
    """Query the project's IFC/BIM model for EXACT facts about the building.

    Element counts, rooms and their areas, storeys (Geschosse), property values
    (fire rating, U-value, load-bearing), materials and classifications. Use
    this instead of knowledge_search whenever the question is about THIS
    building rather than about a regulation — 'how many escape doors', 'net
    floor area per storey', 'welche Raeume sind im Erdgeschoss'.

    operation: 'overview', 'health', 'types', 'properties', 'elements',
    'element', 'schedule' (the Raumbuch: every room with its storey, area and
    volume), 'takeoff' (Massenermittlung), 'profile', 'compliance'.
    """
    return operation


@tool
def ifc_measure(operation: str) -> str:
    """MEASURE the project's IFC/BIM model — geometry, topology, spatial relations.

    Use this when the answer is a DIMENSION, a DISTANCE, an AREA the export may
    not have published, or a spatial relationship: 'wie hoch ist der Raum
    wirklich', 'wie weit ist die Tuer von der Wand', 'welche Bauteile begrenzen
    diesen Raum'.

    operation: 'briefing', 'find_elements', 'element', 'relations', 'measure',
    'survey' — one measure across ALL elements of a selection. Reach for survey
    the moment the question is plural: 'wie hoch ist der Keller' names one room
    and means seventeen. Also 'element_profile', 'distance', 'clearance'.
    """
    return operation


@tool
def use_skill(name: str) -> str:
    """Load an agent skill's full instructions by name."""
    return name


PRODUCTION_SHAPED_TOOLS = [
    web_search_tool,
    knowledge_search,
    ris_search_tool,
    ris_fetch_tool,
    ris_catalog_lookup_tool,
    remember,
    emit_card,
    surface_documents,
    ifc_query,
    ifc_measure,
    use_skill,
]


def _index() -> ToolSearchIndex:
    return ToolSearchIndex(PRODUCTION_SHAPED_TOOLS)


def _ask(query: str, *, top_k: int = 4, always_include=()):
    return _index().select([QueryPart(query, 1.0)], top_k=top_k, always_include=list(always_include))


# ---------------------------------------------------------------------------
# Retrieval quality
# ---------------------------------------------------------------------------


class TestRetrievalPicksTheRightTool:
    """The ranking has to survive real German questions, not English keywords."""

    def test_the_keller_question_reaches_the_measurement_tool(self):
        """'wie hoch ist der Keller' — the question that started all of this."""
        selection = _ask("wie hoch ist der Keller")

        assert selection.narrowed is True
        assert "ifc_measure" in selection.selected
        # The tools that cannot answer a dimension question are the ones that go.
        assert "ris_fetch_tool" in selection.withheld

    def test_a_norm_question_reaches_the_ris_tools_not_the_model_tools(self):
        """A Bauordnung question is answered from the law, not from the building."""
        selection = _ask("Was sagt die Wiener Bauordnung zu Abstandsflaechen?")

        assert selection.narrowed is True
        assert "ris_search_tool" in selection.selected
        assert "ris_catalog_lookup_tool" in selection.selected

    def test_a_room_schedule_question_reaches_the_index_tool(self):
        """'welche Raeume' is what the export WROTE DOWN — ifc_query, not geometry."""
        selection = _ask("Wie viele Raeume hat das Erdgeschoss und wie gross sind sie?")

        assert "ifc_query" in selection.selected

    def test_diacritics_do_not_hide_a_tool(self):
        """'Räume' and 'Raeume' must reach the same tool; folding is not optional."""
        with_umlaut = _ask("Wie viele Räume hat das Erdgeschoß?")
        assert "ifc_query" in with_umlaut.selected

    def test_an_inflected_compound_still_matches_its_stem(self):
        """A question says 'Geschosse'; the description says 'storey'/'Geschosse'."""
        selection = _ask("Welche Geschosse hat das Gebaeude und wie sind die Raumhoehen?")
        assert "ifc_query" in selection.selected or "ifc_measure" in selection.selected


# ---------------------------------------------------------------------------
# Recall bias — the failure this feature must never cause
# ---------------------------------------------------------------------------


class TestNeverNarrowsAwayTheToolTheModelNeeds:
    """A retrieval that hides the one right tool costs the answer, not a turn."""

    def test_always_include_survives_a_query_that_ranks_it_nowhere(self):
        """A pinned tool is bound even when the question never mentions it."""
        unpinned = _ask("wie hoch ist der Keller")
        assert "remember" in unpinned.withheld, "precondition: this query does not rank `remember`"

        pinned = _ask("wie hoch ist der Keller", always_include=["remember", "emit_card"])
        assert "remember" in pinned.selected
        assert "emit_card" in pinned.selected

    def test_a_pin_is_matched_on_its_base_name(self):
        """A group-qualified `mcp__remember` is pinned by writing `remember`."""

        class _Qualified:
            name = "mcp__remember"
            description = "Store a durable project finding in the project memory."

        index = ToolSearchIndex([*PRODUCTION_SHAPED_TOOLS, _Qualified()])
        selection = index.select(
            [QueryPart("wie hoch ist der Keller", 1.0)],
            top_k=2,
            always_include=["remember"],
        )
        assert "mcp__remember" in selection.selected

    def test_pins_do_not_eat_the_retrieval_budget(self):
        """`top_k` counts RETRIEVED tools; pins sit on top of them.

        The budget is a ceiling on the ranking, not a quota to fill: this query
        scores one tool, so two pins make three bound tools and not four. What
        must never happen is a pin displacing a tool that actually ranked.
        """
        unpinned = _ask("wie hoch ist der Keller", top_k=2)
        pinned = _ask("wie hoch ist der Keller", top_k=2, always_include=["remember", "emit_card"])

        assert "ifc_measure" in pinned.selected
        assert {"remember", "emit_card"} <= set(pinned.selected)
        assert set(pinned.selected) == set(unpinned.selected) | {"remember", "emit_card"}

    def test_a_query_the_corpus_does_not_recognize_binds_everything(self):
        """No signal is not a ranking. Ranking a table of zeros picks at random."""
        selection = _ask("asdf qwerty zzzz")

        assert selection.narrowed is False
        assert selection.reason == "no_signal"
        assert set(selection.selected) == {t.name for t in PRODUCTION_SHAPED_TOOLS}

    def test_an_empty_query_binds_everything(self):
        selection = _index().select([], top_k=4)

        assert selection.narrowed is False
        assert set(selection.selected) == {t.name for t in PRODUCTION_SHAPED_TOOLS}

    def test_a_tool_set_smaller_than_top_k_is_never_narrowed(self):
        """config_web_kimi.yml has three tools. There is nothing to withhold."""
        index = ToolSearchIndex([web_search_tool, knowledge_search, ifc_measure])
        selection = index.select([QueryPart("wie hoch ist der Keller", 1.0)], top_k=4)

        assert selection.narrowed is False
        assert selection.reason == "nothing_to_narrow"
        assert len(selection.selected) == 3

    def test_a_non_positive_top_k_disables_narrowing(self):
        selection = _ask("wie hoch ist der Keller", top_k=0)

        assert selection.narrowed is False
        assert selection.reason == "top_k_disabled"

    def test_the_selection_is_never_empty(self):
        """Whatever the query, the model is always left something to call."""
        for query in ("", "asdf", "wie hoch ist der Keller", "Danke!", "?!?"):
            selection = _ask(query)
            assert selection.selected, f"empty selection for {query!r}"

    def test_a_sparse_match_binds_what_scored_and_not_the_budget(self):
        """The padding that made registration order a config knob.

        Filling the leftover `top_k` slots from the unmatched tools was sold as
        recall insurance and bought none — the padded tools are unrelated to
        the question by construction. All it decided was WHICH unrelated tools,
        by the order the workflow happened to assemble its list in.
        """
        selection = _ask("wie hoch ist der Keller", top_k=4)

        assert selection.reason == "ranked_sparse"
        assert len(selection.selected) < 4
        assert "ifc_measure" in selection.selected

    def test_reversing_the_tool_list_does_not_change_the_selection(self):
        """The defect, stated as the property it violated.

        With padding, 10 of the 11 evaluation questions selected a different
        tool set when the same tools were registered in the opposite order.
        """
        forward = ToolSearchIndex(PRODUCTION_SHAPED_TOOLS)
        backward = ToolSearchIndex(list(reversed(PRODUCTION_SHAPED_TOOLS)))

        for question, _ in RECALL_EVAL:
            a = forward.select([QueryPart(question, 1.0)], top_k=4)
            b = backward.select([QueryPart(question, 1.0)], top_k=4)
            assert set(a.selected) == set(b.selected), f"registration order changed the selection for {question!r}"
            assert a.reason == b.reason

    def test_the_reason_tells_a_full_ranking_from_a_sparse_one(self):
        """`ranked` vs `ranked_sparse` is the log line that explains a blinding."""
        sparse = _ask("wie hoch ist der Keller", top_k=4)
        full = _ask("wie hoch ist der Keller", top_k=1)

        assert sparse.reason == "ranked_sparse"
        assert full.reason == "ranked"


# The five tools a question does NOT describe. Four are interaction tools —
# "merk dir das" and "zeig mir das als Karte" are the user's INTENT, not a
# subject the tool description shares vocabulary with — and `ris_fetch_tool` is
# sequenced: its turn comes from what `ris_search_tool` returned, not from
# anything the user said. A retrieval over the user's turn structurally cannot
# rank either kind, which is what `always_include` is for. This is the
# recommended production pin set; the test below is the reason it exists.
RECOMMENDED_PINS = ["remember", "emit_card", "use_skill", "surface_documents", "ris_fetch_tool"]

# One realistic German question per tool. Over the fixture descriptions above
# this set scores 8/11 unpinned and 11/11 pinned — the single strongest argument
# for shipping this feature off by default and never turning it on without a pin
# set. The numbers survive swapping in `measure_register._TOOL_DESCRIPTION` (the
# real 10 603-char text, against these 643-char stand-ins), which is the only
# claim made for them: this is a shape check on the ranker, not a measurement of
# production recall.
#
# No question here may appear verbatim in the description of the tool it expects.
# „wie hoch ist der Keller" did — it is quoted in `ifc_measure`'s own text as the
# example of a question that means seventeen rooms — so the item was scoring the
# ranker against a sentence the ranker had already been handed.
RECALL_EVAL = [
    ("Wie hoch sind die Kellerraeume tatsaechlich?", "ifc_measure"),
    ("Wie viele Raeume hat das Erdgeschoss?", "ifc_query"),
    ("Welche Waende sind tragend?", "ifc_query"),
    ("Wie weit ist die Tuer von der Wand entfernt?", "ifc_measure"),
    ("Was sagt die Wiener Bauordnung zu Abstandsflaechen?", "ris_search_tool"),
    ("Welches Bautechnikgesetz gilt in der Steiermark?", "ris_catalog_lookup_tool"),
    ("Hol mir den Volltext der Bauordnung fuer Wien", "ris_fetch_tool"),
    ("Merk dir: die Gebaeudeklasse ist 4", "remember"),
    ("Welche Dokumente habe ich hochgeladen?", "surface_documents"),
    ("Zeig mir das als Karte zum Bestaetigen", "emit_card"),
    ("Mach eine BIM-Pruefung nach unserer Methode", "use_skill"),
]


class TestRecallOverARealisticQuestionSet:
    """One German question per tool. Every one must still reach its tool."""

    def test_the_recommended_pin_set_loses_no_tool(self):
        index = _index()
        lost = []
        for question, expected in RECALL_EVAL:
            selection = index.select(
                [QueryPart(question, 1.0)],
                top_k=4,
                always_include=RECOMMENDED_PINS,
            )
            if selection.narrowed and expected not in selection.selected:
                lost.append((question, expected))

        assert not lost, f"narrowing hid the answering tool for: {lost}"

    def test_the_pins_are_what_makes_that_true(self):
        """Without them the same set loses tools — the pin list is not decoration."""
        index = _index()
        lost = [
            expected
            for question, expected in RECALL_EVAL
            if (sel := index.select([QueryPart(question, 1.0)], top_k=4)).narrowed and expected not in sel.selected
        ]

        assert lost, "if unpinned recall is now perfect, revisit the recommended pin set"


# ---------------------------------------------------------------------------
# The query
# ---------------------------------------------------------------------------


class TestTheQueryIsTheUsersTurn:
    def test_the_query_is_built_from_human_turns_only(self):
        """Assistant/tool messages are the loop's own output, not the question."""
        parts = build_query_parts(
            [
                HumanMessage(content="Was sagt die Wiener Bauordnung?"),
                AIMessage(content="ich habe ris_search_tool aufgerufen"),
                HumanMessage(content="und wie hoch ist der Keller"),
            ]
        )

        texts = [p.text for p in parts]
        assert texts[0] == "und wie hoch ist der Keller"
        assert "ris_search_tool" not in " ".join(texts)

    def test_the_current_turn_outweighs_the_context_turns(self):
        parts = build_query_parts(
            [
                HumanMessage(content="Was sagt die Wiener Bauordnung?"),
                HumanMessage(content="und wie hoch ist der Keller"),
            ]
        )

        assert parts[0].weight == 1.0
        assert all(p.weight < 1.0 for p in parts[1:])

    def test_a_follow_up_that_names_nothing_still_reaches_the_prior_topic(self):
        """'und die Breite?' after a Bauordnung turn must not lose RIS."""
        index = _index()
        parts = build_query_parts(
            [
                HumanMessage(content="Was sagt die Wiener Bauordnung zu Abstandsflaechen?"),
                HumanMessage(content="und was gilt fuer die Breite?"),
            ]
        )
        selection = index.select(parts, top_k=4)

        assert "ris_search_tool" in selection.selected


# ---------------------------------------------------------------------------
# Wiring into the agent
# ---------------------------------------------------------------------------


class TestTheAgentBindsWhatWasRetrieved:
    @pytest.fixture(autouse=True)
    def _bypass_citation_pipeline(self):
        """Same bypass the agent tests use: these runs execute no real tool."""
        with (
            patch.object(SourceRegistry, "all_sources", return_value=[SourceEntry(url="https://example.com")]),
            patch("aiq_agent.agents.shallow_researcher.agent.verify_citations") as mock_verify,
            patch("aiq_agent.agents.shallow_researcher.agent.sanitize_report") as mock_sanitize,
        ):
            mock_verify.side_effect = lambda content, reg, reference_sources=None: MagicMock(
                verified_report=content, removed_citations=[]
            )
            mock_sanitize.side_effect = lambda content: MagicMock(sanitized_report=content)
            yield

    @pytest.fixture
    def bindings(self):
        """Record every bind_tools call so the BOUND set is observable."""
        return []

    @pytest.fixture
    def mock_llm(self, bindings):
        llm = MagicMock()
        llm.ainvoke = AsyncMock(return_value=AIMessage(content="Antwort"))

        def _bind(tools, **kwargs):
            bindings.append([t.name for t in tools])
            bound = MagicMock()
            bound.ainvoke = llm.ainvoke
            bound.bound_tool_names = [t.name for t in tools]
            return bound

        llm.bind_tools = MagicMock(side_effect=_bind)
        return llm

    @pytest.fixture
    def provider(self, mock_llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=mock_llm)
        return provider

    def _agent(self, provider, **settings):
        return ShallowResearcherAgent(
            llm_provider=provider,
            tools=PRODUCTION_SHAPED_TOOLS,
            tool_search=ToolSearchSettings(**settings) if settings else None,
        )

    @pytest.mark.asyncio
    async def test_a_research_turn_binds_only_the_retrieved_tools(self, provider, bindings):
        agent = self._agent(provider, enabled=True, top_k=3)
        bindings.clear()

        await agent.run(ShallowResearchAgentState(messages=[HumanMessage(content="wie hoch ist der Keller")]))

        narrowed = [b for b in bindings if len(b) < len(PRODUCTION_SHAPED_TOOLS)]
        assert narrowed, "expected a narrowed binding"
        assert "ifc_measure" in narrowed[-1]
        # What SCORED, not what fits: `top_k` is a ceiling, not a quota.
        assert set(narrowed[-1]) == set(
            agent._select_tools_for_query([HumanMessage(content="wie hoch ist der Keller")]).selected
        )

    @pytest.mark.asyncio
    async def test_the_prompt_tool_list_matches_the_binding(self, provider):
        """The model is never TOLD about a tool it has not been GIVEN."""
        agent = self._agent(provider, enabled=True, top_k=3)
        state = ShallowResearchAgentState(messages=[HumanMessage(content="wie hoch ist der Keller")])

        result = await agent.run(state)

        prompt = result.cached_system_prompt or ""
        selection = agent._select_tools_for_query(state.messages)
        # The prompt lists tools as `- **name**` bullets under "Available Tools"
        # (names only — descriptions travel in the bound schemas). A withheld
        # tool must not appear as a bullet; the prose elsewhere may still
        # mention `remember` by name, which is not an offer of the tool.
        for withheld in selection.withheld:
            assert f"- **{withheld}**" not in prompt, f"prompt advertises withheld tool {withheld}"
        assert "- **ifc_measure**" in prompt
        # And the narrowed list handed to the renderer IS the bound set.
        _, tools_info = agent._research_tool_binding(state.messages, agent.tools_info)
        assert [ti["name"] for ti in tools_info] == list(selection.selected)

    @pytest.mark.asyncio
    async def test_a_retrieval_failure_binds_the_full_set(self, provider, bindings):
        """The ranking is a convenience; the tool set is the contract."""
        agent = self._agent(provider, enabled=True, top_k=3)
        with patch.object(agent._tool_search_index, "select", side_effect=RuntimeError("index exploded")):
            bindings.clear()
            await agent.run(ShallowResearchAgentState(messages=[HumanMessage(content="wie hoch ist der Keller")]))

        assert all(len(b) == len(PRODUCTION_SHAPED_TOOLS) for b in bindings), bindings

    @pytest.mark.asyncio
    async def test_the_retrieval_runs_once_per_run_not_once_per_iteration(self, provider, mock_llm):
        """The loop must not re-rank on every LLM call — and must not drift."""
        mock_llm.ainvoke = AsyncMock(
            side_effect=[
                AIMessage(
                    content="", tool_calls=[{"name": "ifc_measure", "args": {"operation": "briefing"}, "id": "1"}]
                ),
                AIMessage(content="Antwort"),
            ]
        )
        agent = self._agent(provider, enabled=True, top_k=3)
        with patch.object(agent._tool_search_index, "select", wraps=agent._tool_search_index.select) as spy:
            await agent.run(ShallowResearchAgentState(messages=[HumanMessage(content="wie hoch ist der Keller")]))

        assert spy.call_count == 1, f"retrieval ran {spy.call_count}x across one run"


# ---------------------------------------------------------------------------
# The budget — the reason this is not a `search_tools` tool
# ---------------------------------------------------------------------------


class TestNarrowingCostsNoTurn:
    @pytest.fixture(autouse=True)
    def _bypass_citation_pipeline(self):
        with (
            patch.object(SourceRegistry, "all_sources", return_value=[SourceEntry(url="https://example.com")]),
            patch("aiq_agent.agents.shallow_researcher.agent.verify_citations") as mock_verify,
            patch("aiq_agent.agents.shallow_researcher.agent.sanitize_report") as mock_sanitize,
        ):
            mock_verify.side_effect = lambda content, reg, reference_sources=None: MagicMock(
                verified_report=content, removed_citations=[]
            )
            mock_sanitize.side_effect = lambda content: MagicMock(sanitized_report=content)
            yield

    def _provider(self, responses):
        llm = MagicMock()
        llm.ainvoke = AsyncMock(side_effect=list(responses))

        def _bind(tools, **kwargs):
            bound = MagicMock()
            bound.ainvoke = llm.ainvoke
            return bound

        llm.bind_tools = MagicMock(side_effect=_bind)
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=llm)
        return provider, llm

    def _responses(self):
        return [
            AIMessage(content="", tool_calls=[{"name": "ifc_measure", "args": {"operation": "briefing"}, "id": "1"}]),
            AIMessage(content="Antwort"),
        ]

    @pytest.mark.asyncio
    async def test_the_turn_count_is_identical_with_and_without_narrowing(self):
        """The whole justification for narrowing OUTSIDE the loop, asserted."""
        question = ShallowResearchAgentState(messages=[HumanMessage(content="wie hoch ist der Keller")])

        provider_off, llm_off = self._provider(self._responses())
        off = ShallowResearcherAgent(llm_provider=provider_off, tools=PRODUCTION_SHAPED_TOOLS)
        result_off = await off.run(question.model_copy(deep=True))

        provider_on, llm_on = self._provider(self._responses())
        on = ShallowResearcherAgent(
            llm_provider=provider_on,
            tools=PRODUCTION_SHAPED_TOOLS,
            tool_search=ToolSearchSettings(enabled=True, top_k=3),
        )
        result_on = await on.run(question.model_copy(deep=True))

        assert result_on.tool_iterations == result_off.tool_iterations == 1
        assert llm_on.ainvoke.call_count == llm_off.ainvoke.call_count == 2

    def test_no_discovery_tool_is_added_to_the_tool_set(self):
        """The model is never offered a tool whose job is finding tools."""
        provider, _ = self._provider([AIMessage(content="Antwort")])
        agent = ShallowResearcherAgent(
            llm_provider=provider,
            tools=PRODUCTION_SHAPED_TOOLS,
            tool_search=ToolSearchSettings(enabled=True, top_k=3),
        )

        names = {t.name for t in agent.tools}
        assert names == {t.name for t in PRODUCTION_SHAPED_TOOLS}
        assert not any("search_tool" in n and n.startswith("search") for n in names)

    def test_the_graph_gains_no_node(self):
        """Same two nodes as before: agent and tools. No retrieval step."""
        provider, _ = self._provider([AIMessage(content="Antwort")])
        off = ShallowResearcherAgent(llm_provider=provider, tools=PRODUCTION_SHAPED_TOOLS)
        on = ShallowResearcherAgent(
            llm_provider=provider,
            tools=PRODUCTION_SHAPED_TOOLS,
            tool_search=ToolSearchSettings(enabled=True, top_k=3),
        )

        assert set(on.graph.get_graph().nodes) == set(off.graph.get_graph().nodes)


# ---------------------------------------------------------------------------
# Inert when off
# ---------------------------------------------------------------------------


class TestInertWhenDisabled:
    @pytest.fixture
    def provider(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock(return_value=AIMessage(content="Antwort"))
        llm.bind_tools = MagicMock(return_value=llm)
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=llm)
        return provider

    def test_no_settings_means_no_index_is_even_built(self, provider):
        """A deployment that does not ask for this does not pay for it."""
        agent = ShallowResearcherAgent(llm_provider=provider, tools=PRODUCTION_SHAPED_TOOLS)

        assert agent.tool_search is None
        assert agent._tool_search_index is None

    def test_disabled_settings_are_the_same_as_no_settings(self, provider):
        agent = ShallowResearcherAgent(
            llm_provider=provider,
            tools=PRODUCTION_SHAPED_TOOLS,
            tool_search=ToolSearchSettings(enabled=False, top_k=2),
        )

        assert agent.tool_search is None
        assert agent._tool_search_index is None

    def test_a_disabled_agent_binds_the_prebuilt_full_binding(self, provider):
        agent = ShallowResearcherAgent(llm_provider=provider, tools=PRODUCTION_SHAPED_TOOLS)
        binding, tools_info = agent._research_tool_binding(
            [HumanMessage(content="wie hoch ist der Keller")], agent.tools_info
        )

        assert binding is agent._llm_with_tools
        assert tools_info is agent.tools_info

    def test_the_config_field_defaults_to_off(self):
        """An existing YAML with no `tool_search:` block must behave as today."""
        from aiq_agent.agents.shallow_researcher.register import ShallowResearchAgentConfig

        config = ShallowResearchAgentConfig(llm="some_llm")

        assert config.tool_search.enabled is False


# ---------------------------------------------------------------------------
# Observability (ADR-0045: the shape of the call, never the building)
# ---------------------------------------------------------------------------


class TestObservability:
    def test_the_decision_is_logged_as_names_and_counts(self, caplog):
        provider = MagicMock(spec=LLMProvider)
        llm = MagicMock()
        llm.bind_tools = MagicMock(return_value=llm)
        provider.get = MagicMock(return_value=llm)
        agent = ShallowResearcherAgent(
            llm_provider=provider,
            tools=PRODUCTION_SHAPED_TOOLS,
            tool_search=ToolSearchSettings(enabled=True, top_k=3),
        )

        with caplog.at_level("INFO", logger="aiq_agent.agents.shallow_researcher.agent"):
            agent._select_tools_for_query([HumanMessage(content="wie hoch ist der Keller")])

        records = [r for r in caplog.records if "[ToolSearch]" in r.getMessage()]
        assert records, "the narrowing decision must be observable"
        message = records[-1].getMessage()
        assert "ifc_measure" in message
        assert "1/11" in message
        # The reason is what makes a thin binding readable in the log.
        assert "ranked_sparse" in message

    def test_the_log_never_carries_the_users_question(self, caplog):
        """ADR-0045: tool names are code identifiers; the question is not."""
        provider = MagicMock(spec=LLMProvider)
        llm = MagicMock()
        llm.bind_tools = MagicMock(return_value=llm)
        provider.get = MagicMock(return_value=llm)
        agent = ShallowResearcherAgent(
            llm_provider=provider,
            tools=PRODUCTION_SHAPED_TOOLS,
            tool_search=ToolSearchSettings(enabled=True, top_k=3),
        )

        # A client's name and their Parzelle, not a credential — `detect-secrets`
        # reads the variable name. pragma: allowlist secret
        secret = "Bauherr Familie Gruber, Parzelle 1234/7, wie hoch ist der Keller"  # pragma: allowlist secret
        with caplog.at_level("INFO", logger="aiq_agent.agents.shallow_researcher.agent"):
            agent._select_tools_for_query([HumanMessage(content=secret)])

        for record in caplog.records:
            rendered = record.getMessage()
            assert "Gruber" not in rendered
            assert "1234/7" not in rendered
