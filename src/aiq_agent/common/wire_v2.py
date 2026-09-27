"""The chat wire, version 2: every frame the chat socket carries, as types (ADR-0068).

The design of record is ``docs/design/chat-wire-v2.md``. This module is the
contract that design names, and nothing else: no I/O, no NAT import, no
LangChain import, so the producers in ``aiq_agent`` (and ``sources/``) and the
socket handler in ``aiq_api`` all import it without a cycle.

Three layers
------------

**Bodies** (``*Body``) are what a producer says: a step, a delta, a card, the
turn's result. A body has a ``type`` and nothing that belongs to the
connection. The per-turn emitter (``common/turn_emitter.py``) queues bodies.

**Events** are what the socket sends: a body plus the envelope (``v``,
``conversation_id``, ``turn_id``, ``seq``, ``ts``). Only the handler makes
events, with :func:`stamp`, because only it owns the turn's sequence counter:
the heartbeat and the stage frames are its own, and they share the counter
with everything the workflow yields.

**Client messages** are what the browser sends: ``user_message``,
``interaction_response``, ``cancel_turn`` and ``attach``.

Rules the models carry
----------------------

* Names are AG-UI's where AG-UI has one (``RUN_STARTED``, ``TEXT_MESSAGE_*``,
  ``STATE_SNAPSHOT``, ``STEP_*``, ``RUN_FINISHED``, ``RUN_ERROR``, ``CUSTOM``);
  the ``CUSTOM`` events are told apart by ``name``.
* ``seq`` is per turn, starts at 1 with ``RUN_STARTED`` and increases by one
  per event, stage frames after ``RUN_FINISHED`` included. ``seq == 0`` marks an
  out-of-band ``rejected`` notice, which is never replayed.
* A frame omits every field at its default and is never ``null`` where a value
  is absent; the discriminators are always present (:class:`_Model`). The
  reader's schema restores the defaults. Where absence would be ambiguous there
  is a separate event instead of a null (``card_refused``, ``answer_retracted``).
* Nothing raw rides a step. A step is typed data a reader is shown; a tool's
  input or output never reaches the wire (the Trace-Lanes of a knowledge search
  travel as a ``sources`` step, built from the records, not scraped from the
  tool's text).

The TypeScript mirror is ``frontends/ui/src/adapters/api/wire-v2.ts``. Both are
held to ``shared/wire/v2.schema.json`` (generated from this module by
``scripts/generate_wire_schema.py``) and to the recorded turns under
``shared/wire/v2/``: ``tests/aiq_agent/common/test_wire_v2.py`` and
``wire-v2.spec.ts`` validate every fixture, each on its own side.
"""

from __future__ import annotations

import hashlib
import json
from typing import Annotated
from typing import Any
from typing import Literal
from typing import get_args
from typing import get_origin

from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field
from pydantic import SerializationInfo
from pydantic import SerializerFunctionWrapHandler
from pydantic import TypeAdapter
from pydantic import model_serializer

#: The only wire version. There is no ``v: 1`` reader anywhere (ADR-0068).
WIRE_VERSION: Literal[2] = 2

#: Close code for a socket that asked for another wire version (``?v=`` on the
#: upgrade). The client maps it to "Piloti was updated, reload".
CLOSE_CLIENT_OUTDATED = 4426

Scalar = str | int | float | bool


def _is_const(annotation: Any) -> bool:
    return get_origin(annotation) is Literal and len(get_args(annotation)) == 1


class _Model(BaseModel):
    """Closed models: a field the contract does not name is a producer bug.

    A frame omits every field at its default (:func:`to_frame` dumps with
    ``exclude_defaults``) except the ``const`` ones, which are the discriminators
    (``v``, ``type``, ``name``, ``kind``) and must always be on the wire. The
    reader's schema restores the defaults, so the frame stays minimal and still
    parses to the same value.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    @model_serializer(mode="wrap")
    def _keep_consts(self, handler: SerializerFunctionWrapHandler, info: SerializationInfo) -> dict[str, Any]:
        data = handler(self)
        if info.exclude_defaults:
            consts = {
                name: getattr(self, name) for name, f in type(self).model_fields.items() if _is_const(f.annotation)
            }
            data = {**consts, **data}
        return data


class _OpenModel(BaseModel):
    """A payload whose full contract lives elsewhere (cards, sources, ledger).

    The wire names the fields it routes on and passes the rest through; the
    owning contract validates the whole (``gridCardSchema``, the citation wire,
    ``sanitizeAnswerMeta``).
    """

    model_config = ConfigDict(extra="allow", frozen=True)


# ---------------------------------------------------------------------------
# Payload value types
# ---------------------------------------------------------------------------

SourceKindKey = Literal["baurecht", "buero", "projekt", "web"]
Channel = Literal["live", "technical"]
Scope = Literal["chat", "deep"]


class TraceLaneSource(_Model):
    """One document in a lane: identity, the locus that round reached, its shelf."""

    name: str = Field(min_length=1, description="Raw file name: the document identity.")
    title: str | None = Field(default=None, description="Display title, omitted when it would repeat `name`.")
    detail: str | None = Field(default=None, description="Locus, e.g. 'Pkt. 3.5.2 p.12'.")
    shelf: str | None = None
    round: int | None = Field(default=None, ge=0, description="The retrieval round that fetched it.")
    provenance: dict[str, str] | None = Field(default=None, description="Agent authorship keys (ADR-0061).")


class TraceLane(_Model):
    """One lane of a search's fan-out: the fine lane and the coarse kind it renders as."""

    key: str = Field(min_length=1)
    label: str
    kind: SourceKindKey
    hit_count: int = Field(ge=0)
    sources: list[TraceLaneSource]


class WireSource(_OpenModel):
    """A cited source (``source_entry_to_wire``). ``number`` is its ``[N]`` in the prose."""

    content: str
    number: int | None = Field(default=None, ge=1)
    file_name: str | None = None
    page: int | None = None


class KeyedCard(_Model):
    """A card and its identity key, so a card equal to one already drawn keeps its node."""

    key: str = Field(min_length=1, description="card_key(card): stable across the live event and the terminal.")
    card: dict[str, Any] = Field(description="A GridCard (cards/models.py); validated by gridCardSchema on render.")


def card_key(card: dict[str, Any]) -> str:
    """The identity of a card: a hash of its canonical JSON.

    The live ``card`` event and the terminal carry the same key for the same
    card, so the client reconciles by key instead of comparing card trees.
    """
    canonical = json.dumps(card, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Herleitung steps: compact, typed, one discriminated union on ``kind``
# ---------------------------------------------------------------------------


class _StepBase(_Model):
    #: Stable within the turn and chosen by the producer (``status:retrieval:2``,
    #: ``tool:call_abc``). The same id again REPLACES the row: newest wins.
    id: str = Field(min_length=1, max_length=200)
    #: Which agent took the step. ``deep`` for in-process deep research.
    scope: Scope = "chat"


class StatusStep(_StepBase):
    """A status line or a technical record (``turn_status.emit_status`` and its siblings)."""

    kind: Literal["status"] = "status"
    slot: str = Field(min_length=1, description="e.g. 'synthesis', 'budget', 'decision:rerank'.")
    key: str | None = Field(default=None, description="i18n id (ALL_STATUS_KEYS); absent on technical records.")
    values: dict[str, str] = Field(default_factory=dict, description="Interpolation values ONLY.")
    channel: Channel = "live"
    detail: dict[str, Scalar | list[str]] = Field(
        default_factory=dict, description="Structured detail that is not part of the sentence (counts, reasons)."
    )


class RetrievalStep(_StepBase):
    """One announced retrieval round: where it looks, for what, and the model's own conclusion."""

    kind: Literal["retrieval"] = "retrieval"
    round: int = Field(ge=0)
    key: str
    values: dict[str, str] = Field(default_factory=dict)
    tools: list[str] = Field(default_factory=list, description="Tool basenames this round called.")
    reason: str | None = Field(default=None, max_length=160, description="The model's conclusion, verbatim.")


class SourcesStep(_StepBase):
    """What one evidence tool returned, as lanes. Built from the grounding records, never from text."""

    kind: Literal["sources"] = "sources"
    round: int | None = Field(default=None, ge=0)
    tool: str = Field(min_length=1)
    lanes: list[TraceLane]


class ToolStep(_StepBase):
    """A tool call ran: its basename and outcome. Never its arguments or its result."""

    kind: Literal["tool"] = "tool"
    tool: str = Field(min_length=1)
    status: Literal["running", "ok", "error"] = "running"


class SkillStep(_StepBase):
    """A skill was offered (count only), activated or loaded (``skills/events.py``)."""

    kind: Literal["skill"] = "skill"
    phase: Literal["offered", "activated", "loaded"]
    skill: str | None = Field(default=None, description="Absent on the per-turn `offered` record.")
    title: str | None = None
    hidden: bool = False
    count: int | None = Field(default=None, ge=0, description="`offered`: how many skills the catalog held.")
    channel: Channel = "live"


class ClarificationStep(_StepBase):
    """The clarify step started: the one row it contributes before its first question."""

    kind: Literal["clarification"] = "clarification"
    max_turns: int = Field(ge=1)


Step = Annotated[
    StatusStep | RetrievalStep | SourcesStep | ToolStep | SkillStep | ClarificationStep,
    Field(discriminator="kind"),
]


# ---------------------------------------------------------------------------
# The answer's live state and the turn's result
# ---------------------------------------------------------------------------


class AnswerSnapshot(_Model):
    """The streamed prose settled (ADR-0066): it REPLACES text, citations and masthead; cards are untouched."""

    text: str
    sources: list[WireSource] = Field(default_factory=list)
    answer_meta: dict[str, Any] | None = Field(default=None, description="Absent: the re-gate dropped the masthead.")


class CitationsRemoved(_Model):
    count: int = Field(ge=1)
    reasons: list[str]


class RunHandoff(_Model):
    """The run a turn commissioned (ADR-0062) and the message it narrates itself in: both or neither."""

    run_id: str = Field(min_length=1)
    run_message_id: str = Field(min_length=1)


class TurnResult(_Model):
    """Everything the finished turn delivers; authoritative, and what the server persists.

    It replaces the text once more and takes back what it omits (a card
    suppressed, a masthead gated out). The persisted row is built from this
    model and nothing else (``aiq_api`` ``persist_turn_result``).
    """

    message_id: str = Field(min_length=1, description="deterministic_assistant_message_id(conversation, turn).")
    text: str
    cards: list[KeyedCard] = Field(default_factory=list)
    sources: list[WireSource] = Field(default_factory=list)
    read_sources: list[dict[str, Any]] = Field(default_factory=list)
    answer_meta: dict[str, Any] | None = None
    answer_confidence: Literal["low", "medium", "high"] | None = None
    answer_confidence_reason: str | None = Field(default=None, max_length=300)
    answer_confidence_capped_reason: (
        Literal["ungrounded", "quote_unverified", "normative_claim_uncited", "measurement_only", "citation_fallback"]
        | None
    ) = None
    routing_decision: Literal["meta", "shallow", "deep", "error"] | None = None
    escalation_reason: str | None = None
    citations_removed: CitationsRemoved | None = None
    research_truncated: bool = False
    job_admission_rejected: bool = False
    retry_after_seconds: int | None = Field(default=None, ge=0)
    skills_activated: list[str] = Field(default_factory=list)
    skills_hidden: list[str] = Field(default_factory=list)
    retrieval_ledger: list[dict[str, Any]] = Field(default_factory=list)
    #: ADR-0062: the run this turn commissioned instead of answering itself.
    run: RunHandoff | None = None


# ---------------------------------------------------------------------------
# Bodies (what producers say) and events (what the socket sends)
# ---------------------------------------------------------------------------


class Envelope(_Model):
    v: Literal[2] = WIRE_VERSION
    conversation_id: str = Field(min_length=1)
    #: The id of the user message this turn answers (the client's `message_id`).
    turn_id: str = Field(min_length=1)
    seq: int = Field(ge=0)
    #: Server clock, epoch milliseconds.
    ts: int = Field(ge=0)


class RunStartedBody(_Model):
    """The turn was admitted. Sent by the handler before any setup I/O: the client's delivery ack."""

    type: Literal["RUN_STARTED"] = "RUN_STARTED"
    message_id: str = Field(min_length=1, description="The answer's id; the bubble is keyed by it from now on.")


class TextMessageStartBody(_Model):
    """The first prose of a streamed answering call is about to arrive."""

    type: Literal["TEXT_MESSAGE_START"] = "TEXT_MESSAGE_START"
    message_id: str = Field(min_length=1)


class TextMessageContentBody(_Model):
    """Prose, appended. Coalesced by the emitter to at most one per RELAY_WINDOW_S."""

    type: Literal["TEXT_MESSAGE_CONTENT"] = "TEXT_MESSAGE_CONTENT"
    message_id: str = Field(min_length=1)
    delta: str = Field(min_length=1)


class TextMessageEndBody(_Model):
    """The envelope's `answer` string closed. A settled snapshot may follow; the terminal will."""

    type: Literal["TEXT_MESSAGE_END"] = "TEXT_MESSAGE_END"
    message_id: str = Field(min_length=1)


class StateSnapshotBody(_Model):
    """ADR-0066's settle: the verified, renumbered prose and its sources replace what streamed."""

    type: Literal["STATE_SNAPSHOT"] = "STATE_SNAPSHOT"
    snapshot: AnswerSnapshot


class StepStartedBody(_Model):
    """A step with a duration began (a tool call). Instant steps send only STEP_FINISHED."""

    type: Literal["STEP_STARTED"] = "STEP_STARTED"
    step: Step


class StepFinishedBody(_Model):
    """A step, whole. For a started step it carries the same id and its final state."""

    type: Literal["STEP_FINISHED"] = "STEP_FINISHED"
    step: Step


class RunFinishedBody(_Model):
    """The turn ended with an answer, a refusal, a hand-off to a run, or the asker's Stop."""

    type: Literal["RUN_FINISHED"] = "RUN_FINISHED"
    outcome: Literal["answered", "refused", "handed_off", "cancelled"]
    result: TurnResult


class RunErrorBody(_Model):
    """The turn failed. Nothing is persisted; the client asks the server for a finished answer first."""

    type: Literal["RUN_ERROR"] = "RUN_ERROR"
    code: Literal["workflow_error", "auth_error", "interaction_expired"]
    message: str
    details: str | None = None


# --- CUSTOM (AG-UI's extension point), one model per `name` -----------------


class MastheadValue(_Model):
    answer_meta: dict[str, Any]


class CardValue(_Model):
    index: int = Field(ge=0, description="Position in the terminal's order: `[[card:N]]` is index N-1.")
    key: str = Field(min_length=1)
    card: dict[str, Any]


class CardRefusedValue(_Model):
    index: int = Field(ge=0)


class EmptyValue(_Model):
    pass


class HeartbeatValue(_Model):
    every_ms: int = Field(gt=0)


class StageValue(_Model):
    """A post-answer stage's outcome (``docs/architecture/post-answer-stages.md`` §4)."""

    stage: Literal["follow_ups", "memory_reflection"]
    status: Literal["ready", "empty", "failed"]
    payload: dict[str, Any] | None = Field(default=None, description="Only on `ready`.")


class InteractionOption(_Model):
    id: str = Field(min_length=1)
    label: str = Field(min_length=1)


class InteractionRequestValue(_Model):
    """The turn is waiting for its asker (``prompt_user_input``): a question, maybe with choices."""

    interaction_id: str = Field(min_length=1)
    input: Literal["text", "choice"]
    text: str
    options: list[InteractionOption] = Field(default_factory=list)
    placeholder: str | None = None
    expires_at: int = Field(ge=0, description="Epoch ms; after it the turn ends with RUN_ERROR interaction_expired.")


class InteractionResolvedValue(_Model):
    interaction_id: str = Field(min_length=1)
    outcome: Literal["answered", "expired", "cancelled"]


class RejectedValue(_Model):
    """A client message was refused. Out of band: ``seq == 0``, never replayed, never ends a turn."""

    of: Literal["user_message", "interaction_response", "cancel_turn", "attach"]
    code: Literal[
        "auth_expired",
        "conversation_mismatch",
        "duplicate_turn",
        "not_asker",
        "no_pending_interaction",
        "turn_not_found",
        "invalid_message",
    ]
    message: str | None = None


class _CustomBody(_Model):
    type: Literal["CUSTOM"] = "CUSTOM"


class MastheadBody(_CustomBody):
    """The masthead above the prose, gated, before the first word. Text unchanged."""

    name: Literal["masthead"] = "masthead"
    value: MastheadValue


class CardBody(_CustomBody):
    """One card, the moment its JSON closed. May arrive before its `[[card:N]]` marker."""

    name: Literal["card"] = "card"
    value: CardValue


class CardRefusedBody(_CustomBody):
    """The validator refused the card at this index; its place stays empty."""

    name: Literal["card_refused"] = "card_refused"
    value: CardRefusedValue


class AnswerRetractedBody(_CustomBody):
    """The streamed call was a tool round: clear its text, citations, masthead and cards."""

    name: Literal["answer_retracted"] = "answer_retracted"
    value: EmptyValue


class HeartbeatBody(_CustomBody):
    name: Literal["heartbeat"] = "heartbeat"
    value: HeartbeatValue


class StageBody(_CustomBody):
    name: Literal["stage"] = "stage"
    value: StageValue


class InteractionRequestBody(_CustomBody):
    name: Literal["interaction_request"] = "interaction_request"
    value: InteractionRequestValue


class InteractionResolvedBody(_CustomBody):
    name: Literal["interaction_resolved"] = "interaction_resolved"
    value: InteractionResolvedValue


class RejectedBody(_CustomBody):
    name: Literal["rejected"] = "rejected"
    value: RejectedValue


# The events: the envelope plus the body. `stamp` is the only constructor the
# handler uses; tests and fixtures validate through `WIRE_EVENT`.


class RunStarted(Envelope, RunStartedBody):
    pass


class TextMessageStart(Envelope, TextMessageStartBody):
    pass


class TextMessageContent(Envelope, TextMessageContentBody):
    pass


class TextMessageEnd(Envelope, TextMessageEndBody):
    pass


class StateSnapshot(Envelope, StateSnapshotBody):
    pass


class StepStarted(Envelope, StepStartedBody):
    pass


class StepFinished(Envelope, StepFinishedBody):
    pass


class RunFinished(Envelope, RunFinishedBody):
    pass


class RunError(Envelope, RunErrorBody):
    pass


class Masthead(Envelope, MastheadBody):
    pass


class Card(Envelope, CardBody):
    pass


class CardRefused(Envelope, CardRefusedBody):
    pass


class AnswerRetracted(Envelope, AnswerRetractedBody):
    pass


class Heartbeat(Envelope, HeartbeatBody):
    pass


class Stage(Envelope, StageBody):
    pass


class InteractionRequest(Envelope, InteractionRequestBody):
    pass


class InteractionResolved(Envelope, InteractionResolvedBody):
    pass


class Rejected(Envelope, RejectedBody):
    pass


CustomEvent = Annotated[
    Masthead
    | Card
    | CardRefused
    | AnswerRetracted
    | Heartbeat
    | Stage
    | InteractionRequest
    | InteractionResolved
    | Rejected,
    Field(discriminator="name"),
]

WireEvent = Annotated[
    RunStarted
    | TextMessageStart
    | TextMessageContent
    | TextMessageEnd
    | StateSnapshot
    | StepStarted
    | StepFinished
    | RunFinished
    | RunError
    | CustomEvent,
    Field(discriminator="type"),
]

EventBody = (
    RunStartedBody
    | TextMessageStartBody
    | TextMessageContentBody
    | TextMessageEndBody
    | StateSnapshotBody
    | StepStartedBody
    | StepFinishedBody
    | RunFinishedBody
    | RunErrorBody
    | MastheadBody
    | CardBody
    | CardRefusedBody
    | AnswerRetractedBody
    | HeartbeatBody
    | StageBody
    | InteractionRequestBody
    | InteractionResolvedBody
    | RejectedBody
)

_EVENT_OF_BODY: dict[type[BaseModel], type[Envelope]] = {
    RunStartedBody: RunStarted,
    TextMessageStartBody: TextMessageStart,
    TextMessageContentBody: TextMessageContent,
    TextMessageEndBody: TextMessageEnd,
    StateSnapshotBody: StateSnapshot,
    StepStartedBody: StepStarted,
    StepFinishedBody: StepFinished,
    RunFinishedBody: RunFinished,
    RunErrorBody: RunError,
    MastheadBody: Masthead,
    CardBody: Card,
    CardRefusedBody: CardRefused,
    AnswerRetractedBody: AnswerRetracted,
    HeartbeatBody: Heartbeat,
    StageBody: Stage,
    InteractionRequestBody: InteractionRequest,
    InteractionResolvedBody: InteractionResolved,
    RejectedBody: Rejected,
}


def stamp(body: EventBody, *, conversation_id: str, turn_id: str, seq: int, ts: int) -> Envelope:
    """The event the socket sends for ``body``: the body under this turn's envelope."""
    event_type = _EVENT_OF_BODY[type(body)]
    return event_type(
        conversation_id=conversation_id,
        turn_id=turn_id,
        seq=seq,
        ts=ts,
        **{name: getattr(body, name) for name in type(body).model_fields},
    )


def to_frame(event: Envelope) -> dict[str, Any]:
    """The JSON object the socket writes: defaults omitted (never null), discriminators always present."""
    return event.model_dump(mode="json", exclude_defaults=True)


# ---------------------------------------------------------------------------
# Client -> server
# ---------------------------------------------------------------------------


class _ClientBase(_Model):
    v: Literal[2] = WIRE_VERSION
    conversation_id: str = Field(min_length=1)


class UserMessage(_ClientBase):
    """A question (or, with ``context_only``, a colleague's line the agent must see but not answer).

    ``type`` stays ``user_message``: the gateway's per-socket turn limiter
    (``frontends/ui/src/lib/limits/ws-frames.js``) counts turns by it.
    """

    type: Literal["user_message"] = "user_message"
    message_id: str = Field(min_length=1, max_length=128, description="Becomes the turn_id.")
    text: str = Field(min_length=1)
    data_sources: list[str] = Field(default_factory=list)
    context_only: Literal[True] | None = None
    author_name: str | None = None
    focus_file_name: str | None = None
    focus_shelf: Literal["session", "project", "archiv"] | None = None
    source_preset: Literal["law", "project", "office"] | None = None
    focus_document_id: str | None = None
    focus_version_id: str | None = None
    focus_version_state: Literal["draft", "in_review", "changes_requested"] | None = None


class InteractionResponse(_ClientBase):
    """The asker's answer to an ``interaction_request``: typed text or a chosen option, never both."""

    type: Literal["interaction_response"] = "interaction_response"
    turn_id: str = Field(min_length=1)
    interaction_id: str = Field(min_length=1)
    answer: TextAnswer | OptionAnswer


class TextAnswer(_Model):
    """A typed answer. "skip" is only ever typed."""

    text: str = Field(min_length=1)


class OptionAnswer(_Model):
    """A chosen option, by the id the ``interaction_request`` gave it."""

    option_id: str = Field(min_length=1)


class CancelTurn(_ClientBase):
    """Stop. Authorised: only the asker (or an internal caller) may cancel a turn."""

    type: Literal["cancel_turn"] = "cancel_turn"
    turn_id: str = Field(min_length=1)


class Attach(_ClientBase):
    """After a reconnect or a reload: replay this turn from ``after_seq`` + 1, then continue live."""

    type: Literal["attach"] = "attach"
    turn_id: str = Field(min_length=1)
    after_seq: int = Field(ge=0)


ClientMessage = Annotated[
    UserMessage | InteractionResponse | CancelTurn | Attach,
    Field(discriminator="type"),
]

WIRE_EVENT: TypeAdapter[Any] = TypeAdapter(WireEvent)
CLIENT_MESSAGE: TypeAdapter[Any] = TypeAdapter(ClientMessage)


def _consts_required(node: Any) -> None:
    """Mark every ``const`` property required, in place.

    A literal with a default (``type``, ``kind``, ``name``, ``v``) is optional to
    pydantic's validator but always present on the wire, since nothing drops it
    when dumping. The schema must say so: zod's ``discriminatedUnion`` reads the
    discriminator off a required literal, and refuses a defaulted one.
    """
    if isinstance(node, list):
        for entry in node:
            _consts_required(entry)
        return
    if not isinstance(node, dict):
        return
    properties = node.get("properties")
    if isinstance(properties, dict):
        consts = [name for name, prop in properties.items() if isinstance(prop, dict) and "const" in prop]
        required = list(node.get("required", []))
        node["required"] = required + [name for name in consts if name not in required]
    for value in node.values():
        _consts_required(value)


def wire_json_schema() -> dict[str, Any]:
    """The JSON Schema ``shared/wire/v2.schema.json`` holds: both unions, by name."""
    events = WIRE_EVENT.json_schema(ref_template="#/$defs/{model}")
    clients = CLIENT_MESSAGE.json_schema(ref_template="#/$defs/{model}")
    defs = {**events.pop("$defs", {}), **clients.pop("$defs", {})}
    defs["WireEvent"] = events
    defs["ClientMessage"] = clients
    _consts_required(defs)
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Piloti chat wire v2",
        "description": (
            "Generated from src/aiq_agent/common/wire_v2.py by scripts/generate_wire_schema.py. "
            "Do not edit by hand; tests/aiq_agent/common/test_wire_v2.py fails when it is stale."
        ),
        "$defs": dict(sorted(defs.items())),
    }
