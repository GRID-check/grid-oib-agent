"""Tests for the ClarifierAgent."""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool

from aiq_agent.agents.clarifier.agent import CLARIFICATION_PROMPT
from aiq_agent.agents.clarifier.agent import CLARIFIER_GRAPH
from aiq_agent.agents.clarifier.agent import PLAN_GENERATION_PROMPT
from aiq_agent.agents.clarifier.agent import SKIP_COMMANDS
from aiq_agent.agents.clarifier.agent import ClarifierAgent
from aiq_agent.agents.clarifier.agent import TurnConfig
from aiq_agent.agents.clarifier.agent import fallback_clarification
from aiq_agent.agents.clarifier.agent import format_plan_for_user
from aiq_agent.agents.clarifier.agent import parse_json_response
from aiq_agent.agents.clarifier.agent import parse_plan_reply
from aiq_agent.agents.clarifier.agent import route_after_clarifier
from aiq_agent.agents.clarifier.models import ClarificationResponse
from aiq_agent.agents.clarifier.models import ClarifierAgentState
from aiq_agent.agents.clarifier.models import ClarifierResult
from aiq_agent.agents.clarifier.models import PlanResponse
from aiq_agent.common import LLMProvider
from aiq_agent.common import LLMRole


@tool
def web_search_tool(query: str) -> str:
    """Search the web for information."""
    return f"Results for: {query}"


def make_llm(*replies: str) -> MagicMock:
    """A chat-model double that answers ``replies`` in order.

    ``bind_tools`` and ``bind`` return the model itself, the way a real
    integration returns a runnable that still serves ``ainvoke`` — the clarifier
    binds one or the other on every model it resolves.
    """
    llm = MagicMock()
    llm.bind_tools = MagicMock(return_value=llm)
    llm.bind = MagicMock(return_value=llm)
    messages = [AIMessage(content=reply) for reply in replies]
    if len(messages) == 1:
        llm.ainvoke = AsyncMock(return_value=messages[0])
    elif messages:
        llm.ainvoke = AsyncMock(side_effect=messages)
    else:
        llm.ainvoke = AsyncMock()
    return llm


def make_provider(llm: MagicMock) -> MagicMock:
    provider = MagicMock(spec=LLMProvider)
    provider.get = MagicMock(return_value=llm)
    return provider


def clarification(question: str | None = None, options: list[str] | None = None) -> str:
    """The JSON envelope the clarifier LLM is expected to return."""
    if question is None:
        return ClarificationResponse.complete().model_dump_json()
    return ClarificationResponse(
        needs_clarification=True,
        clarification_question=question,
        options=options or [],
    ).model_dump_json()


def state_for(text: str = "Research AI") -> ClarifierAgentState:
    return ClarifierAgentState(messages=[HumanMessage(content=text)])


class TestClarifierAgentInit:
    """Tests for ClarifierAgent initialization."""

    @pytest.fixture
    def provider(self):
        return make_provider(make_llm())

    def test_init_with_defaults(self, provider):
        """Test initialization with default values."""
        callback = AsyncMock()
        agent = ClarifierAgent(llm_provider=provider, user_prompt_callback=callback)

        assert agent.llm_provider == provider
        assert agent.tools == []
        assert agent.user_prompt_callback == callback
        assert agent.max_turns == 3
        assert agent.enable_plan_approval is False
        assert agent.max_plan_iterations == 10
        assert agent.callbacks == []

    def test_init_with_tools(self, provider):
        """Test initialization with tools."""
        agent = ClarifierAgent(
            llm_provider=provider,
            tools=[web_search_tool],
            user_prompt_callback=AsyncMock(),
        )

        assert len(agent.tools) == 1

    def test_init_with_custom_max_turns(self, provider):
        """Test initialization with custom max_turns."""
        agent = ClarifierAgent(llm_provider=provider, user_prompt_callback=AsyncMock(), max_turns=5)

        assert agent.max_turns == 5

    def test_init_with_callbacks(self, provider):
        """Test initialization with callbacks."""
        callback = MagicMock()
        agent = ClarifierAgent(llm_provider=provider, user_prompt_callback=AsyncMock(), callbacks=[callback])

        assert agent.callbacks == [callback]

    def test_the_graph_is_shared_not_per_agent(self, provider):
        """Compiling per agent (or per request) is the cost this removes."""
        first = ClarifierAgent(llm_provider=provider, user_prompt_callback=AsyncMock())
        second = ClarifierAgent(llm_provider=provider, user_prompt_callback=AsyncMock())

        assert first.graph is CLARIFIER_GRAPH
        assert second.graph is CLARIFIER_GRAPH

    def test_boot_binding_resolves_the_clarifier_role(self, provider):
        """The agent's LLM comes from the provider under the clarifier role."""
        ClarifierAgent(llm_provider=provider, user_prompt_callback=AsyncMock())

        provider.get.assert_called_with(LLMRole.CLARIFIER)


class TestClarifierBinding:
    """What one request may vary, and what it must not rebuild."""

    def test_a_tool_free_clarifier_gets_the_schema_natively(self):
        """No tools: the model is bound to strict json_schema output."""
        llm = make_llm()
        ClarifierAgent(llm_provider=make_provider(llm), user_prompt_callback=AsyncMock())

        llm.bind_tools.assert_not_called()
        bound = [call.kwargs["response_format"] for call in llm.bind.call_args_list]
        assert all(fmt["type"] == "json_schema" for fmt in bound)
        assert "ClarificationResponse" in [fmt["json_schema"]["name"] for fmt in bound]

    def test_a_tool_bound_clarifier_is_not_also_schema_bound(self):
        """Binding both is how OpenRouter silently drops the tool calls."""
        llm = make_llm()
        ClarifierAgent(llm_provider=make_provider(llm), tools=[web_search_tool], user_prompt_callback=AsyncMock())

        llm.bind_tools.assert_called_once()
        # The planner still binds its own schema; the clarifier model does not.
        for call in llm.bind.call_args_list:
            assert call.kwargs["response_format"]["json_schema"]["name"] == "PlanResponse"

    def test_the_planner_always_gets_the_schema(self):
        """Plan generation is tool-free, so it is always strict."""
        planner = make_llm()
        ClarifierAgent(
            llm_provider=make_provider(make_llm()),
            user_prompt_callback=AsyncMock(),
            planner_llm=planner,
        )

        assert planner.bind.call_args.kwargs["response_format"]["json_schema"]["name"] == "PlanResponse"

    def test_a_turn_config_overrides_the_provider_without_touching_the_agent(self):
        """The per-request seam: a new provider, the same agent and graph."""
        boot_llm = make_llm()
        agent = ClarifierAgent(llm_provider=make_provider(boot_llm), user_prompt_callback=AsyncMock())
        request_llm = make_llm()

        binding = agent.binding_for(TurnConfig(llm_provider=make_provider(request_llm)))

        assert binding.llm is request_llm
        assert agent._boot.llm is boot_llm

    def test_a_turn_config_narrows_the_tools(self):
        """Data-source filtering hands the request a shorter tool list."""
        agent = ClarifierAgent(
            llm_provider=make_provider(make_llm()),
            tools=[web_search_tool],
            user_prompt_callback=AsyncMock(),
        )

        binding = agent.binding_for(TurnConfig(tools=[]))

        assert binding.tool_node.tools_by_name == {}

    @pytest.mark.asyncio
    async def test_the_graph_refuses_to_run_without_a_binding(self):
        """A graph-direct invocation has no models to call; say so, don't crash later."""
        with pytest.raises(RuntimeError, match="outside run"):
            await CLARIFIER_GRAPH.ainvoke(state_for())


class TestPrompts:
    """The prompts are module constants, read once at import."""

    def test_prompts_are_loaded(self):
        assert "research clarification assistant" in CLARIFICATION_PROMPT
        assert "research planning assistant" in PLAN_GENERATION_PROMPT

    def test_the_turn_limit_is_single_sourced(self):
        """The prompt used to hard-code TWO while the config said three."""
        assert "{{ max_turns }}" in CLARIFICATION_PROMPT
        assert "TWO clarification questions" not in CLARIFICATION_PROMPT

    def test_the_rendered_turn_limit_is_the_configured_one(self):
        from aiq_agent.common import render_prompt_template

        rendered = render_prompt_template(
            CLARIFICATION_PROMPT,
            clarifier_result=None,
            project_context=None,
            available_documents=None,
            max_turns=3,
        )

        assert "Never ask more than 3 clarification questions total" in rendered

    def test_clarification_prompt_localizes_question_text(self):
        """Clarification prompt tells the model to write questions in the user's language."""
        assert "**Language**" in CLARIFICATION_PROMPT
        assert "same language as the user's most recent message" in CLARIFICATION_PROMPT.lower()
        # The skip control keyword the backend matches must stay byte-stable.
        assert "byte-stable" in CLARIFICATION_PROMPT
        assert "SKIP_COMMANDS" in CLARIFICATION_PROMPT

    def test_clarification_prompt_prefers_asking_over_silently_guessing(self):
        """The prompt used to bias hard against asking ("minimal friction",
        clarification marked "(Rare)", a threshold of "genuinely cannot
        proceed"). A live transcript pattern was the model silently picking
        one of several plausible angles instead of offering the choice as
        `options` — the exact UI users report enjoying, just rarely offered.

        This locks in the calibration the other way: whenever 2-5 concrete,
        distinct directions can already be named, the prompt must say to ask
        rather than to guess.
        """
        assert "2-5 concrete" in CLARIFICATION_PROMPT
        assert "do not silently pick one and proceed" in CLARIFICATION_PROMPT.lower()
        # The old framing that told the model clarification was rare/costly
        # must be gone, not just supplemented — a stray copy would keep
        # pulling the model back toward silence.
        assert "(rare)" not in CLARIFICATION_PROMPT.lower()
        assert "minimal friction" not in CLARIFICATION_PROMPT.lower()

    def test_every_example_carries_every_key(self):
        """Strict json_schema requires all three keys, so the examples show all three."""
        assert CLARIFICATION_PROMPT.count('"needs_clarification"') == CLARIFICATION_PROMPT.count('"options"')

    def test_plan_generation_prompt_localizes_content(self):
        """Plan-generation prompt localizes title/sections but not the approval envelope."""
        assert "same language as the user's request" in PLAN_GENERATION_PROMPT.lower()
        # The byte-stable approval envelope contract is documented and must not
        # be emitted by the model.
        assert "APPROVAL ENVELOPE" in PLAN_GENERATION_PROMPT
        assert "PLAN_REPLIES" in PLAN_GENERATION_PROMPT

    def test_localization_contract_comments_stay_out_of_rendered_prompts(self):
        """The byte-stable contract notes are Jinja comments — never sent to the model."""
        from aiq_agent.common import render_prompt_template

        rendered_clarification = render_prompt_template(
            CLARIFICATION_PROMPT,
            project_context=None,
            available_documents=None,
            clarifier_result=None,
            max_turns=3,
        )
        rendered_plan = render_prompt_template(
            PLAN_GENERATION_PROMPT,
            project_context=None,
            clarifier_context=None,
            feedback_history=None,
        )

        # Human-facing documentation comments are stripped at render time.
        assert "SKIP_COMMANDS" not in rendered_clarification
        assert "APPROVAL ENVELOPE" not in rendered_plan
        # ...but the localization instruction itself survives into the prompt.
        assert "**Language**" in rendered_clarification
        assert "same language as the user's request" in rendered_plan.lower()


class TestParseJsonResponse:
    """One parse, one helper, for both structured replies."""

    def test_valid_json(self):
        parsed = parse_json_response(clarification("What scope?"), ClarificationResponse)

        assert parsed is not None
        assert parsed.needs_clarification is True
        assert parsed.clarification_question == "What scope?"

    def test_code_fenced_json(self):
        text = '```json\n{"needs_clarification": true, "clarification_question": "Q?", "options": []}\n```'

        parsed = parse_json_response(text, ClarificationResponse)

        assert parsed is not None
        assert parsed.clarification_question == "Q?"

    def test_prose_around_the_json(self):
        text = 'Here you go: {"needs_clarification": false, "clarification_question": null, "options": []}'

        parsed = parse_json_response(text, ClarificationResponse)

        assert parsed is not None
        assert parsed.needs_clarification is False

    def test_not_json_at_all(self):
        assert parse_json_response("not json", ClarificationResponse) is None

    def test_empty_string(self):
        assert parse_json_response("", ClarificationResponse) is None

    def test_json_that_does_not_fit_the_schema(self, caplog):
        """A validation failure names itself instead of being swallowed."""
        with caplog.at_level("WARNING"):
            assert parse_json_response('{"needs_clarification": "maybe"}', ClarificationResponse) is None

        assert "ClarificationResponse" in caplog.text

    def test_plan_response(self):
        parsed = parse_json_response('{"title": "T", "sections": ["A", "B"]}', PlanResponse)

        assert parsed is not None
        assert parsed.title == "T"
        assert parsed.sections == ["A", "B"]

    def test_plan_response_with_non_string_sections(self):
        assert parse_json_response('{"title": "T", "sections": [1, 2]}', PlanResponse) is None


class TestSkipCommands:
    """The replies that end the questioning."""

    @pytest.mark.parametrize("command", ["skip", "done", "exit", "quit", "proceed", "continue", "no", "n", ""])
    def test_recognized(self, command):
        assert command in SKIP_COMMANDS

    def test_not_recognized(self):
        assert "tell me more" not in SKIP_COMMANDS


class TestFallbackClarification:
    """What is asked when the model's own clarification is unusable."""

    def test_topic_aware(self):
        response = fallback_clarification("Research quantum computing applications")

        assert response.needs_clarification is True
        assert "Research quantum computing applications" in (response.clarification_question or "")
        assert response.is_valid() is True

    def test_long_query_is_truncated(self):
        response = fallback_clarification("x" * 200)

        assert "..." in (response.clarification_question or "")

    def test_generic_without_a_query(self):
        response = fallback_clarification(None)

        assert response.needs_clarification is True
        assert response.is_valid() is True


class TestParsePlanReply:
    """Three literal tokens, one bare refusal, everything else is feedback."""

    @pytest.mark.parametrize("reply", ["approve", "APPROVE", "  approve  "])
    def test_approve(self, reply):
        assert parse_plan_reply(reply) == ("approved", "")

    def test_shallow(self):
        assert parse_plan_reply("shallow") == ("shallow", "")

    def test_cancel(self):
        assert parse_plan_reply("cancel") == ("cancelled", "")

    @pytest.mark.parametrize("reply", ["no", "nein", "nope", "reject"])
    def test_a_bare_refusal_falls_through_to_shallow(self, reply):
        """The user said no to the PLAN, not to being answered."""
        assert parse_plan_reply(reply) == ("shallow", "")

    @pytest.mark.parametrize("reply", ["stop", "abbrechen"])
    def test_a_bare_cancellation_ends_the_turn(self, reply):
        assert parse_plan_reply(reply) == ("cancelled", "")

    @pytest.mark.parametrize(
        "reply",
        [
            "no, focus only on Wien",
            "don't include costs in the plan",
            "add a section about fire safety",
            "keine Kosten bitte",
        ],
    )
    def test_a_sentence_is_feedback_not_a_verdict(self, reply):
        """A revision must stay a revision: these are the plan being improved,
        not the plan being refused."""
        decision, feedback = parse_plan_reply(reply)

        assert decision == "feedback"
        assert feedback == reply

    def test_json_wrapped_reply(self):
        assert parse_plan_reply('{"query": "approve"}') == ("approved", "")

    def test_json_wrapped_feedback(self):
        assert parse_plan_reply('{"query": "add a security section"}') == ("feedback", "add a security section")

    def test_json_with_a_non_string_query_is_not_unwrapped(self):
        """A number here used to crash the turn on .strip()."""
        decision, _ = parse_plan_reply('{"query": 42}')

        assert decision == "feedback"


class TestPlanFormatting:
    """The envelope the UI regex-matches."""

    def test_format_plan_for_user(self):
        result = format_plan_for_user(PlanResponse(title="AI Research Report", sections=["Introduction", "Analysis"]))

        assert "**Research Plan Preview**" in result
        assert "**Title:** AI Research Report" in result
        assert "1. Introduction" in result
        assert "2. Analysis" in result
        assert "approve" in result.lower()
        assert "shallow" in result.lower()
        assert "cancel" in result.lower()

    def test_format_plan_for_user_empty_sections(self):
        result = format_plan_for_user(PlanResponse(title="Test Plan", sections=[]))

        assert "**Title:** Test Plan" in result
        assert "**Sections:**" in result


class TestClarifierAgentRun:
    """Tests for the run method."""

    @pytest.mark.asyncio
    async def test_run_immediate_completion(self):
        """Test run when LLM immediately returns complete."""
        agent = ClarifierAgent(
            llm_provider=make_provider(make_llm(clarification())),
            user_prompt_callback=AsyncMock(),
        )

        result = await agent.run(state_for())

        assert isinstance(result, ClarifierResult)
        assert result.plan_outcome is None

    @pytest.mark.asyncio
    async def test_run_with_skip_command(self):
        """Test run when user skips clarification."""
        callback = AsyncMock(return_value="skip")
        agent = ClarifierAgent(
            llm_provider=make_provider(make_llm(clarification("What scope?"))),
            user_prompt_callback=callback,
        )

        result = await agent.run(state_for())

        assert "[Skipped clarification]" in result.clarifier_log
        callback.assert_called_once()

    @pytest.mark.asyncio
    async def test_run_with_zero_turns_never_asks(self):
        """max_turns=0 completes without a question."""
        callback = AsyncMock()
        agent = ClarifierAgent(
            llm_provider=make_provider(make_llm(clarification("What scope?"))),
            user_prompt_callback=callback,
            max_turns=0,
        )

        await agent.run(state_for())

        callback.assert_not_called()

    @pytest.mark.asyncio
    async def test_the_dialog_stops_at_max_turns(self):
        """The configured limit governs; the state carries no second copy."""
        llm = make_llm()
        llm.ainvoke = AsyncMock(return_value=AIMessage(content=clarification("Which angle?")))
        callback = AsyncMock(return_value="the technical one")
        agent = ClarifierAgent(llm_provider=make_provider(llm), user_prompt_callback=callback, max_turns=2)

        result = await agent.run(state_for())

        assert callback.await_count == 2
        assert "**Turn 2 - User:**" in result.clarifier_log

    @pytest.mark.asyncio
    async def test_the_answer_is_recorded_in_the_log(self):
        agent = ClarifierAgent(
            llm_provider=make_provider(make_llm(clarification("Which angle?"), clarification())),
            user_prompt_callback=AsyncMock(return_value="the technical one"),
        )

        result = await agent.run(state_for())

        assert "**Turn 1 - Assistant:**" in result.clarifier_log
        assert "the technical one" in result.clarifier_log

    @pytest.mark.asyncio
    async def test_an_unparseable_reply_asks_the_fallback_question(self):
        """A model that writes prose still gets the user asked, not researched."""
        seen: list[str] = []

        async def callback(question: str, options) -> str:
            seen.append(question)
            return "skip"

        agent = ClarifierAgent(
            llm_provider=make_provider(make_llm("I think we should research AI broadly.")),
            user_prompt_callback=callback,
        )

        await agent.run(state_for("Research AI"))

        assert len(seen) == 1
        assert "Research AI" in seen[0]

    @pytest.mark.asyncio
    async def test_run_logs_query(self, caplog):
        """Test that run logs the query."""
        agent = ClarifierAgent(
            llm_provider=make_provider(make_llm(clarification())),
            user_prompt_callback=AsyncMock(),
        )

        with caplog.at_level("INFO"):
            await agent.run(state_for("Test query"))

        assert "Clarifier: Starting" in caplog.text

    @pytest.mark.asyncio
    async def test_the_llm_reply_is_parsed_once_per_call(self, caplog):
        """The parse used to run five times per turn, warning five times over."""
        agent = ClarifierAgent(
            llm_provider=make_provider(make_llm("still not json")),
            user_prompt_callback=AsyncMock(return_value="skip"),
        )

        with caplog.at_level("WARNING"):
            await agent.run(state_for())

        assert len([line for line in caplog.text.splitlines() if "No JSON in the" in line]) == 1


class TestClarifierAgentPlanApproval:
    """Tests for plan approval workflow."""

    @staticmethod
    def agent_for(callback, planner, **kwargs) -> ClarifierAgent:
        return ClarifierAgent(
            llm_provider=make_provider(make_llm(clarification())),
            user_prompt_callback=callback,
            enable_plan_approval=True,
            planner_llm=planner,
            **kwargs,
        )

    @pytest.mark.asyncio
    async def test_run_with_plan_approval_approved(self):
        """Test run with plan approval when user approves."""
        planner = make_llm('{"title": "Test Research Plan", "sections": ["Intro", "Analysis", "Conclusion"]}')

        result = await self.agent_for(AsyncMock(return_value="approve"), planner).run(state_for())

        assert result.plan_approved is True
        assert result.plan_rejected is False
        assert result.plan_cancelled is False
        assert result.plan_title == "Test Research Plan"
        assert result.plan_sections == ["Intro", "Analysis", "Conclusion"]

    @pytest.mark.asyncio
    async def test_plan_generation_anchors_on_current_request(self):
        """The planner is anchored on the CURRENT request, not an earlier-turn
        topic still sitting in history — guards against stale-plan carry-over
        (an aborted research bleeding into a new, unrelated request)."""
        planner = make_llm('{"title": "T", "sections": ["A", "B"]}')
        agent = self.agent_for(AsyncMock(return_value="approve"), planner)

        # History carries an earlier, since-abandoned topic; the latest turn is new.
        state = ClarifierAgentState(
            messages=[
                HumanMessage(content="Research the 17-basement high-rise fire code"),
                AIMessage(content="(earlier deep-research discussion)"),
                HumanMessage(content="actually, summarize the daylight rules for small dwellings"),
            ]
        )
        await agent.run(state)

        # The final message handed to the planner names the CURRENT request.
        anchor = planner.ainvoke.await_args.args[0][-1].content
        assert "CURRENT request" in anchor
        assert "summarize the daylight rules for small dwellings" in anchor

    @pytest.mark.asyncio
    async def test_run_with_plan_approval_rejected(self):
        """A bare refusal declines the plan and falls through to shallow."""
        planner = make_llm('{"title": "Test Plan", "sections": ["Section 1"]}')

        result = await self.agent_for(AsyncMock(return_value="reject"), planner).run(state_for())

        assert result.plan_approved is False
        assert result.plan_rejected is True
        assert result.plan_cancelled is False

    @pytest.mark.asyncio
    async def test_run_with_plan_approval_shallow_request(self):
        """The explicit middle way: „Kurz beantworten" declines the plan the
        same way a rejection does, so the caller falls through to shallow."""
        planner = make_llm('{"title": "Test Plan", "sections": ["Section 1"]}')

        result = await self.agent_for(AsyncMock(return_value="shallow"), planner).run(state_for())

        assert result.plan_approved is False
        assert result.plan_rejected is True
        assert result.plan_cancelled is False

    @pytest.mark.asyncio
    async def test_run_with_plan_approval_cancelled(self):
        """An explicit cancellation is neither an approval nor a decline-to-shallow."""
        planner = make_llm('{"title": "Test Plan", "sections": ["Section 1"]}')

        result = await self.agent_for(AsyncMock(return_value="cancel"), planner).run(state_for())

        assert result.plan_approved is False
        assert result.plan_rejected is False
        assert result.plan_cancelled is True

    @pytest.mark.asyncio
    async def test_run_with_plan_approval_feedback_then_approve(self):
        """Test run with plan approval when user provides feedback then approves."""
        planner = make_llm(
            '{"title": "Initial Plan", "sections": ["Intro", "Analysis"]}',
            '{"title": "Revised Plan", "sections": ["Intro", "Security", "Analysis"]}',
        )
        callback = AsyncMock(side_effect=["add a security section", "approve"])

        result = await self.agent_for(callback, planner).run(state_for())

        assert result.plan_approved is True
        assert result.plan_title == "Revised Plan"
        assert "Security" in result.plan_sections

    @pytest.mark.asyncio
    async def test_feedback_reaches_the_next_plan(self):
        """The revision is what the user asked for, not a fresh guess."""
        planner = make_llm('{"title": "P", "sections": ["A"]}')
        callback = AsyncMock(side_effect=["add a security section", "approve"])

        await self.agent_for(callback, planner).run(state_for())

        second_system_prompt = planner.ainvoke.await_args_list[1].args[0][0].content
        assert "add a security section" in second_system_prompt

    @pytest.mark.asyncio
    async def test_run_with_plan_approval_max_iterations(self):
        """Test plan approval auto-approves after max iterations."""
        planner = make_llm('{"title": "Test Plan", "sections": ["Section 1"]}')
        callback = AsyncMock(return_value="make it better")

        result = await self.agent_for(callback, planner, max_plan_iterations=2).run(state_for())

        assert result.plan_approved is True
        assert callback.await_count == 2

    @pytest.mark.asyncio
    async def test_run_with_plan_approval_fallback_plan(self):
        """Test plan approval uses fallback when LLM returns invalid plan."""
        planner = make_llm("not valid json")

        result = await self.agent_for(AsyncMock(return_value="approve"), planner).run(state_for())

        assert result.plan_approved is True
        assert result.plan_title == "Research Report"
        assert "Introduction" in result.plan_sections

    @pytest.mark.asyncio
    async def test_run_with_plan_approval_zero_iterations(self):
        """Test plan approval with zero max_plan_iterations uses fallback values."""
        planner = make_llm('{"title": "Test Plan", "sections": ["Section 1"]}')
        callback = AsyncMock()

        result = await self.agent_for(callback, planner, max_plan_iterations=0).run(state_for())

        assert result.plan_approved is True
        assert result.plan_title == "Research Report"
        assert "Introduction" in result.plan_sections
        callback.assert_not_called()

    @pytest.mark.asyncio
    async def test_plan_approval_off_ends_without_a_plan(self):
        """Without plan approval the dialog ends when clarification does."""
        callback = AsyncMock()
        agent = ClarifierAgent(
            llm_provider=make_provider(make_llm(clarification())),
            user_prompt_callback=callback,
        )

        result = await agent.run(state_for())

        assert result.plan_outcome is None
        callback.assert_not_called()

    @pytest.mark.asyncio
    async def test_the_planner_llm_is_used_when_configured(self):
        """The planner ref exists so plan generation can run on another model."""
        clarifier_llm = make_llm(clarification())
        planner = make_llm('{"title": "T", "sections": ["A"]}')
        agent = ClarifierAgent(
            llm_provider=make_provider(clarifier_llm),
            user_prompt_callback=AsyncMock(return_value="approve"),
            enable_plan_approval=True,
            planner_llm=planner,
        )

        await agent.run(state_for())

        assert planner.ainvoke.await_count == 1
        assert clarifier_llm.ainvoke.await_count == 1


class TestClarifierAgentOptions:
    """Tests for threading structured answer options to the prompt callback."""

    @pytest.mark.asyncio
    async def test_options_are_passed_to_the_callback(self):
        """The picker is starved unless the labels reach the callback as data."""
        question = "**Focus**: which area?\n\n1. Alpha: about alpha\n2. Beta: about beta"
        seen: list[tuple[str, list[str]]] = []

        async def callback(text: str, options) -> str:
            seen.append((text, list(options)))
            return "skip"

        agent = ClarifierAgent(
            llm_provider=make_provider(make_llm(clarification(question, ["Alpha", "Beta"]))),
            user_prompt_callback=callback,
        )
        await agent.run(state_for())

        assert len(seen) == 1
        asked, options = seen[0]
        assert options == ["Alpha", "Beta"]
        # The prose question still carries the framing sentence and the numbered
        # list; the options add the picker, they do not replace it.
        assert "**Focus**" in asked

    @pytest.mark.asyncio
    async def test_a_question_without_options_offers_none(self):
        """An open question is asked as free text, exactly as before."""
        seen: list[list[str]] = []

        async def callback(text: str, options) -> str:
            seen.append(list(options))
            return "skip"

        agent = ClarifierAgent(
            llm_provider=make_provider(make_llm(clarification("Which period?"))),
            user_prompt_callback=callback,
        )
        await agent.run(state_for())

        assert seen == [[]]

    @pytest.mark.asyncio
    async def test_free_text_answer_is_still_accepted(self):
        """The user may type instead of picking; that reply drives the next turn."""
        agent = ClarifierAgent(
            llm_provider=make_provider(
                make_llm(clarification("**Focus**: which area?", ["Alpha", "Beta"]), clarification())
            ),
            user_prompt_callback=AsyncMock(return_value="Something I typed myself"),
        )

        result = await agent.run(state_for())

        assert "Something I typed myself" in result.clarifier_log

    @pytest.mark.asyncio
    async def test_options_are_never_parsed_out_of_the_question(self):
        """Regex-parsing the prose back into options is the bug being fixed."""
        question = "**Focus**: which area?\n\n1. Alpha: about alpha\n2. Beta: about beta"
        seen: list[list[str]] = []

        async def callback(text: str, options) -> str:
            seen.append(list(options))
            return "skip"

        agent = ClarifierAgent(
            llm_provider=make_provider(make_llm(clarification(question))),
            user_prompt_callback=callback,
        )
        await agent.run(state_for())

        assert seen == [[]]


class TestClarifierAgentTools:
    """The tool loop: the model searches, then decides."""

    @staticmethod
    def tool_call_message() -> AIMessage:
        return AIMessage(
            content="",
            tool_calls=[{"name": "web_search_tool", "args": {"query": "OIB"}, "id": "call-1"}],
        )

    @pytest.mark.asyncio
    async def test_a_tool_call_runs_the_tool_and_comes_back(self):
        """The branch that had no test at all: model -> tools -> model."""
        llm = make_llm()
        llm.ainvoke = AsyncMock(side_effect=[self.tool_call_message(), AIMessage(content=clarification())])
        agent = ClarifierAgent(
            llm_provider=make_provider(llm),
            tools=[web_search_tool],
            user_prompt_callback=AsyncMock(),
        )

        result = await agent.run(state_for())

        assert result.plan_outcome is None
        assert llm.ainvoke.await_count == 2
        second_request = llm.ainvoke.await_args_list[1].args[0]
        assert any(isinstance(message, ToolMessage) for message in second_request)

    @pytest.mark.asyncio
    async def test_the_json_reminder_follows_the_tool_results(self):
        """After tool output the model reaches for a report; the reminder stops it."""
        llm = make_llm()
        llm.ainvoke = AsyncMock(side_effect=[self.tool_call_message(), AIMessage(content=clarification())])
        agent = ClarifierAgent(
            llm_provider=make_provider(llm),
            tools=[web_search_tool],
            user_prompt_callback=AsyncMock(),
        )

        await agent.run(state_for())

        assert "valid JSON object" in llm.ainvoke.await_args_list[1].args[0][-1].content

    def test_the_router_refuses_an_empty_message_list(self):
        """A state with nothing in it is a bug upstream, not a route to guess at."""
        with pytest.raises(ValueError, match="no messages"):
            route_after_clarifier(ClarifierAgentState(messages=[]), {"configurable": {}})
