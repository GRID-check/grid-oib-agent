"""The ``[N]`` in a surface's ``Text`` leaves, held to the answer's own citations.

A ``Text`` leaf is Markdown the answer would otherwise have written in its prose
(``models.SURFACE_TEXT``), so it cites the way the prose does. But citation
verification and the renumbering that closes the gaps it leaves run over the
prose alone: without this pass a tab would keep a ``[3]`` that now means a
different source, or one the check removed.

The rule is the reader's: a number in a tab points at a chip in the answer's
"Belegt durch" row, or it is not drawn. So each ``[N]`` follows the prose's
renumbering, and one that does not land on a source the answer cites is
dropped rather than guessed at.
"""

from __future__ import annotations

import re
from collections.abc import Collection
from collections.abc import Mapping
from typing import Any

from aiq_agent.cards.models import SURFACE_TEXT

#: A bare ``[N]``: not a ``[[card:N]]`` marker, not the label of a Markdown link.
_CITATION = re.compile(r"(?<!\[)\[(\d+)\](?![\](])")


def recite_text(text: str, renumber: Mapping[int, int], cited: Collection[int]) -> str:
    """``text`` with each ``[N]`` renumbered, or removed when it is not a cited source."""

    def replace(match: re.Match[str]) -> str:
        old = int(match.group(1))
        # The map lists every number that SURVIVED (sanitize's renumbering), so
        # one missing from it was removed. Passing it through unchanged would
        # land it on whichever survivor was renumbered onto that number.
        new = renumber.get(old) if renumber else old
        return f"[{new}]" if new is not None and new in cited else ""

    recited = _CITATION.sub(replace, text)
    # A removed marker leaves the space before it: "REI 90 [4]." → "REI 90 ."
    return re.sub(r"[  ]+([.,;:)])", r"\1", recited) if recited != text else text


def recite_surface(card: dict[str, Any], renumber: Mapping[int, int], cited: Collection[int]) -> dict[str, Any]:
    """The card with its ``Text`` leaves recited; any other card is returned as it is."""
    if card.get("type") != "surface":
        return card
    components = [
        {**component, "text": recite_text(str(component.get("text", "")), renumber, cited)}
        if component.get("component") == SURFACE_TEXT
        else component
        for component in card.get("components", [])
    ]
    return {**card, "components": components}
