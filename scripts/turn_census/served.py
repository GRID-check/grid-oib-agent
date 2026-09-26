"""The agent as a reader reaches it: the production launcher, driven over the chat socket.

``nat run`` answers a question through NAT's console front end, which never
touches ``frontends/aiq_api``: not the socket handler, not the workflow stream,
not the WebSocket server. Every production error filed on 2026-09-26 lived in
exactly that layer (#334, #337, #338, #758, #759), so a check that runs turns
through ``nat run`` cannot see the class of fault it most needs to. This module
serves the backend with ``deploy/start_web.py``, the command the container
runs, and speaks to it the way the UI does (``adapters/api/websocket-client.ts``).

Two things a reader does are provided: ask a question and read the answer
(:func:`ask`), and send again while an answer is still being written, which
cancels the first turn (:func:`ask_and_interrupt`). When a turn stops to ask a
clarifying question, both answer it as a reader would (:func:`clarification_reply`).

The backend runs without its BFF: ``REQUIRE_AUTH=false`` (no WorkOS), a
throwaway SQLite job store, and no internal API. What depends on the BFF says
so at startup; a caller that gates on ERROR records should read the log from
the first turn on (:meth:`Server.log_since`).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import uuid
from collections.abc import Iterator
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CONFIG = "configs/config_oib_openrouter.yml"
#: How long the backend gets to build its workflow and start serving.
STARTUP_SECONDS = 300
#: How long one turn gets to reach its COMPLETE frame.
TURN_SECONDS = 600


@dataclass
class Turn:
    """What one turn sent back over the socket."""

    message_id: str
    answer: str = ""
    steps: list[dict] = field(default_factory=list)
    frames: int = 0
    clarifications: int = 0
    completed: bool = False


@dataclass
class Server:
    """A running backend, and the log it writes."""

    port: int
    log: Path

    @property
    def socket_url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/websocket"

    def log_offset(self) -> int:
        return self.log.stat().st_size

    def log_since(self, offset: int) -> str:
        with self.log.open("rb") as handle:
            handle.seek(offset)
            return handle.read().decode(errors="replace")


@contextlib.contextmanager
def serve(log: Path) -> Iterator[Server]:
    """Run ``deploy/start_web.py`` until the block ends; raise with the log's tail if it never serves."""
    port = _free_port()
    jobs = Path(tempfile.mkdtemp(prefix="served-jobs-")) / "jobs.db"
    env = {
        **os.environ,
        "CONFIG_FILE": CONFIG,
        "HOST": "127.0.0.1",
        "PORT": str(port),
        "REQUIRE_AUTH": "false",
        "GRID_JOB_EXECUTION": "db",
        "NAT_JOB_STORE_DB_URL": f"sqlite+aiosqlite:///{jobs}",
    }
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("wb") as sink:
        process = subprocess.Popen(
            [sys.executable, "deploy/start_web.py"], cwd=REPO, env=env, stdout=sink, stderr=subprocess.STDOUT
        )
    try:
        _wait_until_serving(process, port, log)
        yield Server(port=port, log=log)
    finally:
        process.terminate()
        try:
            process.wait(timeout=30)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _wait_until_serving(process: subprocess.Popen, port: int, log: Path) -> None:
    deadline = time.monotonic() + STARTUP_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"the backend exited while starting:\n{_tail(log)}")
        with contextlib.suppress(OSError):
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2):
                return
        time.sleep(1)
    raise RuntimeError(f"the backend did not serve within {STARTUP_SECONDS}s:\n{_tail(log)}")


def _tail(log: Path, lines: int = 40) -> str:
    return "\n".join(log.read_text(errors="replace").splitlines()[-lines:])


def user_message(text: str, conversation_id: str) -> tuple[str, str]:
    """A ``user_message`` frame as the UI sends it, and its id."""
    message_id = str(uuid.uuid4())
    frame = {
        "type": "user_message",
        "schema_type": "chat_stream",
        "id": message_id,
        "conversation_id": conversation_id,
        "content": {"messages": [{"role": "user", "content": [{"type": "text", "text": json.dumps({"query": text})}]}]},
    }
    return json.dumps(frame), message_id


def read_frame(turn: Turn, frame: dict) -> None:
    """Fold one socket frame into ``turn``: a step, or its COMPLETE answer.

    Response frames name the user message they answer in ``parent_id``, so one
    for another turn is ignored. Step frames carry the step tree's parent
    instead, so they are taken as they come: a socket runs one turn at a time.
    """
    content = frame.get("content")
    if not isinstance(content, dict):
        content = {}
    if frame.get("type") == "system_intermediate_message":
        turn.frames += 1
        turn.steps.append({"name": content.get("name"), "payload": content.get("payload")})
        return
    if frame.get("type") != "system_response_message" or frame.get("parent_id") != turn.message_id:
        return
    turn.frames += 1
    if frame.get("status") == "complete":
        turn.answer = str(content.get("text") or "")
        turn.completed = True


async def ask(server: Server, question: str) -> Turn:
    """Ask ``question`` on a new conversation and read the turn to its COMPLETE frame."""
    import websockets

    conversation_id = f"served-{uuid.uuid4().hex[:12]}"
    async with websockets.connect(_url(server, conversation_id), max_size=None) as ws:
        frame, message_id = user_message(question, conversation_id)
        turn = Turn(message_id=message_id)
        await ws.send(frame)
        await asyncio.wait_for(_read_until_complete(ws, turn), TURN_SECONDS)
        return turn


async def ask_and_interrupt(server: Server, question: str, follow_up: str, *, after_frames: int = 5) -> Turn:
    """Ask ``question``, send ``follow_up`` on the same conversation while it runs, and read the follow-up's turn.

    Sending again mid-answer is how a reader cancels a turn: the handler
    cancels the running one and starts the next (``set_workflow_task``).
    """
    import websockets

    conversation_id = f"served-{uuid.uuid4().hex[:12]}"
    async with websockets.connect(_url(server, conversation_id), max_size=None) as ws:
        frame, first_id = user_message(question, conversation_id)
        first = Turn(message_id=first_id)
        await ws.send(frame)
        await asyncio.wait_for(_read_frames(ws, first, until=lambda: first.frames >= after_frames), TURN_SECONDS)
        frame, second_id = user_message(follow_up, conversation_id)
        second = Turn(message_id=second_id)
        await ws.send(frame)
        await asyncio.wait_for(_read_until_complete(ws, second), TURN_SECONDS)
        return second


def _url(server: Server, conversation_id: str) -> str:
    return f"{server.socket_url}?conversationId={conversation_id}&conversation_id={conversation_id}"


async def _read_until_complete(ws, turn: Turn) -> None:
    await _read_frames(ws, turn, until=lambda: turn.completed)


async def _read_frames(ws, turn: Turn, *, until) -> None:
    async for raw in ws:
        try:
            frame = json.loads(raw)
        except json.JSONDecodeError:
            continue
        read_frame(turn, frame)
        if (reply := clarification_reply(turn, frame)) is not None:
            await ws.send(reply)
        if until():
            return


def clarification_reply(turn: Turn, frame: dict) -> str | None:
    """The answer a reader gives when ``turn`` stops to ask: the first option offered, else a plain go-ahead.

    The clarifier asks before answering when the question is broad and the
    corpus is there to narrow it; left unanswered, the turn waits for the reader
    until it times out. The UI answers with ``user_interaction_message``
    (``websocket-client.ts`` ``sendInteractionResponse``), naming the user
    message the prompt belongs to.
    """
    if frame.get("type") != "system_interaction_message" or frame.get("parent_id") != turn.message_id:
        return None
    content = frame.get("content") if isinstance(frame.get("content"), dict) else {}
    if content.get("input_type") == "notification":
        return None
    options = [o for o in content.get("options") or [] if isinstance(o, dict)]
    text = str(options[0].get("label") or options[0].get("value")) if options else "Einen Überblick, bitte."
    turn.clarifications += 1
    return json.dumps(
        {
            "type": "user_interaction_message",
            "id": str(uuid.uuid4()),
            "parent_id": turn.message_id,
            "conversation_id": frame.get("conversation_id"),
            "content": {"messages": [{"role": "user", "content": [{"type": "text", "text": text}]}]},
        }
    )
