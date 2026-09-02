"""Telling the user what the turn is actually doing, while it does it.

Everything a Grid turn currently reports about itself is an accident of
observability. NAT's ``StepAdaptor`` watches the LangChain instrumentation and
turns LLM/tool/function spans into ``system_intermediate_message`` frames; the
frontend then guesses an activity label by regex-matching the raw NAT function
name. Nothing in this repo ever *said* anything. The holes that leaves are not
edge cases — they are the longest stretches of the turn: context loading before
the graph starts, and the whole answer phase behind a generic label.

This module is the other direction: the agent states what it is doing at the
moment it does it.

Keys, not sentences
-------------------

It states it as a **stable key plus interpolation values**, never as a finished
sentence. The first cut of this module emitted German prose in a ``text``
field and the frontend rendered it verbatim, so an English-locale reader got
German — a regression the whole product rule exists to prevent: **nothing in
emitted data is language-specific**. What travels now is

``key``
    a stable dotted id (``status.retrieval.withQuery``, ``status.escalation``)
    that the frontend resolves against its own dictionary. It is an identifier,
    not copy: renaming one is a wire change.
``values``
    the interpolation data ONLY, ``dict[str, str]``. Everything else the event
    knows (an intent, a depth, a source count, the classifier's reason) travels
    as its own field, because those are telemetry for the details panel and not
    slots in a sentence.

Which means every value in ``values`` must survive being dropped into an
English sentence. Three rules, applied per value:

1. **A proper noun travels as itself.** A skill's authored ``grid-title``
   ("Brandschutznachweis") is that office's name for their own working method;
   it is the same word in every locale, and translating it would be inventing a
   name nobody uses.
2. **A name the PRODUCT chose travels as an id.** "OIB-Wissen", "Ihre
   Unterlagen", "im Gebäudemodell" are product copy wearing a proper noun's
   clothes — and the preposition and the conjunction joining two of them are
   pure German grammar. So a corpus travels as ``knowledge``/``ris``/``web``/
   ``documents``/``ifc`` and the frontend both names and joins them.
3. **Prose is never a value.** An escalation ``reason`` is a free-text sentence
   an LLM wrote; it cannot be interpolated into an English line without
   smuggling a German clause into it. The live line therefore says only the
   DECISION, from a fixed enum, phrased entirely by the frontend. The reason
   still travels — as the ``reason`` FIELD, which the Herleitung already renders
   as the model's own words, attributed and secondary. (Because it is still
   read by a user there, ``intent_classification.j2`` no longer pins it to
   German: it asks for the language of the user's own query.)

The user query quoted in a retrieval line is the reader's own words echoed
back, so it is neither prose we wrote nor a name we chose — it goes back out
exactly as it came in.

What earns a line
-----------------

A status line must complete the sentence "…so the reader knows that ___" with
a noun from an ARCHITECT's world — a law, a document, a working method, a
check. If the only honest completion names a mechanism (a function, a class, a
catalog size, a character count), it is telemetry, and telemetry travels with
``channel="technical"`` so it can sit in the opt-in panel and never on the
live line. Two further rules follow from that:

- **A constant is not an event.** Something that is true on every single turn
  tells the reader nothing by being announced. Where a phase cannot vary, it
  is either not emitted or gated on the thing that does vary.
- **Volume is a design constraint.** The live line REPLACES rather than
  accumulates, so a phase that would fire several times a second is aggregated
  into one event instead. One good sentence beats three true ones.

How it reaches the user
-----------------------

**It is a custom step, on the same wire.** No new frame type, no schema
change: :func:`push_custom_step` pushes an ordinary
``IntermediateStepPayload`` through the run's ``IntermediateStepManager``,
which the step adaptor already forwards. Two constraints shape how:

1. The adaptor's DEFAULT mode (this repo sets no ``step_adaptor:`` block, so
   DEFAULT is what runs) forwards only LLM, TOOL and FUNCTION categories —
   ``CUSTOM_*`` events are dropped before they reach a socket. So a
   transparency step is a FUNCTION step, and its name is what the frontend
   reads as the function name.
2. A START event pushes a frame onto the run's ``active_span_id_stack`` that
   only the matching END pops. Pushing a lone START would leak a frame and
   corrupt the *next* legitimate close — the exact fault
   ``common.nat_step_repair`` exists to repair. So every step here is pushed
   as a balanced START/END pair with one shared UUID, and the stack is
   restored before the function returns.

**The step NAME is load-bearing.** The frontend dedupes thinking steps on the
parsed function name, so two statuses sharing a name collapse into one step
instead of appearing as two. Each status therefore gets its own ``status:``
slot, and the skills substrate (``skills.events``) names its steps per skill
for the same reason.

**It never fails a turn.** A transparency event is worth strictly less than
the answer it describes. Every push is wrapped and logged at debug: if the
context is missing, the manager is unhappy, or a payload will not serialise,
the turn proceeds in silence exactly as it did before this module existed.
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)

#: Step-name prefix for the status one-liners in this module. The suffix is the
#: SLOT (``status:context``, ``status:routing``, …) — one step per slot, so the
#: frontend's name-based dedupe keeps them apart instead of merging them.
STATUS_STEP_PREFIX = "status:"

#: ``channel`` on the payload. ``live`` may be shown as the single running
#: one-liner; ``technical`` is for the opt-in details panel ONLY. The
#: distinction is the difference between what the reader is told and what an
#: operator can go look up, and the frontend must not blur it: this product
#: already shipped a phantom "web search" line because an availability signal
#: was rendered as activity.
CHANNEL_LIVE = "live"
CHANNEL_TECHNICAL = "technical"

#: Room for the quoted retrieval query inside a status line, after the label
#: and the punctuation around it. Budgeted here rather than in the frontend
#: because the backend is the only side that sees the untruncated query, and a
#: status that overflows its one line is worse than one that says slightly
#: less. (The line as a whole is budgeted by the dictionary copy: every
#: template under ``chat.thinking.turnStatus`` is written to fit one narrow
#: row with this much query in it.)
MAX_QUERY_CHARS = 32

#: Reason strings (routing, escalation) travel in full-ish as a separate field
#: rather than being crammed into the one-liner.
MAX_REASON_CHARS = 160


# --- The keys ---------------------------------------------------------------
#
# Stable dotted ids. The frontend owns the words; these own the meaning. Each
# has a German and an English string under ``chat.thinking.turnStatus.*``, and
# a key with no dictionary entry renders NOTHING — never the key itself.

#: ``status.documents.<shelf>`` — which shelf of the reader's own files is
#: being read. The shelf is in the KEY rather than in ``values`` because German
#: needs the dative ("aus dem Büroarchiv") and English needs no article at all:
#: a shelf name cannot be interpolated into one shared template.
KEY_DOCUMENTS_PREFIX = "status.documents."

#: ``status.documents.waiting`` — a file the reader just uploaded is still
#: being indexed and the turn is holding for it. Value-less: the filename is
#: the reader's own word but the line reads the same whichever file it is.
KEY_DOCUMENTS_WAITING = "status.documents.waiting"

#: Retrieval, with and without a query to quote.
KEY_RETRIEVAL_WITH_QUERY = "status.retrieval.withQuery"
KEY_RETRIEVAL_PLAIN = "status.retrieval.plain"
#: The retrieval loop trying other formulations after judging the first pool
#: insufficient. Value-less on purpose: the alternative queries are the
#: model's words, not the reader's, and the rule above keeps them off the line.
KEY_RETRIEVAL_REQUERY = "status.retrieval.requery"

#: Non-retrieval tools the reader asked for by name.
KEY_ACTION_REMEMBER = "status.action.remember"
KEY_ACTION_CARD = "status.action.card"

KEY_CITATIONS = "status.citations"
#: The turn's one bounded repair: a citation or a quote failed verification,
#: one more retrieval and one rewrite are being tried before the answer ships
#: with its markers. Value-less; the counts travel as detail.
KEY_REPAIR = "status.repair"
KEY_ESCALATION = "status.escalation"

#: EVERY key this module can emit, exhaustively. Two tests hang off it: the
#: Python one asserts nothing is emitted that is not in here, and the UI one
#: (``features/chat/lib/turn-events.spec.ts``) reads this tuple out of this
#: file and asserts each id has a German AND an English string. Drift in either
#: direction is a failing build rather than a reader seeing a blank line.
ALL_STATUS_KEYS: tuple[str, ...] = (
    "status.documents.archiv",
    "status.documents.project",
    "status.documents.session",
    "status.documents.several",
    "status.documents.waiting",
    "status.retrieval.withQuery",
    "status.retrieval.plain",
    "status.retrieval.requery",
    "status.action.remember",
    "status.action.card",
    "status.citations",
    "status.repair",
    "status.escalation",
)


def clip(text: str, limit: int) -> str:
    """``text`` shortened to ``limit`` characters, ellipsis included in the count.

    The one-liners are budgeted, not truncated by the reader: a status that
    overflows its line is worse than one that says slightly less.
    """
    text = " ".join(str(text).split())
    if len(text) <= limit:
        return text
    return text[: max(1, limit - 1)].rstrip() + "…"


def push_custom_step(step_name: str, payload: dict[str, Any]) -> None:
    """Push ONE balanced custom FUNCTION step named ``step_name``.

    ``payload`` is serialised to compact JSON and carried as the step's
    ``data.input``/``data.output``, which is what the step adaptor renders into
    the frame's payload string. JSON rather than prose because every consumer
    then parses one shape, and adding a field later cannot break a reader that
    does not know about it.

    Fail-open by contract — see the module docstring. Never raises.
    """
    try:
        from nat.builder.context import Context
        from nat.data_models.intermediate_step import IntermediateStepPayload
        from nat.data_models.intermediate_step import IntermediateStepType
        from nat.data_models.intermediate_step import StreamEventData

        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        step_id = str(uuid.uuid4())
        manager = Context.get().intermediate_step_manager
        manager.push_intermediate_step(
            IntermediateStepPayload(
                UUID=step_id,
                event_type=IntermediateStepType.FUNCTION_START,
                name=step_name,
                data=StreamEventData(input=body),
            )
        )
        # Same UUID, immediately: closes the span this call opened so the next
        # real END still pops exactly one frame (see the module docstring).
        manager.push_intermediate_step(
            IntermediateStepPayload(
                UUID=step_id,
                event_type=IntermediateStepType.FUNCTION_END,
                name=step_name,
                data=StreamEventData(input=body, output=body),
            )
        )
    except Exception:  # noqa: BLE001 — transparency must never take a turn down
        logger.debug("Transparency step %r not emitted", step_name, exc_info=True)


def emit_status(
    slot: str,
    key: str,
    *,
    values: dict[str, Any] | None = None,
    channel: str = CHANNEL_LIVE,
    **extra: Any,
) -> None:
    """Emit one status event into the run's step stream.

    Args:
        slot: The status slot (``context``, ``routing``, …). Becomes the step
            name, so it is also the frontend's dedupe key.
        key: The stable dotted id the frontend resolves to a sentence. NOT
            copy — see the module docstring.
        values: Interpolation data ONLY, stringified. Empty values are dropped
            so a template placeholder is either filled or the frontend can see
            that it was not.
        channel: :data:`CHANNEL_LIVE` or :data:`CHANNEL_TECHNICAL`.
        extra: Structured detail that is NOT part of the sentence (the intent,
            the depth, the classifier's reason, a source count). ``None``
            values are omitted so an absent detail is absent rather than null.
    """
    clean: dict[str, str] = {}
    for name, value in (values or {}).items():
        if value is None:
            continue
        text = str(value).strip()
        if text:
            clean[name] = text
    payload: dict[str, Any] = {
        "kind": "status",
        "channel": channel,
        "slot": slot,
        "key": key,
        "values": clean,
    }
    payload.update({name: value for name, value in extra.items() if value is not None})
    push_custom_step(f"{STATUS_STEP_PREFIX}{slot}", payload)


# --- What each moment is called ---------------------------------------------
#
# Ids only. No copy lives in this file any more: the German and the English
# sentences sit side by side in the frontend dictionary, which is the only
# place that knows who is reading.

#: Retrieval tools, by basename prefix, in match order. The value is the CORPUS
#: ID — not its display name: "im OIB-Wissen" is product copy and a German
#: preposition, and two corpora are joined by a German "und". The frontend owns
#: both (``chat.thinking.turnStatus.corpus.*``).
#:
#: Deliberately the corpus and not a specific Richtlinie: the retrieval tools
#: take a query and nothing else, so naming "OIB-Richtlinie 2" here would be
#: claiming a narrowing the system did not perform.
_SEARCH_CORPORA: tuple[tuple[str, str], ...] = (
    ("knowledge_search", "knowledge"),
    ("ris_", "ris"),
    ("advanced_web_search", "web"),
    ("web_search", "web"),
    ("surface_documents", "documents"),
    ("ifc_", "ifc"),
)

#: Non-retrieval tools that still deserve a line, because the user asked for
#: the thing they do and can see whether it happened. A tool that is on neither
#: this list nor :data:`_SEARCH_CORPORA` gets NO line: the only thing left to
#: say about it is its internal name, and an identifier dressed up as a status
#: is the noise this whole module exists to remove.
_ACTION_KEYS = {
    "remember": KEY_ACTION_REMEMBER,
    "emit_card": KEY_ACTION_CARD,
}

#: Argument names a retrieval query hides behind, in preference order.
_QUERY_KEYS = ("query", "search_query", "question", "q", "text", "name_contains")

#: Function-group separators used by NAT-qualified tool names (mirrors
#: ``shallow_researcher.agent._TOOL_NAME_SEPARATORS``).
_TOOL_NAME_SEPARATORS = ("__", ".")


def tool_basename(tool_name: str) -> str:
    """The final segment of a (possibly group-qualified) tool name."""
    base = tool_name or ""
    for separator in _TOOL_NAME_SEPARATORS:
        if separator in base:
            base = base.rsplit(separator, 1)[-1]
    return base


def _search_corpus(base: str) -> str | None:
    for prefix, corpus in _SEARCH_CORPORA:
        if base.startswith(prefix):
            return corpus
    return None


def _query_text(args: Any) -> str | None:
    """The retrieval query inside a tool call's arguments, or ``None``.

    Named keys first (a search tool's query is nearly always one of them), then
    the first non-empty string argument — a tool naming its query something
    unexpected should still show what was asked, and a tool with no string
    argument at all correctly shows nothing.
    """
    if not isinstance(args, dict):
        return None
    for key in _QUERY_KEYS:
        value = args.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    for value in args.values():
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


#: Where the reader's own documents live, as SHELF IDS. ``base`` is absent on
#: purpose: the OIB corpus is read on every research turn, so announcing it
#: would be announcing a constant — and it is not "your documents" in any case.
_SHELF_IDS = {
    "archiv": "archiv",
    "project": "project",
    "session": "session",
}

#: More than one shelf collapses into one line rather than listing them: a
#: conjunction of three dative noun phrases is a sentence, not a status.
_SHELF_SEVERAL = "several"


def emit_documents_loading(shelves: list[str] | None = None) -> None:
    """The pre-graph I/O phase — but ONLY when the reader's own files are in it.

    The first hole in the turn, and until now a total one: no frame of any kind
    existed before the intent classifier's LLM call, so the user watched a
    generic label through every one of these round-trips.

    Gated on the turn actually being scoped to a shelf of theirs, which is what
    makes this an event rather than a constant. "Unterlagen werden geladen" on
    every turn is the availability-as-activity mistake this product has already
    paid for once.
    """
    named: list[str] = []
    for shelf in shelves or ():
        shelf_id = _SHELF_IDS.get(str(shelf))
        if shelf_id and shelf_id not in named:
            named.append(shelf_id)
    if not named:
        return
    where = named[0] if len(named) == 1 else _SHELF_SEVERAL
    emit_status(
        "documents",
        f"{KEY_DOCUMENTS_PREFIX}{where}",
        shelves=list(shelves or ()),
    )


def emit_retrieval(tool_calls: list[dict[str, Any]] | None, *, round_index: int) -> None:
    """ONE line for a whole round of tool calls: where it looks, and for what.

    "Sucht im OIB-Wissen: „Fluchtweglänge GK4“" is a different sentence from
    "searching": it names the body of law being read and shows the reader
    whether the question was understood, while there is still time to say no.
    What is emitted here is the ingredients of that sentence — the corpus ids
    and the user's own query — never the sentence.

    Aggregated per round rather than per call because the model emits its calls
    in parallel batches — three separate lines in the same instant would be a
    log stream, not a status. ``round_index`` keeps successive rounds from
    collapsing into one step under the frontend's name dedupe.
    """
    calls = [call for call in (tool_calls or []) if isinstance(call, dict)]
    if not calls:
        return

    corpora: list[str] = []
    tools: list[str] = []
    query: str | None = None
    action_key: str | None = None
    for call in calls:
        base = tool_basename(str(call.get("name") or ""))
        if not base or base == "use_skill":
            # The skills substrate narrates its own activation with the skill's
            # human title; repeating it here as a tool name would say the same
            # thing twice, worse.
            continue
        tools.append(base)
        corpus = _search_corpus(base)
        if corpus is not None:
            if corpus not in corpora:
                corpora.append(corpus)
            query = query or _query_text(call.get("args"))
        elif action_key is None:
            action_key = _ACTION_KEYS.get(base)

    if corpora:
        values: dict[str, Any] = {"corpus": ",".join(corpora)}
        if query:
            values["query"] = clip(query, MAX_QUERY_CHARS)
            key = KEY_RETRIEVAL_WITH_QUERY
        else:
            key = KEY_RETRIEVAL_PLAIN
    elif action_key is not None:
        key = action_key
        values = {}
    else:
        # Nothing left to say but an internal tool name. Say nothing.
        return

    emit_status(f"retrieval:{round_index}", key, values=values, tools=tools)


def emit_documents_waiting(*, file_count: int) -> None:
    """The turn holding for an upload that is still being indexed.

    Rare by construction — most turns have nothing in flight — and the one
    honest account of a turn whose first byte is seconds later than usual:
    the question is about a file that does not exist to search yet, and the
    answer is worth more after it does.
    """
    emit_status("documents:waiting", KEY_DOCUMENTS_WAITING, file_count=file_count)


def emit_retrieval_requery(*, query_count: int) -> None:
    """The search widening itself: the first pool was judged insufficient and
    other formulations are being tried.

    Worth a line because it varies — most searches never reach it — and
    because it is the honest account of a turn that takes a few seconds
    longer than usual. The count travels as detail, not in the sentence.
    """
    emit_status("retrieval:requery", KEY_RETRIEVAL_REQUERY, query_count=query_count)


def emit_citation_check(*, source_count: int | None = None) -> None:
    """The last stretch before the answer, and the blankest one.

    This one is worth a line even though it is near-constant on a research
    turn: it is the product's trust proposition stated out loud — every
    citation in the answer is checked against what was actually retrieved
    before the reader sees it.
    """
    emit_status("citations", KEY_CITATIONS, source_count=source_count)


def emit_answer_repair(*, removed_citations: int, unverified_quotes: int) -> None:
    """The answer's own verification failed and one repair is being tried.

    Worth a line because it varies — most answers verify clean — and because
    it is the honest account of an answer that arrives a few seconds late:
    a citation nothing retrieved supports, or a quote no passage contains,
    is being re-searched and rewritten once rather than shipped marked.
    """
    emit_status(
        "repair",
        KEY_REPAIR,
        removed_citations=removed_citations,
        unverified_quotes=unverified_quotes,
    )


def emit_escalation(reason: str | None = None) -> None:
    """Shallow → deep, announced at the moment the router decides it.

    Deep research is minutes, not seconds. A reader who is told the short
    answer was not good enough is waiting; one who is not is wondering whether
    the turn broke.

    The key is fixed and deliberately NOT built from the internal
    ``escalation_reason`` ("Shallow agent emitted insufficiency marker"), which
    names a marker in a message and tells an architect nothing. The internal
    string still travels as the ``reason`` field for the details panel.
    """
    reason_text = " ".join(str(reason).split()) if reason else ""
    emit_status("escalation", KEY_ESCALATION, reason=clip(reason_text, MAX_REASON_CHARS) or None)


#: Slot for the budget-exhaustion record. Its own slot, so it never overwrites
#: a retrieval line and the frontend's name dedupe keeps it apart.
BUDGET_SLOT = "budget"


def emit_research_truncated(
    *,
    ceiling: int,
    research_budget: int,
    reserved: int,
    spent: int,
    rounds: int,
    shape: list[str] | None = None,
) -> None:
    """Record that evidence-gathering was CUT OFF, not completed.

    Technical channel, and therefore no ``key``: whether the reader should be
    told "this answer stopped early" is a product decision, and shipping a live
    key would make it silently. What this is for is the operator question the
    config comment has been asking in prose for a release — *how often does
    truncation happen, and on which question shapes* — which needs the event to
    exist at all before it can be counted.

    Args:
        ceiling: The tool-call count that triggered forced synthesis.
        research_budget: ``max_tool_iterations`` — the part of the ceiling the
            question itself was allowed to spend.
        reserved: The part granted for forced-skill overhead.
        spent: Tool calls charged when the ceiling was hit (≥ ceiling: a
            parallel batch can cross it by more than one).
        rounds: LLM turns that asked for tools — the pair with ``spent`` that
            distinguishes one greedy batch from a long walk into the wall.
        shape: Ordered tool basenames of the run. Names only; a query string is
            the reader's own words and does not belong in telemetry.
    """
    payload: dict[str, Any] = {
        "kind": "status",
        "channel": CHANNEL_TECHNICAL,
        "slot": BUDGET_SLOT,
        "truncated": True,
        "ceiling": ceiling,
        "research_budget": research_budget,
        "reserved": reserved,
        "spent": spent,
        "rounds": rounds,
    }
    if shape:
        payload["tools"] = list(shape)
    push_custom_step(f"{STATUS_STEP_PREFIX}{BUDGET_SLOT}", payload)


#: Slot for the DEEP researcher's own budget record. Its own slot rather than
#: :data:`BUDGET_SLOT` because a deep run is cut off by different things — a
#: wall clock and a graph step limit, not a tool-call ceiling — and collapsing
#: the two under one step name would make the frontend's name dedupe drop one.
DEEP_BUDGET_SLOT = "budget:deep"

#: Why a deep run stopped early. Stable tokens, not prose: they are counted.
CUTOFF_WALL_CLOCK = "wall_clock"
CUTOFF_STEP_LIMIT = "step_limit"
#: A timeout that came from BELOW — a provider or transport call that timed out
#: and escaped the graph — rather than from this run's own budget. Salvaged the
#: same way, counted separately: reporting a 30-second provider timeout as a
#: 2400-second budget overrun makes "how often do runs exhaust their budget?"
#: unanswerable, and that question is the reason the budget is tunable.
CUTOFF_UPSTREAM_TIMEOUT = "upstream_timeout"

#: Ways a finished deep answer is weaker than a clean one. Also stable tokens.
DEGRADED_NO_REPORT_FILE = "no_report_file"
DEGRADED_NO_VALID_CITATIONS = "no_valid_citations"
#: The report is whole, but the proposals the job derives from it post-hoc
#: (Grid cards) could not be produced. Job path only: the chat path emits its
#: cards mid-turn as a tool step, so it has nothing to derive and nothing to
#: fail silently. Without this token a run whose card model timed out looked
#: exactly like a run whose report warranted no proposals.
DEGRADED_CARDS_GENERATION_FAILED = "cards_generation_failed"


def emit_deep_research_cutoff(
    *,
    reason: str,
    salvaged: bool,
    source_count: int,
    report_chars: int,
    elapsed_seconds: float | None = None,
) -> None:
    """Record that a DEEP run was cut off, and whether anything survived it.

    Technical channel, like :func:`emit_research_truncated`, and for the same
    operator question: *how often does a deep run run out of clock or steps, and
    when it does, do we still ship something?* Before this existed a cutoff was
    an exception in a log and the run's whole output was discarded, so neither
    half of that question could be answered.

    Args:
        reason: :data:`CUTOFF_WALL_CLOCK` or :data:`CUTOFF_STEP_LIMIT`.
        salvaged: Whether a report was recovered from the partial run.
        source_count: Sources the run had captured when it was cut off — the
            number that decides whether salvage was even allowed.
        report_chars: Length of the salvaged report; 0 when nothing survived.
        elapsed_seconds: Wall-clock the run had spent, when known.
    """
    payload: dict[str, Any] = {
        "kind": "status",
        "channel": CHANNEL_TECHNICAL,
        "slot": DEEP_BUDGET_SLOT,
        "truncated": True,
        "agent": "deep",
        "reason": reason,
        "salvaged": salvaged,
        "source_count": source_count,
        "report_chars": report_chars,
    }
    if elapsed_seconds is not None:
        payload["elapsed_seconds"] = round(elapsed_seconds, 1)
    push_custom_step(f"{STATUS_STEP_PREFIX}{DEEP_BUDGET_SLOT}", payload)


def emit_answer_degraded(*, agent: str, reasons: list[str]) -> None:
    """Record that an answer shipped in a known-weaker form than a clean run.

    The two deep-research cases this exists for both used to be a bare
    ``logger.warning`` beside a ``return``: the writer never persisted a report
    (so the answer is a chat message wearing a report's clothes), and citation
    verification found no valid citations at all (so nothing in the answer is
    provably grounded). Both shipped looking exactly like a good answer.

    Args:
        agent: Which researcher degraded (``deep`` / ``shallow``).
        reasons: Stable tokens, e.g. :data:`DEGRADED_NO_REPORT_FILE`.
    """
    if not reasons:
        return
    push_custom_step(
        f"{STATUS_STEP_PREFIX}degraded",
        {
            "kind": "status",
            "channel": CHANNEL_TECHNICAL,
            "slot": "degraded",
            "agent": agent,
            "degraded": True,
            "reasons": list(reasons),
        },
    )
