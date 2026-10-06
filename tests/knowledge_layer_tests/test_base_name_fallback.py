"""A ``file_name=`` that names nothing must not empty a base-corpus (law) search.

Reproduction of the empty reply to "Welche Absturzhöhe bei den Brüstungen ...":
the prompt tells the model the user has a file open, the model passes that
name as ``file_name=``, and the hard filter dropped every OIB hit.
"""

from __future__ import annotations

from types import SimpleNamespace

from sources.knowledge_layer.src.register import _apply_agent_filters
from sources.knowledge_layer.src.register import _narrow_with_base_name_fallback

BASE = "oib_knowledge"


def _chunk(file_name: str, collection: str) -> SimpleNamespace:
    return SimpleNamespace(
        chunk_id=file_name,
        file_name=file_name,
        content="text",
        score=0.9,
        content_type=SimpleNamespace(value="text"),
        metadata={"collection": collection},
    )


def _pool() -> list:
    return [_chunk("OIB-RL 4.pdf", BASE), _chunk("Museum-Grundriss.pdf", "project_x")]


def _narrow(file_name: str) -> list[str]:
    kept = _narrow_with_base_name_fallback(
        _pool(),
        base_collection=BASE,
        doc_class=None,
        title_contains=None,
        file_name=file_name,
        folder=None,
    )
    return [c.file_name for c in kept]


def test_the_plain_filter_empties_the_law_search() -> None:
    """The cause: the filter alone leaves nothing for a name that matches no hit."""
    assert _apply_agent_filters(_pool(), None, None, "Anderer-Plan.pdf") == []


def test_a_name_that_matches_no_hit_keeps_the_base_hits() -> None:
    assert _narrow("Anderer-Plan.pdf") == ["OIB-RL 4.pdf"]


def test_a_name_that_matches_still_filters() -> None:
    assert _narrow("Museum-Grundriss.pdf") == ["Museum-Grundriss.pdf"]
