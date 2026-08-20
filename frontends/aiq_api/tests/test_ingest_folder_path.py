"""`POST /v1/ingest` carries the folder the BFF filed the document in (ADR-0049).

This is the crossing point: the BFF knows `project_folders.path`, the Python
backend does not, and the ingest dispatch is the only call that runs when a
document first appears. If `folder_path` does not survive into the job config,
nothing downstream can stamp it and the agent never learns the filing.

The field name is the contract and both sides pin it: the BFF twin is
`dispatch.spec.ts` ("the ingest dispatch sends the document's folder path"),
which asserts the same `folder_path` key on the request body.
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


@pytest.fixture
def mock_ingestor():
    ingestor = MagicMock()
    ingestor.backend_name = "test"
    ingestor.submit_job.return_value = "job_folder_1"
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
            mock_response.content = b"pdf bytes"
            mock_response.headers = {"content-type": "application/pdf"}
            mock_response.raise_for_status = MagicMock()
            mock_get.return_value = mock_response
            return await client.post("/v1/ingest", json=body)


def _config(mock_ingestor) -> dict:
    return mock_ingestor.submit_job.call_args.kwargs["config"]


@pytest.mark.asyncio
async def test_the_folder_path_reaches_the_ingest_job_config(app, mock_ingestor):
    response = await _ingest(
        app,
        {
            "file_ref": "http://seaweedfs.test/bucket/plan.pdf?X-Amz-Signature=abc",
            "collection": "proj_test123",
            "document_id": "doc-1",
            "folder_path": "Brandschutz/Fluchtwege",
        },
    )

    assert response.status_code == 202
    assert _config(mock_ingestor)["folder_path"] == "Brandschutz/Fluchtwege"


@pytest.mark.asyncio
async def test_a_document_with_no_folder_carries_none(app, mock_ingestor):
    # A caller predating this field, and a document at the project root, are the
    # same case: the key is simply absent, which reads as "the root".
    response = await _ingest(
        app,
        {
            "file_ref": "http://seaweedfs.test/bucket/plan.pdf?X-Amz-Signature=abc",
            "collection": "proj_test123",
        },
    )

    assert response.status_code == 202
    assert "folder_path" not in _config(mock_ingestor)


@pytest.mark.asyncio
async def test_a_blank_folder_path_is_not_a_folder(app, mock_ingestor):
    response = await _ingest(
        app,
        {
            "file_ref": "http://seaweedfs.test/bucket/plan.pdf?X-Amz-Signature=abc",
            "collection": "proj_test123",
            "folder_path": "   ",
        },
    )

    assert response.status_code == 202
    assert "folder_path" not in _config(mock_ingestor)
