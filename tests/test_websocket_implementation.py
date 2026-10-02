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


def _module_constant(name: str) -> object:
    """A constant from start_web.py, read without importing it (the script has import-time effects)."""
    for node in ast.parse(START_WEB.read_text()).body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == name for t in node.targets):
            return ast.literal_eval(node.value)
    raise AssertionError(f"deploy/start_web.py no longer names {name}")


def _production_implementation() -> str:
    return str(_module_constant("WS_IMPLEMENTATION"))


def _uvicorn_run_keywords() -> dict[str, str]:
    """The keyword arguments ``main()`` passes to ``uvicorn.run``, each as the name or literal it is given."""
    for node in ast.walk(ast.parse(START_WEB.read_text())):
        if isinstance(node, ast.Call) and ast.unparse(node.func) == "uvicorn.run":
            return {kw.arg: ast.unparse(kw.value) for kw in node.keywords if kw.arg}
    raise AssertionError("deploy/start_web.py no longer calls uvicorn.run")


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


def test_keepalive_tolerates_a_late_pong():
    # uvicorn's default ws_ping_timeout of 20 s closed live chat sockets with
    # 1011 when a background tab or a waking radio answered late.
    keywords = _uvicorn_run_keywords()
    assert keywords["ws_ping_interval"] == "WS_PING_INTERVAL"
    assert keywords["ws_ping_timeout"] == "WS_PING_TIMEOUT"
    assert _module_constant("WS_PING_INTERVAL") == 20.0
    assert _module_constant("WS_PING_TIMEOUT") == 60.0


#: Runs in a fresh interpreter, because websockets reads its line limit once, at
#: import. With ``start_web`` loaded first (argv[1] == "1") the limit is the
#: script's; without it, websockets' own 8192. Prints the upgrade's status line.
_UPGRADE_WITH_A_LONG_LINE = """
import asyncio, base64, os, runpy, sys
if sys.argv[1] == "1":
    runpy.run_path(sys.argv[2], run_name="start_web")
import uvicorn

async def app(scope, receive, send):
    if scope["type"] == "websocket":
        await receive()
        await send({"type": "websocket.accept"})
        await send({"type": "websocket.close"})

async def main():
    config = uvicorn.Config(app, host="127.0.0.1", port=0, ws=sys.argv[3], log_level="critical", lifespan="off")
    server = uvicorn.Server(config)
    serving = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.01)
    port = server.servers[0].sockets[0].getsockname()[1]
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    key = base64.b64encode(os.urandom(16)).decode()
    writer.write(
        f"GET / HTTP/1.1\\r\\nHost: x\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n"
        f"Sec-WebSocket-Key: {key}\\r\\nSec-WebSocket-Version: 13\\r\\n"
        f"X-Grid-Request-Context: {'A' * int(sys.argv[4])}\\r\\n\\r\\n".encode()
    )
    try:
        print((await asyncio.wait_for(reader.readline(), 3)).decode().strip() or "closed")
    except asyncio.TimeoutError:
        print("no answer")
    writer.close()
    server.should_exit = True
    await serving

asyncio.run(main())
"""


def _upgrade_status(*, with_start_web: bool, line_length: int) -> str:
    import subprocess
    import sys

    env = {key: value for key, value in os.environ.items() if key != "WEBSOCKETS_MAX_LINE_LENGTH"}
    args = ["1" if with_start_web else "0", str(START_WEB), _production_implementation(), str(line_length)]
    done = subprocess.run(
        [sys.executable, "-c", _UPGRADE_WITH_A_LONG_LINE, *args],
        capture_output=True,
        text=True,
        env=env,
        timeout=60,
        check=False,
    )
    return done.stdout.strip()


def test_websockets_alone_drops_an_upgrade_whose_envelope_line_is_long():
    # The oracle: websockets' default 8192-byte line limit drops the upgrade
    # with no response at all. If this ever upgrades, the test below proves nothing.
    assert _upgrade_status(with_start_web=False, line_length=12_000) == "no answer"


def test_production_upgrades_a_socket_whose_envelope_line_is_long():
    # The signed request context is one header line and the project context in
    # it is unbounded; past 8192 bytes a project's chat would never connect.
    assert _module_constant("WS_MAX_HEADER_LINE") >= 65536
    assert _upgrade_status(with_start_web=True, line_length=60_000) == "HTTP/1.1 101 Switching Protocols"
