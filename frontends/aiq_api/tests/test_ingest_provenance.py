"""`POST /v1/ingest` carries who wrote a document and who released it (ADR-0054).

The second crossing point after ``folder_path``, and the one with the sharper
failure. The BFF is the sole authority on authorship; the Python tier reads what
it is told. If the four keys do not survive into the job config, a document
Piloti wrote and a person approved reaches the index looking exactly like a
stamped Gutachten — the retrieval side has nothing else to go on, and its
documented posture is fail-open.

The names are the contract and both sides pin it: the BFF twin is
``dispatch.spec.ts`` ("sends the four provenance keys for a published Piloti
document"), and the parser is ``aiq_agent.common.provenance``. ``file_name`` is
asserted here for the same reason — it is the chunk join key every purge
addresses, and deriving it from the presigned URL is a guess about a string the
BFF already knows.
"""

from unittest.mock import MagicMock
from unittest.mock import patch

import httpx
import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_agent.knowledge.factory import clear_active_ingestor
from aiq_agent.knowledge.factory import set_active_ingestor
from aiq_api.routes.ingest import add_ingest_routes

_PILOTI = {
    "file_ref": "http://seaweedfs.test/bucket/aktenvermerk-2026-09-01.md?X-Amz-Signature=abc",
    "collection": "proj_test123",
    "document_id": "doc-1",
    "file_name": "piloti/doc-1/aktenvermerk-2026-09-01.md",
    "authored_by": "agent",
    "approved_by": "Maria Huber",
    "approved_at": "2026-09-01T10:00:00.000Z",
    "producer": "agent_document",
}


@pytest.fixture
def mock_ingestor():
    ingestor = MagicMock()
    ingestor.backend_name = "test"
    ingestor.submit_job.return_value = "job_prov_1"
    set_active_ingestor(ingestor)
    yield ingestor
    clear_active_ingestor()


@pytest.fixture
def app(mock_ingestor, monkeypatch):
    monkeypatch.setenv("SEAWEED_PUBLIC_ENDPOINT", "http://seaweedfs.test")
    monkeypatch.setenv("SEAWEED_ENDPOINT", "http://seaweedfs.test")
    app = FastAPI()
    router = APIRouter()
    add_ingest_routes(router)
    app.include_router(router)
    return app


async def _ingest(app, body: dict) -> httpx.Response:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        with patch("httpx.AsyncClient.get") as mock_get:
            mock_response = MagicMock(spec=httpx.Response)
            mock_response.status_code = 200
            mock_response.content = b"# Aktenvermerk"
            mock_response.headers = {"content-type": "text/markdown"}
            mock_response.raise_for_status = MagicMock()
            mock_get.return_value = mock_response
            return await client.post("/v1/ingest", json=body)


def _config(mock_ingestor) -> dict:
    return mock_ingestor.submit_job.call_args.kwargs["config"]


@pytest.mark.asyncio
async def test_the_four_keys_reach_the_ingest_job_config(app, mock_ingestor):
    response = await _ingest(app, _PILOTI)

    assert response.status_code == 202
    config = _config(mock_ingestor)
    assert config["authored_by"] == "agent"
    assert config["approved_by"] == "Maria Huber"
    assert config["approved_at"] == "2026-09-01T10:00:00.000Z"
    assert config["producer"] == "agent_document"


@pytest.mark.asyncio
async def test_the_stated_file_name_is_what_the_chunks_are_filed_under(app, mock_ingestor):
    # The presigned URL's last segment is `aktenvermerk-2026-09-01.md` — the
    # OBJECT KEY's basename, which the BFF flattened. Filing chunks under it
    # would file them under a name no purge ever asks for.
    response = await _ingest(app, _PILOTI)

    assert response.status_code == 202
    assert _config(mock_ingestor)["original_filenames"] == ["piloti/doc-1/aktenvermerk-2026-09-01.md"]


@pytest.mark.asyncio
async def test_without_a_stated_name_the_url_still_decides(app, mock_ingestor):
    # Every caller predating the field, and the IFC digest dispatch, which
    # genuinely ingests a different file than the row names.
    response = await _ingest(
        app,
        {
            "file_ref": "http://seaweedfs.test/bucket/Z%C3%BCrich%20Plan.pdf?X-Amz-Signature=abc",
            "collection": "proj_test123",
        },
    )

    assert response.status_code == 202
    assert _config(mock_ingestor)["original_filenames"] == ["Zürich Plan.pdf"]


@pytest.mark.asyncio
async def test_a_human_document_carries_no_provenance_at_all(app, mock_ingestor):
    response = await _ingest(
        app,
        {
            "file_ref": "http://seaweedfs.test/bucket/plan.pdf?X-Amz-Signature=abc",
            "collection": "proj_test123",
        },
    )

    assert response.status_code == 202
    config = _config(mock_ingestor)
    # Absent, not null-valued. `parse_agent_provenance` returns None for
    # anything unmarked, and a human document must stay byte-for-byte what it
    # was through the whole pipeline.
    for key in ("authored_by", "approved_by", "approved_at", "producer"):
        assert key not in config


@pytest.mark.asyncio
async def test_a_non_agent_author_carries_nothing_either(app, mock_ingestor):
    # The one value the retrieval side acts on is the token `agent`. Anything
    # else is an unmarked document, and half a provenance — an approver with no
    # author — is worse than none: it would travel as data nothing reads.
    response = await _ingest(
        app,
        {
            "file_ref": "http://seaweedfs.test/bucket/plan.pdf?X-Amz-Signature=abc",
            "collection": "proj_test123",
            "authored_by": "user",
            "approved_by": "Maria Huber",
        },
    )

    assert response.status_code == 202
    config = _config(mock_ingestor)
    assert "authored_by" not in config
    assert "approved_by" not in config


@pytest.mark.asyncio
async def test_an_agent_document_with_no_approver_still_states_its_author(app, mock_ingestor):
    # The lifecycle CHECK forbids a published version with no approver, so this
    # should not happen — and a route that assumed it could not would be a route
    # that drops the author when it does.
    response = await _ingest(
        app,
        {
            "file_ref": "http://seaweedfs.test/bucket/plan.md?X-Amz-Signature=abc",
            "collection": "proj_test123",
            "authored_by": "agent",
        },
    )

    assert response.status_code == 202
    config = _config(mock_ingestor)
    assert config["authored_by"] == "agent"
    assert "approved_by" not in config
