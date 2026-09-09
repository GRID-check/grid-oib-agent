"""Rendering primitives both BIM tools share: clipped lists and the unresolved-model reply."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

#: Plural noun → the whole singular phrase, article included. A lookup rather
#: than a rule because German plurals and genders are not derivable, and
#: "ein weiteres Raum" in an answer an architect reads is worse than a wrong
#: number.
_ONE_MORE_DE = {
    "Geschoße": "ein weiteres Geschoß",
    "Bauteile": "ein weiteres Bauteil",
    "Bauteiltypen": "ein weiterer Bauteiltyp",
    "betroffene Bauteile": "ein weiteres betroffenes Bauteil",
    "Räume": "ein weiterer Raum",
    "Räume ohne Türkante": "ein weiterer Raum ohne Türkante",
    "Regeln": "eine weitere Regel",
    "Gruppen": "eine weitere Gruppe",
    "Merkmale": "ein weiteres Merkmal",
    "fehlende Merkmale": "ein weiteres fehlendes Merkmal",
    "neue Bauteile": "ein weiteres neues Bauteil",
    "entfallene Bauteile": "ein weiteres entfallenes Bauteil",
    "geänderte Bauteile": "ein weiteres geändertes Bauteil",
    "Einträge": "ein weiterer Eintrag",
    "unbestimmte Türen": "eine weitere unbestimmte Tür",
    "ausgeschlossene Türen": "eine weitere ausgeschlossene Tür",
}


def clipped(items: list, shown: int, noun: str) -> str | None:
    """A line saying what a clipped list left out, or None when nothing was.

    Every list a renderer cuts must say so, or the agent presents fifty rows as
    the whole set. Singular when exactly one was left out.
    """
    missing = len(items) - shown
    if missing <= 0:
        return None
    if missing == 1:
        return f"… {_ONE_MORE_DE.get(noun, f'ein weiteres {noun}')} nicht gezeigt."
    return f"… {missing} weitere {noun} nicht gezeigt."


def listed(
    items: list,
    shown: int,
    noun: str,
    render: Callable[[Any], str | list[str]],
    *,
    indent: str = "",
) -> list[str]:
    """The first ``shown`` items rendered, followed by the clip note when the list was cut."""
    lines: list[str] = []
    for item in items[:shown]:
        rendered = render(item)
        lines.extend([rendered] if isinstance(rendered, str) else rendered)
    note = clipped(items, shown, noun)
    return lines + [f"{indent}{note}"] if note else lines


def render_unresolved(result: dict[str, Any], fallback: str) -> str:
    """A model that could not be selected, with the alternatives when there are any.

    "Verfügbare" only when the list really is a set of alternatives: on
    ``not_ready`` the route returns the model that could not be read, and
    calling that available beside "(processing, 0 Bauteile)" reads as a
    building with no elements.
    """
    message = result.get("message") or fallback
    models = result.get("models") or []
    if not models:
        return str(message)
    listed_models = ", ".join(
        f"{m.get('filename')} ({m.get('status')}, {m.get('elements', 0)} Bauteile)" for m in models[:10]
    )
    heading = (
        "Verfügbare Modelle"
        if result.get("reason") in {"no_match", "ambiguous"}
        else "Modelle in diesem Projekt (noch nicht abfragbar)"
    )
    return f"{message} {heading}: {listed_models}."
