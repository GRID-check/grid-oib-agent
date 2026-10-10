"""The project-experience route answers with the reading in its contract shape, and never non-200 for a fault in it.

The retriever, its summary model, its chunks and the document list are patched at the knowledge
layer's factory, which the route imports at call time. The model is a fake that answers the three
calls in turn, so the route, the reading and the wire shape are the real ones.
"""

import json
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_agent.knowledge import factory
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_api.routes.project_experience import add_project_experience_routes

TOKEN = "project-experience-test-token"
PATH = "/v1/internal/project-experience"

CHUNKS = {"Baubeschreibung.pdf": [("1", "Das Gebäude ist in die Gebäudeklasse 4 eingestuft.")]}


class _FakeLLM:
    def __init__(self, *replies: Any):
        self.replies = list(replies)
        self.model_name = "fake/model"

    def bind(self, **_kwargs: Any) -> "_FakeLLM":
        return self

    def invoke(self, _messages: list[Any]) -> SimpleNamespace:
        return SimpleNamespace(content=json.dumps(self.replies.pop(0)))


class _FakeCollection:
    def get(self, where: dict[str, str], include: list[str]) -> dict[str, Any]:
        chunks = CHUNKS.get(where["file_name"], [])
        return {
            "documents": [text for _, text in chunks],
            "metadatas": [{"page_label": page} for page, _ in chunks],
        }


class _FakeChroma:
    def get_collection(self, name: str) -> _FakeCollection:
        return _FakeCollection()


class _FakeRetriever:
    def __init__(self, llm: Any):
        self.summary_llm = llm

    def _get_chroma_client(self) -> _FakeChroma:
        return _FakeChroma()


def _body() -> dict[str, Any]:
    return {
        "organizationId": "org_1",
        "projectId": "proj-1",
        "collection": "col-main",
        "fileNames": ["Baubeschreibung.pdf"],
        "vocabulary": {
            "gebaeudeklasse": {"multiple": False, "options": [{"token": "4", "label": "GK 4"}]},
        },
        "knownFacts": [],
        "knownDecisions": [],
    }


@pytest.fixture
def app(monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", TOKEN)
    app = FastAPI()
    router = APIRouter()
    add_project_experience_routes(router)
    app.include_router(router)
    return app


def _patch_knowledge(monkeypatch: pytest.MonkeyPatch, llm: Any) -> None:
    monkeypatch.setattr(factory, "get_active_retriever", lambda: _FakeRetriever(llm))
    monkeypatch.setattr(
        factory, "get_available_documents", lambda collection: [AvailableDocument(file_name="Baubeschreibung.pdf")]
    )


async def _post(app: FastAPI, body: dict[str, Any], token: str | None = TOKEN) -> Any:
    headers = {"x-grid-internal-token": token} if token is not None else {}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.post(PATH, json=body, headers=headers)


async def test_a_request_without_the_internal_token_is_refused(app) -> None:
    response = await _post(app, _body(), token=None)

    assert response.status_code == 403


async def test_a_request_with_the_wrong_internal_token_is_refused(app) -> None:
    response = await _post(app, _body(), token="not-the-token")

    assert response.status_code == 403


async def test_a_body_without_the_collection_is_a_validation_error(app) -> None:
    body = _body()
    del body["collection"]

    response = await _post(app, body)

    assert response.status_code == 422


async def test_a_body_without_the_files_it_may_read_is_a_validation_error(app) -> None:
    # The BFF names the files every member may open; a body without them reads nothing.
    body = _body()
    del body["fileNames"]

    response = await _post(app, body)

    assert response.status_code == 422


async def test_the_reading_is_answered_in_the_contract_shape(app, monkeypatch) -> None:
    llm = _FakeLLM(
        {"file_names": ["Baubeschreibung.pdf"]},
        {
            "values": [
                {
                    "key": "gebaeudeklasse",
                    "value": "4",
                    "evidence": [{"fileName": "Baubeschreibung.pdf", "page": "1", "quote": "Gebäudeklasse 4"}],
                }
            ]
        },
        {"decisions": []},
    )
    _patch_knowledge(monkeypatch, llm)

    response = await _post(app, _body())

    assert response.status_code == 200
    body = response.json()
    assert body["error"] is None
    assert body["model"] == "fake/model"
    assert body["documentsRead"] == ["Baubeschreibung.pdf"]
    assert body["decisions"] == []
    assert body["fingerprint"] == [
        {
            "key": "gebaeudeklasse",
            "value": "4",
            "evidence": [{"fileName": "Baubeschreibung.pdf", "page": "1", "quote": "Gebäudeklasse 4"}],
        }
    ]


async def test_a_retriever_without_a_summary_model_is_answered_as_no_model(app, monkeypatch) -> None:
    _patch_knowledge(monkeypatch, None)

    response = await _post(app, _body())

    assert response.status_code == 200
    assert response.json()["error"] == "no_model"
    assert response.json()["fingerprint"] == []


async def test_a_retriever_that_cannot_be_built_is_answered_as_extraction_failed(app, monkeypatch) -> None:
    def unavailable() -> None:
        raise RuntimeError("no knowledge backend configured")

    monkeypatch.setattr(factory, "get_active_retriever", unavailable)

    response = await _post(app, _body())

    assert response.status_code == 200
    assert response.json()["error"] == "extraction_failed"
    assert response.json()["documentsRead"] == []
