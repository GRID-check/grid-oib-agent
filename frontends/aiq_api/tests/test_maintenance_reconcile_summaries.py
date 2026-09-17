"""The summary-reconcile sweep forgets rows whose chunks are gone, and nothing else.

Module under test: ``aiq_api.routes.maintenance.reconcile_orphaned_summaries``.

The agent's document inventory is the summaries table; retrieval is the
vector store. A summary row with no chunks behind it lists a file the agent
cannot read (the rows ``delete_file`` orphaned before it learned to forget
both together). These tests pin what the sweep forgets, what it must keep,
and that one broken collection never costs the others their sweep.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import aiq_agent.knowledge.chunk_text_store as chunk_text_store_mod
import aiq_agent.knowledge.ingest_status_store as ingest_status_mod
from aiq_agent.knowledge import factory as knowledge_factory
from aiq_agent.knowledge.schema import FileStatus
from aiq_api.routes.maintenance import reconcile_orphaned_summaries


class _Ingestor:
    """The two reads the sweep makes of the vector store, scripted per collection."""

    def __init__(self, chunk_counts: dict[str, int], files: dict[str, list[tuple[str, FileStatus]]]):
        self._chunk_counts = chunk_counts
        self._files = files
        self.list_collections_raises: Exception | None = None

    def list_collections(self):
        if self.list_collections_raises is not None:
            raise self.list_collections_raises
        return [SimpleNamespace(name=name, chunk_count=count) for name, count in self._chunk_counts.items()]

    def list_files(self, collection: str):
        entries = self._files.get(collection)
        if isinstance(entries, Exception):
            raise entries
        return [SimpleNamespace(file_name=name, status=status) for name, status in (entries or [])]


class _TextStore:
    def __init__(self) -> None:
        self.deleted: list[tuple[str, str]] = []

    def delete_by_file(self, collection: str, file_name: str) -> int:
        self.deleted.append((collection, file_name))
        return 1


@pytest.fixture
def world(monkeypatch):
    """Summaries, vector store and text store as plain dicts the test scripts."""
    summaries: dict[str, list[str]] = {}
    unregistered: list[tuple[str, str]] = []
    in_flight: dict[str, list[str]] = {}
    text_store = _TextStore()
    state = SimpleNamespace(
        summaries=summaries,
        unregistered=unregistered,
        in_flight=in_flight,
        text_store=text_store,
        ingestor=_Ingestor({}, {}),
    )

    monkeypatch.setattr(knowledge_factory, "get_active_ingestor", lambda: state.ingestor)
    monkeypatch.setattr(knowledge_factory, "list_summary_collections", lambda: list(summaries))
    monkeypatch.setattr(
        knowledge_factory,
        "get_available_documents",
        lambda collection: [SimpleNamespace(file_name=n) for n in summaries.get(collection, [])],
    )

    def _unregister(collection: str, file_name: str) -> None:
        unregistered.append((collection, file_name))
        summaries[collection] = [n for n in summaries.get(collection, []) if n != file_name]

    monkeypatch.setattr(knowledge_factory, "unregister_summary", _unregister)
    monkeypatch.setattr(chunk_text_store_mod, "get_chunk_text_store", lambda: text_store)
    monkeypatch.setattr(
        ingest_status_mod,
        "in_flight_files",
        lambda collections: {c: list(in_flight.get(c, [])) for c in collections},
    )
    return state


@pytest.mark.asyncio
async def test_forgets_a_summary_whose_chunks_are_gone_and_keeps_the_rest(world):
    world.summaries["proj_a"] = ["live.pdf", "ghost.pdf"]
    world.ingestor = _Ingestor({"proj_a": 12}, {"proj_a": [("live.pdf", FileStatus.SUCCESS)]})

    result = await reconcile_orphaned_summaries(None, dry_run=False)

    assert result["status"] == "ok"
    assert result["forgotten"] == [{"collection": "proj_a", "file_name": "ghost.pdf"}]
    assert result["orphans_found"] == 1
    assert result["orphans_forgotten"] == 1
    assert result["failures"] == []
    assert world.unregistered == [("proj_a", "ghost.pdf")]
    # The lexical mirror goes with the row.
    assert world.text_store.deleted == [("proj_a", "ghost.pdf")]
    assert world.summaries["proj_a"] == ["live.pdf"]


@pytest.mark.asyncio
async def test_dry_run_reports_and_touches_nothing(world):
    world.summaries["proj_a"] = ["ghost.pdf"]
    world.ingestor = _Ingestor({"proj_a": 3}, {"proj_a": [("other.pdf", FileStatus.SUCCESS)]})

    result = await reconcile_orphaned_summaries(None, dry_run=True)

    assert result["dry_run"] is True
    assert result["orphans_found"] == 1
    assert result["orphans_forgotten"] == 0
    assert result["forgotten"] == [{"collection": "proj_a", "file_name": "ghost.pdf"}]
    assert world.unregistered == []
    assert world.text_store.deleted == []


@pytest.mark.asyncio
async def test_a_tracked_file_in_any_status_keeps_its_summary(world):
    """A failed or still-ingesting file has no chunks YET; that is not an orphan."""
    world.summaries["proj_a"] = ["failed.pdf", "ingesting.pdf"]
    world.ingestor = _Ingestor(
        {"proj_a": 1},
        {"proj_a": [("failed.pdf", FileStatus.FAILED), ("ingesting.pdf", FileStatus.INGESTING)]},
    )

    result = await reconcile_orphaned_summaries(None, dry_run=False)

    assert result["forgotten"] == []
    assert world.unregistered == []


@pytest.mark.asyncio
async def test_a_file_whose_ingest_is_in_flight_is_not_judged(world):
    """The summary can land before the chunks do; the ingest-status store says a file is coming."""
    world.summaries["proj_a"] = ["uploading.pdf"]
    world.ingestor = _Ingestor({"proj_a": 0}, {"proj_a": []})
    world.in_flight["proj_a"] = ["uploading.pdf"]

    result = await reconcile_orphaned_summaries(None, dry_run=False)

    assert result["forgotten"] == []


@pytest.mark.asyncio
async def test_matches_a_chunk_name_stored_encoded_or_with_a_temp_prefix(world):
    """The row and its chunks were written by one ingest, but not always under one spelling."""
    world.summaries["proj_a"] = ["Zürich Plan.pdf", "schnitt.pdf"]
    world.ingestor = _Ingestor(
        {"proj_a": 4},
        {"proj_a": [("Z%C3%BCrich%20Plan.pdf", FileStatus.SUCCESS), ("tmpab12cd34_schnitt.pdf", FileStatus.SUCCESS)]},
    )

    result = await reconcile_orphaned_summaries(None, dry_run=False)

    assert result["forgotten"] == []


@pytest.mark.asyncio
async def test_forgets_the_mirror_under_both_spellings_of_an_encoded_row(world):
    world.summaries["proj_a"] = ["Alte%20Datei.pdf"]
    world.ingestor = _Ingestor({"proj_a": 2}, {"proj_a": [("other.pdf", FileStatus.SUCCESS)]})

    await reconcile_orphaned_summaries(None, dry_run=False)

    assert world.unregistered == [("proj_a", "Alte%20Datei.pdf")]
    assert world.text_store.deleted == [("proj_a", "Alte%20Datei.pdf"), ("proj_a", "Alte Datei.pdf")]


@pytest.mark.asyncio
async def test_a_collection_chroma_no_longer_has_loses_every_summary(world):
    """Same verdict the purge route reaches: no collection, no chunks, no inventory."""
    world.summaries["proj_gone"] = ["a.pdf", "b.pdf"]
    world.ingestor = _Ingestor({"proj_other": 5}, {})

    result = await reconcile_orphaned_summaries(None, dry_run=False)

    assert sorted(f["file_name"] for f in result["forgotten"]) == ["a.pdf", "b.pdf"]
    assert result["failures"] == []


@pytest.mark.asyncio
async def test_an_empty_listing_of_a_collection_that_holds_chunks_is_a_failure_not_a_purge(world):
    """``list_files`` answers ``[]`` for an unreachable collection too. Chroma
    just reported chunks there, so an empty listing is a failed read — and a
    failed read must not forget every summary the collection has."""
    world.summaries["proj_a"] = ["live.pdf"]
    world.ingestor = _Ingestor({"proj_a": 40}, {"proj_a": []})

    result = await reconcile_orphaned_summaries(None, dry_run=False)

    assert result["forgotten"] == []
    assert [f["collection"] for f in result["failures"]] == ["proj_a"]
    assert world.unregistered == []


@pytest.mark.asyncio
async def test_fails_per_collection_and_sweeps_the_others(world):
    world.summaries["proj_a"] = ["ghost.pdf"]
    world.summaries["proj_b"] = ["ghost.pdf"]
    world.ingestor = _Ingestor(
        {"proj_a": 1, "proj_b": 1},
        {"proj_a": RuntimeError("chroma timeout"), "proj_b": [("live.pdf", FileStatus.SUCCESS)]},
    )

    result = await reconcile_orphaned_summaries(None, dry_run=False)

    assert result["collections_scanned"] == 2
    assert result["failures"] == [{"collection": "proj_a", "error": "chroma timeout"}]
    assert result["forgotten"] == [{"collection": "proj_b", "file_name": "ghost.pdf"}]


@pytest.mark.asyncio
async def test_scopes_to_the_collections_the_caller_names(world):
    """The BFF passes the collections it chunk-reconciled; the OIB corpus is never in that list."""
    world.summaries["proj_a"] = ["ghost.pdf"]
    world.summaries["oib_knowledge"] = ["ghost.pdf"]
    world.ingestor = _Ingestor({"proj_a": 1, "oib_knowledge": 1}, {"proj_a": [], "oib_knowledge": []})
    world.ingestor = _Ingestor(
        {"proj_a": 1, "oib_knowledge": 1},
        {"proj_a": [("live.pdf", FileStatus.SUCCESS)], "oib_knowledge": [("live.pdf", FileStatus.SUCCESS)]},
    )

    result = await reconcile_orphaned_summaries(["proj_a"], dry_run=False)

    assert result["collections_scanned"] == 1
    assert world.unregistered == [("proj_a", "ghost.pdf")]
    assert world.summaries["oib_knowledge"] == ["ghost.pdf"]


@pytest.mark.asyncio
async def test_a_vector_store_that_cannot_be_listed_fails_the_whole_request(world):
    """Nothing can be judged, so nothing is forgotten — not even by accident."""
    world.summaries["proj_a"] = ["ghost.pdf"]
    world.ingestor = _Ingestor({}, {})
    world.ingestor.list_collections_raises = ConnectionError("chroma down")

    with pytest.raises(HTTPException) as exc:
        await reconcile_orphaned_summaries(None, dry_run=False)

    assert exc.value.status_code == 503
    assert world.unregistered == []


@pytest.mark.asyncio
async def test_no_active_ingestor_is_a_503(world):
    world.ingestor = None
    with pytest.raises(HTTPException) as exc:
        await reconcile_orphaned_summaries(None, dry_run=False)
    assert exc.value.status_code == 503


def test_the_route_is_registered_beside_purge_with_the_same_guard():
    """The BFF calls it by path; a typo here is a 404 that looks like a backend outage."""
    from fastapi import APIRouter

    from aiq_api.routes.maintenance import add_maintenance_routes

    router = APIRouter()
    add_maintenance_routes(router)
    paths = {route.path for route in router.routes}
    assert "/v1/maintenance/reconcile-summaries" in paths
    assert "/v1/maintenance/purge-project-resources" in paths
