"""The ``[N]`` in a surface's ``Text`` leaves, held to the answer's own citations.

A ``Text`` leaf is Markdown the answer would otherwise have written in its prose
(``models.SURFACE_TEXT``), so it cites the way the prose does. But citation
verification and the renumbering that closes the gaps it leaves run over the
prose alone: without this pass a tab would keep a ``[3]`` that now means a
different source, or one the check removed.

The rule is the reader's: a number in a tab points at a chip in the answer's
"Belegt durch" row, or it is not drawn. So each ``[N]`` follows the prose's
own steps in the prose's order: a group (``[2, 3]``) is expanded as the prose's
is, a duplicate source line's number is merged onto the line it duplicates as
the verifier rewrote it in the prose, and the survivor follows sanitize's
renumbering. One that does not land on a source the answer cites is dropped
rather than guessed at.
"""

from __future__ import annotations

import re
from collections.abc import Collection
from collections.abc import Mapping
from typing import Any

from pydantic import ValidationError

from aiq_agent.cards.models import SURFACE_LAYOUTS
from aiq_agent.cards.models import SURFACE_TEXT
from aiq_agent.cards.models import SurfaceCard
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.common.citation_verification import _map_outside_code
from aiq_agent.common.citation_verification import expand_grouped_citations

#: A bare ``[N]`` with the blanks before it: not a ``[[card:N]]`` marker, not
#: the label of a Markdown link. The blanks are group 1 so a dropped marker
#: takes them along and nothing else in the text is touched.
_CITATION = re.compile(r"([ \t ]*)(?<!\[)\[(\d+)\](?![\](])")

_NO_MERGES: Mapping[int, int] = {}

#: What a recited ``Text`` leaf says when it cited nothing that survived and
#: the surface cannot stand without it (:func:`recite_surface`).
BLANK_TEXT = "—"


def recite_text(
    text: str,
    renumber: Mapping[int, int],
    cited: Collection[int],
    merged: Mapping[int, int] = _NO_MERGES,
) -> str:
    """``text`` with each ``[N]`` renumbered, or removed when it is not a cited source.

    ``merged`` maps a duplicate source line's number to the line it duplicates
    (``citation_verification.merged_citations``), in the numbering before
    sanitize's; ``renumber`` is sanitize's map of every survivor, old to new.
    A removed marker goes with the blanks before it (``REI 90 [4].`` becomes
    ``REI 90.``), and nothing outside the markers changes. Code (a fence, an
    inline span) is left as written: ``S[1]`` there is a node, not a source.
    """

    def replace(match: re.Match[str]) -> str:
        old = int(match.group(2))
        old = merged.get(old, old)
        # The map lists every number that SURVIVED (sanitize's renumbering), so
        # one missing from it was removed. Passing it through unchanged would
        # land it on whichever survivor was renumbered onto that number.
        new = renumber.get(old) if renumber else old
        return f"{match.group(1)}[{new}]" if new is not None and new in cited else ""

    # Outside code only: `x[1]` or a mermaid node `S[1]` is source, not a citation.
    return _map_outside_code(
        text,
        lambda prose: _CITATION.sub(replace, expand_grouped_citations(prose)),
        unterminated_fence_is_code=False,
    )


def recite_surface(
    card: dict[str, Any],
    renumber: Mapping[int, int],
    cited: Collection[int],
    merged: Mapping[int, int] = _NO_MERGES,
) -> dict[str, Any]:
    """The card with its ``Text`` leaves recited; any other card is returned as it is.

    A ``Text`` leaf whose only content was markers that were all removed is
    empty, and an empty leaf fails the surface's validation, so the frontend
    would refuse the whole surface. That leaf is dropped with every reference
    to it (a Row's or Column's child, a tab). When the surface does not hold
    together without it (a container left with one child, a surface left with
    one leaf), the one card left standing is the card; failing that, the leaf
    stays and says :data:`BLANK_TEXT`. Never the unrecited original: its other
    leaves would keep numbers that now name a different source, or none.
    """
    if card.get("type") != "surface":
        return card
    components = [
        {**component, "text": recite_text(str(component.get("text", "")), renumber, cited, merged)}
        if component.get("component") == SURFACE_TEXT
        else component
        for component in card.get("components", [])
    ]
    blank = {
        component.get("id")
        for component in components
        if component.get("component") == SURFACE_TEXT and not component["text"].strip()
    }
    if not blank:
        return {**card, "components": components}
    kept = [_without(component, blank) for component in components if component.get("id") not in blank]
    recited = {**card, "components": kept}
    if _stands(recited):
        return recited
    return _hoisted(kept) or {
        **card,
        "components": [
            {**component, "text": BLANK_TEXT} if component.get("id") in blank else component for component in components
        ],
    }


def _stands(surface: dict[str, Any]) -> bool:
    try:
        SurfaceCard.model_validate(surface)
    except ValidationError:
        return False
    return True


def _hoisted(components: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The one card among ``components`` as a card on its own, or ``None``."""
    leaves = [component for component in components if component.get("component") not in SURFACE_LAYOUTS]
    if len(leaves) != 1 or leaves[0].get("component") == SURFACE_TEXT:
        return None
    props = {key: value for key, value in leaves[0].items() if key not in ("id", "component")}
    try:
        return grid_card_adapter.validate_python({**props, "type": leaves[0]["component"]}).model_dump(
            exclude_none=True
        )
    except ValidationError:
        return None


def _without(component: dict[str, Any], ids: set[Any]) -> dict[str, Any]:
    """``component`` with no reference to ``ids`` left among its children or tabs."""
    if isinstance(component.get("children"), list):
        return {**component, "children": [child for child in component["children"] if child not in ids]}
    if isinstance(component.get("tabs"), list):
        tabs = [tab for tab in component["tabs"] if not (isinstance(tab, dict) and tab.get("child") in ids)]
        return {**component, "tabs": tabs}
    return component
