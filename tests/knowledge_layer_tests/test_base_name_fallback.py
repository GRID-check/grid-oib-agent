"""A ``file_name=`` that names nothing empties a law search; the miss must say how to recover.

Reproduction of the empty reply to "Welche Absturzhöhe bei den Brüstungen ...":
the prompt said the user had a file open, the model passed that name as
``file_name=``, and the filter dropped every OIB hit. The filter stays a filter
(another file's hits would be a silent bait-and-switch); the empty-search
message tells the model a norm question is answered without the name.
"""

from __future__ import annotations

from types import SimpleNamespace

from sources.knowledge_layer.src.register import _apply_agent_filters
from sources.knowledge_layer.src.register import _empty_search_message


def _chunk(file_name: str, collection: str) -> SimpleNamespace:
    return SimpleNamespace(
        chunk_id=file_name,
        file_name=file_name,
        content="text",
        score=0.9,
        content_type=SimpleNamespace(value="text"),
        metadata={"collection": collection},
    )


def test_a_name_that_matches_no_hit_empties_the_law_search() -> None:
    pool = [_chunk("OIB-RL 4.pdf", "oib_knowledge"), _chunk("Museum-Grundriss.pdf", "project_x")]
    assert _apply_agent_filters(pool, None, None, "Anderer-Plan.pdf") == []


def test_the_miss_with_a_file_name_says_to_retry_without_it_for_the_law() -> None:
    text = _empty_search_message("Absturzhöhe Brüstung", file_name="Museum-Grundriss.pdf")
    assert "WITHOUT `file_name=`" in text


def test_the_miss_without_a_file_name_does_not_mention_dropping_one() -> None:
    assert "WITHOUT" not in _empty_search_message("Absturzhöhe Brüstung")
