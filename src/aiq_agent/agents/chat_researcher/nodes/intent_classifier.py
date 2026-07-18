"""Intent classifier agent for classifying meta vs research queries."""

import asyncio
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.messages import BaseMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage

from aiq_agent.common import extract_json
from aiq_agent.common import load_prompt
from aiq_agent.common import render_prompt_template

from ..models import ChatResearcherState
from ..models import DepthDecision
from ..models import IntentResult
from ..utils import trim_message_history

logger = logging.getLogger(__name__)


_LLM_UNAVAILABLE_MESSAGE = (
    "I'm unable to reach the model service right now. "
    "Please check your LLM API key and that the configured model is available for your account."
)
_LLM_TIMEOUT_MESSAGE = "The model service took too long to respond and the request timed out. "

# Appended as the final turn of the classification request. With the raw
# conversation replayed as real chat turns, a chat-tuned model's strongest pull
# is to keep conversing and answer the user's question instead of classifying
# it — this makes "emit the routing JSON" the most recent instruction it sees.
_CLASSIFY_NOW_INSTRUCTION = (
    "Classify the user's most recent question (shown as USER QUERY in the system prompt above). "
    "Respond with ONLY the raw JSON object — no prose, no markdown, no code fences."
)

_JSON_RETRY_INSTRUCTION = (
    "That response was not the required JSON. Respond again with ONLY the raw JSON object "
    '({"intent": ..., "research_depth": ..., "depth_reasoning": ...}) — nothing else.'
)

# OpenAI-style structured-output request, supported by OpenRouter and other
# OpenAI-compatible gateways. Providers that don't support json_schema either
# silently ignore the parameter (prose parsing still applies) or reject the
# request (handled by the plain-call fallback in _ainvoke_classifier).
_INTENT_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "intent_classification",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "intent": {"type": "string", "enum": ["meta", "research"]},
                "research_depth": {
                    "anyOf": [{"type": "string", "enum": ["shallow", "deep"]}, {"type": "null"}],
                },
                "depth_reasoning": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            },
            "required": ["intent", "research_depth", "depth_reasoning"],
            "additionalProperties": False,
        },
    },
}


def _is_llm_api_unavailable(err: BaseException) -> bool:
    """True if the error is from the LLM API being unreachable (e.g. 404, function not found)."""
    msg = str(err).strip()
    return (
        "[404]" in msg
        or "not found for account" in msg.lower()
        or (msg.lower().startswith("not found") and "account" in msg.lower())
    )


def _is_timeout_error(err: BaseException) -> bool:
    """True if the error is from a timeout (asyncio.wait_for or gateway 504)."""
    if isinstance(err, TimeoutError | asyncio.TimeoutError):
        return True
    msg = str(err).strip().lower()
    return "504" in msg or "gateway time-out" in msg or "gateway timeout" in msg


class IntentClassifier:
    def __init__(
        self,
        llm: BaseChatModel,
        tools_info: list[dict[str, str]] | None = None,
        prompt: str | None = None,
        callbacks: list[BaseCallbackHandler] | None = None,
        max_history: int = 20,
        llm_timeout: float = 90,
    ) -> None:
        self.llm = llm
        self.tools_info = tools_info or []
        self.prompt = prompt or self._load_default_prompt()
        self.callbacks = callbacks or []
        self.max_history = max_history
        self.llm_timeout = llm_timeout

    async def _ainvoke_classifier(
        self,
        llm: Any,
        messages: list[BaseMessage],
        config: dict[str, Any],
    ) -> Any:
        """Invoke the classifier LLM, enforcing JSON via structured output when possible.

        Chat models get a request-scoped ``response_format`` binding so
        OpenAI-compatible providers enforce the JSON schema server-side. If the
        provider rejects the parameter, fall back to a plain call and rely on
        prose parsing. Timeouts and unreachable-API errors propagate to the
        caller's handlers either way.
        """
        if isinstance(llm, BaseChatModel):
            try:
                structured = llm.bind(response_format=_INTENT_RESPONSE_FORMAT)
                return await asyncio.wait_for(
                    structured.ainvoke(messages, config=config),
                    timeout=self.llm_timeout,
                )
            except Exception as e:
                if _is_timeout_error(e) or _is_llm_api_unavailable(e):
                    raise
                from aiq_agent.common import is_reasoning_incompatible_error

                if is_reasoning_incompatible_error(e):
                    # The model itself cannot run with reasoning disabled — the
                    # plain retry below would 400 identically. Propagate so the
                    # caller falls back to the workflow-default model.
                    raise
                logger.warning(
                    "Structured-output classification failed (%s); retrying without response_format",
                    str(e).split("\n")[0],
                )
        return await asyncio.wait_for(
            llm.ainvoke(messages, config=config),
            timeout=self.llm_timeout,
        )

    def _load_default_prompt(self) -> str:
        try:
            return load_prompt(Path(__file__).parent.parent / "prompts", "intent_classification.j2")
        except Exception:
            return (
                "/no_think\n\n"
                "You are a routing classifier. Classify intent as 'meta' or 'research' "
                "and provide 'research_depth' ('shallow' or 'deep').\n"
                "Respond ONLY with the raw JSON object — no prose, no code fences."
            )

    async def run(
        self,
        state: ChatResearcherState,
        tools_info: list[dict[str, str]] | None = None,
    ) -> dict[str, Any]:
        """Run the intent classifier node.

        Args:
            state: Current chat researcher state.
            tools_info: Optional request-scoped tool list to render into the
                prompt instead of ``self.tools_info``. The classifier instance
                is shared across requests, so per-request narrowing must be
                passed in rather than mutated onto the instance.
        """
        messages = state.messages
        if not messages:
            return {
                "user_intent": IntentResult(intent="research", raw=None),
                "depth_decision": DepthDecision(decision="deep", raw_reasoning="No query"),
            }

        user_info = state.user_info or {}
        # Date only: a per-second timestamp would defeat provider prompt
        # caching of the otherwise-static classification prompt.
        current_datetime = datetime.now().strftime("%Y-%m-%d")
        last_content = messages[-1].content
        query = last_content if isinstance(last_content, str) else str(last_content or "")

        system_content = render_prompt_template(
            self.prompt,
            query=query,
            current_datetime=current_datetime,
            user_info=user_info,
            tools=tools_info if tools_info is not None else self.tools_info,
            project_context=state.project_context,
        )
        trimmed_conversation = trim_message_history(list(state.messages), max_tokens=self.max_history)
        messages: list[BaseMessage] = (
            [SystemMessage(content=system_content)]
            + trimmed_conversation
            + [HumanMessage(content=_CLASSIFY_NOW_INSTRUCTION)]
        )

        try:
            config = {"callbacks": self.callbacks} if self.callbacks else {}
            # Resolve per-org runtime model overrides at invocation time — the
            # classifier instance is shared across requests, so it is never
            # mutated; the override yields a request-scoped model copy.
            from aiq_agent.common import AgentGroup
            from aiq_agent.common import apply_model_override
            from aiq_agent.common import apply_org_credential
            from aiq_agent.common import is_reasoning_incompatible_error

            overridden = apply_model_override(self.llm, AgentGroup.INTENT)
            llm = apply_org_credential(overridden)
            try:
                response = await self._ainvoke_classifier(llm, messages, config)
            except Exception as e:
                # An org override can point this reasoning-off role at a model
                # that cannot disable reasoning (e.g. grok-4.5) — the provider
                # 400s on every call. Fall back to the workflow-default model
                # instead of failing the turn; the picker filters such models
                # at selection time, this is the runtime safety net.
                if overridden is self.llm or not is_reasoning_incompatible_error(e):
                    raise
                logger.warning(
                    "Intent model override is reasoning-incompatible (%s); falling back to the workflow default",
                    str(e).split("\n")[0],
                )
                llm = apply_org_credential(self.llm)
                response = await self._ainvoke_classifier(llm, messages, config)

            response_text = (response.content or "").strip()
            parsed = extract_json(response_text)

            if not parsed or not isinstance(parsed, dict):
                # One corrective retry before giving up: quote the bad reply
                # back and demand bare JSON. Misparsing here misroutes the turn
                # (the fallback below is research + strict citation contract),
                # so a second LLM round-trip is cheaper than a wrong route.
                retry_messages = messages + [
                    AIMessage(content=response_text),
                    HumanMessage(content=_JSON_RETRY_INSTRUCTION),
                ]
                response = await self._ainvoke_classifier(llm, retry_messages, config)
                parsed = extract_json((response.content or "").strip())

            if not parsed or not isinstance(parsed, dict):
                logger.warning(
                    "Intent classification returned no parseable JSON after retry; defaulting to research/shallow",
                )
                return {
                    "user_intent": IntentResult(intent="research", raw=None),
                    "depth_decision": DepthDecision(decision="shallow", raw_reasoning="Parse failed"),
                }

            raw_intent = (parsed.get("intent") or "research").strip().lower()
            intent = raw_intent if raw_intent in ("meta", "research") else "research"
            research_depth = (parsed.get("research_depth") or "shallow").strip().lower()
            depth_reasoning = parsed.get("depth_reasoning") or ""

            # Pure router: no user-facing text is authored here. Meta turns are
            # handled by the shallow agent (it owns the persona and the
            # `remember` tool); this node only emits the routing decision.
            return {
                "user_intent": IntentResult(intent=intent, raw=parsed),
                "depth_decision": DepthDecision(
                    decision=research_depth if research_depth in ("shallow", "deep") else "shallow",
                    raw_reasoning=str(depth_reasoning),
                ),
            }

        except TimeoutError:
            logger.warning(
                "LLM call timed out after %s seconds.",
                self.llm_timeout,
            )
            return {
                "user_intent": IntentResult(intent="error", raw=None),
                "messages": [AIMessage(content=_LLM_TIMEOUT_MESSAGE)],
            }
        except Exception as e:
            if _is_llm_api_unavailable(e):
                logger.exception(
                    "LLM API unreachable (e.g. 404 model/function not found): %s.",
                    str(e).split("\n")[0],
                )
                return {
                    "user_intent": IntentResult(intent="error", raw=None),
                    "messages": [AIMessage(content=_LLM_UNAVAILABLE_MESSAGE)],
                }
            if _is_timeout_error(e):
                logger.exception("LLM call failed with timeout (e.g. 504 Gateway Time-out): %s", e)
                return {
                    "user_intent": IntentResult(intent="error", raw=None),
                    "messages": [AIMessage(content=_LLM_TIMEOUT_MESSAGE)],
                }
            logger.exception("Error in orchestration: %s", e)
            err_msg = "We couldn't process your request due to a temporary error. Please try again."
            return {
                "user_intent": IntentResult(intent="error", raw=None),
                "messages": [AIMessage(content=err_msg)],
            }
