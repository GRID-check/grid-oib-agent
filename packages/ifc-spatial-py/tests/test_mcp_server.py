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
import subprocess
import sys
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
    """A JSON-RPC client speaking to `ifc-spatial-mcp` over a pipe."""

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

    def send(self, message: dict) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def read(self) -> dict:
        assert self.process.stdout is not None
        line = self.process.stdout.readline()
        assert line, "der Server hat die Verbindung geschlossen"
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


def test_lists_the_tools_with_their_german_descriptions(session: _Session) -> None:
    listed = session.request(2, "tools/list")["result"]["tools"]
    names = [tool["name"] for tool in listed]
    assert names[0] == "open_model" and "relations" in names and "draw" in names
    relations = next(tool for tool in listed if tool["name"] == "relations")
    assert "decidable: false" in relations["description"]
    assert relations["inputSchema"]["properties"]["relation"]["enum"][0] == "hostedIn"


def test_a_full_call_returns_the_answer_with_its_provenance(session: _Session) -> None:
    opened = session.request(
        3, "tools/call", {"name": "open_model", "arguments": {"path": str(SAMPLE_HOUSE)}}
    )
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
    opened = session.request(
        5, "tools/call", {"name": "open_model", "arguments": {"path": str(SAMPLE_HOUSE)}}
    )
    handle = json.loads(opened["result"]["content"][0]["text"])["model"]
    failed = session.request(
        6,
        "tools/call",
        {"name": "relations", "arguments": {"model": handle, "globalId": "nicht-vorhanden", "relation": "hosts"}},
    )
    assert failed["result"]["isError"] is True
    assert "Unbekannte GlobalId" in failed["result"]["content"][0]["text"]
