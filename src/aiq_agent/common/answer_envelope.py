"""The structured answer envelope (``answer_json``): the answer IS a document.

A research answer is generated as ONE JSON object in a fenced ``answer_json``
block — the schema is taught in the system prompt and RENDERED FROM the models
in this module (:func:`render_envelope_schema`), so the contract the model sees
and the validator that enforces it cannot drift. The object's required
``answer`` field carries the markdown prose (citations, the sources section and
the trailing control markers included, so the whole verification pipeline keeps
operating on one string); the other fields are the answer's own RHETORICAL
anatomy, every one optional: the headline verdict, the takeaways, the single
callout.

They used to be ordinary card types the model emitted through ``emit_card``,
which was wrong twice over — emission was optional twice (the model had to
recognise the trigger AND spend a tool call), and the domain model was muddy: a
verdict is not an exhibit attached BESIDE the answer the way a stair diagram
is, it is the answer's own headline. So they are NATIVE answer fields,
structured from generation onwards: parsed and validated here, gated
deterministically, and carried on the answer itself — ``answer_meta`` beside
``answer_confidence`` on the wire — where the frontend renders them in a FIXED
layout (verdict above the prose, callout and takeaways after it). The model
decides content, never placement. The retired card TYPES stay valid union
members only so stored threads keep rendering.

**Extension contract.** The envelope is versioned (:data:`ENVELOPE_VERSION`,
stamped as ``v`` on the wire payload) and the anatomy is a REGISTRY
(:data:`ANATOMY_FIELDS`): one entry per field, carrying its model and its
deterministic gate. Adding a field is one registry entry, one earned-when line
in the prompt section, and one layout slot in the frontend — nothing else
changes, and the schema the model sees updates itself. Unknown fields in a
model's output are ignored (never fatal), and the frontend sanitizer keeps a
newer payload's version stamp and every field it knows, so a rollback renders
what it can instead of blanking the row.

**Home.** ``common/`` rather than the shallow agent, deliberately: the deep
writer's report is the obvious next adopter of the same contract (the job
runner already parses a trailing ``[CONFIDENCE:…]`` line out of
``/shared/output.md``; the envelope generalises that), and a contract two
agents share must not live in one agent's package.

Fail-open in every direction, and the asymmetry is deliberate: a malformed
envelope may cost the ENRICHMENT, never the ANSWER. Parsing is safe to attempt
at all because the chat pipeline is fully buffered — nothing streams to the
reader before this module has run (docs/design/streaming-chat-answer.md).

The gates are the point, not an accident (see ``docs/architecture/cards.md``):

- a verdict must be a short VALUE the reader can copy — a number, a class,
  „Nicht geregelt" — so anything longer than :data:`VERDICT_VALUE_MAX_CHARS`
  is a heading claiming too much, and is dropped;
- a takeaway block is earned by an answer long enough to need one
  (:data:`TAKEAWAYS_MIN_PROSE_CHARS`, mirroring the frontend's lede threshold)
  and holds two to five items, never more;
- at most ONE callout, by schema shape.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from types import UnionType
from typing import Literal
from typing import Union
from typing import get_args
from typing import get_origin

from pydantic import BaseModel
from pydantic import Field
from pydantic import ValidationError

logger = logging.getLogger(__name__)

#: Contract version, stamped as ``v`` on every wire payload. Bump ONLY on a
#: breaking change to an existing field's meaning or shape — adding an optional
#: field is not one (readers ignore what they do not know).
ENVELOPE_VERSION = 1

#: The fence language of the envelope block, shared with the prompt.
ENVELOPE_FENCE = "answer_json"

# The fenced envelope — the LAST such block is the signal. The fence is
# required by the contract (a bare object could be any of the JSON a research
# answer legitimately quotes), but extraction also accepts a reply that IS one
# bare JSON object with an "answer" key, because that is the most common way a
# model drops the fence and the answer inside it must not be lost to a
# formatting slip.
_ANSWER_JSON_FENCE_RE = re.compile(rf"```{ENVELOPE_FENCE}[ \t]*\n(.*?)\n?```", re.DOTALL)

#: A verdict is a VALUE — a number, a class, a short ruling. Anything longer is
#: a sentence pressed into a header. 60 chars fits „Nicht geregelt (Wiener
#: BauO)" with room and refuses a paragraph.
VERDICT_VALUE_MAX_CHARS = 60

#: A summary is the whole answer in ONE to TWO sentences — the standfirst the
#: reader gets before the prose. Unlike the verdict it is expected on
#: basically every research reply (a ruling is earned, a summary is owed).
#: Above this it is a paragraph wearing a summary's name, and it is dropped
#: whole — the prose's own lede then does the job, so nothing is lost.
SUMMARY_MAX_CHARS = 320

#: The callout's PLACEMENT marker. The one anatomy field whose right place the
#: model knows better than a fixed layout does: a Landesabweichung belongs
#: beside the paragraph it qualifies, not three screens under it. The model
#: writes this token alone on a line of the `answer` prose and the frontend
#: draws the callout there (same grammar as the `[[card:N]]` markers, same
#: own-line contract); without a marker the callout keeps its fixed after-prose
#: slot. Verdict and takeaways stay fixed — a masthead that moves is not a
#: masthead.
CALLOUT_MARKER = "[[callout]]"

#: A marker alone on its line (up to 3 spaces of indent, as the frontend's
#: line-based reading allows) — the only form the frontend will place.
_CALLOUT_LINE_RE = re.compile(r"^ {0,3}\[\[callout\]\][ \t]*$")
_CALLOUT_INLINE_RE = re.compile(r"\[\[callout\]\]")

#: A takeaway block is earned by length: below this the prose IS the takeaway.
#: Mirrors the frontend's lede threshold (LEDE_MIN_CHARS in AgentResponse.tsx)
#: so "long enough for a lede" and "long enough for takeaways" stay one
#: judgement.
TAKEAWAYS_MIN_PROSE_CHARS = 600

TAKEAWAYS_MAX_ITEMS = 5


class _EnvelopeModel(BaseModel):
    """Base for envelope models: ignore unknown fields, model output is untrusted."""

    model_config = {"extra": "ignore"}


class AnswerMetaReference(_EnvelopeModel):
    """The Fundstelle a verdict rests on; mirrors the card NormReference."""

    document: str = Field(min_length=1, description="e.g. 'OIB-Richtlinie 2'")
    section: str | None = Field(default=None, description="e.g. 'Tabelle 1b'")
    edition: str | None = Field(default=None, description="e.g. 'Ausgabe Mai 2023'")


class AnswerMetaVerdict(_EnvelopeModel):
    value: str = Field(min_length=1, description="the copyable VALUE — a number, a class, 'Nicht geregelt'")
    subject: str = Field(min_length=1, description="what the verdict answers, e.g. 'Erforderliche Geländerhöhe'")
    reference: AnswerMetaReference | None = Field(
        default=None, description="only when one Fundstelle carries the verdict"
    )


class AnswerMetaTakeaway(_EnvelopeModel):
    """One row of „Das Wichtigste" — the claim, and the footnote folded behind it.

    Both descriptions are long on purpose: they are the only guidance that
    reaches BOTH the taught schema and the provider-enforced one, and the two
    failures they name are the two this block actually shipped — a row that is
    a topic („Rechtsgrundlage") instead of a claim, and a `detail` so thin that
    opening it repaid nothing.
    """

    text: str = Field(
        min_length=1,
        description=(
            "ONE standalone claim carrying its own value — the number, the class, the Frist, the ruling: "
            "'Tragende Bauteile in GK 4: mindestens REI 60' passes. A topic or an outline heading fails, "
            "and is the usual mistake: 'Rechtsgrundlage', 'Fazit', 'Anforderungen an tragende Bauteile' "
            "name what the row would be about instead of saying it. The reader who reads only these rows "
            "must leave with the answer, so a row with nothing to write down is a wasted row"
        ),
    )
    detail: str | None = Field(
        default=None,
        description=(
            "The footnote behind the claim, one to two FULL sentences, revealed only when the reader "
            "opens the row: where the value comes from (Richtlinie, Punkt, Tabelle, Ausgabe), how it was "
            "derived, or the one case in which the claim does not hold. It has to repay the click — a "
            "half-sentence, a pointer back at the prose, or `text` said again in other words is worse "
            "than none. Omit it where the claim needs no footnote; that is normal, and a row without one "
            "simply does not open"
        ),
    )


class AnswerMetaCallout(_EnvelopeModel):
    kind: Literal["hinweis", "achtung", "frist", "tipp"]
    text: str = Field(min_length=1, description="the one sentence that changes what the reader DOES")
    title: str | None = Field(default=None, description="short headline; omit when text says it")
    detail: str | None = Field(default=None, description="background revealed on expand; omit rather than pad")


class AnswerMetaConfidence(_EnvelopeModel):
    """The self-assessment, as a field instead of a bracket grammar.

    The canonical carrier of what the ``[CONFIDENCE:…]`` marker used to say;
    the marker stays UNDERSTOOD as a fallback (and the deep writer still uses
    it), so the two never race — the envelope wins when both appear. The value
    surfaced to the reader is still decided by the server-side overconfidence
    guard, never here.
    """

    level: Literal["low", "medium", "high"]
    reason: str | None = Field(
        default=None, description="one short clause naming the decisive grounding fact, in the answer's language"
    )


class AnswerMeta(_EnvelopeModel):
    """The validated envelope beyond ``answer``. Every field optional.

    Two kinds of field, deliberately separate: ANATOMY (verdict, takeaways,
    callout — rendered content, gated through :data:`ANATOMY_FIELDS` onto the
    wire) and CONTROL (confidence, escalate_to_deep — signals the platform
    consumes, which never ride the ``answer_meta`` wire payload; confidence
    travels as ``answer_confidence`` exactly as it always has).
    """

    summary: str | None = Field(
        default=None,
        description="the whole answer in 1-2 sentences: outcome plus the decisive qualifier, in the answer's language",
    )
    verdict: AnswerMetaVerdict | None = None
    takeaways: list[AnswerMetaTakeaway] | None = None
    callout: AnswerMetaCallout | None = None
    confidence: AnswerMetaConfidence | None = None
    escalate_to_deep: bool | None = Field(
        default=None,
        description=(
            "true when this question needs deep research: the user commissioned a report or document, "
            "the answer needs many sources read against each other, or what you retrieved cannot support "
            "an adequate answer"
        ),
    )
    escalation_reason: str | None = Field(
        default=None,
        description="with escalate_to_deep: one short clause saying why, in the answer's language",
    )

    @property
    def empty(self) -> bool:
        return (
            self.summary is None
            and self.verdict is None
            and not self.takeaways
            and self.callout is None
            and self.confidence is None
            and self.escalate_to_deep is None
            and self.escalation_reason is None
        )


# ---------------------------------------------------------------------------
# The anatomy registry: one entry per field, gate included.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GateContext:
    """Everything a gate may judge an answer by. Extend here, not per gate."""

    prose_chars: int


def _gate_summary(meta: AnswerMeta, ctx: GateContext) -> str | None:
    if meta.summary is None:
        return None
    summary = meta.summary.strip()
    if not summary:
        return None
    if len(summary) > SUMMARY_MAX_CHARS:
        logger.info(
            "answer_meta summary gated out: %d chars exceeds %d — a paragraph, not a standfirst",
            len(summary),
            SUMMARY_MAX_CHARS,
        )
        return None
    return summary


def _gate_verdict(meta: AnswerMeta, ctx: GateContext) -> dict | None:
    if meta.verdict is None:
        return None
    value = meta.verdict.value.strip()
    subject = meta.verdict.subject.strip()
    if not value or not subject or len(value) > VERDICT_VALUE_MAX_CHARS:
        logger.info(
            "answer_meta verdict gated out: value length %d exceeds %d (or a field is blank)",
            len(value),
            VERDICT_VALUE_MAX_CHARS,
        )
        return None
    verdict: dict = {"value": value, "subject": subject}
    if meta.verdict.reference is not None:
        verdict["reference"] = meta.verdict.reference.model_dump(exclude_none=True)
    return verdict


def _gate_callout(meta: AnswerMeta, ctx: GateContext) -> dict | None:
    if meta.callout is None or not meta.callout.text.strip():
        return None
    callout: dict = {"kind": meta.callout.kind, "text": meta.callout.text.strip()}
    if meta.callout.title and meta.callout.title.strip():
        callout["title"] = meta.callout.title.strip()
    if meta.callout.detail and meta.callout.detail.strip():
        callout["detail"] = meta.callout.detail.strip()
    return callout


def _takeaway_payload(item: AnswerMetaTakeaway) -> dict:
    """One takeaway on the wire, without a ``detail`` that opens onto nothing.

    A row WITH a detail is a button in the frontend; a row without one is not
    (``KeyTakeawaysCard.tsx``). So a detail that repeats its own claim does not
    merely waste a line — it teaches the reader the chevrons are decorative, and
    then they stop opening the ones that are not.

    Blank and verbatim-restated are the two forms of that a gate can judge
    without guessing at editorial quality; the rest is the schema's job
    (:class:`AnswerMetaTakeaway`, whose description says what a detail must
    carry). Deliberately not a similarity test: a detail that qualifies the
    claim in words close to it is exactly what the field is for.
    """
    text = item.text.strip()
    detail = (item.detail or "").strip()
    if not detail or detail.casefold() == text.casefold():
        return {"text": text}
    return {"text": text, "detail": detail}


def _gate_takeaways(meta: AnswerMeta, ctx: GateContext) -> list | None:
    takeaways = [t for t in (meta.takeaways or []) if t.text.strip()][:TAKEAWAYS_MAX_ITEMS]
    if not takeaways:
        return None
    if ctx.prose_chars < TAKEAWAYS_MIN_PROSE_CHARS:
        logger.info(
            "answer_meta takeaways gated out: prose %d chars is under the %d floor",
            ctx.prose_chars,
            TAKEAWAYS_MIN_PROSE_CHARS,
        )
        return None
    if len(takeaways) < 2:
        logger.info("answer_meta takeaways gated out: a single takeaway is a sentence, not a block")
        return None
    return [_takeaway_payload(t) for t in takeaways]


@dataclass(frozen=True)
class AnatomyField:
    """One envelope field: its wire name and its deterministic gate.

    The registry order is also the frontend's render order contract for the
    fields that share a slot; the frontend owns the LAYOUT (verdict above the
    prose, the rest after it), this owns which content survives.
    """

    name: str
    gate: Callable[[AnswerMeta, GateContext], object | None]


ANATOMY_FIELDS: tuple[AnatomyField, ...] = (
    AnatomyField("summary", _gate_summary),
    AnatomyField("verdict", _gate_verdict),
    AnatomyField("callout", _gate_callout),
    AnatomyField("takeaways", _gate_takeaways),
)


# ---------------------------------------------------------------------------
# Extraction: model output → (prose, validated anatomy).
# ---------------------------------------------------------------------------


def _parse_object(raw: str) -> dict | None:
    """One JSON object out of ``raw``, tolerating trailing junk; None if none.

    ``strict=False`` for the same reason ``emit_card`` uses it: a raw newline
    inside a JSON string is how a model writes a two-sentence detail. When a
    direct parse fails, a brace-balanced re-scan from the first ``{`` recovers
    the common failure of text before/after an otherwise well-formed object.
    """
    try:
        payload = json.loads(raw, strict=False)
        return payload if isinstance(payload, dict) else None
    except (json.JSONDecodeError, TypeError):
        pass
    start = raw.find("{")
    if start == -1:
        return None
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(raw)):
        char = raw[i]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                try:
                    payload = json.loads(raw[start : i + 1], strict=False)
                except (json.JSONDecodeError, TypeError):
                    return None
                return payload if isinstance(payload, dict) else None
    return None


def _validated_meta(payload: dict) -> AnswerMeta | None:
    """The payload's anatomy fields as a validated model, or None. Fail-open."""
    try:
        meta = AnswerMeta.model_validate(payload)
    except ValidationError as exc:
        logger.warning("answer envelope anatomy failed validation, dropped: %s", exc)
        return None
    return None if meta.empty else meta


def extract_answer_envelope(content: object) -> tuple[object, AnswerMeta | None]:
    """Split a research reply into its prose and its validated anatomy.

    The contract is one fenced ```answer_json object whose ``answer`` field is
    the markdown prose; extraction is deliberately more tolerant than the
    contract, in this order:

    1. A fenced ``answer_json`` object with a usable ``answer`` string — the
       contract shape. Prose is that field; anatomy is the rest.
    2. A reply that IS one bare JSON object with an ``answer`` key — a model
       that dropped the fence. Same split.
    3. A fenced object WITHOUT a usable ``answer`` — the trailer form (prose
       outside, anatomy inside). Prose is the content with the fences removed;
       anatomy comes from the object.
    4. Anything else — plain prose. Returned unchanged with no anatomy.

    Fail-open with one invariant: the ANSWER is never lost. A fence whose JSON
    cannot be parsed at all is left standing in the content (ugly beats gone)
    and logged. Must run BEFORE the control-marker detectors, which are
    tail-anchored on the prose this returns.
    """
    if not isinstance(content, str):
        return content, None

    matches = list(_ANSWER_JSON_FENCE_RE.finditer(content))
    if matches:
        payload = _parse_object(matches[-1].group(1))
        if payload is None:
            logger.warning("answer_json envelope is not parseable JSON; leaving the reply untouched")
            return content, None
        answer = payload.get("answer")
        if isinstance(answer, str) and answer.strip():
            return answer.strip(), _validated_meta(payload)
        # Trailer form: the prose lives outside the fence.
        stripped = _ANSWER_JSON_FENCE_RE.sub("", content).strip()
        if stripped:
            return stripped, _validated_meta(payload)
        logger.warning("answer_json envelope has no usable answer field; leaving the reply untouched")
        return content, None

    bare = content.strip()
    if bare.startswith("{") and bare.endswith("}"):
        payload = _parse_object(bare)
        if payload is not None:
            answer = payload.get("answer")
            if isinstance(answer, str) and answer.strip():
                return answer.strip(), _validated_meta(payload)

    return content, None


def gate_answer_meta(meta: AnswerMeta, *, prose_chars: int) -> dict | None:
    """Run the registry's gates and return the versioned wire payload, or None.

    The payload is what rides the answer as its ``answer_meta`` field: the
    contract version under ``v`` plus every surviving anatomy field, gated-out
    fields absent rather than null. Callers pass ``prose_chars`` as the length
    of the answer's prose WITHOUT the sources section, so the takeaway gate
    judges the answer, not its apparatus.
    """
    ctx = GateContext(prose_chars=prose_chars)
    payload: dict = {}
    for field in ANATOMY_FIELDS:
        survived = field.gate(meta, ctx)
        if survived is not None:
            payload[field.name] = survived
    if not payload:
        return None
    return {"v": ENVELOPE_VERSION, **payload}


def resolve_callout_marker(prose: str, *, has_callout: bool) -> str:
    """Leave at most one placeable ``[[callout]]`` in ``prose``, or none.

    Runs after gating, on the final answer text. Two invariants, mirroring the
    card-marker contract on the frontend:

    - The reader never meets a marker with nothing behind it: when the callout
      was gated out (or the envelope carried none), every occurrence is
      stripped — the own-line form with its whole line, the mid-sentence form
      in place.
    - One callout, one slot: when the callout survived, the FIRST own-line
      marker stays and every later or mid-sentence occurrence goes. The
      frontend would place a slot per marker, and a warning drawn twice reads
      as two warnings.
    """
    if CALLOUT_MARKER not in prose:
        return prose

    kept = False
    lines: list[str] = []
    for line in prose.split("\n"):
        if _CALLOUT_LINE_RE.match(line):
            if has_callout and not kept:
                kept = True
                lines.append(line)
            # A dropped marker takes its whole line: a blank paragraph where
            # the warning would have been reads as a rendering fault.
            continue
        lines.append(_CALLOUT_INLINE_RE.sub("", line))
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# The schema the model sees, rendered from the models above.
# ---------------------------------------------------------------------------


def _shape(model_cls: type[BaseModel]) -> str:
    """A model's fields as ``{ name*: type (desc), ... }`` — one line, compact."""
    parts: list[str] = []
    for name, info in model_cls.model_fields.items():
        annotation = info.annotation
        origin = getattr(annotation, "__args__", None)
        if annotation is str or (origin and str in origin):
            type_str = "string"
        elif getattr(annotation, "__origin__", None) is Literal or "Literal" in str(annotation):
            type_str = " | ".join(json.dumps(a) for a in annotation.__args__)  # type: ignore[union-attr]
        elif isinstance(annotation, type) and issubclass(annotation, BaseModel):
            type_str = _shape(annotation)
        elif origin:
            inner = next((a for a in origin if a is not type(None)), str)
            if isinstance(inner, type) and issubclass(inner, BaseModel):
                type_str = _shape(inner)
            else:
                type_str = "string"
        else:
            type_str = "string"
        req = "*" if info.is_required() else ""
        desc = f" ({info.description})" if info.description else ""
        parts.append(f"{name}{req}: {type_str}{desc}")
    return "{ " + ", ".join(parts) + " }"


def _strict_property(annotation: object, *, required: bool) -> dict:
    """One field's strict-mode JSON schema, derived from its annotation.

    Strict structured outputs (OpenRouter/OpenAI ``json_schema`` with
    ``strict: true``) require EVERY key present and ``additionalProperties:
    false`` — optionality is expressed as a nullable type, not an absent key.
    The envelope models already accept explicit ``null`` everywhere a field is
    optional (``X | None`` throughout), so an enforced reply parses through
    the same validator as a fenced one.

    Raises on an annotation shape no envelope field has, deliberately: a new
    field whose type this walker cannot express must fail the test suite at
    the registry, not ship a silently wrong schema to the provider.
    """
    origin = get_origin(annotation)
    if origin is Union or origin is UnionType:
        members = [a for a in get_args(annotation) if a is not type(None)]
        nullable = len(members) < len(get_args(annotation)) or not required
        core: object = members[0]
    else:
        nullable = not required
        core = annotation

    schema: dict
    if core is str:
        schema = {"type": "string"}
    elif core is bool:
        schema = {"type": "boolean"}
    elif get_origin(core) is Literal:
        schema = {"type": "string", "enum": list(get_args(core))}
    elif isinstance(core, type) and issubclass(core, BaseModel):
        schema = _strict_object(core)
    elif get_origin(core) is list:
        (item,) = get_args(core)
        schema = {"type": "array", "items": _strict_object(item)}
    else:
        raise TypeError(f"envelope field type {annotation!r} has no strict-schema rendering")

    if not nullable:
        return schema
    if isinstance(schema.get("type"), str) and schema["type"] != "object" and "enum" not in schema:
        return {**schema, "type": [schema["type"], "null"]}
    return {"anyOf": [schema, {"type": "null"}]}


def _strict_object(model_cls: type[BaseModel]) -> dict:
    """A model as a strict-mode object schema: all keys required, closed."""
    properties: dict[str, dict] = {}
    for name, info in model_cls.model_fields.items():
        prop = _strict_property(info.annotation, required=info.is_required())
        if info.description:
            prop = {**prop, "description": info.description}
        properties[name] = prop
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


def render_envelope_response_format() -> dict:
    """The provider-enforced shape of a research reply, for ``response_format``.

    OpenRouter structured outputs (``type: json_schema``, ``strict: true``):
    on a supporting provider the reply IS one schema-valid JSON object — no
    fence, no prose around it — which the extractor's bare-object tier already
    accepts. Derived from the same Pydantic models as the validator and the
    prompt schema, so the three cannot drift. The deterministic gates stay the
    editorial enforcement (a schema cannot know the answer is too short to
    earn takeaways); this only guarantees the syntax and the shape.
    """
    schema = _strict_object(AnswerMeta)
    schema["properties"] = {
        "answer": {
            "type": "string",
            "description": "the full written answer: markdown prose with [N] citations and the sources section",
        },
        **schema["properties"],
    }
    schema["required"] = list(schema["properties"])
    return {
        "type": "json_schema",
        "json_schema": {"name": "answer_envelope", "strict": True, "schema": schema},
    }


def render_envelope_schema() -> str:
    """The envelope's field spec for the system prompt, derived from the models.

    Fields marked ``*`` are required; everything else is omitted rather than
    nulled. Rendered rather than hand-written so a registry change reaches the
    model in the same commit that changes the validator — the drift between a
    taught schema and an enforced one is exactly what this module exists to
    close.
    """
    lines = [
        "answer*: string (the full written answer: markdown prose with [N] citations and the sources section)",
        f"confidence: {_shape(AnswerMetaConfidence)}",
        "escalate_to_deep: boolean (true when the question needs deep research: a commissioned report or "
        "document, many sources to read against each other, or retrieved sources that cannot support an "
        "adequate answer)",
        "escalation_reason: string (with escalate_to_deep: one short clause saying why, in the answer's language)",
    ]
    field_models: dict[str, type[BaseModel] | None] = {
        "verdict": AnswerMetaVerdict,
        "callout": AnswerMetaCallout,
    }
    for field in ANATOMY_FIELDS:
        if field.name == "summary":
            description = AnswerMeta.model_fields["summary"].description
            lines.append(f"summary: string ({description})")
            continue
        if field.name == "takeaways":
            lines.append(f"takeaways: [{_shape(AnswerMetaTakeaway)}] (2-{TAKEAWAYS_MAX_ITEMS} items)")
            continue
        model_cls = field_models.get(field.name)
        if model_cls is not None:
            lines.append(f"{field.name}: {_shape(model_cls)}")
    return "\n".join(f"  {line}" for line in lines)
