"""`POST /v1/ingest` carries the document type a person chose at filing.

The BFF sends it as `document_type` (`dispatchIngest`, `ShelfUploadInput.documentType`);
the route's part is to refuse a value outside the controlled vocabulary and let a
known one reach the job config untouched, where the ingest job stores it as the
person's type tag (`knowledge_layer.llamaindex.adapter._keep_chosen_document_type`).
The BFF twin is `ingest-document-type-contract.spec.ts`.

The values are read from the vocabulary rather than spelled here, so a rename of
the tokens touches the vocabulary and nothing in this file.
"""

from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_agent.knowledge.document_classification import DISCIPLINE_TAGS
from aiq_agent.knowledge.document_classification import DOCUMENT_TYPE_TAGS
from aiq_agent.knowledge.factory import clear_active_ingestor
from aiq_agent.knowledge.factory import set_active_ingestor
from aiq_api.routes.ingest import add_ingest_routes

BODY = {
    "file_ref": "http://seaweedfs.test/bucket/letter.pdf?X-Amz-Signature=abc",
    "collection": "proj_test123",
    "document_id": "doc-1",
}


@pytest.fixture
def mock_ingestor():
    ingestor = MagicMock()
    ingestor.backend_name = "test"
    ingestor.submit_job.return_value = "job_type_1"
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
@pytest.mark.parametrize("document_type", DOCUMENT_TYPE_TAGS)
async def test_every_type_of_the_vocabulary_reaches_the_job_config(app, mock_ingestor, document_type):
    response = await _ingest(app, {**BODY, "document_type": document_type})

    assert response.status_code == 202
    assert _config(mock_ingestor)["document_type"] == document_type


@pytest.mark.asyncio
@pytest.mark.parametrize("absent", [None, {}])
async def test_a_filing_that_chose_no_type_carries_no_key(app, mock_ingestor, absent):
    body = {**BODY, "document_type": None} if absent is None else BODY

    response = await _ingest(app, body)

    assert response.status_code == 202
    assert "document_type" not in _config(mock_ingestor)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "outside",
    [
        "not-a-type",
        # A discipline is a tag, not a type: the type slot takes types only.
        DISCIPLINE_TAGS[0],
        # The store compares exactly; a case variant would be a second spelling.
        DOCUMENT_TYPE_TAGS[0].upper(),
        "",
    ],
)
async def test_a_type_outside_the_vocabulary_is_refused_before_a_job_exists(app, mock_ingestor, outside):
    response = await _ingest(app, {**BODY, "document_type": outside})

    assert response.status_code == 422
    mock_ingestor.submit_job.assert_not_called()
