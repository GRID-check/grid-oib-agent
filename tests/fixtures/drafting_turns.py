"""The three drafting turn shapes, and the one assertion both harnesses make.

A drafting turn is the shape the Piloti-writes work added and nothing measured:
someone commissions a document, has it revised, and files it into the project.
Ledger row 5 asked for the three against a live model; this module is what
keeps that eval and the scripted one from drifting into two different tests.

The **prompts** live here because a live case and a fake-LLM case that ask
different questions stop being the same case the day one of them is edited.
The **assertion** lives here for the same reason, and because it is the whole
of what "turn shape" means: which tools ran, what the reader was shown, and
what kind of answer came back. Neither harness may add a rule of its own
without adding it here.

What is deliberately NOT asserted: the prose. A live model writes a different
Aktenvermerk every run, and an eval that pins wording measures the model's
mood. What must hold is that the document was WRITTEN rather than described,
that the card the reader acts on exists and knows whether it has been filed,
and that a drafting turn never grows a ruling's masthead — a verdict on
„schreib mir einen Aktenvermerk" is the compliance-checker voice leaking into
a turn that has nothing to rule on.

Used by:

* ``tests/benchmarks/test_turn_shapes_live.py`` — the real model, stub
  retrieval, real working directory (skips without ``OPENROUTER_API_KEY``).
* ``tests/aiq_agent/agents/piloti/test_agent.py`` — the same three through the
  compiled graph on a scripted LLM, which is what runs in CI.
"""

from __future__ import annotations

from dataclasses import dataclass
from dataclasses import field
from typing import Any

#: The card a drafting turn owes the reader. Two states, and the difference is
#: three fields the card model refuses to carry apart (``DocumentDraftCard``).
UNFILED = "unfiled"
FILED = "filed"

#: Answer kinds a drafting turn may come back as. ``ruling`` is the one that
#: must never appear: it is the shape that carries a verdict masthead, and
#: „leg das ins Projekt ab" has no legal value to put in one. ``handoff``
#: is excluded too — writing an Aktenvermerk is this turn's work, not deep
#: research's. ``None`` is the legacy envelope and stays allowed.
DRAFTING_ANSWER_KINDS: frozenset[str | None] = frozenset({None, "direct", "walkthrough"})


@dataclass(frozen=True)
class DraftingCase:
    """One commissioned document turn, as both harnesses run it."""

    id: str
    prompt: str
    #: Every one of these must have been called. The verb IS the case.
    required_tools: tuple[str, ...]
    #: None of these may have been called: a commission that files, or a
    #: revision that writes a second file, is a different turn than the one
    #: asked for.
    forbidden_tools: tuple[str, ...] = ()
    #: The draft the working directory holds when the turn starts, as
    #: ``{path: content}``. Empty for the commission, which creates it.
    seed: dict[str, str] = field(default_factory=dict)
    #: What the ``document_draft`` card must say afterwards.
    card: str = UNFILED


_AKTENVERMERK = "/entwuerfe/aktenvermerk-ma37-fluchtweg.md"

_SEEDED_DRAFT = (
    "# Aktenvermerk – Besprechung MA 37\n\n"
    "## 1. Anlass\nBesprechung mit der MA 37 am 3. September.\n\n"
    "## 2. Teilnehmer\nBauwerberin, Entwurfsverfasser, MA 37.\n\n"
    "## 3. Fluchtweg\nDer zweite Fluchtweg über das Stiegenhaus Ost wurde besprochen. "
    "Die Behörde hält die Länge des Fluchtwegs für klärungsbedürftig und erwartet eine "
    "Darstellung im Einreichplan, aus der die Gehweglänge bis ins Freie hervorgeht.\n\n"
    "## 4. Vereinbartes\nDer Einreichplan wird ergänzt.\n"
)

COMMISSION = DraftingCase(
    id="commission",
    prompt="Schreib mir einen Aktenvermerk zur Besprechung mit der MA 37 über den Fluchtweg",
    required_tools=("write_file",),
    # A commission produces a draft in the conversation. Filing it is a second
    # request the reader has not made yet, and the tool description says so in
    # as many words („nicht von selbst nach jedem Schreiben").
    forbidden_tools=("file_draft", "submit_draft"),
    card=UNFILED,
)

REVISE = DraftingCase(
    id="revise",
    prompt="Kürze Punkt 3 des Aktenvermerks",
    # An edit, not a rewrite: `write_file` here would be a second document with
    # the same content, and the reader's version history would show a new file
    # rather than a shortened paragraph.
    required_tools=("edit_file",),
    forbidden_tools=("write_file", "file_draft", "submit_draft"),
    seed={_AKTENVERMERK: _SEEDED_DRAFT},
    card=UNFILED,
)

FILE = DraftingCase(
    id="file",
    prompt="Leg den Aktenvermerk ins Projekt ab",
    required_tools=("file_draft",),
    # Filing is not submitting. „Ablegen" asks nobody to review anything, and
    # a turn that submits has put an item in a colleague's inbox uninvited.
    forbidden_tools=("submit_draft",),
    seed={_AKTENVERMERK: _SEEDED_DRAFT},
    card=FILED,
)

DRAFTING_CASES: tuple[DraftingCase, ...] = (COMMISSION, REVISE, FILE)

#: The path the seeded cases hand the model, so a test that needs to name it
#: (a scripted tool call) and the seed itself cannot disagree.
SEEDED_DRAFT_PATH = _AKTENVERMERK


def draft_cards(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Just the ``document_draft`` cards, in the order the reader sees them."""
    return [card for card in cards if card.get("type") == "document_draft"]


def assert_turn_shape(
    case: DraftingCase,
    *,
    called_tools: list[str],
    cards: list[dict[str, Any]],
    answer_meta: dict[str, Any] | None,
    escalated: bool,
) -> None:
    """The whole shape of a drafting turn. Raises ``AssertionError`` with the trace.

    Args:
        case: Which of the three.
        called_tools: Tool names the turn called, in order.
        cards: The turn's card registry snapshot.
        answer_meta: The gated envelope anatomy from the state, or ``None``.
        escalated: Whether the envelope asked for deep research.
    """
    for name in case.required_tools:
        assert name in called_tools, f"{case.id}: {name} was never called; trace was {called_tools}"
    for name in case.forbidden_tools:
        assert name not in called_tools, f"{case.id}: {name} was called uninvited; trace was {called_tools}"

    drafts = draft_cards(cards)
    assert drafts, f"{case.id}: the reader was shown no document_draft card"
    latest = drafts[-1]
    filed = latest.get("document_id") is not None
    assert filed is (case.card == FILED), f"{case.id}: card filed={filed}, expected {case.card}: {latest}"
    if case.card == FILED:
        # The three travel together or the card cannot offer the two controls
        # that make a filed draft actionable.
        assert latest.get("version_id") and latest.get("version_state"), latest

    assert escalated is False, f"{case.id}: a drafting turn handed itself to deep research"
    meta = answer_meta or {}
    assert meta.get("kind") in DRAFTING_ANSWER_KINDS, f"{case.id}: answer kind {meta.get('kind')!r}"
    assert "verdict" not in meta, f"{case.id}: a drafting turn grew a verdict masthead: {meta.get('verdict')}"
