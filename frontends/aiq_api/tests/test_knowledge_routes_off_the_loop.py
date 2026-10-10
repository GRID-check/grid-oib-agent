"""The document and collection routes call the ingestor in a THREAD, not on the loop.

Every ingestor and metadata-store call is synchronous: a Chroma read, a SQL
statement on a sync engine, the ingest-status store. The route handlers are
coroutines on the API's one event loop, so a call made inline does not only
make its own request slow; it stalls every other request the worker is serving,
chat streams included.

What is asserted is WHERE each call ran: the fakes record
``threading.current_thread()`` and the test compares it with the thread the
event loop is on — the shape of ``test_prompt_render_off_the_loop.py``. The
response shapes are asserted too, because moving a call into a thread must not
change what the BFF reads back.
"""

from __future__ import annotations

import threading
from datetime import datetime

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_agent.knowledge.factory import clear_active_ingestor
from aiq_agent.knowledge.factory import set_active_ingestor
from aiq_agent.knowledge.schema import CollectionInfo
from aiq_agent.knowledge.schema import FileInfo
from aiq_agent.knowledge.schema import FileStatus
from aiq_agent.knowledge.schema import IngestionJobStatus
from aiq_agent.knowledge.schema import JobState
from aiq_api.routes import documents as documents_module
from aiq_api.routes.collections import add_collection_routes
from aiq_api.routes.documents import add_document_routes


class _RecordingIngestor:
    """An ingestor whose every method records the thread it ran on."""

    backend_name = "test"

    def __init__(self) -> None:
        self.calls: list[tuple[str, threading.Thread]] = []

    def _record(self, name: str) -> None:
        self.calls.append((name, threading.current_thread()))

    def get_collection(self, name):
        self._record("get_collection")
        return CollectionInfo(
            name=name, backend="test", created_at=datetime(2026, 1, 1), updated_at=datetime(2026, 1, 1)
        )

    def create_collection(self, name, description=None, metadata=None):
        self._record("create_collection")
        return self.get_collection(name)

    def delete_collection(self, name):
        self._record("delete_collection")
        return True

    def list_files(self, collection_name):
        self._record("list_files")
        return [
            FileInfo(file_id="f1", file_name="plan.pdf", collection_name=collection_name, status=FileStatus.SUCCESS)
        ]

    def delete_files(self, file_ids, collection_name):
        self._record("delete_files")
        return {"successful": list(file_ids), "failed": [], "total_deleted": len(file_ids)}

    def get_job_status(self, job_id):
        self._record("get_job_status")
        if job_id == "unknown":
            return None
        return IngestionJobStatus(
            job_id=job_id,
            status=JobState.COMPLETED,
            submitted_at=datetime(2026, 1, 1),
            collection_name="proj_a",
            backend="test",
        )

    def get_document_visual_details(self, collection_name, file_name):
        self._record("get_document_visual_details")
        return [{"page": 1, "description": "Grundriss"}]


@pytest.fixture
def ingestor():
    recording = _RecordingIngestor()
    set_active_ingestor(recording)
    yield recording
    clear_active_ingestor()


@pytest.fixture
def client(ingestor):
    app = FastAPI()
    router = APIRouter()
    add_collection_routes(router)
    add_document_routes(router)
    app.include_router(router)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture
def store_threads(monkeypatch):
    """Record the thread each metadata-store seam the routes call ran on."""
    threads: list[tuple[str, threading.Thread]] = []

    def recorder(name, result):
        def call(*_args, **_kwargs):
            threads.append((name, threading.current_thread()))
            return result

        return call

    monkeypatch.setattr(documents_module, "set_document_tags_by_person", recorder("set_document_tags_by_person", True))
    monkeypatch.setattr(documents_module, "set_document_display_title", recorder("set_document_display_title", True))
    monkeypatch.setattr(documents_module, "set_document_folder_path", recorder("set_document_folder_path", True))
    monkeypatch.setattr(documents_module, "rewrite_document_folder_paths", recorder("rewrite", 3))

    async def no_summaries(_collection):
        return []

    monkeypatch.setattr(documents_module, "get_available_documents_async", no_summaries)
    return threads


def _on_the_loop(calls: list[tuple[str, threading.Thread]]) -> list[str]:
    loop_thread = threading.current_thread()
    return [name for name, thread in calls if thread is loop_thread]


async def test_the_ingestor_is_never_called_on_the_event_loop(client, ingestor, store_threads):
    async with client as http:
        listed = await http.get("/v1/collections/proj_a/documents")
        deleted = await http.request("DELETE", "/v1/collections/proj_a/documents", json={"file_ids": ["plan.pdf"]})
        status = await http.get("/v1/documents/job-1/status")
        batch = await http.post("/v1/documents/status/batch", json={"job_ids": ["job-1", "unknown"]})
        details = await http.get("/v1/collections/proj_a/documents/plan.pdf/visual-details")
        created = await http.post("/v1/collections", json={"name": "proj_b"})
        fetched = await http.get("/v1/collections/proj_b")
        dropped = await http.delete("/v1/collections/proj_b")

    assert [row["file_name"] for row in listed.json()] == ["plan.pdf"]
    assert deleted.json() == {
        "successful": ["plan.pdf"],
        "failed": [],
        "total_deleted": 1,
        "message": "Successfully deleted 1 file(s)",
    }
    assert status.json()["job_id"] == "job-1"
    assert batch.json()["statuses"]["job-1"]["status"] == "completed"
    assert batch.json()["statuses"]["unknown"] is None
    assert details.json() == {"details": [{"page": 1, "description": "Grundriss"}]}
    assert created.status_code == 201 and fetched.json()["name"] == "proj_b"
    assert dropped.json() == {"success": True, "collection": "proj_b"}

    called = {name for name, _ in ingestor.calls}
    assert called >= {
        "get_collection",
        "create_collection",
        "delete_collection",
        "list_files",
        "delete_files",
        "get_job_status",
        "get_document_visual_details",
    }, "a fake method was never reached; the routes are not wired to it"
    assert _on_the_loop(ingestor.calls) == [], "these ingestor calls blocked the event loop"


async def test_the_metadata_store_is_never_written_on_the_event_loop(client, store_threads):
    async with client as http:
        tags = await http.patch("/v1/collections/proj_a/documents/plan.pdf/tags", json={"tags": []})
        title = await http.patch(
            "/v1/collections/proj_a/documents/plan.pdf/display-title", json={"display_title": "Plan EG"}
        )
        folder = await http.patch(
            "/v1/collections/proj_a/documents/plan.pdf/folder-path", json={"folder_path": "Statik"}
        )
        subtree = await http.patch(
            "/v1/collections/proj_a/folder-paths", json={"from_path": "Statik", "to_path": "Tragwerk"}
        )

    assert tags.json() == {"collection_name": "proj_a", "file_name": "plan.pdf", "tags": []}
    assert title.json()["display_title"] == "Plan EG"
    assert folder.json()["folder_path"] == "Statik"
    assert subtree.json()["updated"] == 3
    assert len(store_threads) == 4
    assert _on_the_loop(store_threads) == [], "these metadata-store writes blocked the event loop"
