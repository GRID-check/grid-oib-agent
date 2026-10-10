"""Every model call a route makes itself is a Langfuse generation (ADR-0089).

A route under ``routes/`` runs outside any NAT workflow, so NAT's span exporter
never sees a ``/chat/completions`` POST it makes: six such calls once cost money
and seconds with no trace anywhere. The ratchet is a source scan: every call
that names the endpoint must sit inside an ``async with observed_generation(...)``
block (``aiq_agent.observability.direct_trace``), so a seventh route that skips
it fails here instead of going dark in production.

The route-level test below proves the wrapping is live, not just present: the
summary route's real handler produces the span, with the provider's usage on it.
"""

from __future__ import annotations

import ast
from pathlib import Path
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import httpx
import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from aiq_agent.observability import direct_trace

ROUTES = Path(__file__).resolve().parents[1] / "src" / "aiq_api" / "routes"
MODEL_ENDPOINT = "/chat/completions"
WRAPPER = "observed_generation"

#: The call sites the scan must find, so a glob that matched nothing cannot pass.
KNOWN = {
    "cleanup_proposal.py",
    "consistency_check.py",
    "documents.py",
    "feedback_digest.py",
    "generate_conversation_title.py",
    "generate_summary.py",
    "lesson_distill.py",
    "skill_review.py",
}


def _names_the_endpoint(node: ast.AST) -> bool:
    return any(
        isinstance(child, ast.Constant) and isinstance(child.value, str) and MODEL_ENDPOINT in child.value
        for child in ast.walk(node)
    )


def _opens_the_wrapper(node: ast.AST) -> bool:
    if not isinstance(node, ast.AsyncWith | ast.With):
        return False
    return any(
        isinstance(item.context_expr, ast.Call)
        and isinstance(item.context_expr.func, ast.Name)
        and item.context_expr.func.id == WRAPPER
        for item in node.items
    )


def _model_calls(tree: ast.AST) -> list[tuple[ast.Call, list[ast.AST]]]:
    """Every call whose arguments name the model endpoint, with its ancestors."""
    found: list[tuple[ast.Call, list[ast.AST]]] = []

    def visit(node: ast.AST, ancestors: list[ast.AST]) -> None:
        if isinstance(node, ast.Call) and any(_names_the_endpoint(arg) for arg in node.args):
            found.append((node, ancestors))
        for child in ast.iter_child_nodes(node):
            visit(child, [*ancestors, node])

    visit(tree, [])
    return found


def _call_sites() -> list[tuple[str, int, bool]]:
    """``(file, line, traced)`` for every model call under ``routes/``."""
    sites: list[tuple[str, int, bool]] = []
    for path in sorted(ROUTES.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for call, ancestors in _model_calls(tree):
            sites.append((path.name, call.lineno, any(_opens_the_wrapper(node) for node in ancestors)))
    return sites


def test_the_scan_sees_the_known_call_sites():
    assert {name for name, _line, _traced in _call_sites()} >= KNOWN


def test_the_scan_tells_a_traced_call_from_an_untraced_one():
    source = (
        "async def traced(client, cred):\n"
        "    async with observed_generation('x', model=None, messages=None) as generation, client:\n"
        "        await client.post(f'{cred.base_url}/chat/completions')\n"
        "async def untraced(client, cred):\n"
        "    async with client:\n"
        "        await client.post(f'{cred.base_url}/chat/completions')\n"
    )
    traced = [
        any(_opens_the_wrapper(node) for node in ancestors) for _call, ancestors in _model_calls(ast.parse(source))
    ]
    assert traced == [True, False]


def test_every_model_call_under_routes_is_an_observed_generation():
    untraced = [f"{name}:{line}" for name, line, traced in _call_sites() if not traced]
    assert not untraced, (
        f"These routes post to {MODEL_ENDPOINT} outside `async with {WRAPPER}(...)`, so the call is "
        f"invisible in Langfuse: {untraced}. Wrap the request and `.finish()` the reply "
        "(aiq_agent.observability.direct_trace)."
    )


@pytest.fixture
def exporter(monkeypatch):
    monkeypatch.setenv("SUMMARY_LLM_API_KEY", "test-key")
    direct_trace.reset_tracer_provider()
    memory = InMemorySpanExporter()
    direct_trace.install_tracer_provider(None, env={}, exporter=memory)
    yield memory
    direct_trace.reset_tracer_provider()


def _app() -> FastAPI:
    from aiq_api.routes.generate_summary import add_generate_summary_routes

    app = FastAPI()
    router = APIRouter()
    add_generate_summary_routes(router)
    app.include_router(router)
    return app


def _fake_client(post: AsyncMock) -> MagicMock:
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    client.post = post
    return MagicMock(return_value=client)


async def _post_summary(post: AsyncMock) -> httpx.Response:
    async with AsyncClient(transport=ASGITransport(app=_app()), base_url="http://test") as client:
        with patch("httpx.AsyncClient", _fake_client(post)):
            return await client.post("/v1/generate-summary", json={"profile_text": "Bürobau in Linz."})


async def test_a_route_call_reaches_langfuse_as_a_generation_with_usage(exporter):
    reply = MagicMock(spec=httpx.Response)
    reply.raise_for_status = MagicMock()
    reply.json.return_value = {
        "choices": [{"message": {"content": "Ein Bürobau in Linz."}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 50, "completion_tokens": 8, "total_tokens": 58, "cost": 0.0001},
    }

    response = await _post_summary(AsyncMock(return_value=reply))

    assert response.json()["summary"] == "Ein Bürobau in Linz."
    direct_trace._provider.force_flush()
    (span,) = exporter.get_finished_spans()
    assert span.attributes["langfuse.trace.name"] == "project-summary"
    assert span.attributes["langfuse.observation.type"] == "generation"
    assert span.attributes["gen_ai.usage.input_tokens"] == 50
    assert span.attributes["langfuse.observation.output"] == "Ein Bürobau in Linz."


async def test_a_failed_route_call_is_an_error_generation_and_the_route_degrades_as_before(exporter):
    response = await _post_summary(AsyncMock(side_effect=httpx.ConnectError("refused")))

    assert response.status_code == 200
    assert response.json() == {"summary": "", "error": "llm_request_failed"}
    direct_trace._provider.force_flush()
    (span,) = exporter.get_finished_spans()
    assert span.attributes["langfuse.observation.level"] == "ERROR"
    assert span.attributes["langfuse.observation.status_message"] == "ConnectError"
