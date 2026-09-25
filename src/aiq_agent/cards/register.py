"""``emit_card`` tool — the agent's first-class channel for rich UI cards.

The answering agent calls this mid-turn whenever a structured element (a legal
basis, a dimension/stair diagram, a summary, …) communicates better than
prose. The card is validated against the shared card schema and pushed into
the conversation-scoped :class:`~aiq_agent.cards.registry.CardRegistry`; the
chat entrypoint reads that registry after the turn and attaches the cards to
the response.

This is the SYNCHRONOUS card channel: the answering agent emits cards from full
context, as a visible tool step, on the chat path. The async
deep-research job runner has no card registry bound in its Dask worker, so it
still derives cards post-hoc from the finished report via
:func:`aiq_agent.cards.generate.generate_cards`. Both surfaces describe the same
schema AND the same trigger doctrine to the model through the shared
:mod:`aiq_agent.cards.catalog`; each adds only what is true of itself.
"""

import json
import logging

# Importing this module runs its ``@register_function`` so NAT discovers the
# ``surface_documents`` tool through the same ``aiq_cards`` entry point that
# imports this file — no extra plugin entry needed.
from aiq_agent.cards import surface_documents as _surface_documents  # noqa: F401

# Re-exported so the shape-hint retry loop and tests keep importing them from
# here; the definitions live in the framing-free catalog module.
from aiq_agent.cards.catalog import CARD_EXAMPLES as _CARD_EXAMPLES  # noqa: F401
from aiq_agent.cards.catalog import CHAT_ONLY_CARD_TYPES
from aiq_agent.cards.catalog import model_facing_card_types
from aiq_agent.cards.catalog import render_card_details
from aiq_agent.cards.catalog import render_card_doctrine
from aiq_agent.cards.catalog import render_card_index
from aiq_agent.cards.catalog import shape_hint_for as _shape_hint_for  # noqa: F401 — re-exported
from aiq_agent.cards.envelope import REFUSED_ENVELOPE_TYPE
from aiq_agent.cards.envelope import REFUSED_SHAPE
from aiq_agent.cards.envelope import REFUSED_SYSTEM_TYPE
from aiq_agent.cards.envelope import validate_model_card
from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)


# The WHOLE contract for calling this tool: which trigger takes which card, how that card is
# filled well, what may go on one and when to emit none. It is one statement because it is one
# decision — "a Verfahren -> process_map" and "stations must carry what each step requires" are a
# question and its answer, and they were split across this file and the `<cards>` section of
# Piloti's system prompt (`piloti/prompts/piloti.j2`). The prompt's half had since grown its own
# sharpened triggers, its own two-card budget and its own restatement test beside the ones the
# doctrine already carried, which is what a rule kept in two places always does. A new card type
# now earns a trigger line AND its craft in `catalog._CARD_TRIGGERS`, together.
#
# Two things stayed in the prompt rather than moving here, because they are facts about the
# ANSWER rather than about this tool: the `[[card:N]]` placement marker contract (the tool's own
# success message repeats the marker per call, so nothing is lost by not paying for the paragraph
# on turns that emit nothing), and the redirect saying a verdict, the key takeaways and the
# callout are `answer_json` envelope fields rather than cards. The refusal below still names the
# right channel for a model that reaches for one of those anyway.
_CARD_DOCTRINE = render_card_doctrine()


def _build_tool_description() -> str:
    """Frame ``emit_card`` with the card INDEX; the shape arrives with the error.

    Rendering every shape and worked example here costs ~5,200 tokens on every
    turn whether or not a card is emitted, and grows ~190 per card type we add.
    The index costs ~900 and ~23 per new type, which is what makes a growing
    vocabulary affordable on a cost-optimised model tier.

    Learning a shape used to cost a charged ``describe_card`` round trip, which
    this description then had to talk the model into paying — and the shape it
    fetched was needed only when the first attempt would have been wrong. So the
    RETRY carries it instead: a failed ``emit_card`` hands back the full shape,
    the building blocks and the worked example for the type that failed, which
    is exactly what ``describe_card`` returned. A card that would have been
    filled in correctly pays nothing; one that would not pays the same one round
    trip it used to pay in advance, and pays it knowing which field was wrong.
    """
    return (
        "Render a rich UI card alongside your answer, in addition to your written reply — always "
        "write the prose too: delete the cards mentally and the answer must still answer. On an "
        "ordinary turn put your cards in the `cards` field of your answer envelope instead, in the "
        "same message as the answer — that costs no further call; this tool is for a card you must "
        "show BEFORE the answer is written. Several cards are one call: pass a JSON array of card "
        "objects.\n\n"
        + _CARD_DOCTRINE
        + "\n\nHOW. Pass `card_json`: a JSON object with a `type` field plus that type's fields. "
        "Fill it from the type's line below and the rules above; you are not shown every shape up "
        "front, and you do not need to look one up first — if a field is wrong, the error hands "
        "you that type's full shape and a worked example, so an unfamiliar shape is never a reason "
        "to skip a card the answer called for. Fields marked * are "
        "required; omit optional ones rather than passing null. Numbers are plain JSON numbers. For "
        "schematic cards, supply the measured/actual value from the question or project profile and "
        "the OIB limit in `required`; if a value is unknown, omit it and set that check's status to "
        '"needs_input" — never estimate.\n\n' + render_card_index(exclude=CHAT_ONLY_CARD_TYPES)
    )


_DESCRIBE_DESCRIPTION = (
    "Return the exact JSON shape, the shared building blocks and a worked example for one or more "
    "card types, so you can fill `emit_card` in correctly on the first attempt. Pass `card_types`: "
    "one type name, or several separated by commas. Call this once for the types you intend to "
    "emit; the shapes stay in context afterwards."
)


# The redirect for a model that recognised "this answer has a verdict" and reached for a tool call
# anyway. It used to be stated TWICE on this surface: once up front in the doctrine every turn
# pays, and once here, on the one call that actually needed it. The up-front sentence is the
# answering prompt's now — placement and the answer's own anatomy are facts about the answer being
# written, and the post-hoc surface has neither — so this is the tool's whole statement of it, and
# it is named rather than inline so a test can hold it to naming the channel.
_ENVELOPE_REFUSAL = (
    "Error: card type '{card_type}' is not emitted as a card. Put its content into the matching "
    "field of your ```answer_json answer envelope instead (see the answer contract)."
)


#: What comes back when no conversation context is bound. The answer still
#: stands; the cards simply have nowhere to be delivered.
_NO_CHANNEL = "Noted, but no card channel is available in this context; continue with your written answer."


def _declared_type(payload: object) -> str:
    """What the model called this element, for a refusal that can name it."""
    if not isinstance(payload, dict):
        return type(payload).__name__
    return str(payload.get("type", "?"))


def _many_result(markers: list[str], refusals: list[str]) -> str:
    """The array call's one reply: every marker to write, then what was refused."""
    if not markers:
        return "\n".join(refusals)

    count = "1 card" if len(markers) == 1 else f"{len(markers)} cards"
    registered = (
        f"{count} will be shown with your answer, as {', '.join(markers)}. Write each marker on a "
        "line of its own at the point in your answer where that card belongs, and it is drawn there "
        "instead of after the whole answer. A marker you leave out lands its card at the end."
    )
    if not refusals:
        return registered
    return registered + "\n\n" + "\n".join(refusals)


class EmitCardConfig(FunctionBaseConfig, name="emit_card"):
    """Configuration for the ``emit_card`` tool."""


@register_function(config_type=EmitCardConfig)
async def emit_card(tool_config: EmitCardConfig, builder: Builder):
    from aiq_agent.cards.registry import get_card_registry

    def _validated_or_refusal(payload: object) -> tuple[dict | None, str | None]:
        """One card object through the shape check and the two closed channels.

        Every card comes through here, whether it arrived on its own or as an
        element of an array, so an array never buys a card a softer standard
        than the one it would have met on its own call.

        Every exit logs, including the refusals. A turn that came back with no
        card used to be indistinguishable, after the fact, between "the model
        never called this" and "the model called it and we refused": only the
        success below wrote a line, so both left the same silence. Those two
        call for opposite fixes, a doctrine that does not get the card named
        versus a shape the model cannot fill in, and a triage that cannot tell
        them apart picks by guess. Refusals are ``warning`` because each one is
        a card the reader was supposed to get and did not.
        """
        # ONE validator for a card the model composes, shared with the answer
        # envelope's `cards` field (``cards/envelope.py``): the shape check,
        # the system-card channel and the envelope-field channel. What this
        # tool adds is its own advice — which call to make next.
        validated, refusal = validate_model_card(payload)
        if refusal is None:
            return validated, None
        if refusal.kind == REFUSED_SHAPE:
            # The FULL shape, the building blocks, the field rules and the worked
            # example — the whole of what `describe_card` used to be asked for in
            # advance. The retry is the cheapest place to spend it: it is the one
            # moment we know the model needs it and know which type it needs.
            return None, (
                f"Error: {refusal.message} Fix the fields and call emit_card again, or skip the card."
                + (f"\n\n{refusal.hint}" if refusal.hint else "")
            )
        if refusal.kind == REFUSED_SYSTEM_TYPE:
            # System cards (e.g. memory_proposal) are emitted only by their
            # owning tool on a sanctioned path — the model must never emit one.
            return None, (
                f"Error: card type '{refusal.card_type}' is system-emitted and cannot be created with "
                "emit_card. Do not emit this card type."
            )
        if refusal.kind == REFUSED_ENVELOPE_TYPE:
            # Envelope shapes are answer-envelope fields; the refusal names the
            # right channel so a model that correctly recognised "this answer
            # has a verdict" is redirected rather than merely refused.
            return None, _ENVELOPE_REFUSAL.format(card_type=refusal.card_type)
        return None, f"Error: {refusal.message}"

    def _register(validated: dict) -> int | None:
        """Add the card to this turn's registry and return the marker's N.

        The marker names the card by its POSITION in this turn's registry, which
        is the same 1-based index the frontend counts with — the registry keeps
        emission order, and the response carries the cards in that order. Cards
        gained no id field for this: an id would have to survive validation,
        persistence and the deep-research path that builds cards post-hoc.

        ``None`` means no conversation context is bound (e.g. an unusual
        entrypoint). The answer still stands; the card cannot be delivered.
        """
        registry = get_card_registry()
        if registry is None:
            logger.info("emit_card called with no active card registry; card of type %s dropped", validated["type"])
            return None

        registry.add(validated)
        position = len(registry)
        logger.info("emit_card registered a '%s' card as card %d", validated["type"], position)
        return position

    def _emit_one(payload: object) -> str:
        """One card object: the refusal it earned, or the marker to write."""
        validated, refusal = _validated_or_refusal(payload)
        if refusal is not None:
            return refusal

        position = _register(validated)
        if position is None:
            return _NO_CHANNEL

        return (
            f"Card '{validated['type']}' will be shown with your answer, as card {position}. "
            f"Write [[card:{position}]] on a line of its own at the point in your answer where the "
            "card belongs, and it is drawn there instead of after the whole answer. Leave the marker "
            "out and the card lands at the end."
        )

    def _emit_many(payloads: list) -> str:
        """The array form: every element validated, the sound ones registered.

        A refusal carries the element's INDEX and the type it declared. The
        model wrote the whole array in one call, so "card of type 'x' failed
        validation" on its own leaves it guessing which object to fix — and the
        cards that did register are already in the registry, so a blanket retry
        would duplicate them.
        """
        if not payloads:
            return "Error: card_json is an empty array. Pass at least one card object."

        markers: list[str] = []
        refusals: list[str] = []
        for index, element in enumerate(payloads):
            validated, refusal = _validated_or_refusal(element)
            if refusal is not None:
                refusals.append(f"Card at index {index} (type '{_declared_type(element)}'): {refusal}")
                continue
            position = _register(validated)
            if position is None:
                return _NO_CHANNEL
            markers.append(f"[[card:{position}]]")

        return _many_result(markers, refusals)

    async def _emit(card_json: str) -> str:
        """Validate and register one Grid response card, or an array of them."""
        try:
            # strict=False: a raw newline inside a JSON string is how a model
            # writes the ONE card whose payload is a multi-line mermaid source.
            # Refusing it as "not valid JSON" rejected every diagram the field
            # produced while every short-fielded card sailed through.
            payload = json.loads(card_json, strict=False) if isinstance(card_json, str) else card_json
        except (json.JSONDecodeError, TypeError) as exc:
            logger.warning("emit_card rejected a card: card_json is not valid JSON (%s)", exc)
            return (
                f"Error: card_json is not valid JSON ({exc}). "
                "Pass a JSON object with a 'type' field, or an array of them."
            )

        if isinstance(payload, list):
            return _emit_many(payload)
        return _emit_one(payload)

    yield FunctionInfo.from_fn(_emit, description=_build_tool_description())


class DescribeCardConfig(FunctionBaseConfig, name="describe_card"):
    """Configuration for the ``describe_card`` tool."""


@register_function(config_type=DescribeCardConfig)
async def describe_card(tool_config: DescribeCardConfig, builder: Builder):
    """L2 of the card vocabulary: shapes on demand, so L1 can stay one line each."""

    async def _describe(card_types: str) -> str:
        requested = [t.strip() for t in str(card_types).replace(" ", ",").split(",") if t.strip()]
        if not requested:
            return "Error: pass at least one card type name, e.g. 'stair_diagram'."

        known = model_facing_card_types()
        # Report the unknown names rather than rendering only what resolved: a
        # silently shorter answer reads as "that card does not exist", and the
        # model's next move would be to invent a shape for it.
        unknown = [t for t in requested if t not in known]
        detail = render_card_details(requested)

        if not detail:
            return f"No such card type: {', '.join(unknown)}. Available types: {', '.join(sorted(known))}."
        if unknown:
            detail += f"\n\nNot a card type, ignored: {', '.join(unknown)}."
        return detail

    yield FunctionInfo.from_fn(_describe, description=_DESCRIBE_DESCRIPTION)
