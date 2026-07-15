"""Tests for the classify-only tag backfill script's per-row logic.

The batch driver and CLI are thin; the interesting behaviour is
``process_row`` — text-source selection, idempotency, dry-run, and fail-soft
per-row handling — exercised here with a mock LLM and a fake store.
"""

import importlib.util
import sys
from pathlib import Path
from unittest.mock import MagicMock

from aiq_agent.knowledge.schema import AvailableDocument

REPO_ROOT = Path(__file__).resolve().parents[1]


def _load_backfill():
    """Import ``scripts/backfill_document_tags.py`` without requiring a package."""
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))
    spec = importlib.util.spec_from_file_location(
        "scripts.backfill_document_tags",
        REPO_ROOT / "scripts" / "backfill_document_tags.py",
    )
    module = importlib.util.module_from_spec(spec)
    # Register before exec so @dataclass can resolve the module's namespace.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


backfill = _load_backfill()


class FakeStore:
    """Records update_tags calls; returns whether the (coll, file) 'exists'."""

    def __init__(self, existing: set[tuple[str, str]] | None = None):
        self.updates: list[tuple[str, str, list[str]]] = []
        self.existing = existing if existing is not None else set()

    def update_tags(self, collection: str, file_name: str, tags: list[str]) -> bool:
        self.updates.append((collection, file_name, tags))
        return (collection, file_name) in self.existing


def _llm_returning(tags):
    """A mock LLM whose .invoke returns a JSON array of the given tags."""
    import json

    llm = MagicMock()
    llm.invoke.return_value = MagicMock(content=json.dumps(tags))
    return llm


def test_tags_row_using_summary_when_no_fetcher():
    store = FakeStore(existing={("c", "doc.pdf")})
    doc = AvailableDocument(file_name="doc.pdf", summary="A floor plan.", tags=None)
    llm = _llm_returning(["Grundriss", "Brandschutz"])

    outcome = backfill.process_row("c", doc, llm=llm, update_fn=store.update_tags)

    assert outcome == backfill.TAGGED
    assert store.updates == [("c", "doc.pdf", ["Grundriss", "Brandschutz"])]


def test_prefers_chunk_text_over_summary():
    store = FakeStore(existing={("c", "doc.pdf")})
    doc = AvailableDocument(file_name="doc.pdf", summary="Short summary.", tags=None)
    llm = _llm_returning(["Grundriss"])
    seen = {}

    def fetcher(collection, file_name):
        seen["called"] = (collection, file_name)
        return "Full indexed chunk text about a floor plan."

    outcome = backfill.process_row(
        "c", doc, llm=llm, update_fn=store.update_tags, text_fetcher=fetcher
    )

    assert outcome == backfill.TAGGED
    assert seen["called"] == ("c", "doc.pdf")
    # The chunk text (not the summary) was sent to the LLM.
    prompt = llm.invoke.call_args[0][0]
    assert "Full indexed chunk text" in prompt


def test_falls_back_to_summary_when_fetcher_returns_none():
    store = FakeStore(existing={("c", "doc.pdf")})
    doc = AvailableDocument(file_name="doc.pdf", summary="A summary source.", tags=None)
    llm = _llm_returning(["Grundriss"])

    outcome = backfill.process_row(
        "c", doc, llm=llm, update_fn=store.update_tags, text_fetcher=lambda c, f: None
    )

    assert outcome == backfill.TAGGED
    assert "A summary source." in llm.invoke.call_args[0][0]


def test_existing_tags_skipped_without_force():
    store = FakeStore()
    doc = AvailableDocument(file_name="doc.pdf", summary="S.", tags=["Grundriss"])
    llm = _llm_returning(["Schnitt"])

    outcome = backfill.process_row("c", doc, llm=llm, update_fn=store.update_tags)

    assert outcome == backfill.SKIPPED
    assert store.updates == []
    llm.invoke.assert_not_called()


def test_existing_tags_reclassified_with_force():
    store = FakeStore(existing={("c", "doc.pdf")})
    doc = AvailableDocument(file_name="doc.pdf", summary="S.", tags=["Grundriss"])
    llm = _llm_returning(["Schnitt"])

    outcome = backfill.process_row("c", doc, llm=llm, update_fn=store.update_tags, force=True)

    assert outcome == backfill.TAGGED
    assert store.updates == [("c", "doc.pdf", ["Schnitt"])]


def test_dry_run_writes_nothing():
    store = FakeStore(existing={("c", "doc.pdf")})
    doc = AvailableDocument(file_name="doc.pdf", summary="S.", tags=None)
    llm = _llm_returning(["Grundriss"])

    outcome = backfill.process_row("c", doc, llm=llm, update_fn=store.update_tags, dry_run=True)

    assert outcome == backfill.TAGGED
    assert store.updates == []


def test_no_tags_produced_is_failure():
    store = FakeStore(existing={("c", "doc.pdf")})
    doc = AvailableDocument(file_name="doc.pdf", summary="S.", tags=None)
    llm = _llm_returning([])  # empty after filtering -> classify returns None

    outcome = backfill.process_row("c", doc, llm=llm, update_fn=store.update_tags)

    assert outcome == backfill.FAILED
    assert store.updates == []


def test_off_vocabulary_tags_dropped_then_failure():
    store = FakeStore(existing={("c", "doc.pdf")})
    doc = AvailableDocument(file_name="doc.pdf", summary="S.", tags=None)
    llm = _llm_returning(["Feuerschutz", "NichtEcht"])  # all dropped -> None

    outcome = backfill.process_row("c", doc, llm=llm, update_fn=store.update_tags)

    assert outcome == backfill.FAILED
    assert store.updates == []


def test_store_update_matching_no_row_is_failure():
    store = FakeStore(existing=set())  # update_tags returns False (row vanished)
    doc = AvailableDocument(file_name="doc.pdf", summary="S.", tags=None)
    llm = _llm_returning(["Grundriss"])

    outcome = backfill.process_row("c", doc, llm=llm, update_fn=store.update_tags)

    assert outcome == backfill.FAILED
    assert store.updates == [("c", "doc.pdf", ["Grundriss"])]


def test_classification_exception_is_fail_soft():
    store = FakeStore(existing={("c", "doc.pdf")})
    doc = AvailableDocument(file_name="doc.pdf", summary="S.", tags=None)
    llm = MagicMock()
    llm.invoke.side_effect = RuntimeError("boom")

    # classify_document_tags is itself fail-open, but assert the row is FAILED
    # (not crashing the batch) regardless.
    outcome = backfill.process_row("c", doc, llm=llm, update_fn=store.update_tags)

    assert outcome == backfill.FAILED
    assert store.updates == []


def _patch_main_deps(monkeypatch, stats, *, llm_raises=False):
    """Stub every collaborator ``main`` touches so only its exit-code logic runs."""
    from aiq_agent import knowledge

    monkeypatch.setattr(knowledge, "configure_summary_db", lambda *a, **k: None, raising=False)
    monkeypatch.setattr(knowledge, "list_summary_collections", lambda: ["c"], raising=False)

    def _build_llm():
        if llm_raises:
            raise RuntimeError("No API key")
        return MagicMock()

    monkeypatch.setattr(backfill, "build_summary_llm", _build_llm)
    monkeypatch.setattr(backfill, "make_chunk_text_fetcher", lambda chroma_dir: None)
    monkeypatch.setattr(backfill, "run_backfill", lambda **kwargs: stats)


def test_main_exit_1_when_failures(monkeypatch):
    _patch_main_deps(monkeypatch, backfill.BackfillStats(processed=2, tagged=1, skipped=0, failed=1))
    assert backfill.main(["--summary-db", "sqlite:///unused.db"]) == 1


def test_main_exit_0_when_no_failures(monkeypatch):
    _patch_main_deps(monkeypatch, backfill.BackfillStats(processed=2, tagged=2, skipped=0, failed=0))
    assert backfill.main(["--summary-db", "sqlite:///unused.db"]) == 0


def test_main_dry_run_exit_0_despite_failures(monkeypatch):
    # A dry-run writes nothing, so preview failures must not fail the process.
    _patch_main_deps(monkeypatch, backfill.BackfillStats(processed=2, tagged=0, skipped=0, failed=2))
    assert backfill.main(["--summary-db", "sqlite:///unused.db", "--dry-run"]) == 0


def test_main_exit_2_when_llm_unavailable(monkeypatch):
    _patch_main_deps(monkeypatch, backfill.BackfillStats(), llm_raises=True)
    assert backfill.main(["--summary-db", "sqlite:///unused.db"]) == 2


def test_run_backfill_aggregates_stats():
    store = FakeStore(existing={("c", "a.pdf"), ("c", "b.pdf")})
    docs = {
        "c": [
            AvailableDocument(file_name="a.pdf", summary="Sa.", tags=None),
            AvailableDocument(file_name="b.pdf", summary="Sb.", tags=["Grundriss"]),  # skipped
        ]
    }
    llm = _llm_returning(["Grundriss"])

    stats = backfill.run_backfill(
        collections=["c"],
        get_documents=lambda coll: docs[coll],
        update_fn=store.update_tags,
        llm=llm,
    )

    assert stats.processed == 2
    assert stats.tagged == 1
    assert stats.skipped == 1
    assert stats.failed == 0
