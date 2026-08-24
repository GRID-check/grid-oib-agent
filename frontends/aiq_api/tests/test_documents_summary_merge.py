"""Tests for merging persisted document summaries into the documents listing.

Covers ``_merge_summaries``, the route-level seam that layers SummaryStore rows
(the source of truth) onto the ingestor's collection file list.
"""

from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.knowledge.schema import FileInfo
from aiq_agent.knowledge.schema import FileStatus
from aiq_api.routes.documents import _merge_summaries


def _file(name: str, summary: str | None = None) -> FileInfo:
    return FileInfo(
        file_id=name,
        file_name=name,
        collection_name="proj_abc",
        status=FileStatus.SUCCESS,
        summary=summary,
    )


def test_merges_summary_onto_matching_file():
    files = [_file("plan.pdf"), _file("specs.pdf")]
    summaries = [
        AvailableDocument(file_name="plan.pdf", summary="A ground-floor plan."),
        AvailableDocument(file_name="specs.pdf", summary="Structural specs."),
    ]

    _merge_summaries(files, summaries)

    assert files[0].summary == "A ground-floor plan."
    assert files[1].summary == "Structural specs."


def test_file_without_summary_row_stays_none():
    files = [_file("plan.pdf"), _file("orphan.pdf")]
    summaries = [AvailableDocument(file_name="plan.pdf", summary="Only this one.")]

    _merge_summaries(files, summaries)

    assert files[0].summary == "Only this one."
    assert files[1].summary is None


def test_empty_summaries_leaves_files_untouched():
    files = [_file("plan.pdf")]

    _merge_summaries(files, [])

    assert files[0].summary is None


def test_summary_row_without_matching_file_is_ignored():
    # A summary persisted for a file no longer in the vector store must not
    # invent a document row.
    files = [_file("plan.pdf")]
    summaries = [AvailableDocument(file_name="deleted.pdf", summary="Stale.")]

    _merge_summaries(files, summaries)

    assert files[0].summary is None
    assert len(files) == 1


def test_existing_summary_is_not_overwritten():
    files = [_file("plan.pdf", summary="Already set.")]
    summaries = [AvailableDocument(file_name="plan.pdf", summary="From store.")]

    _merge_summaries(files, summaries)

    assert files[0].summary == "Already set."


def test_summary_row_with_none_summary_is_skipped():
    files = [_file("plan.pdf")]
    summaries = [AvailableDocument(file_name="plan.pdf", summary=None)]

    _merge_summaries(files, summaries)

    assert files[0].summary is None


def test_merges_tags_onto_matching_file():
    files = [_file("plan.pdf")]
    summaries = [
        AvailableDocument(file_name="plan.pdf", summary="A plan.", tags=["Grundriss", "Brandschutz"]),
    ]

    _merge_summaries(files, summaries)

    assert files[0].summary == "A plan."
    assert files[0].tags == ["Grundriss", "Brandschutz"]


def test_file_without_tags_row_stays_none():
    files = [_file("plan.pdf")]
    summaries = [AvailableDocument(file_name="plan.pdf", summary="A plan.")]

    _merge_summaries(files, summaries)

    assert files[0].tags is None


def test_existing_tags_are_not_overwritten():
    files = [_file("plan.pdf")]
    files[0].tags = ["Schnitt"]
    summaries = [AvailableDocument(file_name="plan.pdf", summary="A plan.", tags=["Grundriss"])]

    _merge_summaries(files, summaries)

    assert files[0].tags == ["Schnitt"]


def test_merges_the_folder_path_onto_matching_file():
    """The collection listing states where each document is filed (ADR-0049).

    `list_files` only knows what the vector store holds; the filing lives on the
    metadata row beside the summary and the tags, and this is the one seam that
    puts the two together for the listing contract.
    """
    files = [_file("plan.pdf")]
    summaries = [
        AvailableDocument(
            file_name="plan.pdf",
            summary="A ground-floor plan.",
            folder_path="Brandschutz/Fluchtwege",
        )
    ]

    _merge_summaries(files, summaries)

    assert files[0].folder_path == "Brandschutz/Fluchtwege"


def test_file_filed_at_the_root_keeps_a_null_folder_path():
    files = [_file("plan.pdf")]
    summaries = [AvailableDocument(file_name="plan.pdf", summary="At the root.")]

    _merge_summaries(files, summaries)

    assert files[0].folder_path is None
