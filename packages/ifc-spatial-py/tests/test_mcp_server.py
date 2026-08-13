"""The MCP binding, over a real stdio session.

Everything the tools DO is tested in ``test_tools.py`` against the
transport-free definitions. What is left to prove here is the binding itself,
and the two things that only break over the wire: that the console entry point
speaks JSON-RPC at all, and that stdout stays clean enough for a client to parse
— IfcOpenShell's geometry iterator writes progress from C++, and one stray byte
in the middle of a frame is a malformed message rather than a noisy one.
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

pytest.importorskip("mcp", reason="der offizielle MCP-SDK ist optional: pip install ifc-spatial-py[mcp]")

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT.parents[0] / "ifc-spatial" / "test" / "fixtures"
SAMPLE_HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"
WINDOW = "3cUkl32yn9qRSPvBJVyWcE"


def test_create_server_exposes_the_tool_list() -> None:
    from ifc_spatial.mcp_server import create_server

    server, tools = create_server()
    assert server is not None
    assert [tool.name for tool in tools][0] == "open_model"


class _Session:
    """A JSON-RPC client speaking to `ifc-spatial-mcp` over a pipe.

    Both of the child's output pipes are DRAINED by their own thread, and every
    read is BOUNDED. Neither is tidiness:

    - An unread ``stderr=PIPE`` stops the child dead once the OS pipe buffer
      fills (64 KiB on Linux). IfcOpenShell's geometry iterator writes progress
      from C++, which is the one thing in this process that could produce that
      much, and a child blocked writing to stderr never answers on stdout
      again. Measured on ``Ifc4_SampleHouse.ifc`` the whole session writes 38
      bytes there, so it is a long way from the buffer today — but "today" is a
      fixture, and the failure it buys is not a red test.
    - ``readline()`` has no timeout and this package configures none
      (``addopts = "-ra"``, no ``pytest-timeout``), so a server that stops
      answering hangs the job instead of failing it. A hung CI job has to be
      noticed by a human before it says anything at all.

    stderr is kept rather than sent to ``DEVNULL`` precisely because it now
    costs nothing to keep: it is what says WHY, in the two assertions below
    that fire when the server has stopped talking.
    """

    #: A ceiling on ONE answer, not a performance assertion. The slowest call
    #: here is `open_model` on the sample house with its geometry pass, well
    #: under a second, so this only ever fires when the server has stopped
    #: answering altogether.
    READ_TIMEOUT_SECONDS = 60.0

    def __init__(self) -> None:
        env = dict(os.environ, PYTHONPATH=str(ROOT / "src"))
        self.process = subprocess.Popen(
            [sys.executable, "-c", "from ifc_spatial.mcp_server import main; main()"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
            bufsize=1,
        )
        self.frames: queue.Queue[str] = queue.Queue()
        self.errors: list[str] = []
        for pump in (self._pump_stdout, self._pump_stderr):
            threading.Thread(target=pump, daemon=True).start()

    def _pump_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            self.frames.put(line)
        # An empty frame is END OF STREAM, so a server that died is reported at
        # once instead of after the full timeout.
        self.frames.put("")

    def _pump_stderr(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            self.errors.append(line)

    def _diagnosis(self) -> str:
        tail = "".join(self.errors[-10:]).strip()
        return f"\nstderr:\n{tail}" if tail else ""

    def send(self, message: dict) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def read(self, timeout: float | None = None) -> dict:
        try:
            line = self.frames.get(timeout=timeout or self.READ_TIMEOUT_SECONDS)
        except queue.Empty:
            self.process.kill()
            raise AssertionError(
                f"der Server hat innerhalb von {timeout or self.READ_TIMEOUT_SECONDS:.1f} s "
                f"nicht geantwortet{self._diagnosis()}"
            ) from None
        assert line, f"der Server hat die Verbindung geschlossen{self._diagnosis()}"
        # Every line on stdout must be a frame. Anything else means something
        # printed into the protocol.
        return json.loads(line)

    def request(self, id: int, method: str, params: dict | None = None) -> dict:
        self.send({"jsonrpc": "2.0", "id": id, "method": method, "params": params or {}})
        return self.read()

    def close(self) -> None:
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=20)
        except subprocess.TimeoutExpired:  # pragma: no cover
            self.process.kill()


@pytest.fixture(scope="module")
def session() -> _Session:
    client = _Session()
    hello = client.request(
        1,
        "initialize",
        {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "pytest", "version": "1"}},
    )
    assert hello["result"]["serverInfo"]["name"] == "ifc-spatial"
    client.send({"jsonrpc": "2.0", "method": "notifications/initialized"})
    yield client
    client.close()


def test_the_client_drains_stderr_and_bounds_its_reads(session: _Session) -> None:
    """The two ways this harness could hang CI rather than fail it.

    The server's readiness line arrives on stderr, so finding it there is proof
    that the pipe is being emptied and not silently filling toward the 64 KiB
    that would stop the child mid-answer. The second half is the read itself: a
    server that says nothing has to end as an assertion, not as a job that
    never returns.
    """
    # The line is written before the server reads its first frame, so it has
    # long since arrived — but it arrives on ANOTHER thread, and a test that
    # races its own harness is the kind of flake this whole change is about.
    deadline = time.monotonic() + 5.0
    while not any("bereit" in line for line in session.errors) and time.monotonic() < deadline:
        time.sleep(0.02)
    assert any("bereit" in line for line in session.errors)

    silent = _Session()
    try:
        # Nothing was sent, so nothing can come back. 0.5 s is enough to tell
        # "not answering" from "still starting"; the point is that it RETURNS.
        with pytest.raises(AssertionError, match="nicht geantwortet"):
            silent.read(timeout=0.5)
    finally:
        silent.close()


def test_lists_the_tools_with_their_german_descriptions(session: _Session) -> None:
    listed = session.request(2, "tools/list")["result"]["tools"]
    names = [tool["name"] for tool in listed]
    assert names[0] == "open_model" and "relations" in names and "draw" in names
    relations = next(tool for tool in listed if tool["name"] == "relations")
    assert "decidable: false" in relations["description"]
    assert relations["inputSchema"]["properties"]["relation"]["enum"][0] == "hostedIn"


def test_a_full_call_returns_the_answer_with_its_provenance(session: _Session) -> None:
    opened = session.request(3, "tools/call", {"name": "open_model", "arguments": {"path": str(SAMPLE_HOUSE)}})
    payload = json.loads(opened["result"]["content"][0]["text"])
    assert "GEBÄUDE" in payload["briefing"]
    handle = payload["model"]

    answered = session.request(
        4,
        "tools/call",
        {"name": "relations", "arguments": {"model": handle, "globalId": WINDOW, "relation": "opensTo"}},
    )
    assert not answered["result"].get("isError")
    room = json.loads(answered["result"]["content"][0]["text"])
    assert [ref["name"] for ref in room["value"]] == ["Bedroom"]
    assert room["provenance"] == "computed"


def test_an_unknown_global_id_comes_back_as_a_tool_error(session: _Session) -> None:
    """`isError` rather than a thrown protocol error: the model has to SEE the
    reason to correct itself. A wrong GlobalId is a fixable mistake, not an
    outage."""
    opened = session.request(5, "tools/call", {"name": "open_model", "arguments": {"path": str(SAMPLE_HOUSE)}})
    handle = json.loads(opened["result"]["content"][0]["text"])["model"]
    failed = session.request(
        6,
        "tools/call",
        {"name": "relations", "arguments": {"model": handle, "globalId": "nicht-vorhanden", "relation": "hosts"}},
    )
    assert failed["result"]["isError"] is True
    assert "Unbekannte GlobalId" in failed["result"]["content"][0]["text"]
