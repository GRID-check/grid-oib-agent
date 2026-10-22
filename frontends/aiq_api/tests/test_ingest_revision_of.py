"""`POST /v1/ingest` carries the Fassung a person chose at upload (ADR-0099).

The upload dialog offers „Als neue Fassung von X ablegen"; the BFF checks the
person may change X and sends X's file name as `revision_of`. The route's part is
to let it reach the job config untouched, where the ingest job writes the link
once the new file has been read. The BFF twin is `dispatch.spec.ts`, which
asserts the same `revision_of` key on the request body.
"""

from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_agent.knowledge.factory import clear_active_ingestor
from aiq_agent.knowledge.factory import set_active_ingestor
from aiq_api.models.requests import IngestRequest
from aiq_api.routes.ingest import add_ingest_routes

BODY = {
    "file_ref": "http://seaweedfs.test/bucket/Grundriss_EG_Index_C.pdf?X-Amz-Signature=abc",
    "collection": "proj_test123",
    "document_id": "doc-1",
}


@pytest.fixture
def mock_ingestor():
    ingestor = MagicMock()
    ingestor.backend_name = "test"
    ingestor.submit_job.return_value = "job_fassung_1"
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
        return await client.post("/v1/ingest", json=body)


def _config(mock_ingestor) -> dict:
    return mock_ingestor.submit_job.call_args.kwargs["config"]


@pytest.mark.asyncio
async def test_the_chosen_older_file_reaches_the_ingest_job_config(app, mock_ingestor):
    response = await _ingest(app, {**BODY, "revision_of": "Grundriss_EG_Index_B.pdf"})

    assert response.status_code == 202
    assert _config(mock_ingestor)["revision_of"] == "Grundriss_EG_Index_B.pdf"


@pytest.mark.asyncio
async def test_an_upload_that_chose_nothing_carries_no_key(app, mock_ingestor):
    response = await _ingest(app, BODY)

    assert response.status_code == 202
    assert "revision_of" not in _config(mock_ingestor)


@pytest.mark.asyncio
@pytest.mark.parametrize("blank", [None, "", "   "])
async def test_a_blank_choice_is_no_choice(app, mock_ingestor, blank):
    response = await _ingest(app, {**BODY, "revision_of": blank})

    assert response.status_code == 202
    assert "revision_of" not in _config(mock_ingestor)


@pytest.mark.asyncio
async def test_the_name_is_trimmed(app, mock_ingestor):
    await _ingest(app, {**BODY, "revision_of": "  Grundriss_EG_Index_B.pdf "})

    assert _config(mock_ingestor)["revision_of"] == "Grundriss_EG_Index_B.pdf"


@pytest.mark.asyncio
async def test_a_name_longer_than_a_file_name_is_refused(app, mock_ingestor):
    response = await _ingest(app, {**BODY, "revision_of": "x" * 513})

    assert response.status_code == 422
    mock_ingestor.submit_job.assert_not_called()


def test_the_request_model_defaults_to_no_choice(monkeypatch):
    monkeypatch.setenv("SEAWEED_ENDPOINT", "http://seaweedfs.test")
    assert IngestRequest(file_ref="http://seaweedfs.test/y.pdf", collection="c").revision_of is None


@pytest.mark.asyncio
async def test_a_bff_that_has_not_rolled_yet_still_sends_the_old_key(app, mock_ingestor):
    """`fassung_of` was the key until migration 0165; the job config carries the new one."""
    response = await _ingest(app, {**BODY, "fassung_of": "Grundriss_EG_Index_B.pdf"})

    assert response.status_code == 202
    config = _config(mock_ingestor)
    assert config["revision_of"] == "Grundriss_EG_Index_B.pdf"
    assert "fassung_of" not in config
