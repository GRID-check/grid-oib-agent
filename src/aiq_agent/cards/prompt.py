"""Shared prompt builder for post-hoc Grid response card generation."""

from aiq_agent.cards.catalog import CHAT_ONLY_CARD_TYPES
from aiq_agent.cards.catalog import render_card_catalog
from aiq_agent.cards.catalog import render_card_doctrine

# What this path may build a card OUT OF, said before anything else it is asked to do.
#
# The synchronous tool emits a card while holding the tool rows the numbers came from; this one is
# handed the question and the finished report text and nothing else. So a card here can only
# restate the report, and a card that invents a figure is worse than one invented on the other
# path: no tool output contradicts it, and nothing downstream checks it against anything. The
# shared doctrine carries the anti-fabrication rule too — this states it again, first and in
# stronger terms, because on this surface it is the only thing between a report and a made-up
# limit on the artifact most likely to be screenshotted into a submission.
_POST_HOC_GROUNDING = """\
WHAT A CARD MAY BE BUILT OUT OF. You did not write this report and you cannot change it. Every
value you put on a card — a number, a limit, a norm reference, a pass/fail status, a deadline —
must be traceable to a sentence in the text you were given. Restate; never fabricate a field, a
reference or a number to fill a card out, never complete a half-stated one from your own
knowledge, and never sharpen a hedged statement into a definite one. Nothing downstream re-checks
these values against a source, and the card is the part that gets screenshotted into a submission.
If a value is unknown, omit it and set that check's status to "needs_input" — never estimate. If
the report does not carry what a card needs, emit no card: the report already answers the question
without it."""

# The CRAFT, in the only form this path can use: a TEST over a finished text rather than an
# instruction about writing one. The shared doctrine is rendered with `include_craft=False`, because
# its craft is written for an answer still being composed.
#
# The retired types (`RETIRED_CARD_TYPES`: the table- and list-shaped cards, `legal_basis`, the
# envelope's anatomy, `follow_ups`) are withheld from this path's catalog and dropped by
# `validate_cards`: the report's own tables, lists and quotes already carry that content, so a
# paragraph teaching one would be an instruction to build a card this path throws away.
_POST_HOC_CRAFT = """\
WHICH ONE EARNS ITS PLACE. A long report is exactly where a card pays off and exactly where they
pile up, so each has to pass its own test against the report you were given. A calculation card
only for a number the report WORKED OUT, with the operands it states — never one merely cited, and
never operands completed from your own knowledge. A table, a list or a quote in the report is
already the reader's; a card that repeats it is a restatement. One or two cards carrying real
substance is a full kit even for a very long report."""

# Ordering, which is the whole of what this path controls about placement. The runner attaches the
# returned list to the finished report as-is (see `aiq_api.jobs.runner`), so list order IS render
# order and there is no marker, no anchor and no way to put a card beside the paragraph it belongs
# to. Saying so is not pedantry: without this sentence the model has no way to know that the list it
# returns is the order the reader reads.
_POST_HOC_ORDERING = """\
WHERE THEY GO. The cards are attached after the whole report, in the order you list them — there
is no marker and no way to place one beside a paragraph. So list them in the order the answer is
built: the substance the report turns on first."""


def build_card_generation_prompt() -> str:
    """Build a system prompt for batch card generation from a finished report.

    Renders the same catalog AND the same trigger doctrine as the ``emit_card``
    tool (:func:`aiq_agent.cards.catalog.render_card_catalog` and
    :func:`~aiq_agent.cards.catalog.render_card_doctrine`), so neither the card
    shapes nor the question of which content takes which card can drift between
    the two surfaces. The doctrine matters most here: this path produces cards
    for the LONGEST answers Grid writes, and until it rendered the doctrine its
    entire instruction was "only include a card when it adds real value" — the
    disclaimer that left fifteen diagram renderers unused everywhere else.

    Three things are this path's own, and all three follow from it being
    post-hoc — handed a question and a finished report, with no tool output, no
    answer being written and no skill runtime:

    * The ``[[card:N]]`` placement contract is withheld and replaced by an
      ordering rule, because there is no text to place a marker into.
    * The IFC triggers are withheld (``include_ifc_triggers=False``), matching
      the model-backed cards this path is already not shown.
    * The per-card craft is withheld (``include_craft=False``) and the grounding
      rule leads instead, with a short post-hoc-truthful craft block standing in:
      the shared craft is written for an agent still composing the answer, and
      the only judgement available here is a test over the report as handed.

    The IFC cards are withheld because this path is handed only the question
    and the finished answer TEXT — no tool output. Every field that identifies
    something in those cards is an IFC GlobalId, a rule id or a model file
    name, none of which can be derived from prose; the model would have to
    scavenge them out of the answer or invent them, and an id that resolves to
    nothing renders as a missing element. The ``emit_card`` tool keeps them,
    because its caller has the ``ifc_query`` rows in context.

    ``ifc_model_picker`` is the one IFC card whose shape is NOT withheld: it
    carries a heading and no file name, so there is nothing in it to invent.
    Only its trigger goes, because that trigger is a live "show me the model"
    intent in the turn being answered and instructs the model to emit the card
    instead of writing the file names as prose — a trade unavailable once the
    prose is written.
    """
    return (
        "You are a structured-output assistant. Given a user question and the finished report that "
        'answered it, produce Grid response cards as a JSON object of the form {"cards": [ ...card '
        "objects... ]}. Use an empty array when no card adds value.\n\n"
        + _POST_HOC_GROUNDING
        + "\n\nFields marked * are required; omit optional fields you cannot fill (do NOT pass null "
        "for optional objects).\n\n"
        + render_card_doctrine(include_ifc_triggers=False, include_craft=False)
        + "\n\n"
        + _POST_HOC_CRAFT
        + "\n\n"
        + _POST_HOC_ORDERING
        + "\n\n"
        + render_card_catalog(include_model_backed=False, exclude=CHAT_ONLY_CARD_TYPES)
        + "\n\nRespond ONLY with the JSON object — no prose, no code fences."
    )
