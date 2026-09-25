"""Research agent: the bounded tool-calling turn loop.

Built ONCE per process (``register.py`` constructs it at boot): the prompt
template is read once, the LangGraph is compiled once, and the boot tool set
is bound once. What a turn may vary from that is a :class:`TurnConfig`: the
model override (BYOK / ZDR / per-org model), the tool set (the per-turn
``use_skill`` closure, the working directory) and the data sources this
conversation has switched off — which narrow what the tools ANSWER, never what
is bound.

The loop is bounded twice, and the two bounds mean different things. ROUNDS
(``max_tool_iterations``) bound how far the investigation goes: one LLM
decision that emitted tool calls is one round, whatever it fanned out into.
INPUT TOKENS (``max_input_tokens_per_turn``) bound what it costs, because a
round stopped being a proxy for cost the moment it stopped being one call.
``run()`` binds those into a :class:`TurnBinding` that travels to the graph
nodes on the LangGraph config, so a turn costs one ``bind_tools`` at most and
never a prompt read or a graph compile.

The post-answer pipeline lives in :mod:`.answer_pipeline`, the repair pass in
:mod:`.repair`, the wire and ledger in :mod:`.ledger`, prompt assembly in
:mod:`.prompt`.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Iterable
from collections.abc import Mapping
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import replace
from typing import Any
from typing import Protocol
from typing import runtime_checkable

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
from langgraph.prebuilt import tools_condition

from aiq_agent.common import LLMProvider
from aiq_agent.common import LLMRole
from aiq_agent.common import content_to_text
from aiq_agent.common import get_source_id_for_tool
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import begin_turn_capture
from aiq_agent.common.citation_verification import end_turn_capture
from aiq_agent.common.citation_verification import extract_sources_from_tool_result
from aiq_agent.common.citation_verification import get_session_registry
from aiq_agent.common.citation_verification import get_turn_captures
from aiq_agent.common.citation_verification import record_turn_capture
from aiq_agent.common.citation_verification import reset_session_registry
from aiq_agent.common.citation_verification import set_session_registry
from aiq_agent.common.cost_tracking import grid_cost_tracker_var
from aiq_agent.common.data_sources import disabled_source_notice
from aiq_agent.common.deferred_tool_loading import DeferredToolBinding
from aiq_agent.common.deferred_tool_loading import DeferredToolLoadingSettings
from aiq_agent.common.deferred_tool_loading import bind_tools_deferred
from aiq_agent.common.grounding_block import begin_grounding_capture
from aiq_agent.common.grounding_block import end_grounding_capture
from aiq_agent.common.grounding_block import strip_trace_lanes
from aiq_agent.common.prompt_caching import begin_stable_prefix
from aiq_agent.common.prompt_caching import end_stable_prefix
from aiq_agent.common.retrieval_rounds import assistant_checkpoint
from aiq_agent.common.retrieval_rounds import failed_call_ids
from aiq_agent.common.retrieval_rounds import ran_signatures
from aiq_agent.common.retrieval_rounds import repeat_fetches
from aiq_agent.common.retrieval_rounds import signatures_of
from aiq_agent.common.tool_errors import render_tool_error
from aiq_agent.common.turn_status import begin_lane_capture
from aiq_agent.common.turn_status import emit_family_coverage
from aiq_agent.common.turn_status import emit_input_budget_exhausted
from aiq_agent.common.turn_status import emit_refused_source
from aiq_agent.common.turn_status import emit_repeat_fetch
from aiq_agent.common.turn_status import emit_research_truncated
from aiq_agent.common.turn_status import emit_retrieval
from aiq_agent.common.turn_status import emit_synthesis
from aiq_agent.common.turn_status import emit_width_cap
from aiq_agent.common.turn_status import end_lane_capture
from aiq_agent.common.turn_status import fetch_signature
from aiq_agent.common.turn_status import get_lane_captures
from aiq_agent.common.turn_status import is_retrieval_round
from aiq_agent.common.turn_status import prefetch_scope
from aiq_agent.common.turn_status import record_round_announcement
from aiq_agent.common.turn_status import retrieval_round_scope
from aiq_agent.knowledge.already_read import merge_digest
from aiq_agent.observability.langfuse_trace_attributes import begin_turn_prompt_link
from aiq_agent.observability.langfuse_trace_attributes import end_turn_prompt_link
from aiq_agent.tools.bim.measurement_sources import begin_measurement_capture
from aiq_agent.tools.bim.measurement_sources import end_measurement_capture
from aiq_agent.tools.bim.measurement_sources import get_measurement_captures
from aiq_agent.turn.answer_stream import streaming_call

from .answer_pipeline import CardRepairFn
from .answer_pipeline import FinalAnswer
from .answer_pipeline import LiveAnswer
from .answer_pipeline import RepairFn
from .answer_pipeline import finalize_answer
from .envelope_call import ainvoke
from .envelope_call import ainvoke_with_envelope_json_mode
from .grounding import tool_result_is_measurement
from .ledger import assemble_result
from .models import ResearchAgentState
from .prompt import build_tools_info
from .prompt import render_system_prompt
from .prompt import shelf_label
from .prompt import stamp_static_prompt_for_turn
from .prompt import system_prompt_template
from .quote_patch import quote_patcher
from .tool_search import ToolSearchIndex
from .tool_search import ToolSearchSettings
from .tool_search import build_query_parts
from .tool_search import tool_basename

logger = logging.getLogger(__name__)

# Imported from outside this package under this name
# (``tests/aiq_agent/agents/test_composer_subject_reaches_prompts.py``).
_shelf_label = shelf_label

# Cap on both tool-search caches (query → selection, selection → bound LLM).
# A shared agent serves many requests, so each map is dropped WHOLE at the cap
# rather than grown or LRU-tracked: a miss costs one re-rank (0.05 ms) or one
# bind_tools (pure CPU, no network), while an unbounded dict on a long-lived
# worker costs memory forever.
_MAX_CACHED_BINDINGS = 32

#: Cumulative INPUT tokens one turn may spend before synthesis is forced.
#: Rounds bound how far the investigation goes; this bounds what it COSTS, and
#: without it nothing does — a round is now one decision however many calls it
#: fans out into. Sized well above the worst turn we have measured (288 583
#: prompt tokens over eight calls, on „was weißt du über die OIB 2"), because a
#: bound that fires on a hard question is a hobble; it is here to stop a
#: runaway, not to shape a turn. 0 disables it.
_DEFAULT_MAX_INPUT_TOKENS_PER_TURN = 600_000

#: The one line that goes in FRONT of the result a withheld repeat is answered
#: with. The guard used to answer a repeat with a scolding and a pointer at the
#: transcript ("das Ergebnis oben ist die Antwort"), which asks the model to go
#: and find something it already asked for — and a model that cannot find it
#: asks a third time. A tool delivers an answer, so the repeat is answered with
#: the ANSWER: the first execution's own text, verbatim, labelled as the earlier
#: result so nothing reads as a second, agreeing retrieval. Still uncharged,
#: still never run again.
_REPEAT_FETCH_PREFIX = (
    "Wiederholter Aufruf: dieser Aufruf lief in diesem Zug bereits identisch und wurde nicht erneut "
    "ausgeführt. Unten steht unverändert sein Ergebnis von damals — weiter mit einer anderen Stelle "
    "oder einer anderen Frage."
)

#: The fallback when the turn no longer holds the first execution's text (the
#: tools node was driven directly, or that call answered with nothing at all).
#: German for the same reason as the prefix, and an INSTRUCTION for the same
#: reason: a retry of the identical call would buy the turn nothing.
_REPEAT_FETCH_MESSAGE = (
    "Nicht ausgeführt: dieser Aufruf lief in diesem Zug bereits identisch; "
    "das Ergebnis oben ist die Antwort — weiter mit einer anderen Stelle oder einer anderen Frage, "
    "nicht mit einer Wiederholung"
)

#: What a same-batch repeat of a FAILED fetch is answered with. The turn holds
#: no result for it — the first occurrence ran and the store did not answer —
#: so :data:`_REPEAT_FETCH_MESSAGE` would point at a result that does not
#: exist, which is the one thing the guard must never do (a failure signs
#: nothing, precisely so the retry stays available). Says what happened and
#: when the call may be made again.
_FAILED_FETCH_REPEAT_MESSAGE = (
    "Nicht ausgeführt: dieser Aufruf war in dieser Runde schon einmal enthalten, und dieser erste "
    "Versuch ist fehlgeschlagen — es liegt kein Ergebnis vor. Du kannst ihn in der nächsten Runde "
    "erneut stellen oder eine andere Stelle wählen."
)

#: How many tool calls ONE round may actually run. A runaway guard, not a
#: doctrine: a round costs one whatever it fans out into, and a model opening
#: all five members of a Richtlinien-Familie at once is using its round well.
#: What this bounds is the shape nothing else sees — sixty parallel calls into
#: the vector store, which ``max_input_tokens_per_turn`` only notices at the
#: START of the next round, by which time the fan-out has already been served.
#: 0 disables it.
_DEFAULT_MAX_CALLS_PER_ROUND = 12

#: What a call beyond the width cap is answered with. An INSTRUCTION, like the
#: two notices above: the call was not refused, it was not RUN THIS ROUND, and
#: the useful next move is to ask for it again in the next one.
_WIDTH_CAP_MESSAGE = (
    "Nicht ausgeführt: diese Runde hat mehr parallele Aufrufe angefordert, als eine Runde ausführen "
    "darf. Die ersten Aufrufe der Runde sind gelaufen; dieser hier nicht. Stell ihn in der nächsten "
    "Runde erneut, wenn du ihn nach den Ergebnissen oben noch brauchst."
)

#: Why the loop stopped early. Stable tokens, not prose: they are counted, and
#: they name two different sizing questions. ``rounds`` is the investigation
#: being cut off — the worst failure this product has. ``input_tokens`` is the
#: turn getting expensive, which is the bound that replaced the per-call budget
#: and should fire on a runaway, never on a hard question.
CUTOFF_ROUNDS = "rounds"
CUTOFF_INPUT_TOKENS = "input_tokens"

#: Where the turn's binding rides on the LangGraph config (``configurable``),
#: so the compiled graph is shared across turns and never rebuilt.
_TURN_BINDING_KEY = "piloti_turn"

_SYNTHESIS_ANCHOR = (
    "You have exhausted your research budget. Synthesize the final answer now "
    "as your ```answer_json envelope object, "
    "using the citations [1], [2] and the '## References' format. "
    "Do not attempt any further tool calls."
)


@runtime_checkable
class FinalReportSink(Protocol):
    """A callback that wants the verified, sanitised answer text."""

    def emit_final_report(self, text: str) -> None: ...


@dataclass(frozen=True)
class TurnConfig:
    """What one turn may vary from the boot-time agent. ``None`` keeps the boot value."""

    llm_provider: LLMProvider | None = None
    tools: Sequence[BaseTool] | None = None
    #: Data sources this conversation may not consult — the org's ADR-0022
    #: toggles plus whatever the request did not select. The tool set does NOT
    #: shrink for them: a call to a switched-off source is answered with one
    #: sentence saying so (:func:`disabled_source_notice`) instead of the tool
    #: disappearing from the binding. Two reasons, both measured. A tool set
    #: that varies per toggle combination is a separate ``prompt_cache_key``
    #: shard (``common/prompt_caching.py``) on a workload that is ~99 % input
    #: tokens and re-sends its prefix 3-8 times per turn; and a capability the
    #: model is told about and then refused is a fact it can say out loud,
    #: where an absent tool is one it has to infer.
    disabled_sources: frozenset[str] = frozenset()
    #: The fetches to run as ROUND 0, before the first LLM call: what the
    #: turn-start decision (``decisions.py``, ADR-0064) says the model's first
    #: round would ask for anyway. Tool-call dicts (``name``, ``args``), run
    #: through the real tools node so the guards, the capture, the round
    #: stamp and the duplicate-fetch answer all apply; the round costs no
    #: budget, because no LLM decision was spent on it.
    prefetch: tuple[dict[str, Any], ...] = ()


@dataclass(frozen=True)
class TurnBinding:
    """A turn's resolved LLM, tool set and budget; what the graph nodes read."""

    llm: BaseChatModel
    llm_with_tools: Any
    tools: tuple[BaseTool, ...]
    tools_info: list[dict[str, str]]
    tool_node: ToolNode
    source_tool_names: frozenset[str]
    #: Tool-calling ROUNDS — LLM decisions that asked for tools — at which
    #: synthesis is forced. Not calls: a round of five parallel fetches is the
    #: model using its round well, and it costs one.
    ceiling: int
    #: Cumulative INPUT tokens this turn may spend before synthesis is forced.
    #: The bound that protects the user's bill, since rounds no longer do:
    #: one round of twelve fetches is cheap in rounds and is not cheap.
    max_input_tokens: int = 0
    #: How many calls of ONE round are actually run. Read in BOTH nodes, like
    #: :attr:`disabled_sources`, so the round the agent node charges is the
    #: round the tools node executes. 0 disables the cap.
    max_calls_per_round: int = 0
    #: See :attr:`TurnConfig.prefetch`. Read once, in :meth:`PilotiAgent.run`.
    prefetch: tuple[dict[str, Any], ...] = ()
    #: See :attr:`TurnConfig.disabled_sources`. Read in BOTH nodes, so the
    #: round the agent node announces is the round the tools node runs.
    disabled_sources: frozenset[str] = frozenset()


def _call_name(call: Any) -> str:
    """The tool name one call addresses, however the provider spelled the call."""
    name = call.get("name") if isinstance(call, dict) else getattr(call, "name", None)
    return str(name or "")


def _call_basenames(message: Any) -> list[str]:
    """The basenames of one message's tool calls, in order."""
    names: list[str] = []
    for call in getattr(message, "tool_calls", None) or []:
        name = call.get("name") if isinstance(call, dict) else getattr(call, "name", None)
        if name:
            names.append(tool_basename(str(name)))
    return names


def _tool_call_shape(messages: Sequence[Any], *, limit: int = 24) -> list[str]:
    """The ordered basenames of every tool this run called.

    The SHAPE of a question, standing in for the question itself: a truncated
    ``use_skill>use_skill>knowledge_search>find_elements>…`` is the fingerprint
    of an OIB 3 daylight chain, and grouping truncations by it is how "on which
    question shapes" gets answered. The tool names and never the arguments: a
    query string is the reader's own words. Capped, because it is a
    fingerprint and not a transcript.
    """
    shape: list[str] = []
    for message in messages:
        shape.extend(_call_basenames(message))
        if len(shape) >= limit:
            return shape[:limit]
    return shape


def _over_width(running: Sequence[Any], max_calls: int) -> list[Any]:
    """The tail of one round beyond the width cap, in the order the model emitted it.

    Applied to what the other two guards left, because the cap bounds what
    RUNS: a round of fifteen calls of which four are repeats asks the stores
    for eleven, and eleven is what the cap has an opinion about. First N kept
    rather than a sample — the model emits its most important call first, and a
    guard that reordered the round would be making a research decision.
    """
    if max_calls <= 0 or len(running) <= max_calls:
        return []
    return list(running[max_calls:])


def _withheld_calls(
    calls: Sequence[Any],
    state: ResearchAgentState,
    disabled: frozenset[str],
    max_calls: int = 0,
) -> tuple[list[Any], list[tuple[Any, str]], list[Any]]:
    """The three guards on this seam, applied once: ``(repeats, refused, over_width)``.

    A fetch whose answer the turn already holds (:func:`repeat_fetches`), a
    call to a source this conversation switched off — each paired with the
    sentence that answers it — and the calls past the round's width cap
    (:func:`_over_width`). Repeats are decided first, so a call that is both is
    counted once and answered as the repeat it is; the cap sees what the other
    two left.

    PURE, and the single derivation both nodes read. The agent node calls it to
    decide what to ANNOUNCE, the tools node to decide what to RUN; two
    derivations eventually announce a search nothing ran.
    """
    repeats = repeat_fetches(calls, state.executed_fetches)
    seen = {id(call) for call in repeats}
    refused = [
        (call, sentence)
        for call in calls
        if id(call) not in seen and (sentence := disabled_source_notice(_call_name(call), disabled)) is not None
    ]
    seen |= {id(call) for call, _ in refused}
    over_width = _over_width([call for call in calls if id(call) not in seen], max_calls)
    return repeats, refused, over_width


def _drop_withheld(
    calls: list[Any],
    state: ResearchAgentState,
    disabled: frozenset[str],
    max_calls: int = 0,
) -> list[Any]:
    """The calls that will actually RUN, and the records the withholding leaves.

    No guard charges anything — charging is per ROUND now, and the round is
    charged whatever survives here — and all three keep their calls out of the
    announcement, so a batch that is only withheld calls consumes no
    ``status:retrieval:N`` slot and does not advance the round counter.
    """
    repeats, refused, over_width = _withheld_calls(calls, state, disabled, max_calls)
    if repeats:
        emit_repeat_fetch(round_index=state.retrieval_round, withheld=len(repeats))
        logger.info(
            "Duplicate fetch withheld: %d call(s) answered with the earlier result, %d asked for (round=%d)",
            len(repeats),
            len(calls),
            state.retrieval_round,
        )
    if refused:
        emit_refused_source(round_index=state.retrieval_round, withheld=len(refused))
        logger.info(
            "Disabled source: %d call(s) answered with the refusal notice (round=%d)",
            len(refused),
            state.retrieval_round,
        )
    if over_width:
        emit_width_cap(
            round_index=state.retrieval_round,
            kept=max_calls,
            withheld=len(over_width),
        )
        logger.warning(
            "Round width cap: %d of %d call(s) run, %d deferred to the next round (cap=%d, round=%d)",
            max_calls,
            len(calls),
            len(over_width),
            max_calls,
            state.retrieval_round,
        )
    # By identity: two parallel calls to one tool can be equal dicts, and
    # ``in`` would then drop the occurrence that is supposed to run.
    withheld = {id(call) for call in (*repeats, *(call for call, _ in refused), *over_width)}
    if not withheld:
        return calls
    return [call for call in calls if id(call) not in withheld]


def _starts_synthesis(response: Any, state: ResearchAgentState) -> bool:
    """Did this response end the tool loop with the answer being written?

    Exactly-once per turn by construction: the loop routes to ``__end__`` on
    the first response without tool calls, so no later round can re-trigger
    it. Gated on tool work done — a direct reply never searched, and claiming
    a synthesis phase there would narrate a distinction the turn does not
    have. Blank content with no calls is degenerate, not synthesis.
    """
    calls = getattr(response, "tool_calls", None) or []
    if calls:
        return False
    text = " ".join(content_to_text(getattr(response, "content", "") or "").split())
    if not text:
        return False
    return state.tool_iterations > 0


def _charge_empty_round(state: ResearchAgentState, ceiling: int) -> tuple[int, int, dict[str, Any] | None]:
    """A round whose every call was withheld: one ROUND, no announcement.

    Something has to be charged — the round cost an LLM call and two graph
    steps and nothing ran to pay for them — and under a round budget there is
    only one thing to charge: the round. The model asked for a round, it got
    one, and one round is what it pays for. That is also what makes the loop
    terminate when a model re-asks for the same passage forever.

    Nothing is announced and the round counter does not move: no fetch ran, so
    there is no layer of the spine to draw and no results to stamp.
    """
    rounds = state.tool_iterations + 1
    logger.info(
        "Round withheld in full (repeat or switched-off source); charged 1 round. Rounds spent: %d/%d",
        rounds,
        ceiling,
    )
    return rounds, state.retrieval_round, None


def _charge_tool_calls(
    response: Any,
    state: ResearchAgentState,
    ceiling: int,
    disabled: frozenset[str] = frozenset(),
    max_calls: int = 0,
) -> tuple[int, int, dict[str, Any] | None]:
    """What this round COSTS and ANNOUNCED: ``(rounds, retrieval_round, record)``.

    ONE per round, whatever the round asked for. A round is one LLM decision
    that emitted tool calls; the calls inside it are that decision being
    carried out, and a model that opens all five members of a Richtlinien-
    Familie in one parallel batch is using its round WELL. Charging each call
    made exactly that turn — the family overview the prompt asks for — the one
    that ran out of budget, and it made the second card of the card doctrine
    unreachable on any turn that had actually searched.

    So there is no second currency any more. The interaction allowance existed
    only to hold `emit_card` / `remember` / the working directory's file verbs
    out of a per-CALL budget; with a per-round budget an interaction-only round
    is simply a round, and it costs one like every other. A repeat-only round
    costs one too (:func:`_charge_empty_round`).

    What the round pays for does not include a WITHHELD call — a repeat fetch,
    a call to a switched-off source, or a call past the round's width cap is
    neither run nor announced — but the round that asked for nothing else still
    costs its one.
    """
    calls = getattr(response, "tool_calls", None) or []
    if not calls:
        return state.tool_iterations, state.retrieval_round, None
    calls = _drop_withheld(calls, state, disabled, max_calls)
    if not calls:
        return _charge_empty_round(state, ceiling)
    rounds = state.tool_iterations + 1
    logger.info(
        "Round of %d tool call(s). Rounds spent: %d/%d",
        len(calls),
        rounds,
        ceiling,
    )
    # The same fact, said to the USER instead of the log: one line per ROUND.
    # The checkpoint sentence rides as ``reason`` so the Herleitung can draw a
    # conclusion instead of the search query. Two channels carry it and
    # ``emit_retrieval`` ranks them: the ``conclusion`` ARGUMENT the retrieval
    # tools declare (what the prompt asks for), and — passed here — the prose
    # the model wrote beside its calls, which is the fallback for a model that
    # narrates instead of filling the slot.
    conclusion = assistant_checkpoint(response)
    searched = emit_retrieval(
        calls,
        round_index=state.retrieval_round,
        conclusion=conclusion,
    )
    retrieval_round = state.retrieval_round + (1 if searched else 0)
    # The stored half of the same announcement: same calls (post withholding),
    # same conclusion, same slot — the ledger join reads this, never a
    # re-derivation, so it cannot describe a different round than the frame.
    record = record_round_announcement(
        round_index=state.retrieval_round,
        calls=calls,
        conclusion=conclusion,
    )
    return rounds, retrieval_round, record


def _executing_retrieval_round(state: ResearchAgentState, ran: Sequence[Any]) -> int | None:
    """The round the tools node is about to execute, or ``None`` for no round.

    Off by one on purpose, and the reason is worth spelling out. The agent node
    announces round N with ``state.retrieval_round`` and only THEN advances the
    counter, so by the time the tools node runs the state already holds N+1 and
    the calls it is holding belong to N — i.e. ``state.retrieval_round - 1``,
    but only when that last agent turn was a fetch. An action-only round
    (``remember`` / ``emit_card``) never advanced the counter and is not a layer
    of the spine: its results belong to no round, so the stamp is ``None``
    rather than the previous fetch's number, which would file a card write
    under the search before it.

    ``ran`` is what the guards LEFT (``_split_round(...).ran``), not what the
    model asked for, because that is what the agent node counted: a round whose
    every fetch was withheld and whose ``emit_card`` survived advanced no
    counter, so reading the raw AIMessage here would file that card under the
    previous round's search. Both halves therefore read the SAME predicate
    (:func:`is_retrieval_round`) off the SAME calls as the announcement did.
    """
    calls = [call for call in ran if isinstance(call, dict)]
    if not is_retrieval_round(calls):
        return None
    # max(): the graph always runs agent→tools, so 0 here means the announcement
    # itself did not happen (a test driving the tools node directly). Round 0 is
    # the honest reading of "the first fetch of this run" — never a negative.
    return max(state.retrieval_round - 1, 0)


def _opened_documents(sources: Iterable[Any]) -> set[str]:
    """The indexed filenames this turn actually got a passage from.

    Read off the citation key, which is ``"<file>, p.N"`` and may carry a shelf
    qualifier when one filename sat on two shelves in one result set. Both are
    RENDERING added around the identity, so both come off here rather than being
    matched around.
    """
    names: set[str] = set()
    for source in sources or ():
        key = str(getattr(source, "citation_key", "") or "")
        name = key.split(",", 1)[0].strip()
        if "(" in name:
            name = name.split("(", 1)[0].strip()
        if name:
            names.add(name)
    return names


def _report_family_coverage(turn_sources: Sequence[Any]) -> None:
    """At synthesis: how much of each Richtlinien-Familie the turn read.

    Only families the turn TOUCHED. A family it never went near is not a miss,
    and emitting six records on every greeting would make the rate meaningless
    as well as noisy — the same "a constant is not an event" rule the status
    module is built on.

    Fail-open: this is a measurement of the answer, worth strictly less than the
    answer.
    """
    try:
        from aiq_agent.common.norm_registry import oib_family_member
        from aiq_agent.knowledge.inventory import get_norm_families

        families = get_norm_families()
        if not families:
            return
        opened = {member for name in _opened_documents(turn_sources) if (member := oib_family_member(name))}
        for family in families:
            hit = [member for member in family.members if member in opened]
            if hit:
                emit_family_coverage(family=family.key, listed=len(family.members), opened=len(hit))
    except Exception:  # noqa: BLE001 — a coverage count must never take a turn down
        logger.debug("Family-coverage record not emitted", exc_info=True)


def _last_tool_calls(state: ResearchAgentState) -> list[dict[str, Any]]:
    """The tool calls the tools node is holding, as dicts."""
    last = state.messages[-1] if state.messages else None
    return [call for call in (getattr(last, "tool_calls", None) or []) if isinstance(call, dict)]


def _without_dropped_calls(state: ResearchAgentState, dropped: Sequence[Any]) -> ResearchAgentState:
    """The state the ``ToolNode`` sees: the same round, minus every withheld call.

    ``dropped`` is the UNION of what the two guards took away — the repeat
    fetches and the calls to a switched-off source — because the ``ToolNode``
    is invoked once and has to be handed one list.

    A COPY — the state's own AIMessage keeps every call it made, because the
    transcript the model reads next has to show the calls it asked for beside
    the answer each of them got.
    """
    withheld = {id(call) for call in dropped}
    last = state.messages[-1]
    kept = [call for call in (getattr(last, "tool_calls", None) or []) if id(call) not in withheld]
    trimmed = last.model_copy(update={"tool_calls": kept})
    return state.model_copy(update={"messages": [*state.messages[:-1], trimmed]})


def _without_trace_lanes(message: Any) -> Any:
    """The same tool result minus the fan-out JSON; anything else untouched."""
    if not isinstance(message, ToolMessage) or not isinstance(message.content, str):
        return message
    stripped = strip_trace_lanes(message.content)
    if stripped == message.content:
        return message
    return message.model_copy(update={"content": stripped})


def _notice(call: Any, content: str) -> ToolMessage:
    """The one result a withheld call gets, addressed to the call that asked."""
    return ToolMessage(
        content=content,
        name=_call_name(call),
        tool_call_id=str(call.get("id") or ""),
    )


def _repeat_answer(call: Any, results: Mapping[str, str], attempted: frozenset[str] = frozenset()) -> str:
    """What a withheld repeat is answered with: the first execution's own result.

    A tool delivers an answer. The guard's job is to stop the turn PAYING for
    the same fetch twice, not to stop the model having the text — so the text
    comes back, labelled, and the model has nothing left to retry.

    With no result to hand back there are two different things to say, and
    saying the wrong one is a lie the model acts on. ``attempted`` is the
    signatures THIS round handed to the tools: a signature in it that produced
    no result is a fetch that FAILED, and the repeat withheld beside it must be
    told exactly that, or ``_REPEAT_FETCH_MESSAGE`` points at „das Ergebnis
    oben" when there is no result above — the same lie a cross-round failure is
    carefully kept from telling (a failure signs nothing, so its retry runs).
    Everything else — the tools node driven directly, a first execution that
    returned nothing at all — is the old fallback.
    """
    signature = fetch_signature(call)
    cached = results.get(signature) if signature is not None else None
    if cached:
        return f"{_REPEAT_FETCH_PREFIX}\n\n{cached}"
    if signature is not None and signature in attempted:
        return _FAILED_FETCH_REPEAT_MESSAGE
    return _REPEAT_FETCH_MESSAGE


@dataclass(frozen=True)
class _RoundSplit:
    """One round cut into what RUNS and what is answered without running."""

    ran: list[Any]
    repeats: list[Any]
    #: ``(call, the sentence that answers it)`` for every call addressing a
    #: source this conversation switched off.
    refused: list[tuple[Any, str]]
    #: The calls past the round's width cap: not refused, just not run THIS
    #: round, and the model is told it may ask again next round.
    over_width: list[Any]

    @property
    def withheld(self) -> list[Any]:
        """Every call the ``ToolNode`` must not be given."""
        return [*self.repeats, *(call for call, _ in self.refused), *self.over_width]

    @property
    def attempted(self) -> frozenset[str]:
        """The fetch signatures this round HANDS to the tools, failures included.

        What :func:`_repeat_answer` needs to tell a same-batch repeat of a
        failed fetch from one the turn simply does not hold: the signature was
        tried here and there is no result, which is a failure and not an
        earlier answer.
        """
        return signatures_of(self.ran)

    def notices(self, results: Mapping[str, str]) -> list[ToolMessage]:
        """The answer each withheld call gets."""
        attempted = self.attempted
        return [
            *(_notice(call, _repeat_answer(call, results, attempted)) for call in self.repeats),
            *(_notice(call, sentence) for call, sentence in self.refused),
            *(_notice(call, _WIDTH_CAP_MESSAGE) for call in self.over_width),
        ]


def _split_round(state: ResearchAgentState, disabled: frozenset[str], max_calls: int = 0) -> _RoundSplit:
    """What the tools node runs, derived the way the agent node derived its charge.

    :func:`_withheld_calls`, reading the SAME calls, the SAME
    ``executed_fetches``, the SAME disabled set and the SAME width cap the
    agent node read — the agent node writes none of them — so what is charged
    and what is executed cannot drift apart.
    """
    calls = _last_tool_calls(state)
    repeats, refused, over_width = _withheld_calls(calls, state, disabled, max_calls)
    withheld = {id(call) for call in (*repeats, *(call for call, _ in refused), *over_width)}
    return _RoundSplit(
        ran=[call for call in calls if id(call) not in withheld],
        repeats=repeats,
        refused=refused,
        over_width=over_width,
    )


def _turn_index(state: ResearchAgentState) -> int:
    """The 1-indexed conversation turn this run is, read off its human turns.

    Best-effort by construction: the input messages are history-trimmed, so
    after trimming the count runs low again. That only ever LOWERs a display
    number — retention is by position, never by this number, and staleness is
    answered by miss-then-search, never by comparing it.
    """
    try:
        return max(1, sum(1 for message in state.messages if isinstance(message, HumanMessage)))
    except Exception:  # noqa: BLE001 — a turn number must never take a turn down
        return 1


def _recursion_limit(ceiling: int) -> int:
    """The LangGraph step guard, derived from the ceiling the loop really stops at.

    Two graph steps per tool-calling round (agent + tools), plus slack. Nothing
    is added on top of the ceiling any more: a round is a round whatever it
    asked for, so the cards, the working directory and a batch of five parallel
    fetches all cost one and the loop cannot outrun the ceiling by emitting its
    calls one at a time. The interaction allowance that used to be added here
    existed only to protect a per-CALL budget, and is gone with it.

    A round whose every call was withheld — a repeat fetch, a switched-off
    source — is charged one round (:func:`_charge_empty_round`), so a model
    that emits the same fetch every round walks into the ceiling in at most
    ``ceiling`` rounds and is forced into synthesis, never into a
    ``GraphRecursionError``.
    """
    return (ceiling * 2) + 10


def _turn_input_tokens() -> int:
    """Input tokens this turn has already paid for, off the cost tracker.

    The one accumulator that already exists: ``GridCostTracker`` meters every
    chat completion of the turn through LangChain's configure hook, so this
    counts the agent's own rounds, the reranker and every post-answer stage
    that has run so far, with no second meter to keep in step. Zero outside a
    tracked turn (a CLI run, an eval, a unit test), which reads as "no budget
    has been spent" and therefore never forces synthesis — the honest default
    for a process that is not billing anyone.
    """
    tracker = grid_cost_tracker_var.get()
    if tracker is None:
        return 0
    return tracker.prompt_tokens


def _live_answer() -> LiveAnswer | None:
    """What the stream may show ahead of the pipeline, gated against the registry this turn answers from."""
    registry = get_session_registry()
    return None if registry is None else LiveAnswer(registry)


def _turn_cutoff(state: ResearchAgentState, binding: TurnBinding) -> str | None:
    """Which bound (if any) this turn has already crossed.

    Two bounds, checked in the same place and in this order. ROUNDS is the
    budget the model spends and the one the config's traced floors are written
    against. INPUT TOKENS is what actually protects the person paying: a round
    ceiling says nothing about a round of twelve parallel fetches into an
    80 000-token context, and rounds stopped being a proxy for cost the moment
    a round stopped being one call.
    """
    if state.tool_iterations >= binding.ceiling:
        return CUTOFF_ROUNDS
    if binding.max_input_tokens > 0 and _turn_input_tokens() >= binding.max_input_tokens:
        return CUTOFF_INPUT_TOKENS
    return None


def _fetch_results(
    ran: Sequence[Any],
    messages: Sequence[Any],
    failed_ids: set[str],
) -> dict[str, str]:
    """Signature → the text each fetch of this round returned.

    The other half of ``executed_fetches``, written from the same calls under
    the same rule: a call that FAILED signs nothing, so its retry runs instead
    of being answered with a result that does not exist. What this buys is the
    duplicate guard's answer — the repeat gets the first execution's own text
    back instead of a sentence telling it to go and find it.
    """
    by_id = {
        str(getattr(message, "tool_call_id", "") or ""): str(message.content or "")
        for message in messages
        if isinstance(message, ToolMessage)
    }
    results: dict[str, str] = {}
    for call in ran:
        call_id = str(call.get("id") or "")
        signature = fetch_signature(call)
        content = by_id.get(call_id)
        if call_id in failed_ids or signature is None or not content:
            continue
        results[signature] = content
    return results


def _capture_sources(
    tool_name: str,
    content: str,
    source_tool_names: frozenset[str],
    registry: SourceRegistry,
) -> None:
    """Register the sources one tool result carries, gated twice.

    The tool must be in the agent's loaded tool set AND resolve to a
    configured data source: Piloti's tool list also carries interaction
    tools such as ``emit_card`` and ``remember``, whose confirmations would
    otherwise register as tool-name citation keys via the non-URL fallback.
    The registry is cumulative across the conversation; the citation-health
    ledger needs THIS turn's retrieval, so it is recorded separately.
    """
    if tool_name not in source_tool_names:
        return
    source_id = get_source_id_for_tool(tool_name)
    if source_id is None:
        logger.debug("[CitationRegistry] Skipping non-data-source tool result from %s", tool_name)
        return
    sources = extract_sources_from_tool_result(tool_name, content, source_id=source_id)
    for source in sources:
        registry.add(source)
    record_turn_capture(sources)
    if sources:
        logger.info(
            "[CitationRegistry] Captured %d source(s) from %s: %s",
            len(sources),
            tool_name,
            [s.url or s.citation_key for s in sources],
        )


def _bind_registry() -> tuple[SourceRegistry, Any]:
    """The registry this run captures into: the session's, else a fresh one.

    The fresh registry is bound via the ContextVar so the tools node sees it,
    and unbound by the caller with the returned token (``None`` when the
    session's registry was already bound). Concurrent standalone runs (``nat
    eval``) therefore never share one and cannot cross-pollinate citations.
    """
    registry = get_session_registry()
    if registry is not None:
        return registry, None
    registry = SourceRegistry()
    return registry, set_session_registry(registry)


class PilotiAgent:
    """Fast, bounded research with tool-calling.

    A two-node LangGraph (``agent`` → ``tools`` → ``agent`` …) whose loop
    terminates on the ROUND ceiling or the turn's input-token ceiling, followed
    by the post-answer pipeline. NAT-independent: every dependency arrives via the constructor,
    and what varies per turn arrives via :meth:`run`'s ``turn``.

    Example:
        >>> provider = LLMProvider()
        >>> provider.set_default(my_llm)
        >>> agent = PilotiAgent(llm_provider=provider, tools=[web_search_tool], max_tool_iterations=5)
        >>> result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="What is CUDA?")]))
    """

    #: The state model ``run`` takes. Declared rather than derived: the async
    #: job runner used to spell it out of the class name, so renaming the class
    #: silently handed the agent a bare dict instead of a state object
    #: (``aiq_api.jobs.runner._get_agent_state_class``).
    state_model = ResearchAgentState

    def __init__(
        self,
        llm_provider: LLMProvider,
        tools: Sequence[BaseTool],
        *,
        system_prompt: str | None = None,
        max_tool_iterations: int = 5,
        max_input_tokens_per_turn: int = _DEFAULT_MAX_INPUT_TOKENS_PER_TURN,
        max_calls_per_round: int = _DEFAULT_MAX_CALLS_PER_ROUND,
        callbacks: list[Any] | None = None,
        tool_search: ToolSearchSettings | None = None,
        deferred_tool_loading: DeferredToolLoadingSettings | None = None,
        envelope_json_mode_with_tools: bool = False,
        repair_pass: bool = True,
        card_repair_llm: BaseChatModel | None = None,
    ) -> None:
        """Build the agent once.

        Args:
            llm_provider: LLMProvider for role-based LLM access.
            tools: The boot tool set. A turn may narrow or extend it.
            system_prompt: Optional custom template; the default is
                ``prompts/piloti.j2``, read once per process.
            max_tool_iterations: The RESEARCH budget, in tool-calling ROUNDS —
                LLM decisions that asked for tools — the turn may spend before
                synthesis is forced. A round costs one whatever it asked for:
                five parallel ``read_passage`` opens are one round, and so is a
                single ``use_skill``. The name is a wire name; see the field
                note on ``ResearchAgentState.tool_iterations``.
            max_input_tokens_per_turn: Cumulative INPUT tokens the turn may
                spend before synthesis is forced, read off the cost tracker
                that already meters them. The bound that protects the person
                paying, now that rounds do not: 0 disables it.
            max_calls_per_round: How many tool calls of ONE round are run. A
                runaway guard and not a doctrine — a round costs one however
                wide it fans out, and a wide round is usually the model using
                it well — so it sits far above any batch the prompt asks for.
                The calls past it are answered with a notice saying they may be
                issued again next round, never deleted from the AIMessage. 0
                disables it.
            callbacks: Optional LangGraph callbacks.
            tool_search: Optional retrieval-based tool narrowing. None (or
                disabled) binds the full set.
            deferred_tool_loading: Optional OpenRouter server-side tool
                search. Orthogonal to ``tool_search``: that one decides WHICH
                tools are bound, this one whether their schemas travel.
            envelope_json_mode_with_tools: Whether provider JSON mode is ALSO
                bound on tool-bound research iterations, not only on the
                tool-free forced-synthesis call. Default False: some
                OpenRouter-routed providers accept the parameter and then stop
                emitting tool calls, a silent degradation the per-call
                fallback cannot see.
            repair_pass: Correct a misremembered quotation in place, on
                ``card_repair_llm`` (``quote_patch.py``, ADR-0067). Off, or
                without that model, ships the marker.
            card_repair_llm: The small model that fixes ONE envelope card
                whose shape the validator refused (``cards/repair.py``): a few
                thousand tokens instead of the full-context round the
                ``emit_card`` retry used to cost. ``None`` drops a card that
                fails validation, and records that it did.
        """
        self.card_repair_llm = card_repair_llm
        self.llm_provider = llm_provider
        self.tools = list(tools)
        self.max_tool_iterations = max_tool_iterations
        self.max_input_tokens_per_turn = max_input_tokens_per_turn
        self.max_calls_per_round = max_calls_per_round
        self.callbacks = callbacks or []
        self.repair_pass = repair_pass
        self.tool_search = tool_search if (tool_search is not None and tool_search.enabled) else None
        self.deferred_tool_loading = (
            deferred_tool_loading if (deferred_tool_loading is not None and deferred_tool_loading.enabled) else None
        )
        self.envelope_json_mode_with_tools = envelope_json_mode_with_tools
        self.system_prompt = system_prompt or system_prompt_template()
        self.tools_info = build_tools_info(self.tools)
        # Retrieval-based tool narrowing, off unless configured. A pure
        # in-process BM25 over tool name + description, built here once: a
        # turn never pays for it, and a deployment that does not ask for it
        # does not even tokenize its tool descriptions. Indexed over the BOOT
        # tools; a tool a turn adds (``use_skill``) is never withheld.
        self._tool_search_index: ToolSearchIndex | None = ToolSearchIndex(self.tools) if self.tool_search else None
        # Selected-tool-set → bound LLM, for the boot binding only.
        self._narrowed_bindings: dict[frozenset[str], Any] = {}
        # Query string → selection, so the retrieval runs once per run.
        self._tool_search_selections: dict[str, Any] = {}
        self._boot = self._bind_turn(self.llm_provider, tuple(self.tools))
        self._graph = self._build_graph()

    # -- bindings ---------------------------------------------------------------

    @property
    def _llm_with_tools(self) -> Any:
        """The boot binding: every boot tool, bound once at construction."""
        return self._boot.llm_with_tools

    @property
    def tool_iteration_ceiling(self) -> int:
        """The ROUND count at which synthesis is forced: the research budget.

        One number, and it is the one the config's traced floors measure. There
        is no reserve on top of it and no second currency beside it — a round
        of cards costs what a round of searches costs, so nothing has to be
        paid for separately.
        """
        return self.max_tool_iterations

    @property
    def graph(self) -> CompiledStateGraph:
        """The compiled LangGraph, for direct access."""
        return self._graph

    def _get_llm(self) -> BaseChatModel:
        """Piloti's boot LLM (the shared ``RESEARCHER`` role)."""
        return self.llm_provider.get(LLMRole.RESEARCHER)

    def _bind_research_tools(self, llm: BaseChatModel, tools: Sequence[BaseTool]) -> Any:
        """Bind a RESEARCH-turn tool set, deferring the schemas when configured.

        The single binding seam: the boot binding, every per-turn binding and
        every narrowed one go through it, so the deferral cannot apply to one
        and silently miss another.
        """
        return bind_tools_deferred(llm, list(tools), settings=self.deferred_tool_loading, parallel_tool_calls=True)

    def _bind_turn(self, provider: LLMProvider, tools: tuple[BaseTool, ...]) -> TurnBinding:
        """Resolve one tool set against one provider: the only per-turn cost, one ``bind_tools``."""
        llm = provider.get(LLMRole.RESEARCHER)
        boot_tools = tools == tuple(self.tools)
        return TurnBinding(
            llm=llm,
            llm_with_tools=self._bind_research_tools(llm, tools),
            tools=tools,
            tools_info=self.tools_info if boot_tools else build_tools_info(tools),
            tool_node=ToolNode(list(tools), handle_tool_errors=render_tool_error),
            source_tool_names=frozenset(t.name for t in tools),
            ceiling=self.max_tool_iterations,
            max_input_tokens=self.max_input_tokens_per_turn,
            max_calls_per_round=self.max_calls_per_round,
        )

    def _resolve_turn(self, turn: TurnConfig | None) -> TurnBinding:
        """The boot binding when the turn varies nothing; a fresh one otherwise.

        A turn's switched-off sources are attached to the binding without
        rebinding anything, and that is the point of row 6: the tool set does
        not change with a toggle, so neither does the payload the provider's
        cache is keyed on. Only the model override and the turn's added tools
        (``use_skill``, the working directory) ever cost a ``bind_tools``.
        """
        if turn is None:
            return self._boot
        provider = turn.llm_provider or self.llm_provider
        tools = tuple(self.tools if turn.tools is None else turn.tools)
        boot = provider is self.llm_provider and tools == self._boot.tools
        base = self._boot if boot else self._bind_turn(provider, tools)
        if turn.disabled_sources == base.disabled_sources and not turn.prefetch:
            return base
        return replace(base, disabled_sources=frozenset(turn.disabled_sources), prefetch=tuple(turn.prefetch))

    def _select_tools_for_query(self, messages: Sequence[Any]) -> Any:
        """Run (or replay) the tool-search retrieval for this run's question.

        Cached on the query string: the query is built from HUMAN turns only,
        so it is identical across every iteration of one run. Returns ``None``
        when the feature is off or the retrieval could not produce a decision;
        both mean "use the full set".
        """
        settings = self.tool_search
        index = self._tool_search_index
        if settings is None or index is None:
            return None
        try:
            query_parts = build_query_parts(messages)
            if not query_parts:
                return None
            cache_key = "\n<<part>>\n".join(f"{part.weight}:{part.text}" for part in query_parts)
            cached = self._tool_search_selections.get(cache_key)
            if cached is not None:
                return cached
            selection = index.select(query_parts, top_k=settings.top_k, always_include=settings.always_include)
        except Exception:  # noqa: BLE001 - a ranking is a convenience; the tool set is the contract
            logger.warning("[ToolSearch] retrieval failed; binding the full tool set", exc_info=True)
            return None
        # ADR-0045: the shape of the call, never the building. Tool names are
        # code identifiers from our own config.
        logger.info(
            "[ToolSearch] %s: bound %d/%d tool(s) — selected=%s withheld=%s",
            selection.reason,
            len(selection.selected),
            len(index.tool_names),
            list(selection.selected),
            list(selection.withheld),
        )
        if len(self._tool_search_selections) >= _MAX_CACHED_BINDINGS:
            self._tool_search_selections.clear()
        self._tool_search_selections[cache_key] = selection
        return selection

    def _narrowed_binding(self, binding: TurnBinding, chosen: frozenset[str], tools: list[BaseTool]) -> Any:
        """The bound LLM for a narrowed set; cached for the boot binding only."""
        if binding is not self._boot:
            return self._bind_research_tools(binding.llm, tools)
        bound = self._narrowed_bindings.get(chosen)
        if bound is not None:
            return bound
        bound = self._bind_research_tools(binding.llm, tools)
        if len(self._narrowed_bindings) >= _MAX_CACHED_BINDINGS:
            self._narrowed_bindings.clear()
        self._narrowed_bindings[chosen] = bound
        return bound

    def _research_tool_binding(
        self,
        messages: Sequence[Any],
        tools_info: list[dict[str, str]],
        binding: TurnBinding | None = None,
    ) -> tuple[Any, list[dict[str, str]]]:
        """LLM + prompt tool list for a RESEARCH turn, narrowed if configured.

        With tool search off this returns the turn's binding and the caller's
        tool list untouched. With it on, the narrowing happens HERE, around
        the LLM call: the model is offered fewer tools, not asked to find
        them, so a narrowed turn costs exactly what an unnarrowed one costs.
        The prompt's tool list is narrowed to match the binding, so the model
        is never told about a tool it has not been given. A tool the index
        never saw (one the turn added) is always kept.
        """
        binding = binding or self._boot
        selection = self._select_tools_for_query(messages)
        if selection is None or not selection.narrowed:
            return binding.llm_with_tools, tools_info
        chosen = frozenset(selection.selected)
        indexed = set(self._tool_search_index.tool_names) if self._tool_search_index else set()
        keep = {t.name for t in binding.tools if t.name in chosen or t.name not in indexed}
        narrowed_tools = [t for t in binding.tools if t.name in keep]
        if not narrowed_tools:
            # Belt and braces over ``select``'s own empty guard: an empty
            # binding would leave the model with no way to answer at all.
            return binding.llm_with_tools, tools_info
        bound = self._narrowed_binding(binding, chosen, narrowed_tools)
        return bound, [ti for ti in tools_info if ti.get("name") in keep]

    # -- graph ------------------------------------------------------------------

    def _build_graph(self) -> CompiledStateGraph:
        """Compile the two-node loop once; turns vary through the config."""
        builder = StateGraph(ResearchAgentState)
        # Round 0 first: the fetches the turn-start decision named, run
        # through the tools node before the model's first call (ADR-0064). A
        # no-op step on a turn with nothing to prefetch.
        builder.set_entry_point("prefetch")
        builder.add_node("prefetch", self._prefetch_node)
        builder.add_node("agent", self._agent_node)
        builder.add_node("tools", self._tools_node)
        builder.add_edge("prefetch", "agent")
        builder.add_conditional_edges("agent", tools_condition, {"tools": "tools", "__end__": "__end__"})
        builder.add_edge("tools", "agent")
        return builder.compile()

    def _turn_binding(self, config: RunnableConfig) -> TurnBinding:
        """The binding ``run()`` put on the config; the boot one on the graph-direct path."""
        return (config.get("configurable") or {}).get(_TURN_BINDING_KEY) or self._boot

    async def _agent_node(self, state: ResearchAgentState, config: RunnableConfig) -> dict[str, Any]:
        """One LLM call: the full binding (ADR-0052), or forced synthesis at a ceiling."""
        binding = self._turn_binding(config)
        tools_info = state.tools_info if state.tools_info else binding.tools_info
        llm_with_tools, tools_info = self._research_tool_binding(state.messages, tools_info, binding)
        # Rendered once per run and cached on the state: every input is fixed
        # for the life of one run(), so the string is byte-identical across
        # tool-loop iterations and the norm-block computation runs once.
        system_prompt = state.cached_system_prompt
        if system_prompt is None:
            # In a THREAD, because the render resolves the static half through
            # the prompt store: with Langfuse prompt management on, that is one
            # bounded HTTP call (2 s) on the first render of a TTL window, and
            # a blocking call inside a coroutine stalls every other turn this
            # worker is serving, not only this one. ``to_thread`` copies the
            # context, so every ContextVar the render reads is the turn's own,
            # and nothing in it depends on the thread it runs on.
            # ``register.py`` moves its blocking reads the same way.
            system_prompt = await asyncio.to_thread(render_system_prompt, self.system_prompt, state, tools_info)
        cutoff = _turn_cutoff(state, binding)
        if cutoff is not None:
            return await self._forced_synthesis(state, binding, system_prompt, cutoff=cutoff)

        messages = [SystemMessage(content=system_prompt), *state.messages]
        # Every round may be the answer, and only its tokens say so; each
        # streams, and the reader shows nothing from a round that is not an
        # envelope. The deferred binding stays buffered (its fallback would
        # replay tokens it already streamed).
        answering, call_config = (
            (llm_with_tools, None)
            if isinstance(llm_with_tools, DeferredToolBinding)
            else streaming_call(llm_with_tools, live=_live_answer())
        )
        if self.envelope_json_mode_with_tools:
            response = await ainvoke_with_envelope_json_mode(answering, messages, call_config)
        else:
            response = await ainvoke(answering, messages, call_config)
        # The tool calls are over and the answer is being written. Without
        # this the live line keeps showing the last retrieval event through
        # the whole synthesis call.
        if _starts_synthesis(response, state):
            emit_synthesis()
        rounds, retrieval_round, round_record = _charge_tool_calls(
            response, state, binding.ceiling, binding.disabled_sources, binding.max_calls_per_round
        )
        update: dict[str, Any] = {
            "messages": [response],
            "tool_iterations": rounds,
            "retrieval_round": retrieval_round,
            "cached_system_prompt": system_prompt,
        }
        if round_record is not None:
            update["retrieval_rounds"] = [*state.retrieval_rounds, round_record]
        return update

    def _record_cutoff(self, state: ResearchAgentState, binding: TurnBinding, cutoff: str) -> None:
        """Say — in the log and on the technical channel — why the loop stopped.

        Two bounds, two records, because they are two different sizing
        questions. Rounds exhausted is "the investigation was cut off": the
        worst failure this product has, counted against the traced floors in
        ``configs/config_oib_openrouter.yml``. Input tokens exhausted is "the
        turn got expensive": the bound that replaced the per-call budget, and
        one that should fire on a runaway rather than on a hard question. What
        is recorded either way is the SHAPE of the run, the ordered tool names,
        because that is what makes the population answerable without logging
        the reader's question.
        """
        shape = _tool_call_shape(state.messages)
        input_tokens = _turn_input_tokens()
        # The rule is a keyword match on "token" in a logged string; these are
        # counts of input tokens against the turn's budget, not a credential.
        # nosemgrep: python.lang.security.audit.logging.logger-credential-leak.python-logger-credential-disclosure
        logger.warning(
            "Forcing synthesis (%s): ceiling=%d rounds_spent=%d input_tokens=%d/%d skill_calls=%d shape=%s",
            cutoff,
            binding.ceiling,
            state.tool_iterations,
            input_tokens,
            binding.max_input_tokens,
            shape.count("use_skill"),
            ">".join(shape) or "-",
        )
        if cutoff == CUTOFF_INPUT_TOKENS:
            emit_input_budget_exhausted(
                limit=binding.max_input_tokens,
                spent=input_tokens,
                rounds=state.tool_iterations,
                shape=shape,
            )
            return
        emit_research_truncated(
            ceiling=binding.ceiling,
            research_budget=self.max_tool_iterations,
            spent=state.tool_iterations,
            rounds=state.tool_iterations,
            shape=shape,
        )

    async def _forced_synthesis(
        self,
        state: ResearchAgentState,
        binding: TurnBinding,
        system_prompt: str,
        *,
        cutoff: str,
    ) -> dict[str, Any]:
        """TRUNCATION: the turn ran out of budget mid-investigation.

        The answer carries ``research_truncated`` whichever bound fired, so the
        reader can be told that evidence-gathering was cut off rather than
        finished. Forced synthesis is the tool-FREE call, so provider JSON mode
        is safe here unconditionally.
        """
        self._record_cutoff(state, binding, cutoff)
        # This call IS the synthesis, by construction (tool-free, anchored on
        # the answer), so the status goes out before it rather than after: the
        # final generation is the longest call of the turn, and the live line
        # would otherwise show the last retrieval event through all of it.
        # The one gate `_starts_synthesis` keeps applies here too: a turn that
        # never researched has no synthesis phase to narrate.
        if state.tool_iterations > 0:
            emit_synthesis()
        # Anchored at the end to combat "Loss in the Middle".
        messages = [SystemMessage(content=system_prompt), *state.messages, HumanMessage(content=_SYNTHESIS_ANCHOR)]
        answering, call_config = streaming_call(binding.llm, live=_live_answer())
        response = await ainvoke_with_envelope_json_mode(answering, messages, call_config)
        return {
            "messages": [response],
            "tool_iterations": state.tool_iterations,
            "cached_system_prompt": system_prompt,
            "research_truncated": True,
        }

    async def _tools_node(self, state: ResearchAgentState, config: RunnableConfig) -> dict[str, Any]:
        """Execute the round's tools and capture sources and measurements.

        Tool-search narrowing gets no execution-side defense: it is a GUESS
        about relevance, and if the model calls a withheld tool anyway the
        guess was wrong and the model is right. Measurement grounding is
        STICKY (OR-ed with what the loop already saw) and recorded BEFORE the
        data-source gate, because ``ifc_measure`` is deliberately not a data
        source: it produces no citable passage.

        The round stamp is set HERE, around the invocation, because this is the
        node the tools actually run in — a ``ContextVar`` set beside the LLM
        call dies at the node boundary, while the tools run as children of THIS
        node. It is derived from the calls that will RUN, never from the raw
        AIMessage: see :func:`_executing_retrieval_round`.

        All three withholding guards land here: a fetch this turn already ran is
        answered with its OWN earlier result, a call to a source this
        conversation switched off with one sentence saying so, and a call past
        the round's width cap with a notice saying it may be issued again next
        round. All are derived from the same calls the agent node charged. The
        AIMessage keeps ALL of its tool calls — a provider rejects a tool result
        with no matching call, and it would reject the un-answered calls too —
        so every call still gets exactly one result and the model reads why some
        of them did not run.

        What actually RETURNED is written back as ``executed_fetches`` and
        ``fetch_results``, which is the only thing the duplicate guard may be
        built from: signing the calls the model asked for would let a withheld
        repeat record itself as done, and signing a call whose store never
        answered would withhold the retry that tool's own message just asked
        for.
        """
        binding = self._turn_binding(config)
        split = _split_round(state, binding.disabled_sources, binding.max_calls_per_round)
        withheld = split.withheld
        executing_round = _executing_retrieval_round(state, split.ran)
        with retrieval_round_scope(executing_round):
            result = await binding.tool_node.ainvoke(_without_dropped_calls(state, withheld) if withheld else state)
        registry = get_session_registry()
        if registry is None:
            raise RuntimeError("PilotiAgent graph invoked outside run(): no source registry is bound")
        ran_messages = list(result.get("messages", []))
        measured = self._capture_round(ran_messages, binding, registry, state)
        # AFTER the capture, which files the sources under the bytes the tool
        # returned: from here on the transcript, the repeat-fetch answers and
        # the next turn's history carry the passages without the lanes JSON
        # the model never reads (``strip_trace_lanes``). The frontend's copy is
        # the NAT tool step, recorded when the tool returned, and unaffected.
        ran_messages = [_without_trace_lanes(message) for message in ran_messages]
        result = {**result, "messages": ran_messages}
        failed_ids = failed_call_ids(ran_messages)
        # Merged BEFORE the notices are built: a call repeated inside its own
        # batch is answered with the result its first occurrence just returned.
        fetch_results = {**state.fetch_results, **_fetch_results(split.ran, ran_messages, failed_ids)}
        if withheld:
            # AFTER the capture loop, deliberately: a withholding notice is not
            # a tool result and must never be mined for citation keys — and it
            # carries the earlier result verbatim now, so mining it would
            # register every passage of that fetch a second time.
            result = {**result, "messages": [*ran_messages, *split.notices(fetch_results)]}
        result = {
            **result,
            "executed_fetches": [*state.executed_fetches, *ran_signatures(split.ran, failed_ids)],
            "fetch_results": fetch_results,
        }
        if measured:
            return {**result, "answer_measurement_grounded": True}
        return result

    def _capture_round(
        self,
        messages: Sequence[Any],
        binding: TurnBinding,
        registry: SourceRegistry,
        state: ResearchAgentState,
    ) -> bool:
        """Register this round's sources; return the sticky measurement flag.

        A call that FAILED contributes neither: its text is an error message,
        not evidence.
        """
        measured = bool(state.answer_measurement_grounded)
        for message in messages:
            if not isinstance(message, ToolMessage) or not message.content:
                continue
            if getattr(message, "status", None) == "error":
                # A call that raised returned no evidence, whatever its text
                # says. Read as a result it contributes the error's own words:
                # a pydantic message links to its error index, and that link
                # used to register as a web source card nobody had searched.
                continue
            tool_name = getattr(message, "name", "") or ""
            content = str(message.content)
            measured = measured or tool_result_is_measurement(tool_name, content)
            _capture_sources(tool_name, content, binding.source_tool_names, registry)
        return measured

    # -- the turn ---------------------------------------------------------------

    def _graph_config(self, binding: TurnBinding) -> dict[str, Any]:
        config: dict[str, Any] = {
            "recursion_limit": _recursion_limit(binding.ceiling),
            "configurable": {_TURN_BINDING_KEY: binding},
        }
        if self.callbacks:
            config["callbacks"] = self.callbacks
        return config

    def _repairer(self) -> RepairFn | None:
        """The turn's quote patch on the small model; ``None`` when off or when there is none."""
        if not self.repair_pass or self.card_repair_llm is None:
            return None
        return quote_patcher(self.card_repair_llm)

    def _card_repairer(self) -> CardRepairFn | None:
        """The turn's card repair on the small model; ``None`` when none is configured."""
        llm = self.card_repair_llm
        if llm is None:
            return None

        async def repair(card: dict[str, Any], refusal: str, answer: str) -> dict[str, Any] | None:
            from aiq_agent.cards.repair import repair_card

            return await repair_card(llm, card, refusal, answer)

        return repair

    async def _prefetch_node(self, state: ResearchAgentState, config: RunnableConfig) -> dict[str, Any]:
        """Round 0: the fetches the decision named, run before the first LLM call.

        Announced and executed exactly as a round the model asked for — the
        same ``emit_retrieval`` / ``record_round_announcement`` pair the agent
        node writes, then the tools node itself — so the Herleitung draws it as
        a layer, its sources are captured, its hits are stamped with its round,
        and a model that asks for the same fetch again is answered with this
        result by the duplicate-fetch guard. What it does NOT do is charge:
        ``tool_iterations`` stays 0, because a round is an LLM decision that
        emitted tool calls and none was spent here. A call to a tool this
        turn has not bound, or to a switched-off source, is dropped before
        anything is announced; a turn with nothing to prefetch is a no-op
        step. A graph NODE rather than a call before the graph, because the
        ``ToolNode`` needs the graph's runtime around it.
        """
        binding = self._turn_binding(config)
        if not binding.prefetch:
            return {}
        bound = {tool.name for tool in binding.tools}
        # Unique per turn, not per index: the last turn's transcript stays in the
        # history with its calls, and a provider refuses two calls under one id.
        turn_key = uuid.uuid4().hex[:8]
        calls = [
            {"name": str(call["name"]), "args": dict(call.get("args") or {}), "id": f"prefetch-{turn_key}-{index}"}
            for index, call in enumerate(binding.prefetch, 1)
            if isinstance(call, dict) and call.get("name") in bound
        ]
        if not calls:
            return {}
        announcement = AIMessage(content="", tool_calls=calls)
        announced = state.model_copy(update={"messages": [*state.messages, announcement]})
        split = _split_round(announced, binding.disabled_sources, binding.max_calls_per_round)
        if not split.ran or not is_retrieval_round(split.ran):
            return {}
        searched = emit_retrieval(split.ran, round_index=state.retrieval_round, conclusion=None)
        record = record_round_announcement(round_index=state.retrieval_round, calls=split.ran, conclusion=None)
        # The counter moves as the agent node moves it, so the tools node
        # derives round 0 for these calls (``_executing_retrieval_round``).
        announced = announced.model_copy(
            update={
                "retrieval_round": state.retrieval_round + (1 if searched else 0),
                "retrieval_rounds": [*state.retrieval_rounds, *([record] if record else [])],
            }
        )
        with prefetch_scope():
            result = await self._tools_node(announced, config)
        logger.info("Prefetched %d fetch(es) as round 0", len(split.ran))
        return {
            **{key: value for key, value in result.items() if key != "messages"},
            "messages": [announcement, *result.get("messages", [])],
            "retrieval_round": announced.retrieval_round,
            "retrieval_rounds": announced.retrieval_rounds,
        }

    def _emit_final_report(self, final: FinalAnswer) -> None:
        """Hand the verified, sanitised text to the first callback that renders it
        (it overwrites the raw draft auto-emitted during ``ainvoke``)."""
        if not final.answered or final.content is None:
            return
        for callback in self.callbacks:
            if isinstance(callback, FinalReportSink):
                callback.emit_final_report(final.content)
                return

    async def run(
        self,
        state: ResearchAgentState,
        *,
        turn: TurnConfig | None = None,
    ) -> ResearchAgentState:
        """Execute one research turn: the tool loop, then the post-answer pipeline.

        What THIS turn's tools returned and MEASURED are captured on two
        separate ledgers beside the cumulative registry. That separation is
        the safety property: ``citation_grounded`` derives from the registry
        and is the only route to a surfaced "high", while the normative brake
        is gated on its ABSENCE; a measurement in the registry would hand an
        uncited legal verdict the evidence of the basement measurement standing
        next to it (see ``bim.measurement_sources``).
        """
        binding = self._resolve_turn(turn)
        # Which static half THIS turn renders, when it is the bundled fallback:
        # that is no prompt link, because it names no prompt Langfuse holds, so
        # the trace metadata is where an operator sees it. Resolved and stamped
        # here, in the turn's own context, because the render itself runs in a
        # worker thread whose copied context discards every ContextVar write.
        # The box is bound BEFORE the resolve, so the identity this turn renders
        # with, including the render thread's own resolution, lands in it and
        # is what this turn's generation spans name.
        prompt_link = begin_turn_prompt_link()
        # The static half is what every call of every turn of this tenant
        # shares; naming it keeps the provider's cache key, and so its shard,
        # stable across turns while the dynamic half moves (already-read
        # digest, date, inventory).
        stable_prefix = begin_stable_prefix(await stamp_static_prompt_for_turn())
        registry, registry_token = _bind_registry()
        turn_capture = begin_turn_capture()
        measurement_capture = begin_measurement_capture()
        lane_capture = begin_lane_capture()
        # What each evidence tool STATED, filed under the bytes it returned, so
        # the citation registry copies fields instead of re-parsing the text an
        # evidence tool wrote (ADR-0061).
        grounding_capture = begin_grounding_capture()
        try:
            graph_result = await self._graph.ainvoke(state, config=self._graph_config(binding))
            turn_sources = get_turn_captures()
            turn_measurements = get_measurement_captures()
            lane_hits = get_lane_captures()
        finally:
            end_grounding_capture(grounding_capture)
            end_lane_capture(lane_capture)
            end_measurement_capture(measurement_capture)
            end_turn_capture(turn_capture)
            end_stable_prefix(stable_prefix)
            end_turn_prompt_link(prompt_link)
            if registry_token is not None:
                reset_session_registry(registry_token)

        # Before the answer is finalised, because the question it answers is
        # about the RESEARCH: how much of a Richtlinien-Familie this turn read
        # against how much of it the inventory listed.
        _report_family_coverage(turn_sources)

        final = await finalize_answer(
            graph_result.get("messages") or [],
            registry=registry,
            tools=binding.tools,
            repair=self._repairer(),
            turn_sources=turn_sources,
            card_repair=self._card_repairer(),
        )
        self._emit_final_report(final)
        # The "already read" digest, appended at turn end: this turn's captures
        # merged over the incoming lines, so the next turn re-opens with
        # `read_passage` instead of re-searching.
        merged_digest = merge_digest(state.already_read_digest, turn_sources, _turn_index(state))
        result = assemble_result(
            graph_result,
            final,
            turn_sources=turn_sources,
            turn_measurements=turn_measurements,
            lane_hits=lane_hits,
        )
        result.already_read_digest = merged_digest
        return result
