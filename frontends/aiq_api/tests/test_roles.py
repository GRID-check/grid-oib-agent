"""The backend's two web roles serve disjoint routes, and between them every route (ADR-0082 step B).

``GRID_ROLE=chat`` and ``GRID_ROLE=api`` are the same image and the same plugin.
What keeps them two jobs and not one is that no route is mounted by both, and
what keeps the split from losing a route is that none is mounted by neither. A
route that goes missing from a Service's pods is a 404 the BFF sees only when a
reader reaches it, so the property is held here, on the routes the real worker
mounts for each role, and not on the lists the plugin keeps.

The baseline is built from the ingredients instead of from the plugin: every
router registrar found under ``aiq_api/routes/`` by name, NAT's own routes, the
job routes, the debug console and the chat socket, mounted on one app the way
the single process did. A router added under ``routes/`` and assigned to no role
is in the baseline and in neither role; one assigned to both is in both roles.
Either fails here.
"""

from __future__ import annotations

import asyncio
import contextlib
import functools
import importlib
import inspect
import pkgutil
import re
from pathlib import Path
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from fastapi.routing import APIRoute
from fastapi.routing import APIWebSocketRoute
from pydantic import BaseModel
from starlette.routing import Route

from aiq_api import plugin
from aiq_api import routes as routes_package
from aiq_api.roles import ROLE_ENV
from aiq_api.roles import WebRole
from aiq_api.roles import web_role
from aiq_api.routes.chat_occupancy import CHAT_OCCUPANCY_PATH
from nat.data_models.config import Config
from nat.data_models.config import GeneralConfig
from nat.front_ends.fastapi.fastapi_front_end_plugin_worker import FastApiFrontEndPluginWorker
from nat.runtime.session import SessionManager

#: What both roles answer: `/health` (NAT's own handler, mounted on each) and FastAPI's documentation routes.
SHARED = {
    ("GET", "/health"),
    ("GET", "/openapi.json"),
    ("GET", "/docs"),
    ("GET", "/docs/oauth2-redirect"),
    ("GET", "/redoc"),
}

_REGISTRAR = re.compile(r"^(add|register)_\w*routes$")


class _Schema(BaseModel):
    """What a NAT session manager answers for its workflow's input and output."""

    text: str = ""


def _route_keys(app: FastAPI) -> set[tuple[str, str]]:
    keys: set[tuple[str, str]] = set()
    for route in app.routes:
        if isinstance(route, APIWebSocketRoute):
            keys.add(("WS", route.path))
        elif isinstance(route, (APIRoute, Route)):
            keys.update((method, route.path) for method in (route.methods or set()) if method != "HEAD")
    return keys


def _session_manager() -> MagicMock:
    manager = MagicMock()
    manager.get_workflow_input_schema.return_value = _Schema
    manager.get_workflow_single_output_schema.return_value = _Schema
    manager.get_workflow_streaming_output_schema.return_value = _Schema
    manager.is_workflow_per_user = False
    return manager


def _worker(role: str) -> plugin.AIQAPIWorker:
    with pytest.MonkeyPatch.context() as env:
        env.setenv(ROLE_ENV, role)
        return plugin.AIQAPIWorker(Config(general=GeneralConfig(front_end=plugin.AIQAPIConfig())))


def _discovered_registrars() -> dict[str, object]:
    """Every public ``add_*_routes`` / ``register_*_routes`` function a module under ``routes/`` defines."""
    found: dict[str, object] = {}
    for info in pkgutil.iter_modules(routes_package.__path__):
        module = importlib.import_module(f"aiq_api.routes.{info.name}")
        for name, function in inspect.getmembers(module, inspect.isroutine):
            if _REGISTRAR.match(name) and function.__module__ == module.__name__:
                found[f"{info.name}.{name}"] = function
    return found


def _unwrapped(function):
    return function.func if isinstance(function, functools.partial) else function


async def _build(worker: plugin.AIQAPIWorker) -> FastAPI:
    app = worker.build_app()
    with patch.object(SessionManager, "create", AsyncMock(return_value=_session_manager())):
        await worker.add_routes(app, MagicMock())
    return app


async def _baseline(worker: plugin.AIQAPIWorker) -> FastAPI:
    """The routes the single process mounted, from the registrars and the pieces and not from the plugin's lists."""
    from aiq_debug import register_debug_routes

    app = FastAPI()
    router = APIRouter()
    app_level = []
    for function in _discovered_registrars().values():
        parameters = list(inspect.signature(function).parameters)
        if parameters[0] == "app":
            app_level.append(function)
        elif len(parameters) == 1:
            function(router)
        else:
            function(router, {})
    app.include_router(router)
    builder = MagicMock()
    with patch.object(SessionManager, "create", AsyncMock(return_value=_session_manager())) as create:
        await FastApiFrontEndPluginWorker.add_routes(worker, app, builder)
        app.add_api_websocket_route(plugin.CHAT_SOCKET_PATH, plugin.chat_socket_endpoint(create.return_value))
    for function in app_level:
        await function(app, builder, worker)
    await register_debug_routes(app)
    return app


@pytest.fixture(scope="module")
def apps(tmp_path_factory: pytest.TempPathFactory) -> dict[str, FastAPI]:
    """The chat role's app, the api role's and the baseline, each built on its own."""
    root: Path = tmp_path_factory.mktemp("roles")
    config_file = root / "config.yml"
    config_file.write_text("{}")
    with pytest.MonkeyPatch.context() as env, contextlib.ExitStack() as stack:
        env.setenv("NAT_JOB_STORE_DB_URL", f"sqlite+aiosqlite:///{root}/jobs.db")
        env.setenv("NAT_CONFIG_FILE", str(config_file))
        env.setenv("AIQ_ENABLE_DEBUG", "true")
        env.setenv("REQUIRE_AUTH", "false")
        # No handshake with a BFF, no handlers installed on the test process.
        stack.enter_context(patch.object(plugin.AIQAPIWorker, "_schedule_internal_api_check", lambda self: None))
        stack.enter_context(patch.object(plugin.AIQAPIWorker, "_install_signal_handlers", lambda self: None))
        stack.enter_context(patch.object(plugin, "install_presigned_url_scrubbing", lambda: None))

        async def build_all() -> dict[str, FastAPI]:
            chat = _worker("chat")
            return {
                "chat": await _build(chat),
                "api": await _build(_worker("api")),
                "baseline": await _baseline(chat),
            }

        return asyncio.run(build_all())


@pytest.fixture(scope="module")
def route_sets(apps: dict[str, FastAPI]) -> dict[str, set[tuple[str, str]]]:
    """The route keys of each app."""
    return {name: _route_keys(app) for name, app in apps.items()}


def test_the_roles_serve_disjoint_routes_apart_from_health_and_the_docs(route_sets):
    chat, api = route_sets["chat"], route_sets["api"]

    assert chat & api == SHARED


def test_every_route_the_single_process_mounted_is_mounted_by_exactly_one_role(route_sets):
    chat, api, baseline = route_sets["chat"], route_sets["api"], route_sets["baseline"]

    assert baseline - (chat | api) == set(), "a route no role mounts"
    assert (chat | api) - baseline == set(), "a route the baseline does not know"


def test_each_role_serves_what_its_deployment_is_there_for(route_sets):
    chat, api = route_sets["chat"], route_sets["api"]

    assert {("WS", plugin.CHAT_SOCKET_PATH), ("GET", CHAT_OCCUPANCY_PATH), ("POST", "/generate/stream")} <= chat
    assert {
        ("POST", "/v1/ingest"),
        ("POST", "/v1/jobs/async/submit"),
        ("GET", "/v1/jobs/async/job/{job_id}/stream"),
        ("POST", "/v1/maintenance/housekeeping/ghost-jobs"),
        # The base corpus (ADR-0082 step A2): its upload, sync and status routes, and the
        # housekeeping cycle that queues one ingest-queue job per file.
        ("POST", "/v1/admin/oib/sync"),
        ("GET", "/v1/oib/status"),
        ("POST", "/v1/maintenance/housekeeping/base-corpus"),
        ("GET", "/debug"),
    } <= api
    assert not any(path.startswith(("/v1/jobs", "/v1/ingest", "/v1/oib", "/v1/admin/oib")) for _, path in chat)
    assert not any(path in (plugin.CHAT_SOCKET_PATH, CHAT_OCCUPANCY_PATH, "/generate") for _, path in api)


def test_every_router_registrar_under_routes_is_assigned_to_exactly_one_role():
    declared = [
        *plugin.CHAT_ROUTERS,
        *plugin.API_APP_REGISTRARS,
        *(_unwrapped(function) for function in plugin.api_routers({})),
    ]
    found = _discovered_registrars()
    by_function = {function: name for name, function in found.items()}

    twice = sorted({by_function.get(f, f.__name__) for f in declared if declared.count(f) > 1})
    unassigned = sorted(name for name, function in found.items() if function not in declared)
    unknown = sorted(f.__name__ for f in declared if f not in by_function)

    assert twice == [], f"assigned to both roles (or twice): {twice}"
    assert unassigned == [], f"under routes/ and mounted by no role: {unassigned}"
    assert unknown == [], f"mounted but not a registrar under routes/: {unknown}"


@pytest.mark.parametrize("raw", ["chat", "api", " API ", "Chat"])
def test_a_web_role_is_read_from_grid_role(raw):
    assert web_role({ROLE_ENV: raw}) is WebRole(raw.strip().lower())


@pytest.mark.parametrize(
    "env", [{}, {ROLE_ENV: ""}, {ROLE_ENV: "web"}, {ROLE_ENV: "worker"}, {ROLE_ENV: "ingest-worker"}]
)
def test_a_missing_or_unknown_web_role_stops_the_process_and_says_which_variable(env):
    with pytest.raises(ValueError, match="GRID_ROLE"):
        web_role(env)


def test_a_worker_built_without_a_web_role_fails_before_it_connects_to_anything(monkeypatch):
    monkeypatch.delenv(ROLE_ENV, raising=False)

    with pytest.raises(ValueError, match="GRID_ROLE"):
        plugin.AIQAPIWorker(Config(general=GeneralConfig(front_end=plugin.AIQAPIConfig())))


@pytest.fixture
def drains(monkeypatch):
    calls: list[str] = []
    manager = MagicMock()

    async def shutdown(timeout: float) -> None:
        calls.append(f"sse closed ({timeout:g}s)")

    async def drain_chat(timeout=None) -> int:
        calls.append("chat turns drained")
        return 0

    async def dispose() -> None:
        calls.append("engines disposed")

    manager.shutdown = shutdown
    monkeypatch.setattr(plugin, "get_connection_manager", lambda: manager)
    monkeypatch.setattr(plugin, "drain_chat_turns", drain_chat)
    monkeypatch.setattr(plugin.EventStore, "dispose_all_engines_async", dispose)
    return calls


async def test_chat_waits_for_the_turns_it_holds_and_closes_no_sse_stream(drains):
    await plugin.drain_owned_work(WebRole.CHAT)

    assert drains == ["chat turns drained", "engines disposed"]


async def test_api_closes_its_sse_streams_and_waits_for_no_chat_turn(drains):
    await plugin.drain_owned_work(WebRole.API)

    assert drains == ["sse closed (5s)", "engines disposed"]


@pytest.mark.parametrize("role", ["chat", "api"])
def test_each_role_mounts_one_health_route_that_names_the_build_and_the_role(apps, monkeypatch, role):
    from fastapi.testclient import TestClient

    monkeypatch.setenv("GRID_GIT_SHA", "abc1234")

    health = [r for r in apps[role].routes if getattr(r, "path", None) == "/health"]
    answer = TestClient(apps[role]).get("/health")

    assert len(health) == 1
    assert answer.status_code == 200
    assert answer.json() == {"status": "healthy", "sha": "abc1234", "role": role}
