"""Tests for the clarification step."""

import asyncio
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool

from aiq_agent.agents.piloti.clarify import CLARIFICATION_PROMPT
from aiq_agent.agents.piloti.clarify import MAX_TOOL_ROUNDS
from aiq_agent.agents.piloti.clarify import PLAN_GENERATION_PROMPT
from aiq_agent.agents.piloti.clarify import SKIP_COMMANDS
from aiq_agent.agents.piloti.clarify import TRACE_STEP_NAME
from aiq_agent.agents.piloti.clarify import ClarifierSettings
from aiq_agent.agents.piloti.clarify import ClarifyDeps
from aiq_agent.agents.piloti.clarify import build_deps
from aiq_agent.agents.piloti.clarify import clarify
from aiq_agent.agents.piloti.clarify import fallback_clarification
from aiq_agent.agents.piloti.clarify import parse_json_response
from aiq_agent.agents.piloti.models import ClarificationResponse
from aiq_agent.agents.piloti.models import ClarifyRequest
from aiq_agent.agents.piloti.models import PlanResponse
from aiq_agent.common import LLMProvider
from aiq_agent.common import LLMRole


@tool
def web_search_tool(query: str) -> str:
    """Search the web for information."""
    return f"Results for: {query}"


def make_llm(*replies: str) -> MagicMock:
    """A chat-model double that answers ``replies`` in order.

    ``bind_tools`` and ``bind`` return the model itself, the way a real
    integration returns a runnable that still serves ``ainvoke`` — the step
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


def deps_for(llm: MagicMock, *, ask=None, tools=(), planner=None, **settings) -> ClarifyDeps:
    """The resolved dependencies one run reads, built the way boot builds them."""
    return build_deps(
        make_provider(llm),
        list(tools),
        planner,
        ClarifierSettings(llm="clarifier_llm", **settings),
        ask or AsyncMock(),
    )


def clarification(question: str | None = None, options: list[str] | None = None) -> str:
    """The JSON envelope the clarifier LLM is expected to return."""
    if question is None:
        return ClarificationResponse.complete().model_dump_json()
    return ClarificationResponse(
        needs_clarification=True,
        clarification_question=question,
        options=options or [],
    ).model_dump_json()


def request_for(text: str = "Research AI") -> ClarifyRequest:
    return ClarifyRequest(messages=[HumanMessage(content=text)])


class TestBuildDeps:
    """What one run resolves, and which model gets which binding."""

    def test_the_clarifier_role_is_what_the_provider_is_asked_for(self):
        """The `clarifier` agent group survives the collapse; this is where it is read."""
        provider = make_provider(make_llm())

        build_deps(provider, [], None, ClarifierSettings(llm="l"), AsyncMock())

        provider.get.assert_called_with(LLMRole.CLARIFIER)

    def test_a_tool_free_clarifier_gets_the_schema_natively(self):
        """No tools: the model is bound to strict json_schema output."""
        llm = make_llm()

        deps_for(llm)

        llm.bind_tools.assert_not_called()
        bound = [call.kwargs["response_format"] for call in llm.bind.call_args_list]
        assert all(fmt["type"] == "json_schema" for fmt in bound)
        assert "ClarificationResponse" in [fmt["json_schema"]["name"] for fmt in bound]

    def test_a_tool_bound_clarifier_is_not_also_schema_bound(self):
        """Binding both is how OpenRouter silently drops the tool calls."""
        llm = make_llm()

        deps_for(llm, tools=[web_search_tool])

        llm.bind_tools.assert_called_once()
        # The planner still binds its own schema; the clarifier model does not.
        for call in llm.bind.call_args_list:
            assert call.kwargs["response_format"]["json_schema"]["name"] == "PlanResponse"

    def test_the_planner_always_gets_the_schema(self):
        """Plan generation is tool-free, so it is always strict."""
        planner = make_llm()

        deps_for(make_llm(), planner=planner)

        assert planner.bind.call_args.kwargs["response_format"]["json_schema"]["name"] == "PlanResponse"

    def test_the_limits_come_from_the_settings(self):
        deps = deps_for(make_llm(), max_turns=5, plan_approval="ask", plan_grace_seconds=20)

        assert (deps.max_turns, deps.plan_approval, deps.plan_grace_seconds) == (5, "ask", 20)

    def test_a_yaml_predating_the_plan_primitive_still_means_auto(self):
        """``enable_plan_approval: true`` is how every deployment spelled it before ADR-0065."""
        settings = ClarifierSettings(llm="clarifier_llm", enable_plan_approval=True, max_plan_iterations=3)
        assert settings.plan_approval == "auto"
        assert ClarifierSettings(llm="clarifier_llm", enable_plan_approval=False).plan_approval == "off"

    def test_the_tools_are_addressable_by_name(self):
        """A tool call names a tool; the step looks it up rather than scanning."""
        assert set(deps_for(make_llm(), tools=[web_search_tool]).tools) == {"web_search_tool"}
        assert deps_for(make_llm(), tools=[]).tools == {}


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
        """Plan-generation prompt localizes title/sections and asks for JSON alone."""
        assert "same language as the user's request" in PLAN_GENERATION_PROMPT.lower()
        # No approval envelope any more (ADR-0065): the JSON becomes a plan row.
        assert "OUTPUT CONTRACT" in PLAN_GENERATION_PROMPT
        assert "PLAN_REPLIES" not in PLAN_GENERATION_PROMPT

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


class TestTheQuestionLoop:
    """Asking, skipping, and stopping."""

    @pytest.mark.asyncio
    async def test_immediate_completion(self):
        """A model that says it has enough asks nothing."""
        ask = AsyncMock()

        result = await clarify(request_for(), deps_for(make_llm(clarification()), ask=ask))

        assert result.plan is None
        assert result.research_context == ""
        ask.assert_not_called()

    @pytest.mark.asyncio
    async def test_a_skip_command_ends_the_questioning(self):
        ask = AsyncMock(return_value="skip")

        result = await clarify(request_for(), deps_for(make_llm(clarification("What scope?")), ask=ask))

        assert "[Skipped clarification]" in result.research_context
        ask.assert_called_once()

    @pytest.mark.asyncio
    async def test_zero_turns_never_asks_and_never_calls_the_model(self):
        ask = AsyncMock()
        llm = make_llm(clarification("What scope?"))

        await clarify(request_for(), deps_for(llm, ask=ask, max_turns=0))

        ask.assert_not_called()
        llm.ainvoke.assert_not_called()

    @pytest.mark.asyncio
    async def test_the_dialog_stops_at_max_turns(self):
        """The configured limit governs, and every turn is in the transcript."""
        llm = make_llm()
        llm.ainvoke = AsyncMock(return_value=AIMessage(content=clarification("Which angle?")))
        ask = AsyncMock(return_value="the technical one")

        result = await clarify(request_for(), deps_for(llm, ask=ask, max_turns=2))

        assert ask.await_count == 2
        assert "**Turn 2 - User:**" in result.research_context

    @pytest.mark.asyncio
    async def test_the_answer_is_recorded_in_the_log(self):
        deps = deps_for(
            make_llm(clarification("Which angle?"), clarification()),
            ask=AsyncMock(return_value="the technical one"),
        )

        result = await clarify(request_for(), deps)

        assert "**Turn 1 - Assistant:**" in result.research_context
        assert "the technical one" in result.research_context

    @pytest.mark.asyncio
    async def test_the_running_transcript_reaches_the_next_prompt(self):
        """Each round re-renders the prompt with what has been asked so far."""
        llm = make_llm(clarification("Which angle?"), clarification())

        await clarify(request_for(), deps_for(llm, ask=AsyncMock(return_value="the technical one")))

        second_system_prompt = llm.ainvoke.await_args_list[1].args[0][0].content
        assert "the technical one" in second_system_prompt

    @pytest.mark.asyncio
    async def test_an_unparseable_reply_asks_the_fallback_question(self):
        """A model that writes prose still gets the user asked, not researched."""
        seen: list[str] = []

        async def ask(question: str, options) -> str:
            seen.append(question)
            return "skip"

        await clarify(request_for("Research AI"), deps_for(make_llm("I think we should research AI broadly."), ask=ask))

        assert len(seen) == 1
        assert "Research AI" in seen[0]

    @pytest.mark.asyncio
    async def test_the_start_is_logged(self, caplog):
        with caplog.at_level("INFO"):
            await clarify(request_for("Test query"), deps_for(make_llm(clarification()), ask=AsyncMock()))

        assert "Clarifier: Starting" in caplog.text

    @pytest.mark.asyncio
    async def test_the_llm_reply_is_parsed_once_per_call(self, caplog):
        """The parse used to run five times per turn, warning five times over."""
        deps = deps_for(make_llm("still not json"), ask=AsyncMock(return_value="skip"))

        with caplog.at_level("WARNING"):
            await clarify(request_for(), deps)

        assert len([line for line in caplog.text.splitlines() if "No JSON in the" in line]) == 1


class TestTheTraceRow:
    """The one thing the reader sees of this step."""

    @pytest.mark.asyncio
    async def test_the_step_announces_itself_under_the_name_the_ui_maps(self):
        """`clarifier_agent` is a UI dictionary key (intermediate-step-parser.ts)
        and it is stamped on turns persisted before the NAT function went away,
        so the live trace has to keep emitting exactly it."""
        with patch("aiq_agent.agents.piloti.clarify.push_custom_step") as push:
            await clarify(request_for(), deps_for(make_llm(clarification()), ask=AsyncMock()))

        assert push.call_args.args[0] == TRACE_STEP_NAME == "clarifier_agent"

    @pytest.mark.asyncio
    async def test_it_is_emitted_before_the_first_question_blocks(self):
        """A row that arrives after the dialog would appear once the reader has
        already been waiting on a question with no explanation."""
        order: list[str] = []

        async def ask(question: str, options) -> str:
            order.append("asked")
            return "skip"

        with patch(
            "aiq_agent.agents.piloti.clarify.push_custom_step",
            side_effect=lambda *a: order.append("traced"),
        ):
            await clarify(request_for(), deps_for(make_llm(clarification("Which angle?")), ask=ask))

        assert order == ["traced", "asked"]


class TestThePlanIsDraftedNotAsked:
    """ADR-0065: the plan is drafted and handed back; nobody is asked about it."""

    @staticmethod
    def deps(planner, ask=None, **settings) -> ClarifyDeps:
        return deps_for(
            make_llm(clarification()), ask=ask or AsyncMock(), planner=planner, plan_approval="auto", **settings
        )

    @pytest.mark.asyncio
    async def test_the_plan_comes_back_without_a_question(self):
        planner = make_llm('{"title": "Test Research Plan", "sections": ["Intro", "Analysis", "Conclusion"]}')
        ask = AsyncMock()

        result = await clarify(request_for(), self.deps(planner, ask))

        ask.assert_not_called()
        assert result.plan is not None and result.plan.title == "Test Research Plan"
        assert result.draft is not None
        assert result.draft.sections == ["Intro", "Analysis", "Conclusion"]
        assert result.draft.question == "Research AI"
        assert result.start is not None and result.start.policy == "auto" and result.start.graceSeconds == 45

    @pytest.mark.asyncio
    async def test_ask_holds_the_plan_for_a_person(self):
        planner = make_llm('{"title": "T", "sections": ["A"]}')
        deps = deps_for(make_llm(clarification()), planner=planner, plan_approval="ask")

        result = await clarify(request_for(), deps)

        assert result.start is not None and result.start.policy == "ask"

    @pytest.mark.asyncio
    async def test_plan_generation_anchors_on_current_request(self):
        """The planner is anchored on the CURRENT request, not an earlier-turn
        topic still sitting in history — guards against stale-plan carry-over."""
        planner = make_llm('{"title": "T", "sections": ["A", "B"]}')
        request = ClarifyRequest(
            messages=[
                HumanMessage(content="Research the 17-basement high-rise fire code"),
                AIMessage(content="(earlier deep-research discussion)"),
                HumanMessage(content="actually, summarize the daylight rules for small dwellings"),
            ]
        )

        await clarify(request, self.deps(planner))

        anchor = planner.ainvoke.await_args.args[0][-1].content
        assert "CURRENT request" in anchor
        assert "summarize the daylight rules for small dwellings" in anchor

    @pytest.mark.asyncio
    async def test_an_unusable_plan_falls_back_to_the_generic_outline(self):
        result = await clarify(request_for(), self.deps(make_llm("not valid json")))

        assert result.plan is not None and result.plan.title == "Research Report"
        assert "Introduction" in result.plan.sections

    @pytest.mark.asyncio
    async def test_planning_off_ends_without_a_plan(self):
        ask = AsyncMock()

        result = await clarify(request_for(), deps_for(make_llm(clarification()), ask=ask))

        assert result.plan is None and result.draft is None
        ask.assert_not_called()

    @pytest.mark.asyncio
    async def test_the_planner_llm_is_used_when_configured(self):
        clarifier_llm = make_llm(clarification())
        planner = make_llm('{"title": "T", "sections": ["A"]}')

        await clarify(request_for(), deps_for(clarifier_llm, planner=planner, plan_approval="auto"))

        assert planner.ainvoke.await_count == 1
        assert clarifier_llm.ainvoke.await_count == 1

    @pytest.mark.asyncio
    async def test_without_a_planner_the_clarifier_model_plans(self):
        llm = make_llm(clarification(), '{"title": "T", "sections": ["A"]}')

        result = await clarify(request_for(), deps_for(llm, plan_approval="auto"))

        assert result.plan is not None
        assert llm.ainvoke.await_count == 2


class TestOptions:
    """Threading structured answer options to the user channel."""

    @pytest.mark.asyncio
    async def test_options_are_passed_to_the_callback(self):
        """The picker is starved unless the labels reach the callback as data."""
        question = "**Focus**: which area?\n\n1. Alpha: about alpha\n2. Beta: about beta"
        seen: list[tuple[str, list[str]]] = []

        async def ask(text: str, options) -> str:
            seen.append((text, list(options)))
            return "skip"

        await clarify(request_for(), deps_for(make_llm(clarification(question, ["Alpha", "Beta"])), ask=ask))

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

        async def ask(text: str, options) -> str:
            seen.append(list(options))
            return "skip"

        await clarify(request_for(), deps_for(make_llm(clarification("Which period?")), ask=ask))

        assert seen == [[]]

    @pytest.mark.asyncio
    async def test_free_text_answer_is_still_accepted(self):
        """The user may type instead of picking; that reply drives the next turn."""
        deps = deps_for(
            make_llm(clarification("**Focus**: which area?", ["Alpha", "Beta"]), clarification()),
            ask=AsyncMock(return_value="Something I typed myself"),
        )

        result = await clarify(request_for(), deps)

        assert "Something I typed myself" in result.research_context

    @pytest.mark.asyncio
    async def test_options_are_never_parsed_out_of_the_question(self):
        """Regex-parsing the prose back into options is the bug being fixed."""
        question = "**Focus**: which area?\n\n1. Alpha: about alpha\n2. Beta: about beta"
        seen: list[list[str]] = []

        async def ask(text: str, options) -> str:
            seen.append(list(options))
            return "skip"

        await clarify(request_for(), deps_for(make_llm(clarification(question)), ask=ask))

        assert seen == [[]]


class TestTools:
    """The tool loop: the model searches, then decides."""

    @staticmethod
    def tool_call_message() -> AIMessage:
        return AIMessage(
            content="",
            tool_calls=[{"name": "web_search_tool", "args": {"query": "OIB"}, "id": "call-1"}],
        )

    def _searching_llm(self, rounds: int) -> MagicMock:
        llm = make_llm()
        llm.ainvoke = AsyncMock(side_effect=[self.tool_call_message() for _ in range(rounds)])
        return llm

    @pytest.mark.asyncio
    async def test_a_tool_call_runs_the_tool_and_comes_back(self):
        """The branch that had no test at all: model -> tools -> model."""
        llm = make_llm()
        llm.ainvoke = AsyncMock(side_effect=[self.tool_call_message(), AIMessage(content=clarification())])

        result = await clarify(request_for(), deps_for(llm, tools=[web_search_tool], ask=AsyncMock()))

        assert result.plan is None
        assert llm.ainvoke.await_count == 2
        second_request = llm.ainvoke.await_args_list[1].args[0]
        assert any(isinstance(message, ToolMessage) for message in second_request)

    @pytest.mark.asyncio
    async def test_the_json_reminder_follows_the_tool_results(self):
        """After tool output the model reaches for a report; the reminder stops it."""
        llm = make_llm()
        llm.ainvoke = AsyncMock(side_effect=[self.tool_call_message(), AIMessage(content=clarification())])

        await clarify(request_for(), deps_for(llm, tools=[web_search_tool], ask=AsyncMock()))

        assert "valid JSON object" in llm.ainvoke.await_args_list[1].args[0][-1].content

    @pytest.mark.asyncio
    async def test_a_failing_tool_is_reported_to_the_model_not_raised(self, caplog):
        """A dead search tool must not end a turn that can still be clarified —
        but the exception is still logged in full."""

        @tool
        def broken_tool(query: str) -> str:
            """Always fails."""
            raise RuntimeError("upstream is down")

        llm = make_llm()
        llm.ainvoke = AsyncMock(
            side_effect=[
                AIMessage(content="", tool_calls=[{"name": "broken_tool", "args": {"query": "x"}, "id": "c1"}]),
                AIMessage(content=clarification()),
            ]
        )

        with caplog.at_level("WARNING"):
            result = await clarify(request_for(), deps_for(llm, tools=[broken_tool], ask=AsyncMock()))

        assert result.plan is None
        tool_reply = llm.ainvoke.await_args_list[1].args[0][-2]
        assert isinstance(tool_reply, ToolMessage)
        assert "upstream is down" in tool_reply.content
        assert "broken_tool failed" in caplog.text

    @pytest.mark.asyncio
    async def test_a_tool_the_deployment_does_not_have_is_named_back(self):
        """The model hallucinated a tool name; it is told so and moves on."""
        llm = make_llm()
        llm.ainvoke = AsyncMock(
            side_effect=[
                AIMessage(content="", tool_calls=[{"name": "no_such_tool", "args": {}, "id": "c1"}]),
                AIMessage(content=clarification()),
            ]
        )

        await clarify(request_for(), deps_for(llm, tools=[web_search_tool], ask=AsyncMock()))

        tool_reply = llm.ainvoke.await_args_list[1].args[0][-2]
        assert "no tool named 'no_such_tool'" in tool_reply.content

    @pytest.mark.asyncio
    async def test_two_tool_calls_run_concurrently(self):
        """Independent searches, one gather — the repo rule for two awaits that
        do not depend on each other."""
        running = 0
        overlapped = False

        @tool
        async def slow_tool(query: str) -> str:
            """Sleeps."""
            nonlocal running, overlapped
            running += 1
            overlapped = overlapped or running > 1
            await asyncio.sleep(0.01)
            running -= 1
            return "done"

        llm = make_llm()
        llm.ainvoke = AsyncMock(
            side_effect=[
                AIMessage(
                    content="",
                    tool_calls=[
                        {"name": "slow_tool", "args": {"query": "a"}, "id": "c1"},
                        {"name": "slow_tool", "args": {"query": "b"}, "id": "c2"},
                    ],
                ),
                AIMessage(content=clarification()),
            ]
        )

        await clarify(request_for(), deps_for(llm, tools=[slow_tool], ask=AsyncMock()))

        assert overlapped

    @pytest.mark.asyncio
    async def test_a_model_that_only_ever_searches_is_cut_off(self, caplog):
        """The loop states its own bound; the graph borrowed LangGraph's
        recursion limit, which was nobody's decision about this dialog."""
        llm = self._searching_llm(MAX_TOOL_ROUNDS + 1)
        ask = AsyncMock()

        with caplog.at_level("WARNING"):
            result = await clarify(request_for(), deps_for(llm, tools=[web_search_tool], ask=ask))

        assert llm.ainvoke.await_count == MAX_TOOL_ROUNDS + 1
        assert result.plan is None
        ask.assert_not_called()
        assert "kept searching" in caplog.text


class TestThePlanDraft:
    """The drafted plan, as the BFF's plan primitive takes it."""

    def test_the_draft_names_documents_and_carries_the_inventory_and_the_rahmen(self):
        from aiq_agent.agents.piloti.clarify import plan_draft

        plan = PlanResponse(title="T", sections=["A"], grundlage=["Einreichplan.pdf"], genre="vergleich")
        request = ClarifyRequest(
            messages=[HumanMessage(content="Vergleiche die Varianten")],
            data_sources=["knowledge_base"],
            available_documents=[
                {
                    "file_name": "Einreichplan.pdf",
                    "display_title": "Einreichplan EG",
                    "shelf": "project",
                    "summary": "x",
                },
                {"summary": "a row without a name is not a document"},
            ],
        )
        draft = plan_draft(request, plan, query="Vergleiche die Varianten")
        assert draft.question == "Vergleiche die Varianten"
        assert draft.grundlage == ["Einreichplan.pdf"] and draft.genre == "vergleich"
        assert draft.dataSources == ["knowledge_base"]
        assert [(d.name, d.title, d.shelf) for d in draft.unterlagen] == [
            ("Einreichplan.pdf", "Einreichplan EG", "project")
        ]

    def test_an_excluded_name_beats_the_same_name_in_the_grundlage(self):
        from aiq_agent.agents.piloti.clarify import plan_documents

        plan = PlanResponse(title="T", sections=["A"], grundlage=["a.pdf"], ausgeschlossen=["a.pdf"])
        docs = plan_documents(plan, [{"file_name": "a.pdf"}])
        assert docs is not None and docs.grundlage == [] and [d.name for d in docs.ausgeschlossen] == ["a.pdf"]

    def test_the_approved_context_names_the_unterlagen(self):
        from aiq_agent.agents.piloti.clarify import approved_plan_context
        from aiq_agent.common.plan_documents import PlanDocument
        from aiq_agent.common.plan_documents import PlanDocuments

        docs = PlanDocuments(
            grundlage=[PlanDocument(name="Einreichplan.pdf", title="Einreichplan EG", shelf="project")],
            ausgeschlossen=[PlanDocument(name="alt.pdf")],
        )
        text = approved_plan_context(PlanResponse(title="T", sections=["A"]), docs)
        assert "Grundlage (documents to read in full" in text
        assert "- Einreichplan EG — Einreichplan.pdf [project]" in text
        assert "Ausgeschlossen (documents that may not be used" in text and "- alt.pdf" in text

    def test_the_approved_context_binds_genre_depth_and_the_points(self):
        from aiq_agent.agents.piloti.clarify import approved_plan_context

        text = approved_plan_context(PlanResponse(title="T", sections=["A", "B"], genre="vergleich", depth="gutachten"))
        assert "Genre: vergleich" in text and "Depth: gutachten" in text
        assert "Sections (required components, in this order):\n- A\n- B" in text

    def test_a_plan_without_the_new_keys_still_parses_with_the_defaults(self):
        plan = parse_json_response('{"title": "T", "sections": ["A"]}', PlanResponse)
        assert plan is not None and plan.genre == "bericht" and plan.depth == "gutachten"
