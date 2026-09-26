"""The server's WebSocket implementation does not log a peer's ordinary close as an ERROR (#758).

err2issue filed ``ConnectionClosedError`` with no traceback, from asyncio's
default exception handler. The source is websockets' legacy protocol (uvicorn's
default): ``ping()`` returns ``asyncio.shield(pong_waiter)``, a peer that closes
while a keepalive ping is unanswered gets the keepalive task, and so the shield,
cancelled first, and Python 3.12+ then reports the waiter's close exception as
"... exception in shielded future". ``deploy/start_web.py`` names the
implementation production runs; this runs that exact close against it, with the
legacy implementation as the oracle that must still reproduce the report.
"""

from __future__ import annotations

import ast
import asyncio
import base64
import gc
import os
from pathlib import Path

import pytest
import uvicorn

START_WEB = Path(__file__).resolve().parents[1] / "deploy" / "start_web.py"


def _production_implementation() -> str:
    """``WS_IMPLEMENTATION`` from start_web.py, read without importing it (the script has import-time effects)."""
    for node in ast.parse(START_WEB.read_text()).body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "WS_IMPLEMENTATION" for t in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError("deploy/start_web.py no longer names WS_IMPLEMENTATION")


async def _app(scope, receive, send):
    if scope["type"] != "websocket":
        return
    await receive()
    await send({"type": "websocket.accept"})
    while (message := await receive())["type"] != "websocket.disconnect":
        if message.get("text"):
            await send({"type": "websocket.send", "text": message["text"]})


def _masked(opcode: int, payload: bytes) -> bytes:
    mask = os.urandom(4)
    return bytes([0x80 | opcode, 0x80 | len(payload)]) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))


async def _close_during_a_ping(implementation: str) -> tuple[list[str], str]:
    """Open a socket, echo one message, let a keepalive ping go unanswered, then close; what asyncio reported."""
    loop = asyncio.get_running_loop()
    reports: list[str] = []
    previous = loop.get_exception_handler()
    loop.set_exception_handler(lambda _loop, context: reports.append(str(context.get("message"))))
    config = uvicorn.Config(
        _app,
        host="127.0.0.1",
        port=0,
        ws=implementation,
        ws_ping_interval=0.1,
        ws_ping_timeout=10,
        log_level="critical",
        lifespan="off",
    )
    server = uvicorn.Server(config)
    serving = asyncio.create_task(server.serve())
    try:
        while not server.started:
            await asyncio.sleep(0.01)
        port = server.servers[0].sockets[0].getsockname()[1]
        reader, writer = await asyncio.open_connection("127.0.0.1", port)
        key = base64.b64encode(os.urandom(16)).decode()
        writer.write(
            f"GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode()
        )
        await reader.readuntil(b"\r\n\r\n")
        writer.write(_masked(0x1, b"hallo"))
        echoed = (await reader.readexactly(7))[2:].decode()  # an unmasked 5-byte text frame
        ping = await reader.readexactly(2)  # the server's keepalive ping; never answered
        assert ping[0] & 0x0F == 0x9
        writer.write(_masked(0x8, (1000).to_bytes(2, "big")))  # a normal close, ping still outstanding
        await asyncio.sleep(0.3)
        writer.close()
        for _ in range(5):
            await asyncio.sleep(0.05)
            gc.collect()
        return reports, echoed
    finally:
        server.should_exit = True
        await serving
        loop.set_exception_handler(previous)


@pytest.mark.asyncio
async def test_the_legacy_implementation_reproduces_the_report():
    # The oracle: if this stops reproducing, the test below proves nothing.
    reports, _ = await _close_during_a_ping("websockets")
    assert any("exception in shielded future" in report for report in reports)


@pytest.mark.asyncio
async def test_the_implementation_production_runs_serves_and_closes_quietly():
    implementation = _production_implementation()
    assert implementation != "auto", "uvicorn's auto picks the legacy protocol"
    reports, echoed = await _close_during_a_ping(implementation)
    assert echoed == "hallo"
    assert reports == []
