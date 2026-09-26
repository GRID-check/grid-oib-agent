"""The chat socket is the one route a turn runs through.

NAT's front end also serves the workflow over HTTP (``/generate``, ``/chat``,
``/v1/chat/completions``, ``/v1/workflow``, ``/evaluate``). Those stream
through NAT's ``generate_streaming_response``, whose early stop leaves the
producer running (#334 #337 #338 #759), skip the socket's per-turn handling,
and are not under the context envelope. They were also allowlisted for
external traffic. So this front end serves none of them, and a config that
asks for one is refused.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.routing import APIRoute
from fastapi.routing import APIWebSocketRoute
from pydantic import ValidationError

from aiq_api.plugin import AIQAPIConfig
from aiq_api.plugin import AIQAPIWorker


def test_the_default_config_serves_the_socket_and_no_http_turn_route():
    config = AIQAPIConfig()
    assert config.workflow.websocket_path == "/websocket"
    assert not any(
        getattr(config.workflow, name)
        for name in ("path", "openai_api_path", "openai_api_v1_path", "legacy_path", "legacy_openai_api_path")
    )
    assert config.evaluate.path is None and config.evaluate_item.path is None


@pytest.mark.parametrize(
    "override",
    [
        {"workflow": {"method": "POST", "description": "x", "legacy_path": "/generate"}},
        {"workflow": {"method": "POST", "description": "x", "openai_api_v1_path": "/v1/chat/completions"}},
        {"evaluate": {"method": "POST", "description": "x", "path": "/evaluate"}},
    ],
)
def test_a_config_that_puts_an_http_route_in_front_of_a_turn_is_refused(override):
    with pytest.raises(ValidationError, match="chat socket only"):
        AIQAPIConfig(**override)


@pytest.mark.asyncio
async def test_the_default_route_is_the_socket_alone():
    # NAT's own add_default_route would add generate and chat routes here, and
    # under Dask an async generate route at `None/async`.
    app = FastAPI()
    worker = SimpleNamespace(front_end_config=AIQAPIConfig(), _dask_available=True)
    await AIQAPIWorker.add_default_route(worker, app, session_manager=SimpleNamespace())

    assert [route.path for route in app.routes if isinstance(route, APIWebSocketRoute)] == ["/websocket"]
    assert [route.path for route in app.routes if isinstance(route, APIRoute)] == []
