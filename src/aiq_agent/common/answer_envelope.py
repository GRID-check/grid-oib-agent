"""The structured answer envelope (``answer_json``): the answer IS a document.

A research answer is generated as ONE JSON object in a fenced ``answer_json``
block — the schema is taught in the system prompt and RENDERED FROM the models
in this module (:func:`render_envelope_schema`), so the contract the model sees
and the validator that enforces it cannot drift. The object's required
``answer`` field carries the markdown prose (citations, the sources section and
the trailing control markers included, so the whole verification pipeline keeps
operating on one string); the other fields are the answer's own RHETORICAL
anatomy, every one optional: the headline verdict, the nominal topic, the
one-line context scope, the takeaways, the single callout.

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

**Home.** ``common/`` rather than Piloti, deliberately: the deep
writer's report is the obvious next adopter of the same contract (the job
runner already parses a trailing ``[CONFIDENCE:…]`` line out of
``/shared/output.md``; the envelope generalises that), and a contract two
agents share must not live in one agent's package.

Fail-open in every direction, and the asymmetry is deliberate: a malformed
envelope may cost the ENRICHMENT, never the ANSWER. Parsing is safe to attempt
at all because what the reader sees before this module has run is only the
envelope's ``answer`` prose, its markers pending until verified, and the
terminal frame built from this module's output replaces it (ADR-0066).

The gates are the point, not an accident (see ``docs/architecture/cards.md``):

- a verdict must be a short VALUE the reader can copy — a number, a class,
  „Nicht geregelt" — so anything longer than :data:`VERDICT_VALUE_MAX_CHARS`
  is a heading claiming too much, and is dropped. It is also exclusive to
  ``kind=ruling``; an absent kind is the legacy envelope and keeps today's
  behaviour (the verdict may survive);
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
from typing import Any
from typing import Literal
from typing import Union
from typing import get_args
from typing import get_origin

from pydantic import BaseModel
from pydantic import Field
from pydantic import ValidationError
from pydantic import field_validator

from aiq_agent.common.provenance import normalize_document_name
from aiq_agent.common.turn_status import VERDICT_DROP_AGENT_AUTHORED
from aiq_agent.common.turn_status import VERDICT_DROP_UNREFERENCED_WITH_AGENT_SOURCE
from aiq_agent.common.turn_status import emit_anatomy_dropped
from aiq_agent.common.turn_status import emit_verdict_dropped

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
#
# The block ENDS where its JSON object ends, not at the first ``` after it. The
# `answer` string is Markdown and may carry a fence of its own — a ```mermaid
# drawing, a listing — and a lazy match stopped at that inner fence, so the
# object was cut mid-string, failed to parse, and the reader got the raw JSON
# instead of the answer. `_envelope_blocks` finds the object's end with the
# same string-aware brace scan `_parse_object` uses, and only falls back to
# the first closing fence for an object that never closes (a truncated reply).
_ANSWER_JSON_OPEN_RE = re.compile(rf"```{ENVELOPE_FENCE}[ \t]*\n")
_ANSWER_JSON_FENCE_RE = re.compile(rf"```{ENVELOPE_FENCE}[ \t]*\n(.*?)\n?```", re.DOTALL)
_FENCE_CLOSE_RE = re.compile(r"[ \t]*\n?```")

#: A verdict is a VALUE — a number, a class, a short ruling. Anything longer is
#: a sentence pressed into a header. 60 chars fits „Nicht geregelt (Wiener
#: BauO)" with room and refuses a paragraph.
VERDICT_VALUE_MAX_CHARS = 60

#: A summary is ONE to TWO sentences the reader gets before the prose: the
#: consequence for THIS reader that the opening does not state (what to do
#: next, what it means for their project). The prompt asks for it only when
#: there is such a consequence (``piloti_static.md``); otherwise the opening
#: already answers and the field is omitted. Above this it is a paragraph
#: wearing a summary's name, and it is dropped whole — the prose's own lede
#: then does the job, so nothing is lost.
SUMMARY_MAX_CHARS = 320

#: A topic is the nominal title for a non-ruling answer ("Brandschutz", never
#: a verdict verb). Plain text in the answer's language, claiming nothing the
#: prose didn't ground. Above this it is a heading claiming too much.
TOPIC_MAX_CHARS = 90

#: A context line is the one-line scope ("OIB-RL 2, Ausgabe Mai 2023 · Wien").
#: Plain text in the answer's language. Above this it is a paragraph, not a
#: scope line.
CONTEXT_MAX_CHARS = 160

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

#: A Fundstelle shorter than this, once normalised, is not a document name a
#: substring test can judge — „RL 2" would match half the registry. Below the
#: floor the gate abstains rather than guessing in either direction.
_MIN_MATCHABLE_NAME_CHARS = 4

#: Exclusive shapes of a shallow answer. A verdict is kept only for ``ruling``.
AnswerKind = Literal["direct", "walkthrough", "ruling", "handoff"]
ANSWER_KINDS: tuple[str, ...] = get_args(AnswerKind)


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

    Two kinds of field, deliberately separate: ANATOMY (kind, summary, verdict,
    topic, context, takeaways, callout — rendered content, gated through :data:`ANATOMY_FIELDS`
    onto the wire) and CONTROL (confidence, escalate_to_deep — signals the
    platform consumes, which never ride the ``answer_meta`` wire payload;
    confidence travels as ``answer_confidence`` exactly as it always has).

    ``kind`` is exclusive: a verdict is kept only for ``ruling``. An absent
    kind is the legacy envelope and keeps today's behaviour. Unknown values
    are coerced to ``walkthrough`` (no verdict) rather than failing open
    to a ruling. ``topic`` and ``context`` render in the masthead and have no
    gate interaction with ``kind`` — the frontend prefers the verdict masthead
    when it shows, the backend keeps both; the model decides content, never
    placement.
    """

    kind: AnswerKind | None = Field(
        default=None,
        description=(
            'exclusive answer shape: "direct" | "walkthrough" | "ruling" | "handoff"; verdict is only for kind=ruling'
        ),
    )
    summary: str | None = Field(
        default=None,
        # Was "the whole answer in 1-2 sentences: outcome plus the decisive
        # qualifier", which is a restatement by definition: every live summary
        # in the September 2026 census restated the prose's opening and was
        # gated out (`_summary_redundant`). The prompt's rule is the consequence.
        description=(
            "omit unless the answer has a consequence for this reader that its opening does not state: "
            "what to do next or what it means for their project, 1-2 sentences, in the answer's language"
        ),
    )
    verdict: AnswerMetaVerdict | None = None
    topic: str | None = Field(
        default=None,
        description=(
            "nominal title for non-ruling answers, e.g. 'Brandschutz' — never a verdict verb; "
            "plain text in the answer's language, claiming nothing the prose didn't ground"
        ),
    )
    context: str | None = Field(
        default=None,
        description=("one-line scope, e.g. 'OIB-RL 2, Ausgabe Mai 2023 · Wien'; plain text in the answer's language"),
    )
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
    #: CONTROL. The model's account of which of the skills in its prompt it
    #: followed (ADR-0063): a body that rode the prompt costs no ``use_skill``
    #: call, so this is the only way the "Skills used" disclosure can learn it
    #: shaped the answer. Names only; the runtime accepts a name only when the
    #: body was in the prompt (``skills/runtime.py::record_applied``).
    skills_applied: list[str] | None = Field(
        default=None,
        description=(
            "the names of the skills from the prompt's Skills section whose method this answer followed; "
            "omit when none did"
        ),
    )
    #: The model's own cards, in the same message as the answer — the card
    #: objects ``emit_card`` takes, validated by the same adapter after
    #: extraction (``cards/envelope.py``) and registered in the same per-turn
    #: registry, so nothing on the wire changes. ``Any`` because the card union
    #: is validated by its own adapter, not here; and OMITTED from the strict
    #: provider schema (``json_schema_extra``), because a 40-way union of
    #: nested objects is not expressible in strict mode — the forced-synthesis
    #: call, the only one enforced that way, is the truncated turn, and a
    #: truncated turn ships without cards rather than without an answer.
    cards: list[Any] | None = Field(
        default=None,
        description=(
            "the rich-UI cards this answer earns, as card objects (each with a `type` field), in the "
            "same message as the answer — the contract for them follows the field list"
        ),
        json_schema_extra={"strict_schema": "omit"},
    )

    @field_validator("kind", mode="before")
    @classmethod
    def _coerce_kind(cls, value: object) -> str | None:
        if not isinstance(value, str):
            return None
        kind = value.strip()
        if not kind:
            return None
        # Unknown is not legacy. Legacy is ABSENT kind. Garbage that kept the
        # gavel made exclusive kinds fail open to a ruling.
        return kind if kind in ANSWER_KINDS else "walkthrough"

    @property
    def empty(self) -> bool:
        return (
            self.kind is None
            and self.summary is None
            and self.verdict is None
            and self.topic is None
            and self.context is None
            and not self.takeaways
            and self.callout is None
            and self.confidence is None
            and self.escalate_to_deep is None
            and not self.skills_applied
            and self.escalation_reason is None
            and not self.cards
        )


# ---------------------------------------------------------------------------
# The anatomy registry: one entry per field, gate included.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GateContext:
    """Everything a gate may judge an answer by. Extend here, not per gate."""

    prose_chars: int
    #: Normalised names of the AGENT-AUTHORED documents this turn captured
    #: (``citation_verification.agent_authored_document_names``). Empty on
    #: every turn that retrieved none, which is nearly all of them — and an
    #: empty set makes the verdict gate below a no-op, so a caller that cannot
    #: reach a registry loses nothing it had.
    agent_authored_documents: frozenset[str] = frozenset()
    #: The answer's prose without its sources section. Empty where a caller has
    #: none to give (the deep writer), which turns the gates reading it off.
    prose: str = ""
    #: Whether a drop is recorded as a turn event. Off for the live stream's
    #: provisional gating (``LiveAnswer``), which runs the gates again as the
    #: answer settles; the finished answer's gating records each drop once.
    record: bool = True

    def anatomy_dropped(self, *, field: str, reason: str) -> None:
        if self.record:
            emit_anatomy_dropped(field=field, reason=reason)

    def verdict_dropped(self, *, reason: str) -> None:
        if self.record:
            emit_verdict_dropped(reason=reason)


#: Share of a summary's content words its prose's opening paragraph may also
#: carry before the summary counts as that paragraph said again. Calibrated on
#: live answers (September 2026 census): three restating summaries scored 0.46
#: to 0.53; the prompt's own consequence-summary („Danach ausschreiben …")
#: scores 0 against its opening.
SUMMARY_RESTATES_OVERLAP = 0.4

_CONTENT_WORD = re.compile(r"[a-zäöüß0-9]{4,}")
_NOT_PROSE_BLOCK = ("|", "```", "[[", "#", "- ", "* ", "> ", "$$")


def _content_words(text: str) -> set[str]:
    """Words that carry meaning, clipped to a crude stem so „Gebäude"/„Gebäuden" match."""
    plain = re.sub(r"\[\d+\]|\*\*|\[\[[^\]]*\]\]", " ", text.lower())
    return {word[:5] for word in _CONTENT_WORD.findall(plain)}


#: Abbreviations whose period ends no sentence, for counting a reply's
#: sentences. A letter-period run („z. B.", „u. a.", „d. h.", „i. d. R.") is
#: matched by shape; the words are the ones a regulation answer cites a
#: provision with. „etc." and „usw." are left out on purpose: they end a
#: sentence as often as not. No library covers this: nltk's Punkt needs a data
#: download at runtime, and a miss only costs a summary the gate keeps.
_ABBREVIATION = re.compile(
    r"\b(?:[A-Za-zÄÖÜäöü]\.\s?)+[A-Za-zÄÖÜäöü]\."
    r"|\b(?:gem|Pkt|Abs|Nr|lt|bzw|vgl|ca|inkl|bzgl|lit|Art|Ziff|Kap|Abb|Tab|Anm|mind|zzgl|ggf|evtl|sog|Bsp)\.",
    re.IGNORECASE,
)
_SENTENCE = re.compile(r"[^.!?]+[.!?](?:\s*\[\d+\])*(?=\s|$)")


def _sentence_count(text: str) -> int:
    """How many sentences `text` has, not counting an abbreviation's period as an end."""
    return len(_SENTENCE.findall(_ABBREVIATION.sub(lambda m: m.group().replace(".", ""), text)))


def _prose_paragraphs(prose: str) -> list[str]:
    return [
        block.strip()
        for block in re.split(r"\n\s*\n", prose)
        if block.strip() and not block.lstrip().startswith(_NOT_PROSE_BLOCK)
    ]


def _summary_redundant(summary: str, prose: str) -> str | None:
    """Why the prose already says what the summary says, or None.

    The standfirst sits directly above the prose, and the prose is told to
    open with the answer, so a summary earns its place only by saying what the
    opening does not: the consequence for this reader (the prompt's
    "Vier Fächer" rule). Two cases say it twice: a reply of two sentences or
    fewer, which is its own summary, and a summary whose words are mostly the
    opening paragraph's.
    """
    if not prose.strip():
        return None
    blocks = [block for block in re.split(r"\n\s*\n", prose) if block.strip()]
    paragraphs = _prose_paragraphs(prose)
    if paragraphs and len(paragraphs) == len(blocks):
        if _sentence_count(" ".join(paragraphs)) <= 2:
            return "short_answer"
    if not paragraphs:
        return None
    words = _content_words(summary)
    if words and len(words & _content_words(paragraphs[0])) / len(words) >= SUMMARY_RESTATES_OVERLAP:
        return "restates_lede"
    return None


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
        ctx.anatomy_dropped(field="summary", reason="too_long")
        return None
    redundant = _summary_redundant(summary, ctx.prose)
    if redundant:
        logger.info("answer_meta summary gated out: %s — the prose already says it", redundant)
        ctx.anatomy_dropped(field="summary", reason=redundant)
        return None
    return summary


def _gate_topic(meta: AnswerMeta, ctx: GateContext) -> str | None:
    if meta.topic is None:
        return None
    topic = meta.topic.strip()
    if not topic:
        return None
    if len(topic) > TOPIC_MAX_CHARS:
        logger.info(
            "answer_meta topic gated out: %d chars exceeds %d — a heading, not a nominal title",
            len(topic),
            TOPIC_MAX_CHARS,
        )
        ctx.anatomy_dropped(field="topic", reason="too_long")
        return None
    return topic


def _gate_context(meta: AnswerMeta, ctx: GateContext) -> str | None:
    if meta.context is None:
        return None
    context = meta.context.strip()
    if not context:
        return None
    if len(context) > CONTEXT_MAX_CHARS:
        logger.info(
            "answer_meta context gated out: %d chars exceeds %d — a paragraph, not a scope line",
            len(context),
            CONTEXT_MAX_CHARS,
        )
        ctx.anatomy_dropped(field="context", reason="too_long")
        return None
    return context


def _gate_kind(meta: AnswerMeta, ctx: GateContext) -> str | None:
    return meta.kind


def _verdict_drop_reason(verdict: AnswerMetaVerdict, ctx: GateContext) -> str | None:
    """Why this verdict may not stand as the answer's headline, or ``None``.

    Two refusals, and the second exists because the first could be walked
    around. A verdict whose Fundstelle names a document PILOTI wrote is dropped
    — an approved office document is evidence of what the OFFICE decided, never
    of what the OIB requires. A verdict with NO Fundstelle cannot be judged that
    way at all, so on a turn that retrieved agent-authored material the gate
    fell open: omitting the reference was the cheapest route to the same
    headline, resting on the same document, with the evidence left out.

    So the absent reference is refused too, and only on such a turn. When
    nothing agent-authored was retrieved there is nothing for the headline to
    launder, and a verdict the model chose not to attribute — „Nicht geregelt"
    is the common one — keeps standing exactly as before.
    """
    if _names_agent_authored_document(verdict.reference, ctx):
        return VERDICT_DROP_AGENT_AUTHORED
    if verdict.reference is None and ctx.agent_authored_documents:
        return VERDICT_DROP_UNREFERENCED_WITH_AGENT_SOURCE
    return None


def _names_agent_authored_document(reference: AnswerMetaReference | None, ctx: GateContext) -> bool:
    """Whether a verdict's Fundstelle names a document PILOTI wrote.

    ``reference.document`` is free text a model produced, so the comparison is
    on normalised names and matches in BOTH directions: the reference may carry
    the document plus an annotation („Brandschutzkonzept Haus B (Büroarchiv)"),
    or be the bare slug of a longer stored title. Deliberately eager — the cost
    of a false positive is a headline the reader loses while the prose keeps
    every word of the answer, and the cost of a false negative is a normative
    value presented as if the OIB required it.
    """
    if reference is None or not ctx.agent_authored_documents:
        return False
    named = normalize_document_name(reference.document)
    if len(named) < _MIN_MATCHABLE_NAME_CHARS:
        return False
    return any(name in named or named in name for name in ctx.agent_authored_documents)


def _gate_verdict(meta: AnswerMeta, ctx: GateContext) -> dict | None:
    if meta.verdict is None:
        return None
    # Exclusive kinds: a present non-ruling kind drops the verdict. An absent
    # kind is the legacy envelope — the verdict may still survive.
    if meta.kind is not None and meta.kind != "ruling":
        logger.info("answer_meta verdict gated out: kind %s is not ruling", meta.kind)
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
    drop = _verdict_drop_reason(meta.verdict, ctx)
    if drop is not None:
        logger.info(
            "answer_meta verdict gated out (%s): Fundstelle %r against %d agent-authored document(s) — "
            "an approved office document is evidence of what the office decided, never of what the OIB requires",
            drop,
            meta.verdict.reference.document if meta.verdict.reference else None,
            len(ctx.agent_authored_documents),
        )
        ctx.verdict_dropped(reason=drop)
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
        ctx.anatomy_dropped(field="takeaways", reason="prose_too_short")
        return None
    if len(takeaways) < 2:
        logger.info("answer_meta takeaways gated out: a single takeaway is a sentence, not a block")
        ctx.anatomy_dropped(field="takeaways", reason="single_item")
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
    AnatomyField("kind", _gate_kind),
    AnatomyField("summary", _gate_summary),
    AnatomyField("verdict", _gate_verdict),
    AnatomyField("topic", _gate_topic),
    AnatomyField("context", _gate_context),
    AnatomyField("callout", _gate_callout),
    AnatomyField("takeaways", _gate_takeaways),
)


# ---------------------------------------------------------------------------
# Extraction: model output → (prose, validated anatomy).
# ---------------------------------------------------------------------------


def _object_end(raw: str, start: int) -> int | None:
    """The index just past the JSON object opening at ``raw[start]``, or None.

    String-aware, so a brace or a fence inside a string value is text, not
    structure. None when the object never closes.
    """
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
                return i + 1
    return None


def _envelope_blocks(content: str) -> list[tuple[int, int, str]]:
    """Every fenced envelope as ``(start, end, body)``, in order.

    ``body`` is the JSON object; ``start``/``end`` span the whole block, fences
    included, so the trailer form can cut it out of the prose.
    """
    blocks: list[tuple[int, int, str]] = []
    position = 0
    while opening := _ANSWER_JSON_OPEN_RE.search(content, position):
        body_start = opening.end()
        brace = content.find("{", body_start)
        # Only a brace that opens the body: one past non-blank text is prose
        # after this block's own closing fence, not its object.
        if brace != -1 and content[body_start:brace].strip():
            brace = -1
        end = _object_end(content, brace) if brace != -1 else None
        if end is None:
            lazy = _ANSWER_JSON_FENCE_RE.match(content, opening.start())
            if lazy is None:
                break
            blocks.append((lazy.start(), lazy.end(), lazy.group(1)))
            position = lazy.end()
            continue
        close = _FENCE_CLOSE_RE.match(content, end)
        block_end = close.end() if close else end
        blocks.append((opening.start(), block_end, content[body_start:end]))
        position = block_end
    return blocks


def _without_blocks(content: str, blocks: list[tuple[int, int, str]]) -> str:
    """``content`` with every envelope block cut out."""
    kept: list[str] = []
    position = 0
    for start, end, _ in blocks:
        kept.append(content[position:start])
        position = end
    kept.append(content[position:])
    return "".join(kept)


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
    end = _object_end(raw, start)
    if end is None:
        return None
    try:
        payload = json.loads(raw[start:end], strict=False)
    except (json.JSONDecodeError, TypeError):
        return None
    return payload if isinstance(payload, dict) else None


def _validated_meta(payload: dict) -> AnswerMeta | None:
    """The payload's anatomy fields as a validated model, or None. Fail-open."""
    try:
        meta = AnswerMeta.model_validate(payload)
    except ValidationError as exc:
        logger.warning("answer envelope anatomy failed validation, dropped: %s", exc)
        return None
    return None if meta.empty else meta


#: Loose text beside a complete envelope past which it is a second copy of the
#: answer rather than a stray line.
_PROSE_OUTSIDE_WARN_CHARS = 200


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

    blocks = _envelope_blocks(content)
    if blocks:
        payload = _parse_object(blocks[-1][2])
        if payload is None:
            logger.warning("answer_json envelope is not parseable JSON; leaving the reply untouched")
            return content, None
        answer = payload.get("answer")
        if isinstance(answer, str) and answer.strip():
            outside = _without_blocks(content, blocks).strip()
            if len(outside) > _PROSE_OUTSIDE_WARN_CHARS:
                # The reply wrote its answer twice: once loose, once in the
                # fence. The fence wins and the reader sees it once, but every
                # token of the loose copy was generated and paid for; the
                # September 2026 census caught one in three doing it.
                logger.warning(
                    "answer_prose_outside_envelope: %d chars of prose outside the answer_json fence discarded",
                    len(outside),
                )
            return answer.strip(), _validated_meta(payload)
        # Trailer form: the prose lives outside the fence.
        stripped = _without_blocks(content, blocks).strip()
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

    headless = _salvage_headless(content)
    if headless is not None:
        return headless

    return content, None


#: The tail of an envelope whose head never arrived: the prose, then `", "kind":`
#: and the rest of the object, then the closing fence.
_HEADLESS_TAIL_RE = re.compile(r'"\s*,\s*(?="kind"\s*:)')


def _salvage_headless(content: str) -> tuple[str, AnswerMeta | None] | None:
    """An envelope whose opening (the fence and `{"answer": "`) is missing.

    Seen live (September 2026 suite, 1 reply in 27): the model began with the
    prose itself and switched into JSON half way, `…p.5", "kind":"ruling",
    "confidence":{…}}` plus the closing fence. Read as plain prose, the reader
    got that JSON tail under the answer and the turn lost its verdict, its
    confidence and its cards. Whatever stands before `", "kind":` is the
    answer; the rest, opened with `{`, is the object. The FIRST `", "kind":`
    whose tail parses whole as one object with an answer kind is taken, so a
    nested card's kind is never the cut and prose quoting JSON is untouched.

    A reply that opens with `{` or the ``answer_json`` fence HAS its head: it is
    an object that did not parse, and a nested `", "kind":` (a callout's) would
    cut it into a JSON fragment passed off as prose. It is left to the caller's
    fail-open path instead.
    """
    head = content.lstrip()
    if head.startswith("{") or head.startswith(f"```{ENVELOPE_FENCE}"):
        return None
    # Only the closing fence at the very end: a ```mermaid fence inside the
    # prose keeps its own.
    body = re.sub(r"\n?```\s*$", "", content.rstrip()).rstrip()
    if not body.endswith("}"):
        return None
    found = next(
        (
            (split, payload)
            for split in _HEADLESS_TAIL_RE.finditer(body)
            if (payload := _headless_tail(body[split.end() :])) is not None
        ),
        None,
    )
    if found is None:
        return None
    split, payload = found
    prose = body[: split.start()].strip()
    if not prose:
        return None
    logger.warning(
        "answer_envelope_headless: salvaged an envelope whose opening was missing (%d chars of prose)", len(prose)
    )
    return prose, _validated_meta({**payload, "answer": prose})


def _headless_tail(tail: str) -> dict | None:
    """``tail`` as the envelope's remaining top-level object, or None.

    The whole tail must be ONE object carrying an answer kind. A nested card's
    `", "kind":` (a callout's ``hinweis``) leaves `]}` after its own object and
    a kind that is no answer kind, so it is refused rather than cut at.
    """
    try:
        payload, end = json.JSONDecoder(strict=False).raw_decode("{" + tail)
    except json.JSONDecodeError:
        return None
    if end != len(tail) + 1 or not isinstance(payload, dict):
        return None
    return payload if payload.get("kind") in ANSWER_KINDS else None


def gate_answer_meta(
    meta: AnswerMeta,
    *,
    prose_chars: int,
    agent_authored_documents: frozenset[str] = frozenset(),
    prose: str = "",
    record: bool = True,
) -> dict | None:
    """Run the registry's gates and return the versioned wire payload, or None.

    The payload is what rides the answer as its ``answer_meta`` field: the
    contract version under ``v`` plus every surviving anatomy field, gated-out
    fields absent rather than null. Callers pass ``prose_chars`` as the length
    of the answer's prose WITHOUT the sources section, so the takeaway gate
    judges the answer, not its apparatus.

    ``agent_authored_documents`` is what the turn retrieved that PILOTI wrote
    (``citation_verification.agent_authored_document_names``); a verdict whose
    Fundstelle resolves into it is dropped, and so is a verdict that names no
    Fundstelle at all — see :func:`_verdict_drop_reason` for why the second
    refusal is not the first one being over-eager. Defaulted so a caller with no
    registry — the deep writer's report path, a test — behaves exactly as
    before.

    ``record=False`` gates without recording a drop as a turn event: the live
    stream gates the same masthead provisionally, twice, and the finished
    answer's gating is the one that counts.
    """
    ctx = GateContext(
        prose_chars=prose_chars, agent_authored_documents=agent_authored_documents, prose=prose, record=record
    )
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
        # An array of one model (takeaways) or of plain strings (skills_applied);
        # ``_strict_property`` on the item keeps a model recursive and raises on
        # anything else the walker cannot express.
        schema = {"type": "array", "items": _strict_property(item, required=True)}
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
        extra = info.json_schema_extra if isinstance(info.json_schema_extra, dict) else {}
        if extra.get("strict_schema") == "omit":
            # A field whose type strict mode cannot express (the cards union):
            # taught in the prompt, validated by its own adapter, and absent
            # from the enforced schema rather than mis-stated in it.
            continue
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


#: The fields the reader sees ABOVE the prose (the masthead, and the kind that
#: names the answer), written before ``answer`` in this order. The reply
#: streams as it is written (ADR-0066): a masthead written after the prose was
#: inserted above text the reader was already reading, and moved it 80-230 px.
MASTHEAD_FIELDS = ("kind", "topic", "context", "verdict", "summary")


def _masthead_first(properties: dict) -> dict:
    """``properties`` reordered: the masthead fields, then ``answer``, then the rest."""
    head = {name: properties[name] for name in MASTHEAD_FIELDS if name in properties}
    answer = {"answer": properties["answer"]} if "answer" in properties else {}
    rest = {name: value for name, value in properties.items() if name not in head and name != "answer"}
    return {**head, **answer, **rest}


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
    schema["properties"] = _masthead_first(
        {
            "answer": {
                "type": "string",
                "description": "the full written answer: markdown prose with [N] citations and the sources section",
            },
            **schema["properties"],
        }
    )
    schema["required"] = list(schema["properties"])
    return {
        "type": "json_schema",
        "json_schema": {"name": "answer_envelope", "strict": True, "schema": schema},
    }


def _masthead_lines_first(lines: list[str]) -> list[str]:
    """The schema lines in the order the reply is written: masthead, answer, rest."""
    named = {line.split(":", 1)[0].rstrip("*"): line for line in lines}
    order = [*MASTHEAD_FIELDS, "answer"]
    head = [named[name] for name in order if name in named]
    return head + [line for line in lines if line not in head]


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
        f"skills_applied: [string] ({AnswerMeta.model_fields['skills_applied'].description})",
    ]
    field_models: dict[str, type[BaseModel] | None] = {
        "verdict": AnswerMetaVerdict,
        "callout": AnswerMetaCallout,
    }
    for field in ANATOMY_FIELDS:
        if field.name == "kind":
            kinds = " | ".join(json.dumps(k) for k in ANSWER_KINDS)
            lines.append(f"kind: {kinds}")
            continue
        if field.name == "takeaways":
            lines.append(f"takeaways: [{_shape(AnswerMetaTakeaway)}] (2-{TAKEAWAYS_MAX_ITEMS} items)")
            continue
        model_cls = field_models.get(field.name)
        if model_cls is not None:
            suffix = " (only for kind=ruling)" if field.name == "verdict" else ""
            lines.append(f"{field.name}: {_shape(model_cls)}{suffix}")
            continue
        # Plain-text anatomy (summary, topic, context, …): one line each,
        # description straight from the model, so a registry entry reaches the
        # prompt in the same commit that changes the validator.
        if field.name in AnswerMeta.model_fields:
            description = AnswerMeta.model_fields[field.name].description
            lines.append(f"{field.name}: string ({description})")
    cards_description = AnswerMeta.model_fields["cards"].description
    lines.append(f"cards: [ {{ type*: string, …the fields of that type }} ] ({cards_description})")
    lines = _masthead_lines_first(lines)
    rendered = "\n".join(f"  {line}" for line in lines)
    # The cards contract — which trigger takes which card, the index, the
    # three shapes the envelope teaches, the placement rule — rendered from the card
    # catalog so it cannot drift from the validator. Imported here because the
    # cards package validates with pydantic models of its own and never needs
    # this module; the dependency runs one way.
    from aiq_agent.cards.envelope import render_envelope_cards_contract

    return rendered + "\n\nCARDS (the `cards` field):\n" + render_envelope_cards_contract()
