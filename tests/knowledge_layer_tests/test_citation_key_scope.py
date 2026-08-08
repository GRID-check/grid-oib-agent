"""A citation key names a document, and a filename alone sometimes cannot.

One ``knowledge_search`` fans out across the base corpus, the session collection
and the project collections concurrently and merges the hits, so one result set
can hold a project ``Plan.pdf`` and a Büroarchiv ``Plan.pdf`` — two different
documents. When that happens the ``Citation:`` field the LLM copies verbatim is
qualified with the shelf, and only then: the ordinary case must stay a plain
filename, because the qualifier is visible to the user in the answer's sources.
"""

from __future__ import annotations

from types import SimpleNamespace

from sources.knowledge_layer.src.register import _ambiguous_file_names
from sources.knowledge_layer.src.register import _format_results


def _chunk(*, file_name: str, collection: str, page: int | None = 3):
    return SimpleNamespace(
        file_name=file_name,
        page_number=page,
        content="snippet",
        content_type=SimpleNamespace(value="text"),
        score=0.9,
        metadata={"collection": collection},
    )


def _format(chunks) -> str:
    return _format_results(SimpleNamespace(success=True, chunks=chunks, error_message=None), "q")


def test_a_name_held_on_one_shelf_is_not_qualified():
    text = _format(
        [
            _chunk(file_name="Plan.pdf", collection="proj_alpha"),
            _chunk(file_name="Konzept.pdf", collection="proj_alpha", page=7),
        ]
    )
    assert "Citation: Plan.pdf, p.3" in text
    assert "Citation: Konzept.pdf, p.7" in text
    assert "(Projektwissen)" not in text


def test_a_name_held_on_two_shelves_is_qualified_on_both():
    text = _format(
        [
            _chunk(file_name="Plan.pdf", collection="proj_alpha"),
            _chunk(file_name="Plan.pdf", collection="archiv_org1"),
        ]
    )
    assert "Citation: Plan.pdf (Projektwissen), p.3" in text
    assert "Citation: Plan.pdf (Büroarchiv), p.3" in text


def test_only_the_ambiguous_name_is_qualified():
    # A collision must not make every other citation in the same answer wear a
    # qualifier it does not need.
    text = _format(
        [
            _chunk(file_name="Plan.pdf", collection="proj_alpha"),
            _chunk(file_name="Plan.pdf", collection="archiv_org1"),
            _chunk(file_name="Konzept.pdf", collection="proj_alpha", page=7),
        ]
    )
    assert "Citation: Konzept.pdf, p.7" in text
    assert "Citation: Konzept.pdf (Projektwissen)" not in text


def test_two_collections_on_the_same_shelf_are_not_a_collision():
    # The session collection and a project collection are both Projektwissen, so
    # the qualifier could not tell them apart anyway — emitting one would add
    # noise to the citation without adding information.
    chunks = [
        _chunk(file_name="Plan.pdf", collection="s_9f2a4c"),
        _chunk(file_name="Plan.pdf", collection="proj_alpha"),
    ]
    assert _ambiguous_file_names(chunks) == set()
    assert "(Projektwissen)" not in _format(chunks)


def test_the_display_title_is_unaffected():
    # `Source:` is the human label and `Citation:` the identity; only the latter
    # is qualified.
    text = _format(
        [
            _chunk(file_name="Plan.pdf", collection="proj_alpha"),
            _chunk(file_name="Plan.pdf", collection="archiv_org1"),
        ]
    )
    assert "Source: Plan.pdf\n" in text
