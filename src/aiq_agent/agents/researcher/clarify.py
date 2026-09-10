"""The clarification step: ask, then confirm a plan, before deep research runs.

One step of the conversation graph, not an agent. It has exactly one caller
(``conversation.ConversationGraph._clarifier_node``), it is handed a state that
caller builds, and it returns a result only that caller can act on — so its
former NAT registration (``_type: clarifier_agent``) bought a YAML block and
nothing else. The block moved onto ``chat_deepresearcher_agent`` as
:class:`ClarifierSettings`; ``AgentGroup.CLARIFIER`` did NOT move, because an
org can re-point this step's model (Platform → Models) and that value is
persisted in ``platform_models.agent_group``.

Shape of the step, in one paragraph: ask at most ``max_turns`` focused
questions (the model may search first, and may offer pickable options), then —
when plan approval is on — show a research plan and take the user's verdict,
revising it while the reply is feedback. The dialog is a loop rather than a
LangGraph because that is all it ever was: no checkpoint, no persistence, no
node name that reaches a reader. What the reader DOES see is one trace row, and
:data:`TRACE_STEP_NAME` still emits it under the name the frontend already maps.

Nothing is rebuilt to serve a request. The models, tools and limits are
resolved once at boot into a :class:`ClarifyDeps`; a request that varies
something — a per-org model override, a BYOK credential, ZDR routing, a
narrowed data-source set — gets its own, and every other request reuses the
boot one.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable
from collections.abc import Callable
from collections.abc import Mapping
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from typing import Self
from typing import TypeVar

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import BaseMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage
from langchain_core.messages import ToolCall
from langchain_core.messages import ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool
from pydantic import BaseModel
from pydantic import Field
from pydantic import ValidationError

from aiq_agent.common import AgentGroup
from aiq_agent.common import LLMProvider
from aiq_agent.common import LLMRole
from aiq_agent.common import VerboseTraceCallback
from aiq_agent.common import all_mapped_tools_filtered_out
from aiq_agent.common import apply_model_override
from aiq_agent.common import apply_org_credential
from aiq_agent.common import build_human_prompt
from aiq_agent.common import content_to_text
from aiq_agent.common import extract_json
from aiq_agent.common import extract_user_response
from aiq_agent.common import filter_tools_by_sources
from aiq_agent.common import get_all_tool_refs
from aiq_agent.common import get_langchain_llm
from aiq_agent.common import get_latest_user_query
from aiq_agent.common import get_model_overrides_from_context
from aiq_agent.common import get_org_llm_credential_from_context
from aiq_agent.common import get_zdr_only_from_context
from aiq_agent.common import is_verbose
from aiq_agent.common import load_prompt
from aiq_agent.common import render_prompt_template
from aiq_agent.common import strict_json_response_format
from aiq_agent.common.turn_status import push_custom_step
from nat.builder.builder import Builder
from nat.builder.context import Context
from nat.builder.framework_enum import LLMFrameworkEnum
from nat.data_models.component_ref import FunctionGroupRef
from nat.data_models.component_ref import FunctionRef
from nat.data_models.component_ref import LLMRef

from .models.clarify import ClarificationResponse
from .models.clarify import ClarifyRequest
from .models.clarify import ClarifyResult
from .models.clarify import PlanDecision
from .models.clarify import PlanOutcome
from .models.clarify import PlanResponse

logger = logging.getLogger(__name__)

PROMPTS_DIR = Path(__file__).parent / "prompts"
"""Where this agent's Jinja templates live."""

CLARIFICATION_PROMPT = load_prompt(PROMPTS_DIR, "research_clarification")
PLAN_GENERATION_PROMPT = load_prompt(PROMPTS_DIR, "plan_generation")
"""Read once, at import. A deployment that ships without a prompt file fails
here, loudly, instead of running degraded on an inline stub nobody reviews."""

TRACE_STEP_NAME = "clarifier_agent"
"""The name this step announces itself under in the turn's step stream.

It is the name the old NAT function emitted, and the frontend maps it to
"Klärung" (``intermediate-step-parser.ts``). Kept verbatim on purpose: turns
persisted before this change carry it in their stored steps, so the frontend
has to keep the entry regardless — and a second name for the same moment would
mean two dictionary entries and a trace that reads differently either side of a
deploy.
"""

SKIP_COMMANDS = frozenset({"skip", "done", "exit", "quit", "proceed", "continue", "no", "n", ""})
"""Replies to a clarification QUESTION that mean "stop asking and get on with it"."""

PLAN_REPLIES: dict[str, PlanDecision] = {
    # The three tokens the plan envelope names, and the only three the UI's
    # buttons send (frontends/ui .../AgentPrompt.tsx).
    "approve": "approved",
    "shallow": "shallow",
    "cancel": "cancelled",
    # A bare refusal, typed rather than picked. Kept, and kept to single words,
    # because dropping it re-opens the transcript where the user said "no", was
    # handed a second plan, said "reject", and only then got out. Anything
    # longer is plan FEEDBACK on purpose: "no, only Wien" is a revision.
    "no": "shallow",
    "nein": "shallow",
    "nope": "shallow",
    "reject": "shallow",
    "stop": "cancelled",
    "abbrechen": "cancelled",
}
"""Literal reply -> decision. Everything else is feedback for a plan revision."""

FALLBACK_PLAN_TITLE = "Research Report"
FALLBACK_PLAN_SECTIONS = ("Introduction", "Background", "Analysis", "Findings", "Conclusion")
"""The outline shown when the planner returns nothing usable."""

MAX_TOOL_ROUNDS = 4
"""How many times one clarification decision may search before it must decide.

The prompt asks for "at most 1-2 searches" and no transcript has ever needed a
third, so this is a ceiling and not a budget. It exists because the loop that
replaced the LangGraph has to state its own bound: the graph's was LangGraph's
``recursion_limit`` (25 super-steps for the whole dialog), which is not a
number anybody chose for this.
"""

JSON_REMINDER_AFTER_TOOLS = (
    "Based on the search results above, now make your clarification decision. "
    "IMPORTANT: You must respond with ONLY a valid JSON object, nothing else. "
    "Do NOT write a report, summary, or analysis. "
    "Output exactly: "
    '{"needs_clarification": true, "clarification_question": "your question", "options": []} '
    "OR "
    '{"needs_clarification": false, "clarification_question": null, "options": []}'
)
"""Reminder after tool results. Only the tool-bound binding needs it: the
tool-free one gets the schema natively (see :func:`_clarifier_llm`)."""

AskUser = Callable[[str, Sequence[str]], Awaitable[str]]
"""Asks the user a question, offering ``options`` as pickable labels, and
returns their reply. Empty options means a free-text question."""

ClarifyFn = Callable[[ClarifyRequest], Awaitable[ClarifyResult]]
"""What the conversation graph holds: one call, one finished dialog."""

ModelT = TypeVar("ModelT", bound=BaseModel)


class ClarifierSettings(BaseModel):
    """The clarification step's configuration, nested under the workflow config.

    These fields were the ``clarifier_agent`` NAT function's own config block;
    they read identically in YAML, one level deeper. ``enable_clarifier`` on the
    workflow decides whether the step exists at all and stays where it is.
    """

    llm: LLMRef = Field(..., description="LLM to use for generating questions")
    planner_llm: LLMRef | None = Field(
        default=None,
        description="LLM to use for plan generation. If not specified, uses the main llm.",
    )
    tools: list[FunctionRef | FunctionGroupRef] = Field(
        default_factory=list,
        description="Explicit tool list. Empty = inherit all from data_source_registry.",
    )
    exclude_tools: list[str] = Field(
        default_factory=list,
        description="Tool names to exclude when inheriting from registry.",
    )
    max_turns: int = Field(default=3, description="Maximum number of clarification Q&A turns")
    enable_plan_approval: bool = Field(
        default=False,
        description="Whether to enable plan preview and approval after clarification",
    )
    max_plan_iterations: int = Field(
        default=10,
        description="Maximum number of plan feedback iterations before auto-approving",
    )
    log_response_max_chars: int = Field(default=2000, description="Max characters to log from LLM responses")
    verbose: bool = Field(default=False, description="Whether to enable verbose logging")


@dataclass(frozen=True)
class ClarifyDeps:
    """One run's resolved models, tools and limits — what the step reads."""

    llm: Any
    planner_llm: Any
    tools: Mapping[str, BaseTool]
    ask_user: AskUser
    max_turns: int
    enable_plan_approval: bool
    max_plan_iterations: int
    callbacks: tuple[Any, ...] = ()

    @property
    def run_config(self) -> RunnableConfig:
        """The LangChain config every call in this run carries (tracing only)."""
        return {"callbacks": list(self.callbacks)}


# -- pure helpers --------------------------------------------------------------


def parse_json_response(content: Any, schema: type[ModelT]) -> ModelT | None:
    """Parse one structured response out of an LLM reply.

    The model is asked for this schema natively (strict ``json_schema``) or, on
    the tool-bound path, in prose; either way the reply is JSON with at most a
    code fence around it, which :func:`extract_json` already handles for the
    whole repo.

    Returns:
        The parsed model, or None when the reply carried no JSON or the JSON
        did not fit the schema — both logged with what was wrong.
    """
    payload = extract_json(content_to_text(content))
    if payload is None:
        logger.warning("No JSON in the %s reply: %.200s", schema.__name__, content_to_text(content))
        return None
    try:
        return schema.model_validate(payload)
    except ValidationError as exc:
        logger.warning("Reply did not validate as %s: %s", schema.__name__, exc)
        return None


def unwrap_query(reply: str) -> str:
    """The reply text, unwrapped from the ``{"query": ...}`` envelope some
    transports put around it.

    A non-string ``query`` (number, null, object) is ignored rather than
    coerced: it used to abort the whole turn on the caller's ``.strip()``.
    """
    try:
        data = json.loads(reply)
    except (json.JSONDecodeError, TypeError):
        return reply
    if isinstance(data, dict) and isinstance(data.get("query"), str):
        return data["query"]
    return reply


def parse_plan_reply(reply: str) -> tuple[PlanDecision, str]:
    """Read one reply to the plan preview.

    Returns:
        ``("approved", "")`` run deep research on this plan;
        ``("shallow", "")`` answer now without the plan;
        ``("cancelled", "")`` stop the turn, no answer wanted;
        ``("feedback", text)`` revise the plan with this text.
    """
    text = unwrap_query(reply).strip()
    decision = PLAN_REPLIES.get(text.lower())
    if decision is None:
        return "feedback", text
    return decision, ""


def format_plan_for_user(plan: PlanResponse) -> str:
    """Render the plan preview the user replies to."""
    sections_text = "\n".join(f"  {i + 1}. {s}" for i, s in enumerate(plan.sections))
    # The footer sentence is a byte-stable envelope: the UI detects it,
    # strips it, and renders localized action buttons in its place
    # (frontends/ui .../AgentPrompt.tsx). Changing a byte here requires
    # changing the regexes there in the same commit.
    return (
        f"**Research Plan Preview**\n\n"
        f"**Title:** {plan.title}\n\n"
        f"**Sections:**\n{sections_text}\n\n"
        f"---\n"
        f"Reply **approve** to proceed, **shallow** for a quick answer instead, "
        f"**cancel** to dismiss, or provide feedback to revise the plan."
    )


def fallback_clarification(query: str | None) -> ClarificationResponse:
    """The question to ask when the model's own clarification was unusable.

    Topic-aware when the user's query is known, generic otherwise.
    """
    if not query:
        return ClarificationResponse(
            needs_clarification=True,
            clarification_question=(
                "I'd like to help with your research. Could you provide more details about:\n\n"
                "1. What specific aspects interest you most?\n"
                "2. Who is this report for?\n"
                "3. How detailed should it be?"
            ),
            options=[],
        )
    topic_snippet = query[:80].strip() + ("..." if len(query) > 80 else "")
    return ClarificationResponse(
        needs_clarification=True,
        clarification_question=(
            f'To help with your research on: "{topic_snippet}"\n\n'
            "Could you specify:\n"
            "1. Which specific aspects are most important to you?\n"
            "2. What level of detail do you need?\n"
            "3. Or type 'skip' to proceed with a general approach."
        ),
        options=[],
    )


def question_for(response: ClarificationResponse | None, messages: Sequence[BaseMessage]) -> ClarificationResponse:
    """The clarification to put to the user: the model's own, or the fallback."""
    if response is not None and response.is_valid():
        return response
    logger.warning("Unusable clarification from the model, asking the fallback question instead")
    return fallback_clarification(get_latest_user_query(list(messages)))


def approved_plan_context(plan: PlanResponse) -> str:
    """The approved plan as deep research reads it (``orchestrator.j2``)."""
    sections_text = "\n".join(f"- {s}" for s in plan.sections)
    return f"**Approved Research Plan**\n\nTitle: {plan.title}\n\nSections:\n{sections_text}"


def _fallback_plan() -> PlanResponse:
    return PlanResponse(title=FALLBACK_PLAN_TITLE, sections=list(FALLBACK_PLAN_SECTIONS))


# -- the dialog ----------------------------------------------------------------


def _clarification_messages(
    request: ClarifyRequest, deps: ClarifyDeps, messages: Sequence[BaseMessage], log: str
) -> list[BaseMessage]:
    """The message list for one clarification call, prompt included."""
    system_prompt = render_prompt_template(
        CLARIFICATION_PROMPT,
        clarifier_result=log,
        project_context=request.project_context,
        available_documents=request.available_documents or [],
        max_turns=deps.max_turns,
    )
    outgoing: list[BaseMessage] = [SystemMessage(content=system_prompt), *messages]
    # After tool results the model reaches for a report; the reminder is what
    # keeps the tool-bound path answering in JSON.
    if messages and isinstance(messages[-1], ToolMessage):
        outgoing.append(HumanMessage(content=JSON_REMINDER_AFTER_TOOLS))
    return outgoing


async def _run_one_tool(deps: ClarifyDeps, call: ToolCall) -> ToolMessage:
    """One tool call, as the message the model reads next.

    A failure is reported back TO THE MODEL rather than raised: this is a
    context search the model chose to make before asking its question, and a
    dead search tool must not end a turn that can still be clarified. The
    exception is logged in full at the same time, so nothing is hidden.
    """
    call_id = call.get("id") or ""
    tool = deps.tools.get(call.get("name") or "")
    if tool is None:
        logger.warning("Clarifier: the model called an unknown tool %r", call.get("name"))
        return ToolMessage(content=f"Error: no tool named {call.get('name')!r}", tool_call_id=call_id)
    try:
        return await tool.ainvoke(call, config=deps.run_config)
    except Exception as exc:  # noqa: BLE001 - handed to the model as a tool result
        logger.exception("Clarifier: tool %s failed", tool.name)
        return ToolMessage(content=f"Error: {exc}", tool_call_id=call_id, status="error")


async def run_tool_calls(deps: ClarifyDeps, calls: Sequence[ToolCall]) -> list[ToolMessage]:
    """Every tool the model asked for, at once — they are independent searches."""
    return list(await asyncio.gather(*(_run_one_tool(deps, call) for call in calls)))


async def _decide(
    request: ClarifyRequest, deps: ClarifyDeps, messages: list[BaseMessage], log: str
) -> tuple[ClarificationResponse | None, list[BaseMessage]]:
    """One clarification decision: call the model, run any tools it asked for,
    call it again, until it answers with something other than a tool call.

    Returns the parsed reply (None when it was not parseable — the caller asks
    the fallback question) and the message history the calls produced.
    """
    for _ in range(MAX_TOOL_ROUNDS + 1):
        reply = await deps.llm.ainvoke(_clarification_messages(request, deps, messages, log), config=deps.run_config)
        messages = [*messages, reply]
        if not getattr(reply, "tool_calls", None):
            return parse_json_response(reply.content, ClarificationResponse), messages
        messages = [*messages, *await run_tool_calls(deps, reply.tool_calls)]
    logger.warning("Clarifier: the model kept searching past %d rounds; proceeding without a question", MAX_TOOL_ROUNDS)
    return ClarificationResponse.complete(), messages


async def gather_clarification(request: ClarifyRequest, deps: ClarifyDeps) -> str:
    """Ask up to ``max_turns`` questions and return the markdown transcript.

    Ends early on a model that says it has enough, and on a user who types one
    of :data:`SKIP_COMMANDS`.
    """
    messages = list(request.messages)
    log = ""
    for turn in range(1, deps.max_turns + 1):
        response, messages = await _decide(request, deps, messages, log)
        if response is not None and not response.needs_clarification:
            return log
        clarification = question_for(response, messages)
        question = clarification.clarification_question or ""
        log = f"{log}\n**Turn {turn} - Assistant:**\n{question}"
        reply = await deps.ask_user(question, clarification.options)
        if reply.strip().lower() in SKIP_COMMANDS:
            logger.info("Clarifier: User requested to skip clarification")
            return f"{log}\n**Turn {turn} - User:** [Skipped clarification]"
        messages = [*messages, HumanMessage(content=reply)]
        log = f"{log}\n**Turn {turn} - User:**\n{reply}"
    return log


async def generate_plan(
    request: ClarifyRequest, deps: ClarifyDeps, log: str, feedback_history: list[str]
) -> PlanResponse:
    """One planner call, anchored on the CURRENT request.

    The anchor exists because the planner otherwise drifts to an earlier turn's
    topic still present in the history (an aborted research the user has moved
    on from), producing plans unrelated to what was just asked.
    """
    system_prompt = render_prompt_template(
        PLAN_GENERATION_PROMPT,
        project_context=request.project_context,
        clarifier_context=log,
        feedback_history=feedback_history or None,
    )
    anchor = HumanMessage(
        content=(
            "Generate a research plan for the user's CURRENT request below. "
            "Earlier messages are background context only — do NOT plan around "
            "topics from earlier turns that the current request does not ask about.\n\n"
            f"Current request: {get_latest_user_query(list(request.messages))}"
        )
    )
    outgoing = [SystemMessage(content=system_prompt), *request.messages, anchor]
    response = await deps.planner_llm.ainvoke(outgoing, config=deps.run_config)
    plan = parse_json_response(response.content, PlanResponse)
    if plan is None or not plan.title or not plan.sections:
        logger.warning("Planner returned no usable plan; showing the generic outline")
        return _fallback_plan()
    return plan


def _outcome(log: str, plan: PlanResponse, outcome: PlanOutcome) -> ClarifyResult:
    """One finished plan preview, as the conversation graph reads it."""
    if outcome != "approved":
        return ClarifyResult(research_context=log, outcome=outcome)
    return ClarifyResult(research_context=f"{log}\n\n{approved_plan_context(plan)}", outcome="approved")


async def preview_plan(request: ClarifyRequest, deps: ClarifyDeps, log: str) -> ClarifyResult:
    """Show a plan, take the user's verdict, revise on feedback."""
    feedback_history: list[str] = []
    plan = _fallback_plan()

    for _ in range(deps.max_plan_iterations):
        plan = await generate_plan(request, deps, log, feedback_history)
        decision, feedback = parse_plan_reply(await deps.ask_user(format_plan_for_user(plan), ()))
        if decision != "feedback":
            logger.info("Clarifier: plan %s by user", decision)
            return _outcome(log, plan, decision)
        logger.info("Clarifier: User provided feedback, regenerating plan")
        feedback_history.append(feedback)

    logger.warning("Clarifier: Max plan iterations reached, auto-approving")
    return _outcome(log, plan, "approved")


async def clarify(request: ClarifyRequest, deps: ClarifyDeps) -> ClarifyResult:
    """Run the clarification dialog and, when enabled, the plan approval.

    Args:
        request: The conversation window and project context to clarify against.
        deps: This run's resolved models, tools, limits and user channel.

    Returns:
        How the dialog ended, plus the text deep research reads if it runs.
    """
    logger.info("Clarifier: Starting (max %d turns)", deps.max_turns)
    query = get_latest_user_query(list(request.messages))
    logger.info("User's query: %s...", str(query)[:100] if query else "")
    # The one row this step contributes to the reader's trace, emitted before
    # the first question blocks the turn rather than after the dialog ends.
    push_custom_step(TRACE_STEP_NAME, {"kind": "clarification", "max_turns": deps.max_turns})
    log = await gather_clarification(request, deps)
    if not deps.enable_plan_approval:
        return ClarifyResult(research_context=log)
    return await preview_plan(request, deps, log)


# -- wiring --------------------------------------------------------------------


async def ask_through_nat(question: str, options: Sequence[str] = ()) -> str:
    """
    Ask the user a question through NAT's user interaction manager.

    Args:
        question: The clarification question to display to the user.
        options: Short labels of the answers the question offers. When present
            the prompt becomes a multiple-choice one so the client can render a
            picker; the question text is unchanged either way, and the user may
            still type a free-text answer or "skip".

    Returns:
        The user's response text, extracted from the NAT response object — a
        typed answer and a picked option arrive as different response models,
        and `extract_user_response` normalizes both.
    """
    user_input_manager = Context.get().user_interaction_manager
    response = await user_input_manager.prompt_user_input(build_human_prompt(question, list(options)))
    return extract_user_response(response)


async def resolve_tools(settings: ClarifierSettings, builder: Builder) -> list[BaseTool]:
    """The tool set the step boots with: the configured refs, else the whole registry."""
    tools = await builder.get_tools(
        tool_names=settings.tools or get_all_tool_refs(),
        wrapper_type=LLMFrameworkEnum.LANGCHAIN,
    )
    if not settings.exclude_tools:
        return list(tools)
    excluded = set(settings.exclude_tools)
    return [t for t in tools if getattr(t, "name", "") not in excluded]


def _clarifier_llm(llm: BaseChatModel, tools: Sequence[BaseTool]) -> Any:
    """Bind the clarifier's model to its tools, or to its output schema.

    Never both. OpenRouter's failure mode for an unsupported ``response_format``
    is to accept it and silently degrade — dropping tool calls — which is why
    the researcher keeps json mode off its tool-bound calls by default
    (``envelope_call.py``). A clarifier with tools therefore asks for JSON in
    the prompt and parses it once; a clarifier without tools gets the schema
    enforced natively.
    """
    if tools:
        return llm.bind_tools(tools, parallel_tool_calls=True)
    return llm.bind(response_format=strict_json_response_format(ClarificationResponse))


def build_deps(
    provider: LLMProvider,
    tools: Sequence[BaseTool],
    planner_llm: BaseChatModel | None,
    settings: ClarifierSettings,
    ask_user: AskUser,
    callbacks: tuple[Any, ...] = (),
) -> ClarifyDeps:
    """Resolve one run's models and tools from the provider it should use."""
    llm = provider.get(LLMRole.CLARIFIER)
    # The planner is always tool-free, so it always gets the schema natively.
    planner = planner_llm or llm
    return ClarifyDeps(
        llm=_clarifier_llm(llm, tools),
        planner_llm=planner.bind(response_format=strict_json_response_format(PlanResponse)),
        tools={tool.name: tool for tool in tools},
        ask_user=ask_user,
        max_turns=settings.max_turns,
        enable_plan_approval=settings.enable_plan_approval,
        max_plan_iterations=settings.max_plan_iterations,
        callbacks=callbacks,
    )


def _request_planner(
    planner_llm: BaseChatModel | None, model_overrides: Any, org_credential: Any
) -> BaseChatModel | None:
    """This request's planner: the boot one under the org's override and credential.

    ``None`` stays ``None`` — no configured planner means :func:`build_deps`
    falls back to the (already overridden) clarifier LLM.
    """
    if planner_llm is None:
        return None
    overridden = apply_model_override(planner_llm, AgentGroup.CLARIFIER, model_overrides)
    return apply_org_credential(overridden, org_credential)


@dataclass(frozen=True)
class Clarifier:
    """The boot-time step, callable once per escalating turn.

    Holds what registration resolved — the provider tagged with
    ``AgentGroup.CLARIFIER``, the tools, the optional planner, the limits — and
    the deps those produce. :meth:`deps_for` returns exactly that object again
    unless this request varies something, so the common turn re-binds no tool
    schema and rebuilds no tool map.
    """

    provider: LLMProvider
    tools: tuple[BaseTool, ...]
    planner_llm: BaseChatModel | None
    settings: ClarifierSettings
    ask_user: AskUser
    callbacks: tuple[Any, ...]
    boot: ClarifyDeps

    @classmethod
    def build(
        cls,
        provider: LLMProvider,
        tools: Sequence[BaseTool],
        planner_llm: BaseChatModel | None,
        settings: ClarifierSettings,
        ask_user: AskUser = ask_through_nat,
        callbacks: tuple[Any, ...] = (),
    ) -> Self:
        return cls(
            provider=provider,
            tools=tuple(tools),
            planner_llm=planner_llm,
            settings=settings,
            ask_user=ask_user,
            callbacks=callbacks,
            boot=build_deps(provider, tools, planner_llm, settings, ask_user, callbacks),
        )

    def deps_for(self, request: ClarifyRequest) -> ClarifyDeps:
        """What this request varies from the boot deps, or the boot deps themselves.

        Two sources of variation, both per-org: the runtime model override
        (X-Grid-Model-Overrides), the provider credential (BYOK) and ZDR routing
        on the LLM side; the data sources this request selected on the tool
        side. The planner LLM belongs to the same ``clarifier`` agent group.
        """
        # No `data_sources is not None` guard: org-disabled sources (ADR-0022)
        # narrow the tool set even when the request selects "all tools".
        selected = filter_tools_by_sources(list(self.tools), request.data_sources)
        if all_mapped_tools_filtered_out(list(self.tools), selected, request.data_sources):
            logger.warning("Clarifier received data_sources with no matching tools")
        overrides = get_model_overrides_from_context()
        credential = get_org_llm_credential_from_context()
        active = (
            self.provider.with_model_overrides(overrides)
            .with_credential(credential)
            .with_zdr(get_zdr_only_from_context())
        )
        if active is self.provider and selected == list(self.tools):
            return self.boot
        planner = _request_planner(self.planner_llm, overrides, credential)
        return build_deps(active, selected, planner, self.settings, self.ask_user, self.callbacks)

    async def __call__(self, request: ClarifyRequest) -> ClarifyResult:
        return await clarify(request, self.deps_for(request))


async def build_clarifier(settings: ClarifierSettings, builder: Builder) -> ClarifyFn:
    """Resolve the clarification step from the workflow config, once, at boot.

    Args:
        settings: The workflow config's ``clarifier`` block.
        builder: NAT Builder for obtaining LLM and tool instances.

    Returns:
        The callable the conversation graph holds as its ``clarifier_fn``.
    """
    llm = await get_langchain_llm(builder, settings.llm)
    planner_llm = await get_langchain_llm(builder, settings.planner_llm) if settings.planner_llm else None
    tools = await resolve_tools(settings, builder)

    provider = LLMProvider()
    provider.set_default(llm, group=AgentGroup.CLARIFIER)

    verbose = is_verbose(settings.verbose)
    callbacks = (
        (VerboseTraceCallback(log_reasoning=True, max_chars=settings.log_response_max_chars),) if verbose else ()
    )
    return Clarifier.build(provider, tools, planner_llm, settings, callbacks=callbacks)
