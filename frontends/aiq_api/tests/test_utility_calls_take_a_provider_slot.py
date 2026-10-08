"""The utility routes' model calls queue for a provider slot in the right class (ADR-0081).

A title, a summary, a consistency check and the rest post to OpenRouter over their
own HTTP client. They used to bypass the provider limiter, so a bulk reindex could
fill the pool and these calls neither queued behind chat nor fed the 429 limit.
These tests send a request through the real route and watch the pool, so a route
rewired to a bare ``httpx.AsyncClient`` fails here even when its tests still mock
the client.

Interactive: summary, consistency check, title, skill review, the „Ausmisten"
proposal. Bulk: feedback digest and lesson distillation, which run in the
background and must yield. And no route module builds a bare client for a model
call, so a route added later cannot skip the slot by being left out of this list.
"""

from __future__ import annotations

import json
from pathlib import Path

import fakeredis
import httpx
import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

import aiq_api.routes as routes_package
from aiq_agent.common import provider_limiter as pl
from aiq_api.routes.cleanup_proposal import add_cleanup_proposal_routes
from aiq_api.routes.consistency_check import add_consistency_check_routes
from aiq_api.routes.feedback_digest import add_feedback_digest_routes
from aiq_api.routes.generate_conversation_title import add_generate_conversation_title_routes
from aiq_api.routes.generate_summary import add_generate_summary_routes
from aiq_api.routes.lesson_distill import add_lesson_distill_routes
from aiq_api.routes.skill_review import add_skill_review_routes

_ROUTES = {
    "summary": (
        add_generate_summary_routes,
        "/v1/generate-summary",
        {"profile_text": "Project type: office renovation."},
        pl.INTERACTIVE,
    ),
    "consistency": (
        add_consistency_check_routes,
        "/v1/consistency-check",
        {
            "structured": [{"field": "Nutzung", "value": "Büro"}],
            "free_text": [{"field": "Beschreibung", "value": "Ein Büro."}],
        },
        pl.INTERACTIVE,
    ),
    "title": (
        add_generate_conversation_title_routes,
        "/v1/generate-conversation-title",
        {"messages": [{"role": "user", "content": "Wie hoch muss die Brüstung sein?"}]},
        pl.INTERACTIVE,
    ),
    "skill-review": (
        add_skill_review_routes,
        "/v1/skills/review",
        {"name": "demo", "description": "A demo skill.", "body": "Do the thing."},
        pl.INTERACTIVE,
    ),
    "cleanup-proposal": (
        add_cleanup_proposal_routes,
        "/v1/cleanup-proposal",
        {"documents": [{"id": "d1", "filename": "Kopie von Plan.pdf"}], "locale": "de"},
        pl.INTERACTIVE,
    ),
    "feedback-digest": (
        add_feedback_digest_routes,
        "/v1/feedback-digest",
        {
            "window_days": 30,
            "answers": 50,
            "up": 30,
            "down": 10,
            "voters": 5,
            "down_voters": 2,
            "samples": [{"verdict": "down", "reason": "inaccurate", "topics": [], "question": "Frage?"}],
        },
        pl.BULK,
    ),
    "lesson-distill": (
        add_lesson_distill_routes,
        "/v1/lesson-distill",
        {"question": "Frage?", "answer": "Antwort.", "reason": "wrong_source", "comment": "Falsch."},
        pl.BULK,
    ),
}


@pytest.fixture(autouse=True)
def _openrouter_credentials(monkeypatch):
    for name in ("SUMMARY", "CONSISTENCY", "SKILL_REVIEW"):
        monkeypatch.setenv(f"{name}_LLM_API_KEY", "test-key")  # pragma: allowlist secret
    monkeypatch.setenv("LLM_BASE_URL", "https://openrouter.ai/api/v1")


@pytest.fixture
def pool(monkeypatch):
    """A one-slot pool on a Redis with Lua, and a way to see how many slots are held."""
    client = fakeredis.FakeRedis(server=fakeredis.FakeServer(), decode_responses=True)
    monkeypatch.setattr(
        pl.cache, "eval_script", lambda script, keys, args: client.eval(script, len(keys), *keys, *args)
    )
    monkeypatch.setenv(pl._CEILING_ENV, "1")
    monkeypatch.setenv(pl._FLOOR_ENV, "1")
    return lambda: client.zcard(pl._keys(pl.POOL)["leases"])


@pytest.fixture
def classes(monkeypatch) -> list[str]:
    """The class of every slot the routes ask for."""
    asked: list[str] = []
    acquire = pl.aacquire

    async def spy(*, cls=None, **kwargs):
        asked.append(cls or pl.current_class())
        return await acquire(cls=cls, **kwargs)

    monkeypatch.setattr(pl, "aacquire", spy)
    return asked


@pytest.mark.parametrize("name", list(_ROUTES))
async def test_the_routes_model_call_holds_a_slot_in_its_class(name, pool, classes, monkeypatch):
    add_routes, path, body, expected = _ROUTES[name]
    held: list[int] = []
    sent: list[dict] = []

    async def serve(self, request: httpx.Request) -> httpx.Response:
        held.append(pool())
        sent.append(json.loads(request.content))
        return httpx.Response(500, json={"error": {"message": "stub", "code": 500}})

    # Whatever the route's client is, the call ends at the socket transport.
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", serve)
    app = FastAPI()
    router = APIRouter()
    add_routes(router)
    app.include_router(router)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(path, json=body)

    assert response.status_code == 200
    assert held == [1], "the call to the provider was made outside a slot"
    assert set(classes) == {expected}
    assert pool() == 0
    # The slot is all the transport adds: the body is the route's own.
    assert "model" in sent[0]


async def test_the_limited_client_does_not_force_the_data_policy(pool, monkeypatch):
    """An organization that switched ZDR off keeps its choice: the transport leaves the body alone."""
    from aiq_agent.common.openrouter import limited_async_http_client

    sent: list[dict] = []

    async def serve(self, request: httpx.Request) -> httpx.Response:
        sent.append(json.loads(request.content))
        return httpx.Response(200, json={})

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", serve)
    async with limited_async_http_client(cls=pl.INTERACTIVE) as client:
        await client.post("https://openrouter.ai/api/v1/chat/completions", json={"model": "vendor/m"})
    assert sent == [{"model": "vendor/m"}]


def test_no_route_calls_a_model_over_a_bare_client():
    """A model call from a route goes through ``limited_async_http_client``, never a bare ``httpx.AsyncClient``."""
    bare = [
        path.name
        for path in sorted(Path(routes_package.__file__).parent.glob("*.py"))
        if "/chat/completions" in (text := path.read_text(encoding="utf-8")) and "httpx.AsyncClient(" in text
    ]
    assert bare == [], f"these routes call a model outside the provider limiter: {bare}"
