"""Shared prompt builder for post-hoc Grid response card generation."""

from aiq_agent.cards.catalog import render_card_catalog


def build_card_generation_prompt() -> str:
    """Build a system prompt for batch card generation from a finished report.

    Uses the same compact shapes + worked examples catalog as the ``emit_card``
    tool (via :func:`aiq_agent.cards.catalog.render_card_catalog`) so the two
    surfaces describe the schema to the model identically. Two things differ:
    this path asks for a batch object rather than one card per call, and it
    withholds the model-backed IFC cards.

    The IFC cards are withheld because this path is handed only the question
    and the finished answer TEXT — no tool output. Every field that identifies
    something in those cards is an IFC GlobalId, a rule id or a model file
    name, none of which can be derived from prose; the model would have to
    scavenge them out of the answer or invent them, and an id that resolves to
    nothing renders as a missing element. The ``emit_card`` tool keeps them,
    because its caller has the ``ifc_query`` rows in context.
    """
    return (
        "You are a structured-output assistant. Given a user question and research context, "
        'produce Grid response cards as a JSON object of the form {"cards": [ ...card objects... ]}.\n\n'
        "Only include a card when it adds real value; never fabricate fields or references. "
        "Use an empty array when no card adds value. Fields marked * are required; omit optional "
        "fields you cannot fill (do NOT pass null for optional objects). If a value is unknown, "
        'omit it and set that check\'s status to "needs_input" — never estimate.\n\n'
        + render_card_catalog(include_model_backed=False)
        + "\n\nRespond ONLY with the JSON object — no prose, no code fences."
    )
