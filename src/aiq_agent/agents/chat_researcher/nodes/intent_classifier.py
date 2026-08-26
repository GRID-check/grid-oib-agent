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

from aiq_agent.common import content_to_text
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

# Fixed redirect for out-of-scope queries. The classifier emits this verbatim
# and the turn ends WITHOUT invoking any answering agent — no LLM call, no source
# lookup, no research-agent step in the trace. Bilingual (German-first product
# with English-speaking users) so it is comprehensible without a language-aware
# generation step. Kept short and inviting so a rare misclassification of a niche
# in-domain question still nudges the user to rephrase rather than dead-ending.
_OUT_OF_SCOPE_REDIRECT = (
    "Das liegt außerhalb meines Fachgebiets. Ich unterstütze dich bei OIB-Richtlinien, "
    "österreichischem Baurecht (RIS), technischen Richtlinien und internem Bürowissen — "
    "womit kann ich dir dort weiterhelfen?\n\n"
    "_(That's outside my area — I can help with Austrian building regulations, OIB "
    "guidelines, technical building standards, and your office knowledge. If I misread "
    "your question, feel free to rephrase it.)_"
)

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
    '({"intent": ..., "research_depth": ..., "report_requested": ..., "depth_reasoning": ...}) '
    "— nothing else."
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
                "intent": {"type": "string", "enum": ["meta", "research", "out_of_scope"]},
                "research_depth": {
                    "anyOf": [{"type": "string", "enum": ["shallow", "deep"]}, {"type": "null"}],
                },
                # The SECOND of the two signals the deep route requires. Asked
                # as its own question, not folded into research_depth, so the
                # AND can be taken in code — see ``_gate_deep_route``.
                "report_requested": {"type": "boolean"},
                "depth_reasoning": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            },
            "required": ["intent", "research_depth", "report_requested", "depth_reasoning"],
            "additionalProperties": False,
        },
    },
}


_MISSING = object()


def _gate_deep_route(intent: str, research_depth: str, parsed: dict[str, Any]) -> tuple[str, str | None]:
    """Make the deep route track ``report_requested``, IN CODE, both ways.

    Deep research is the report pipeline: the one route that does not answer
    the user (it stops the turn and asks them to approve a plan first) and the
    ONLY route that can file its result into the project. ``report_requested``
    is the classifier's judgment that the user commissioned a document rather
    than asking a question, so on a research turn the two must agree in both
    directions:

    * ``deep`` with ``report_requested: false`` is downgraded — a question gets
      an answer, not a plan.
    * ``shallow`` with ``report_requested: true`` is LIFTED — before the lift,
      "erstelle ein File/Bericht über X" on a single-topic question stayed
      shallow (the depth prompt forbids single-topic deep, correctly, for
      questions), and shallow has no way to produce a file: the user asked for
      a document and silently got a chat message. The lift is research-only; a
      ``meta`` or ``out_of_scope`` turn is never routed into a research plan on
      this field alone.

    Why this lives here and not in the prompt: prose is not enforceable on this
    surface. The model behind this role is not the one in the YAML —
    ``apply_model_override(self.llm, AgentGroup.INTENT)`` re-points it at
    whatever the platform owner picked in Platform -> Models, so the boundary
    can move with a dashboard click and no deploy. Measured over eight models
    an admin could plausibly select, three routed plain single-topic OIB
    questions to deep on the prose-only prompt and five did not; taking the
    rule in code brought all eight to the same boundary. A policy that is only
    written down is a policy that holds for the models that happen to agree
    with it.

    Returns the (possibly re-routed) depth and a reason to log, or ``None``.

    FAIL DIRECTION, deliberately open: an ABSENT ``report_requested`` leaves the
    depth untouched, i.e. exactly the pre-gate contract. The structured-output
    path marks the field ``required``, so it is present on every response that
    honoured the schema; absence means a provider dropped the schema and the
    turn fell back to prose parsing. Failing CLOSED there would silently delete
    deep research for that provider — the same class of invisible breakage as a
    sampling parameter the gateway drops — so the gate steps aside instead, and
    says so in the log rather than doing it quietly. An explicit value decides
    both directions; only a missing key is a pass.
    """
    raw = parsed.get("report_requested", _MISSING)
    if raw is _MISSING:
        if research_depth == "deep":
            logger.warning(
                "Depth gate inert: the classifier response carried no 'report_requested' field, "
                "so 'deep' stands on the depth signal alone"
            )
        return research_depth, None
    if isinstance(raw, str):
        raw = raw.strip().lower() not in ("", "false", "no", "0", "null", "none")
    if research_depth == "deep" and not raw:
        return "shallow", (
            "Depth 'deep' downgraded to 'shallow': the request reads as a question to answer, not a report to write"
        )
    if research_depth != "deep" and raw and intent == "research":
        return "deep", ("Depth lifted to 'deep': the user commissioned a document, and only deep research files one")
    return research_depth, None


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
        max_history_tokens: int = 8000,
        llm_timeout: float = 90,
    ) -> None:
        self.llm = llm
        self.tools_info = tools_info or []
        self.prompt = prompt or self._load_default_prompt()
        self.callbacks = callbacks or []
        self.max_history_tokens = max_history_tokens
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
            from aiq_agent.knowledge.inventory import set_listing_shelf

            set_listing_shelf(None)
            # No query at all is the weakest possible evidence for the most
            # expensive route: "deep" here spent minutes and a plan-approval
            # interrupt on nothing. Degenerate input takes the cheap path, like
            # every other unclear case below.
            return {
                "user_intent": IntentResult(intent="research", raw=None),
                "depth_decision": DepthDecision(decision="shallow", raw_reasoning="No query"),
            }

        user_info = state.user_info or {}
        # Date only: a per-second timestamp would defeat provider prompt
        # caching of the otherwise-static classification prompt.
        current_datetime = datetime.now().strftime("%Y-%m-%d")
        last_content = messages[-1].content
        query = last_content if isinstance(last_content, str) else str(last_content or "")

        from aiq_agent.knowledge.inventory import listing_intent_override
        from aiq_agent.knowledge.inventory import set_listing_shelf
        from aiq_agent.knowledge.inventory import shelf_hint_from_query

        listing_shelf = shelf_hint_from_query(query)
        set_listing_shelf(listing_shelf)
        if listing_intent_override(query) == "meta":
            return {
                "user_intent": IntentResult(intent="meta", raw={"reason": "shelf-listing"}),
                "depth_decision": DepthDecision(decision="shallow", raw_reasoning="Shelf listing"),
            }

        system_content = render_prompt_template(
            self.prompt,
            query=query,
            current_datetime=current_datetime,
            user_info=user_info,
            tools=tools_info if tools_info is not None else self.tools_info,
            project_context=state.project_context,
            focus_file_name=state.focus_file_name,
        )
        trimmed_conversation = trim_message_history(list(state.messages), max_tokens=self.max_history_tokens)
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

            response_text = content_to_text(response.content).strip()
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
                parsed = extract_json(content_to_text(response.content).strip())

            if not parsed or not isinstance(parsed, dict):
                logger.warning(
                    "Intent classification returned no parseable JSON after retry; defaulting to research/shallow",
                )
                return {
                    "user_intent": IntentResult(intent="research", raw=None),
                    "depth_decision": DepthDecision(decision="shallow", raw_reasoning="Parse failed"),
                }

            raw_intent = (parsed.get("intent") or "research").strip().lower()
            intent = raw_intent if raw_intent in ("meta", "research", "out_of_scope") else "research"
            research_depth = (parsed.get("research_depth") or "shallow").strip().lower()
            depth_reasoning = parsed.get("depth_reasoning") or ""

            # The deep route tracks report_requested, both ways. See ``_gate_deep_route``.
            research_depth, gate_note = _gate_deep_route(intent, research_depth, parsed)
            if gate_note:
                logger.info("%s", gate_note)
                # The model argued for a route we are not taking; its sentence is
                # rendered to the reader as the reason for THIS route, so it goes
                # with the decision it defended.
                depth_reasoning = ""

            # The user rejected a research plan earlier in this conversation.
            # That is a durable statement about what they want, so the deep
            # route is off for the rest of the thread and the model's "deep"
            # is downgraded HERE — before the status line is emitted and
            # before ``depth_decision`` reaches ``route_after_orchestration``
            # or ``derive_routing_decision``. Downgrading in one place is what
            # keeps the live line, the routing_decision on the answer and the
            # agent that actually ran from disagreeing with each other.
            #
            # ``depth_reasoning`` is dropped with it: it is rendered to the
            # reader as the model's own words for why this route, and the
            # model's words argue for a route we are not taking.
            if research_depth == "deep" and state.deep_research_declined:
                logger.info("Depth 'deep' downgraded to 'shallow': plan already rejected in this conversation")
                research_depth = "shallow"
                depth_reasoning = ""

            # Say which way the turn is going, NOW. This decision is settled
            # about a second into the turn, and until this line it only ever
            # reached the client on the TERMINAL frame -- i.e. the explanation
            # for a three-minute deep research arrived with the report. The
            # model's own reason travels with it, because that is the part a
            # reader can disagree with while disagreeing is still cheap.
            try:
                from aiq_agent.common.turn_status import emit_routing

                emit_routing(intent=intent, depth=research_depth, reason=str(depth_reasoning) or None)
            except Exception:  # noqa: BLE001 — transparency must never take a turn down
                logger.debug("Routing status not emitted", exc_info=True)

            # Out-of-scope: short-circuit with the fixed redirect and end the turn.
            # No answering agent runs — this is the "predefined text, no research
            # agent" path. The message is emitted here (like the error path) and
            # routing sends the turn straight to END.
            if intent == "out_of_scope":
                return {
                    "user_intent": IntentResult(intent="out_of_scope", raw=parsed),
                    "messages": [AIMessage(content=_OUT_OF_SCOPE_REDIRECT)],
                }

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
