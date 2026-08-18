"""Telling the user what the turn is actually doing, while it does it.

Everything a Grid turn currently reports about itself is an accident of
observability. NAT's ``StepAdaptor`` watches the LangChain instrumentation and
turns LLM/tool/function spans into ``system_intermediate_message`` frames; the
frontend then guesses an activity label by regex-matching the raw NAT function
name. Nothing in this repo ever *said* anything. The holes that leaves are not
edge cases — they are the longest stretches of the turn: context loading before
the graph starts, the routing decision (known one second in, shipped only on
the terminal frame), and the whole answer phase behind a generic label.

This module is the other direction: the agent states, in German, what it is
doing at the moment it does it.

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

#: A status line is a glance, not a paragraph: it is read while something else
#: is happening and it sits on one line in a narrow panel.
MAX_STATUS_CHARS = 60

#: Room for the quoted retrieval query inside a status line, after the label
#: and the punctuation around it.
MAX_QUERY_CHARS = 32

#: Reason strings (routing, escalation) travel in full-ish as a separate field
#: rather than being crammed into the one-liner.
MAX_REASON_CHARS = 160


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


def emit_status(slot: str, text: str, *, channel: str = CHANNEL_LIVE, **extra: Any) -> None:
    """Emit one German status line into the run's step stream.

    Args:
        slot: The status slot (``context``, ``routing``, …). Becomes the step
            name, so it is also the frontend's dedupe key.
        text: The sentence the user reads, clipped to :data:`MAX_STATUS_CHARS`.
        channel: :data:`CHANNEL_LIVE` or :data:`CHANNEL_TECHNICAL`.
        extra: Structured detail alongside the sentence (a routing decision, a
            corpus, the retrieval query). ``None`` values are omitted so an
            absent detail is absent rather than null.
    """
    payload: dict[str, Any] = {
        "kind": "status",
        "channel": channel,
        "slot": slot,
        "text": clip(text, MAX_STATUS_CHARS),
    }
    payload.update({key: value for key, value in extra.items() if value is not None})
    push_custom_step(f"{STATUS_STEP_PREFIX}{slot}", payload)


# --- The copy ---------------------------------------------------------------
#
# German, formal register, present tense — the same voice as the frontend's
# activity dictionary ("Frage wird erfasst …", "Antwort wird formuliert …"), so
# a backend-authored line and a frontend-authored one read as one product
# rather than two. Kept here rather than at each call site so the tone has one
# home and drifts as a unit or not at all.

STATUS_CITATIONS = "Belege werden geprüft …"

#: Routing: what the classifier decided, said as a decision rather than a label.
_ROUTING_LEAD = {
    "meta": "Gespräch — keine Recherche nötig",
    "out_of_scope": "Frage außerhalb des Fachgebiets",
    "shallow": "Kurzrecherche",
    "deep": "Tiefenrecherche wird vorbereitet",
}

#: Retrieval tools, by basename prefix, in match order. The value is a
#: prepositional phrase naming the CORPUS an architect recognises — "im
#: OIB-Wissen", not "knowledge_search_tool" — and matches the wording the
#: frontend's own activity dictionary already uses for the same corpora.
#:
#: Deliberately the corpus and not a specific Richtlinie: the retrieval tools
#: take a query and nothing else, so naming "OIB-Richtlinie 2" here would be
#: claiming a narrowing the system did not perform.
_SEARCH_PHRASES: tuple[tuple[str, str], ...] = (
    ("knowledge_search", "im OIB-Wissen"),
    ("ris_", "im RIS"),
    ("advanced_web_search", "im Web"),
    ("web_search", "im Web"),
    ("surface_documents", "in Ihren Unterlagen"),
    ("ifc_", "im Gebäudemodell"),
)

#: Non-retrieval tools that still deserve a line, because the user asked for
#: the thing they do and can see whether it happened.
_ACTION_TEXT = {
    "remember": "Notiz wird gespeichert …",
    "emit_card": "Ergebniskarte wird erstellt …",
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


def _search_phrase(base: str) -> str | None:
    for prefix, phrase in _SEARCH_PHRASES:
        if base.startswith(prefix):
            return phrase
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


def emit_documents_loading(*, shelves: list[str] | None = None, count: int | None = None) -> None:
    """The pre-graph I/O phase — but ONLY when the reader's own files are in it.

    The first hole in the turn, and until now a total one: no frame of any kind
    existed before the intent classifier's LLM call, so the user watched a
    generic label through every one of these round-trips.

    Gated on there actually being a document scope, which is what makes this an
    event rather than a constant. "Unterlagen werden geladen" on a turn that
    loads no documents is the availability-as-activity mistake this product has
    already paid for once.
    """
    named = [shelf for shelf in (shelves or []) if shelf]
    if not named:
        return
    where = named[0] if len(named) == 1 else "Ihren Ablagen"
    emit_status("documents", f"Unterlagen aus {where} werden gesichtet …", shelves=named, count=count)


def emit_routing(*, intent: str, depth: str | None, reason: str | None) -> None:
    """The routing decision, the moment it is parsed.

    Known roughly a second into the turn and, before this, shipped only on the
    TERMINAL frame — i.e. announced after the answer it explains. The reason is
    the model's own words for why, which is the part a reader can disagree with.
    """
    key = intent if intent in ("meta", "out_of_scope") else (depth or "shallow")
    lead = _ROUTING_LEAD.get(key, _ROUTING_LEAD["shallow"])
    reason_text = " ".join(str(reason).split()) if reason else ""
    text = f"{lead}: {reason_text}" if reason_text else lead
    emit_status(
        "routing",
        text,
        intent=intent,
        depth=depth,
        reason=clip(reason_text, MAX_REASON_CHARS) or None,
    )


def emit_retrieval(tool_calls: list[dict[str, Any]] | None, *, round_index: int) -> None:
    """ONE line for a whole round of tool calls: where it looks, and for what.

    "Sucht im OIB-Wissen: „Fluchtweglänge GK4“" is a different sentence from
    "searching": it names the body of law being read and shows the reader
    whether the question was understood, while there is still time to say no.

    Aggregated per round rather than per call because the model emits its calls
    in parallel batches — three separate lines in the same instant would be a
    log stream, not a status. ``round_index`` keeps successive rounds from
    collapsing into one step under the frontend's name dedupe.
    """
    calls = [call for call in (tool_calls or []) if isinstance(call, dict)]
    if not calls:
        return

    phrases: list[str] = []
    tools: list[str] = []
    query: str | None = None
    action: str | None = None
    for call in calls:
        base = tool_basename(str(call.get("name") or ""))
        if not base or base == "use_skill":
            # The skills substrate narrates its own activation with the skill's
            # human title; repeating it here as a tool name would say the same
            # thing twice, worse.
            continue
        tools.append(base)
        phrase = _search_phrase(base)
        if phrase is not None:
            if phrase not in phrases:
                phrases.append(phrase)
            query = query or _query_text(call.get("args"))
        elif action is None:
            action = _ACTION_TEXT.get(base)

    if not tools:
        return
    if phrases:
        where = " und ".join(phrases)
        text = f"Sucht {where}: „{clip(query, MAX_QUERY_CHARS)}“" if query else f"Sucht {where} …"
    elif action is not None:
        text = action
    else:
        text = f"Werkzeug „{tools[0]}“ wird ausgeführt …"

    emit_status(f"retrieval:{round_index}", text, tools=tools, query=query)


def emit_citation_check(*, source_count: int | None = None) -> None:
    """The last stretch before the answer, and the blankest one.

    This one is worth a line even though it is near-constant on a research
    turn: it is the product's trust proposition stated out loud — every
    citation in the answer is checked against what was actually retrieved
    before the reader sees it.
    """
    emit_status("citations", STATUS_CITATIONS, source_count=source_count)


def emit_escalation(reason: str | None = None) -> None:
    """Shallow → deep, announced at the moment the router decides it.

    Deep research is minutes, not seconds. A reader who is told why the turn
    just got long is waiting; one who is not is wondering whether it broke.
    """
    reason_text = " ".join(str(reason).split()) if reason else ""
    lead = "Eskalation zur Tiefenrecherche"
    text = f"{lead}: {reason_text}" if reason_text else f"{lead} …"
    emit_status("escalation", text, reason=clip(reason_text, MAX_REASON_CHARS) or None)
