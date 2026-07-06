# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
Chat Researcher Agent - Orchestrates intent classification, depth routing, and research.

This is the main orchestrator agent that coordinates the full research workflow:
1. Intent classification (meta vs research)
2. Depth routing (shallow vs deep)
3. Research execution
4. Optional escalation from shallow to deep
"""

import logging
from collections.abc import Awaitable
from collections.abc import Callable
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.messages import AIMessage
from langchain_core.messages import BaseMessage
from langchain_core.messages import HumanMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END
from langgraph.graph import StateGraph
from langgraph.graph.state import CompiledStateGraph
from langgraph.types import Command

from aiq_agent.agents.clarifier.models import ClarifierAgentState
from aiq_agent.agents.clarifier.models import ClarifierResult
from aiq_agent.agents.deep_researcher.models import DeepResearchAgentState
from aiq_agent.agents.shallow_researcher.models import ShallowResearchAgentState
from aiq_agent.common import get_latest_user_query
from aiq_agent.common.citation_verification import EmptySourceRegistryError

try:
    from aiq_api.auth.errors import AuthError as _AuthError
except ImportError:
    _AuthError = None  # type: ignore[assignment,misc]

from .models import ChatResearcherState
from .models import ShallowResult
from .utils import trim_message_history

logger = logging.getLogger(__name__)

ESCALATION_MARKER = "[ESCALATE_TO_DEEP]"


def detect_and_strip_escalation_marker(content: Any) -> tuple[Any, bool]:
    """Detect and remove the shallow-agent insufficiency marker from a message.

    If ``content`` is not a string it is returned unchanged with ``False``.
    Otherwise every literal occurrence of :data:`ESCALATION_MARKER` (matched
    leniently as a substring anywhere in the text) is removed, the resulting
    trailing whitespace is collapsed (including any dangling blank line the
    marker left behind), and ``(stripped, was_present)`` is returned.
    """
    if not isinstance(content, str):
        return content, False

    if ESCALATION_MARKER not in content:
        return content, False

    stripped = content.replace(ESCALATION_MARKER, "")
    # Collapse trailing whitespace and any blank line left where the marker sat.
    stripped = stripped.rstrip()
    return stripped, True


def matches_escalation_keywords(content: str) -> bool:
    """Return True if the tail of an answer signals insufficient information.

    Verbatim lift of the keyword tail-match logic historically embedded in
    ``should_escalate``: only the last 800 characters (lowercased) are examined.
    """
    tail = content[-800:].lower() if len(content) > 800 else content.lower()
    escalation_keywords = [
        "i don't have enough information",
        "unable to find",
        "need more research",
        "keine ausreichenden informationen",
        "nicht genügend informationen",
        "konnte keine informationen",
        "keine informationen gefunden",
        "nicht finden",
        "weitere recherche erforderlich",
        "genauere prüfung erforderlich",
    ]
    return any(kw in tail for kw in escalation_keywords)


class ChatResearcherAgent:
    """
    Orchestrates the full chat research workflow.

    Coordinates intent classification, depth routing, and research agents
    to produce research results based on user queries.

    The workflow:
    1. Classify intent (meta vs research)
    2. If meta → respond with meta chatter
    3. If research → route to shallow or deep based on complexity
    4. Optionally escalate from shallow to deep if results insufficient
    """

    def __init__(
        self,
        intent_classifier_fn: Callable[[str], Awaitable[str]],
        shallow_research_fn: Callable[[str], Awaitable[str]],
        deep_research_fn: Callable[[str], Awaitable[str]],
        clarifier_fn: Callable[
            [ClarifierAgentState | list[BaseMessage]],
            Awaitable[ClarifierResult],
        ]
        | None,
        *,
        enable_clarifier: bool = True,
        enable_escalation: bool = True,
        callbacks: list[BaseCallbackHandler] | None = None,
        max_history: int = 5,
        deep_research_job_submitter: Callable[[Any], Awaitable[str]] | None = None,
        checkpointer: BaseCheckpointSaver | None = None,
        validate_deep_research_tools_fn: Callable[[list[str] | None], tuple[bool, str]] | None = None,
    ) -> None:
        """
        Initialize the chat researcher agent.

        Args:
            intent_classifier_fn: Combined orchestration (intent + meta response + depth in one node)
            shallow_research_fn: Function for shallow research
            deep_research_fn: Function for deep research
            clarifier_fn: Function for clarification
            enable_clarifier: Whether to enable clarification
            enable_escalation: Whether to escalate shallow to deep on low confidence
            callbacks: Optional list of callback handlers
            max_history: Maximum number of messages to keep in history
            deep_research_job_submitter: Optional function to submit deep research as async job
            checkpointer: Optional checkpointer for persistent state (defaults to MemorySaver)

        Cards are emitted by the answering agent via the ``emit_card`` tool, not
        generated here — this class no longer needs a card LLM.
        """
        self.intent_classifier_fn = intent_classifier_fn
        self.shallow_research_fn = shallow_research_fn
        self.deep_research_fn = deep_research_fn
        self.clarifier_fn = clarifier_fn
        self.enable_clarifier = enable_clarifier
        self.enable_escalation = enable_escalation
        self.callbacks = callbacks or []
        self.max_history = max_history
        self.deep_research_job_submitter = deep_research_job_submitter
        self.checkpointer = checkpointer
        self.validate_deep_research_tools_fn = validate_deep_research_tools_fn

        self._graph = self._build_graph()

    def _build_graph(self) -> CompiledStateGraph:
        """Build the LangGraph workflow."""

        async def intent_classifier_node(state: ChatResearcherState) -> dict[str, Any]:
            return await self.intent_classifier_fn(state)

        async def clarifier_node(state: ChatResearcherState) -> dict[str, Any]:
            original_query = get_latest_user_query(state.messages)

            # Validate deep research tools before proceeding to clarifier
            if self.validate_deep_research_tools_fn:
                is_valid, error_msg = self.validate_deep_research_tools_fn(state.data_sources)
                if not is_valid:
                    logger.error("Deep research tools validation failed: %s", error_msg)
                    return Command(
                        goto=END,
                        update={
                            "messages": [AIMessage(content=error_msg)],
                            "original_query": original_query,
                        },
                    )

            if self.enable_clarifier and not state.skip_clarifier:
                if self.clarifier_fn is None:
                    raise ValueError(
                        "enable_clarifier is True but clarifier_agent is not defined in config. "
                        "Either add clarifier_agent to functions or set enable_clarifier: false."
                    )
                trimmed_messages: list[BaseMessage] = trim_message_history(state.messages, self.max_history)
                available_docs = [doc.model_dump() for doc in (state.available_documents or [])]
                clarifier_state = ClarifierAgentState(
                    messages=trimmed_messages,
                    data_sources=state.data_sources,
                    available_documents=available_docs if available_docs else None,
                    project_context=state.project_context,
                )
                result = await self.clarifier_fn(clarifier_state)

                # Check if plan was rejected
                if result.plan_rejected:
                    logger.info("ChatResearcher: Plan rejected by user, ending workflow")
                    return Command(
                        goto=END,
                        update={
                            "messages": [
                                AIMessage(
                                    content="Research plan was rejected. Please start a new research query when ready."
                                )
                            ],
                            "original_query": original_query,
                        },
                    )

                # Build clarifier result with optional approved plan context
                clarifier_result = result.clarifier_log
                approved_plan_context = result.get_approved_plan_context()
                if approved_plan_context:
                    clarifier_result = f"{clarifier_result}\n\n{approved_plan_context}"

                return Command(
                    goto="deep_research",
                    update={
                        "clarifier_result": clarifier_result,
                        "original_query": original_query,
                    },
                )
            return Command(goto="deep_research", update={"original_query": original_query})

        async def shallow_research_node(state: ChatResearcherState) -> dict[str, Any]:
            trimmed_messages: list[BaseMessage] = trim_message_history(state.messages, self.max_history)

            logger.debug(
                "shallow_research_node: ChatResearcherState.available_documents = %s",
                state.available_documents,
            )

            # Meta/conversational turns are routed through the shallow agent for
            # persona + the `remember` tool, but they answer from context without
            # calling research tools — so they capture no sources and must NOT be
            # held to the research-only "sources required" guard. Everything else
            # (research) keeps the strict contract.
            requires_sources = not (state.user_intent is not None and state.user_intent.intent == "meta")

            try:
                shallow_state = ShallowResearchAgentState(
                    messages=trimmed_messages,
                    data_sources=state.data_sources,
                    available_documents=state.available_documents,
                    project_context=state.project_context,
                    requires_sources=requires_sources,
                )
                result = await self.shallow_research_fn(shallow_state)
            except EmptySourceRegistryError as exc:
                logger.warning("Shallow research produced no verifiable sources")
                if exc.unavailable_tools:
                    from aiq_agent.common.tool_validation import format_user_facing_tool_error

                    err_msg = format_user_facing_tool_error(
                        "shallow research",
                        exc.unavailable_tools,
                        exc.available_count,
                    )
                else:
                    err_msg = (
                        "The search tools did not return any results for this question. "
                        "This may be due to a temporary issue or the question may need to be rephrased. "
                        "Please try again."
                    )
                # confidence="high" reflects certainty that an error occurred and that the error
                # message is the correct response — not uncertainty about the answer quality.
                # escalate_to_deep=False because retrying deep research will not resolve a
                # source registry or transient failure; the user should rephrase and retry.
                return {
                    "messages": [AIMessage(content=err_msg)],
                    "shallow_result": ShallowResult(
                        answer=err_msg,
                        confidence="high",
                        escalate_to_deep=False,
                    ),
                }
            except Exception as e:
                if _AuthError and isinstance(e, _AuthError):
                    logger.warning("Auth error in shallow research: %s", e)
                    err_msg = str(e)
                    return {
                        "messages": [AIMessage(content=err_msg)],
                        "shallow_result": ShallowResult(
                            answer=err_msg,
                            confidence="high",
                            escalate_to_deep=False,
                        ),
                    }
                logger.exception("Error in shallow research: %s", e)
                err_msg = "An error occurred while researching your question. Please try again."
                # Same rationale as EmptySourceRegistryError: the system is certain an error
                # occurred; escalating to deep research will not resolve an unexpected exception.
                return {
                    "messages": [AIMessage(content=err_msg)],
                    "shallow_result": ShallowResult(
                        answer=err_msg,
                        confidence="high",
                        escalate_to_deep=False,
                    ),
                }

            if not result.messages:
                logger.error("Shallow research agent returned no messages")
                return {
                    "shallow_result": ShallowResult(
                        answer="An error occurred during shallow research.",
                        confidence="low",
                        escalate_to_deep=True,
                        escalation_reason="Shallow research encountered an error",
                    )
                }
            new_messages = result.messages[len(trimmed_messages) :]
            final_ai_message = next(
                (m for m in reversed(new_messages) if isinstance(m, AIMessage) and not m.tool_calls),
                None,
            )
            if final_ai_message:
                if isinstance(final_ai_message.content, str):
                    stripped, marker_present = detect_and_strip_escalation_marker(final_ai_message.content)
                    if marker_present:
                        return {
                            "messages": [final_ai_message.model_copy(update={"content": stripped})],
                            "shallow_result": ShallowResult(
                                answer=stripped,
                                confidence="low",
                                escalate_to_deep=True,
                                escalation_reason="Shallow agent emitted insufficiency marker",
                            ),
                        }
                return {"messages": [final_ai_message], "shallow_result": None}
            if new_messages:
                fallback_message = new_messages[-1]
                if isinstance(fallback_message.content, str):
                    stripped, marker_present = detect_and_strip_escalation_marker(fallback_message.content)
                    if marker_present:
                        return {
                            "messages": [fallback_message.model_copy(update={"content": stripped})],
                            "shallow_result": ShallowResult(
                                answer=stripped,
                                confidence="low",
                                escalate_to_deep=True,
                                escalation_reason="Shallow agent emitted insufficiency marker",
                            ),
                        }
                return {"messages": [fallback_message], "shallow_result": None}
            return {"messages": [], "shallow_result": None}

        async def deep_research_node(state: ChatResearcherState) -> dict[str, Any]:
            trimmed_messages: list[BaseMessage] = trim_message_history(state.messages, self.max_history)
            if self.deep_research_job_submitter is not None:
                job_id = await self.deep_research_job_submitter(state)
                response = f"Deep research job submitted. Job ID: {job_id}"
                # Emit the job id as a structured channel value so the frontend
                # can open the research panel without regex-parsing this prose.
                return {"messages": [AIMessage(content=response)], "deep_research_job_id": job_id}

            research_query = state.original_query or get_latest_user_query(state.messages)
            deep_state = DeepResearchAgentState(
                messages=trimmed_messages + [HumanMessage(content=research_query)],
                data_sources=state.data_sources,
                clarifier_result=state.clarifier_result,
                available_documents=state.available_documents,
                user_info=state.user_info,
                project_context=state.project_context,
            )
            try:
                result = await self.deep_research_fn(deep_state)
            except EmptySourceRegistryError as exc:
                logger.warning("Deep research produced no verifiable sources")
                if exc.unavailable_tools:
                    from aiq_agent.common.tool_validation import format_user_facing_tool_error

                    err_msg = format_user_facing_tool_error(
                        "deep research",
                        exc.unavailable_tools,
                        exc.available_count,
                    )
                else:
                    err_msg = (
                        "The search tools did not return any results for this question. "
                        "This may be due to a temporary issue or the question may need to be rephrased. "
                        "Please try again."
                    )
                return {"messages": [AIMessage(content=err_msg)]}
            except Exception as e:
                if _AuthError and isinstance(e, _AuthError):
                    logger.warning("Auth error in deep research: %s", e)
                    return {"messages": [AIMessage(content=str(e))]}
                raise
            if not result.messages:
                error_message = "An error occurred during deep research."
                logger.error(error_message)
                final_message = AIMessage(content=error_message)
                return {"messages": [final_message]}
            else:
                return {"messages": [result.messages[-1]]}

        def route_after_orchestration(state: ChatResearcherState) -> str:
            """Route by classification: error -> END (canned message already in
            messages), deep research -> clarifier, everything else (research
            shallow AND meta/conversational turns) -> shallow agent, which owns
            the persona and the `remember` tool."""
            if state.user_intent and state.user_intent.intent == "error":
                return "END"
            if state.depth_decision and state.depth_decision.decision == "deep":
                return "clarifier"
            return "shallow_research"

        def should_escalate(state: ChatResearcherState) -> str:
            if not self.enable_escalation:
                return "END"

            # Conversational (meta) turns are answered by the shallow agent but
            # must never escalate: the keyword tail-match below could otherwise
            # misread chit-chat ("I don't have enough information about you...")
            # as a failed research attempt and launch deep research.
            if state.user_intent and state.user_intent.intent == "meta":
                return "END"

            # Respect explicit escalation decision from shallow research.
            # Successful shallow paths set shallow_result=None so this guard
            # only fires when shallow explicitly set escalate_to_deep.
            if state.shallow_result is not None:
                if state.shallow_result.escalate_to_deep:
                    return "deep_research"
                return "END"

            messages = state.messages
            if not messages:
                return "END"

            last_ai_content = None
            for m in reversed(messages):
                if isinstance(m, AIMessage):
                    last_ai_content = m.content if hasattr(m, "content") else str(m)
                    break
            if not last_ai_content:
                return "END"

            last_content = last_ai_content if isinstance(last_ai_content, str) else str(last_ai_content)
            if not last_content.strip():
                return "deep_research"

            if matches_escalation_keywords(last_content):
                return "deep_research"

            return "END"

        graph = StateGraph(ChatResearcherState)

        graph.add_node("intent_classifier", intent_classifier_node)
        graph.add_node("shallow_research", shallow_research_node)
        graph.add_node("clarifier", clarifier_node)
        graph.add_node("deep_research", deep_research_node)

        graph.set_entry_point("intent_classifier")

        graph.add_conditional_edges(
            "intent_classifier",
            route_after_orchestration,
            {
                "END": END,
                "clarifier": "clarifier",
                "shallow_research": "shallow_research",
            },
        )

        graph.add_conditional_edges(
            "shallow_research",
            should_escalate,
            {
                "deep_research": "clarifier",
                "END": END,
            },
        )

        graph.add_edge("deep_research", END)

        return graph.compile(checkpointer=self.checkpointer)

    async def run(
        self, state: ChatResearcherState | dict[str, Any], thread_id: str | None = None
    ) -> ChatResearcherState:
        """
        Execute the chat researcher workflow.

        Args:
            state: ChatResearcherState or dict with new messages to add.
            thread_id: Thread ID for the conversation (used for checkpointing).
        Returns:
            Updated state with response in messages.
        """
        graph_config: RunnableConfig = {"configurable": {"thread_id": thread_id}}
        logger.info("ChatResearcherAgent: Starting workflow")

        if isinstance(state, dict):
            input_state = state
            messages = state.get("messages", [])
        else:
            input_state = {
                "messages": state.messages,
                "user_info": state.user_info,
                "data_sources": state.data_sources,
                "available_documents": state.available_documents,
                "collection_scope": state.collection_scope,
                "shallow_result": None,  # reset at turn boundary to avoid stale checkpoint state
                # Reset like shallow_result: a persisted job id from a previous
                # deep-research turn would otherwise be read as this turn's job.
                "deep_research_job_id": None,
                "skip_clarifier": state.skip_clarifier,
                "project_context": state.project_context,
            }
            messages = state.messages

        if messages:
            query = messages[-1].content
            logger.info("Query: %s...", str(query)[:100] if query else "")
        result = await self._graph.ainvoke(input_state, config=graph_config)

        # Cards are emitted by the answering agent through the `emit_card` tool
        # into the conversation-scoped CardRegistry and read by the chat
        # entrypoint after this returns — no post-hoc card-generation call here.
        logger.info("ChatResearcherAgent: Workflow complete")

        return result

    @property
    def graph(self) -> CompiledStateGraph:
        """Get the compiled LangGraph for direct access."""
        return self._graph
