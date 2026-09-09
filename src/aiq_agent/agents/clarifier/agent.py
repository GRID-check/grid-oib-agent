"""
Clarifier agent for interactive clarification dialog.

Multi-turn clarification before deep research begins: ask up to ``max_turns``
focused questions, then (when plan approval is on) show a research plan and let
the user approve it, ask for a quick answer instead, cancel, or send feedback
for a revision.

The LangGraph is compiled ONCE for the process (``CLARIFIER_GRAPH``) and the
nodes are module-level functions. Everything that varies per request — the
resolved LLMs, the tool set, the callback that asks the user, the limits —
rides on the run's :class:`ClarifierBinding` through the LangGraph config, the
same seam ``shallow_researcher`` uses. Nothing is rebuilt to serve a request.

Example:
    >>> from aiq_agent.agents.clarifier.agent import ClarifierAgent
    >>> from aiq_agent.common import LLMProvider
    >>>
    >>> async def prompt_user(question: str, options: list[str]) -> str:
    ...     return input(question)
    >>>
    >>> provider = LLMProvider()
    >>> provider.set_default(my_llm)
    >>> agent = ClarifierAgent(
    ...     llm_provider=provider,
    ...     user_prompt_callback=prompt_user,
    ... )
"""

from __future__ import annotations

import json
import logging
from collections.abc import Awaitable
from collections.abc import Callable
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path
from typing import Any
from typing import TypeVar

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage
from langchain_core.messages import ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import BaseTool
from langgraph.graph import StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.prebuilt import ToolNode
from pydantic import BaseModel
from pydantic import ValidationError

from aiq_agent.common import LLMProvider
from aiq_agent.common import LLMRole
from aiq_agent.common import content_to_text
from aiq_agent.common import extract_json
from aiq_agent.common import get_latest_user_query
from aiq_agent.common import load_prompt
from aiq_agent.common import render_prompt_template
from aiq_agent.common import strict_json_response_format

from .models import ClarificationResponse
from .models import ClarifierAgentState
from .models import ClarifierResult
from .models import PlanDecision
from .models import PlanResponse

logger = logging.getLogger(__name__)

PROMPTS_DIR = Path(__file__).parent / "prompts"
"""Where this agent's Jinja templates live."""

CLARIFICATION_PROMPT = load_prompt(PROMPTS_DIR, "research_clarification")
PLAN_GENERATION_PROMPT = load_prompt(PROMPTS_DIR, "plan_generation")
"""Read once, at import. A deployment that ships without a prompt file fails
here, loudly, instead of running degraded on an inline stub nobody reviews."""

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

TURN_BINDING_KEY = "clarifier_turn"
"""Where the run's binding rides on the LangGraph config (``configurable``),
so the compiled graph is shared across requests and never rebuilt."""

AskUser = Callable[[str, Sequence[str]], Awaitable[str]]
"""Asks the user a question, offering ``options`` as pickable labels, and
returns their reply. Empty options means a free-text question."""

ModelT = TypeVar("ModelT", bound=BaseModel)


@dataclass(frozen=True)
class TurnConfig:
    """What one request may vary from the boot-time agent. ``None`` keeps the boot value."""

    llm_provider: LLMProvider | None = None
    tools: Sequence[BaseTool] | None = None
    planner_llm: BaseChatModel | None = None


@dataclass(frozen=True)
class ClarifierBinding:
    """A request's resolved models, tools and limits; what the graph nodes read."""

    llm: Any
    planner_llm: Any
    tool_node: ToolNode
    ask_user: AskUser
    max_turns: int
    enable_plan_approval: bool
    max_plan_iterations: int
    callbacks: list[Any] = field(default_factory=list)


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


# -- graph nodes ---------------------------------------------------------------


def binding_of(config: RunnableConfig) -> ClarifierBinding:
    """The binding ``run()`` put on the config for this request."""
    binding = (config.get("configurable") or {}).get(TURN_BINDING_KEY)
    if binding is None:
        raise RuntimeError("Clarifier graph invoked outside run(): no binding on the config")
    return binding


async def clarifier_node(state: ClarifierAgentState, config: RunnableConfig) -> dict[str, Any]:
    """One LLM call: ask the next question, call a tool, or declare completion."""
    binding = binding_of(config)
    if state.iteration >= binding.max_turns:
        complete = ClarificationResponse.complete()
        return {"messages": [AIMessage(content=complete.model_dump_json())], "clarification": complete}

    system_prompt = render_prompt_template(
        CLARIFICATION_PROMPT,
        clarifier_result=state.clarifier_log,
        project_context=state.project_context,
        available_documents=state.available_documents or [],
        max_turns=binding.max_turns,
    )
    messages: list[Any] = [SystemMessage(content=system_prompt), *state.messages]
    # After tool results the model reaches for a report; the reminder is what
    # keeps the tool-bound path answering in JSON.
    if state.messages and isinstance(state.messages[-1], ToolMessage):
        messages.append(HumanMessage(content=JSON_REMINDER_AFTER_TOOLS))

    response = await binding.llm.ainvoke(messages)
    # Parsed HERE, once per LLM call: the router and the question node read the
    # result off the state instead of re-parsing the same text four more times.
    return {"messages": [response], "clarification": parse_json_response(response.content, ClarificationResponse)}


async def tools_node(state: ClarifierAgentState, config: RunnableConfig) -> Any:
    """Run the tool calls the model asked for."""
    return await binding_of(config).tool_node.ainvoke(state)


def question_for(state: ClarifierAgentState) -> ClarificationResponse:
    """The clarification to put to the user: the model's own, or the fallback."""
    clarification = state.clarification
    if clarification is not None and clarification.is_valid():
        return clarification
    logger.warning("Unusable clarification from the model, asking the fallback question instead")
    return fallback_clarification(get_latest_user_query(state.messages))


async def ask_node(state: ClarifierAgentState, config: RunnableConfig) -> dict[str, Any]:
    """Put the clarification question to the user and record their reply."""
    binding = binding_of(config)
    clarification = question_for(state)
    question = clarification.clarification_question or ""
    turn = state.iteration + 1
    log = f"{state.clarifier_log}\n**Turn {turn} - Assistant:**\n{question}"

    reply = await binding.ask_user(question, clarification.options)
    if reply.strip().lower() in SKIP_COMMANDS:
        logger.info("Clarifier: User requested to skip clarification")
        complete = ClarificationResponse.complete()
        return {
            "messages": [AIMessage(content=complete.model_dump_json())],
            "clarification": complete,
            "iteration": binding.max_turns,  # Force end of clarification
            "clarifier_log": f"{log}\n**Turn {turn} - User:** [Skipped clarification]",
        }
    return {
        "messages": [HumanMessage(content=reply)],
        "iteration": turn,
        "clarifier_log": f"{log}\n**Turn {turn} - User:**\n{reply}",
    }


async def generate_plan(
    binding: ClarifierBinding, state: ClarifierAgentState, feedback_history: list[str]
) -> PlanResponse:
    """One planner call, anchored on the CURRENT request.

    The anchor exists because the planner otherwise drifts to an earlier turn's
    topic still present in ``state.messages`` (an aborted research the user has
    moved on from), producing plans unrelated to what was just asked.
    """
    system_prompt = render_prompt_template(
        PLAN_GENERATION_PROMPT,
        project_context=state.project_context,
        clarifier_context=state.clarifier_log,
        feedback_history=feedback_history or None,
    )
    anchor = HumanMessage(
        content=(
            "Generate a research plan for the user's CURRENT request below. "
            "Earlier messages are background context only — do NOT plan around "
            "topics from earlier turns that the current request does not ask about.\n\n"
            f"Current request: {get_latest_user_query(state.messages)}"
        )
    )
    response = await binding.planner_llm.ainvoke([SystemMessage(content=system_prompt), *state.messages, anchor])
    plan = parse_json_response(response.content, PlanResponse)
    if plan is None or not plan.title or not plan.sections:
        logger.warning("Planner returned no usable plan; showing the generic outline")
        return PlanResponse(title=FALLBACK_PLAN_TITLE, sections=list(FALLBACK_PLAN_SECTIONS))
    return plan


async def plan_preview_node(state: ClarifierAgentState, config: RunnableConfig) -> dict[str, Any]:
    """Show a plan, take the user's verdict, revise on feedback."""
    binding = binding_of(config)
    feedback_history: list[str] = []
    plan = PlanResponse(title=FALLBACK_PLAN_TITLE, sections=list(FALLBACK_PLAN_SECTIONS))

    for _ in range(binding.max_plan_iterations):
        plan = await generate_plan(binding, state, feedback_history)
        decision, feedback = parse_plan_reply(await binding.ask_user(format_plan_for_user(plan), ()))
        if decision != "feedback":
            logger.info("Clarifier: plan %s by user", decision)
            return _plan_update(plan, decision)
        logger.info("Clarifier: User provided feedback, regenerating plan")
        feedback_history.append(feedback)

    logger.warning("Clarifier: Max plan iterations reached, auto-approving")
    return _plan_update(plan, "approved")


def _plan_update(plan: PlanResponse, decision: PlanDecision) -> dict[str, Any]:
    """The state update one finished plan preview writes."""
    return {"plan_title": plan.title, "plan_sections": plan.sections, "plan_outcome": decision}


def route_after_clarifier(state: ClarifierAgentState, config: RunnableConfig) -> str:
    """Tool calls first, then completion, else ask the user."""
    if not state.messages:
        raise ValueError("Clarifier graph reached its router with no messages in state")

    last = state.messages[-1]
    if getattr(last, "tool_calls", None):
        return "tools"
    # An unparseable reply leaves ``clarification`` None and is treated as "not
    # complete": the fallback question is better than silently researching.
    if state.clarification is not None and not state.clarification.needs_clarification:
        return "plan_preview" if binding_of(config).enable_plan_approval else "__end__"
    return "ask_for_clarification"


def build_clarifier_graph() -> CompiledStateGraph:
    """Compile the clarification loop once; requests vary through the config."""
    graph = StateGraph(ClarifierAgentState)
    graph.add_node("agent", clarifier_node)
    graph.add_node("tools", tools_node)
    graph.add_node("ask_for_clarification", ask_node)
    graph.add_node("plan_preview", plan_preview_node)
    graph.set_entry_point("agent")
    graph.add_conditional_edges(
        "agent",
        route_after_clarifier,
        {
            "tools": "tools",
            "ask_for_clarification": "ask_for_clarification",
            "plan_preview": "plan_preview",
            "__end__": "__end__",
        },
    )
    graph.add_edge("tools", "agent")
    graph.add_edge("ask_for_clarification", "agent")
    graph.add_edge("plan_preview", "__end__")
    return graph.compile()


CLARIFIER_GRAPH = build_clarifier_graph()
"""The one compiled clarification graph, shared by every agent and request."""


def _clarifier_llm(llm: BaseChatModel, tools: Sequence[BaseTool]) -> Any:
    """Bind the clarifier's model to its tools, or to its output schema.

    Never both. OpenRouter's failure mode for an unsupported ``response_format``
    is to accept it and silently degrade — dropping tool calls — which is why
    the shallow researcher keeps json mode off its tool-bound calls by default
    (``shallow_researcher/envelope_call.py``). A clarifier with tools therefore
    asks for JSON in the prompt and parses it once; a clarifier without tools
    gets the schema enforced natively.
    """
    if tools:
        return llm.bind_tools(tools, parallel_tool_calls=True)
    return llm.bind(response_format=strict_json_response_format(ClarificationResponse))


class ClarifierAgent:
    """
    Clarifier agent for interactive clarification dialog.

    Asks follow-up questions to refine the research scope, constraints and
    requirements before research begins, then optionally previews a research
    plan for approval. Boot-time configuration lives on the instance; the
    compiled graph is shared (``CLARIFIER_GRAPH``) and a request that needs
    different models or tools passes a :class:`TurnConfig` to :meth:`run`.

    Example:
        >>> async def user_prompt_fn(question: str, options: list[str]) -> str:
        ...     return input(question)
        >>>
        >>> provider = LLMProvider()
        >>> provider.set_default(my_llm)
        >>> agent = ClarifierAgent(
        ...     llm_provider=provider,
        ...     tools=[search_tool],
        ...     user_prompt_callback=user_prompt_fn,
        ...     max_turns=3,
        ... )
        >>> state = ClarifierAgentState(messages=[HumanMessage(content="Research AI")])
        >>> result = await agent.run(state)
    """

    def __init__(
        self,
        llm_provider: LLMProvider,
        tools: Sequence[BaseTool] | None = None,
        *,
        user_prompt_callback: AskUser,
        max_turns: int = 3,
        enable_plan_approval: bool = False,
        max_plan_iterations: int = 10,
        planner_llm: BaseChatModel | None = None,
        callbacks: list[Any] | None = None,
    ) -> None:
        """
        Initialize the clarifier agent.

        Args:
            llm_provider: Provider for obtaining LLM instances by role.
            tools: Optional sequence of LangChain tools for context gathering
                (e.g., web search). Tools help the agent ask more informed questions.
            user_prompt_callback: Async callback that asks the user a question,
                offering the short answer labels as pickable options, and
                returns their reply.
            max_turns: Maximum number of clarification Q&A turns before
                automatically completing clarification. Defaults to 3.
            enable_plan_approval: Whether to enable plan preview and approval
                after clarification completes. Defaults to False.
            max_plan_iterations: Maximum number of plan feedback iterations
                before auto-approving. Defaults to 10.
            planner_llm: Optional LLM to use for plan generation. If not provided,
                uses the default clarifier LLM.
            callbacks: Optional list of LangChain callback handlers for
                tracing and logging.
        """
        self.llm_provider = llm_provider
        self.tools = list(tools) if tools else []
        self.user_prompt_callback = user_prompt_callback
        self.max_turns = max_turns
        self.enable_plan_approval = enable_plan_approval
        self.max_plan_iterations = max_plan_iterations
        self.planner_llm = planner_llm
        self.callbacks = callbacks or []
        self._boot = self.binding_for(TurnConfig())

    def binding_for(self, turn: TurnConfig) -> ClarifierBinding:
        """Resolve one request's models and tools; ``None`` fields keep the boot value."""
        provider = turn.llm_provider or self.llm_provider
        tools = list(self.tools if turn.tools is None else turn.tools)
        llm = provider.get(LLMRole.CLARIFIER)
        # The planner is always tool-free, so it always gets the schema natively.
        planner = turn.planner_llm or self.planner_llm or llm
        return ClarifierBinding(
            llm=_clarifier_llm(llm, tools),
            planner_llm=planner.bind(response_format=strict_json_response_format(PlanResponse)),
            tool_node=ToolNode(tools),
            ask_user=self.user_prompt_callback,
            max_turns=self.max_turns,
            enable_plan_approval=self.enable_plan_approval,
            max_plan_iterations=self.max_plan_iterations,
            callbacks=self.callbacks,
        )

    async def run(self, state: ClarifierAgentState, *, turn: TurnConfig | None = None) -> ClarifierResult:
        """
        Execute the clarification dialog.

        Args:
            state: Initial state of the clarifier agent.
            turn: What this request varies from the boot-time agent (per-org
                model override, BYOK credential, narrowed tool set). Omit it
                and the boot binding serves the request unchanged.

        Returns:
            ClarifierResult with clarification log and plan approval details.
        """
        binding = self._boot if turn is None else self.binding_for(turn)
        logger.info("Clarifier: Starting (max %d turns)", binding.max_turns)
        query = get_latest_user_query(state.messages)
        logger.info("User's query: %s...", str(query)[:100] if query else "")
        config: RunnableConfig = {"configurable": {TURN_BINDING_KEY: binding}, "callbacks": binding.callbacks}
        result = await CLARIFIER_GRAPH.ainvoke(state, config=config)
        return ClarifierResult.from_state(ClarifierAgentState.model_validate(result))

    @property
    def graph(self) -> CompiledStateGraph:
        """The compiled LangGraph, for direct access. Shared, never per-agent."""
        return CLARIFIER_GRAPH
