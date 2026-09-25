"""The crossing guard for ``STREAM_EXTRA_FIELDS``.

``turn.streaming.STREAM_EXTRA_FIELDS`` is the list of names Piloti lifts
off the finished ``ChatResponse`` and onto the terminal ``ChatResponseChunk``.
The aiq_api handler then pulls names back off that chunk and attaches them to
the websocket frame — via ``_TRANSPARENCY_EXTRA_FIELDS``,
``_SKILLS_EXTRA_FIELDS``, and the four hand-written lifts (``cards``,
``run_id``, ``answer_confidence``, ``sources``).

Both halves are Python lists of strings that must agree, and NOTHING watched
them agree. Rename one entry here — ``"research_truncated"`` to
``"research_cutoff"`` — and the whole backend suite stays green, the frontend
wire spec stays green (it reads the aiq_api list, not this one), and the field
simply stops reaching the browser: the answer quietly stops saying its research
was cut off. That is the failure this file exists to make loud, and it is
pinned for the LIST, not for any one field — a guard naming a single field
leaves the next one just as blind.

What is pinned is the relationship the code actually obeys: **every name the
register lifts must survive the crossing to the frame** — NOT equality of the
two sides. The direction is the point. The handler lifts names off whatever
response reaches it, so it may legitimately know a field this register never
sets, and pinning equality would report the wider list as the bug.
``skills_hidden`` was that case until the chat agent learned to carry it: the
Piloti recorded the ``grid-hidden`` subset on its own state, the
chat node dropped it, and the disclosure rendered the house voice at full weight
on every answer. Both lists name it now.

What this file does NOT pin is how a field gets ONTO the answer in the first
place — it builds the ``ChatResponse`` itself. Adding a name to
``STREAM_EXTRA_FIELDS`` therefore passes here whether or not anything ever sets
it, which is exactly how ``skills_hidden`` could be declared end to end and
still reach nobody. The hop from graph state to answer is pinned per field, one
file over, in ``test_hidden_skills_reach_the_answer.py``.

The assertion is the real crossing rather than a comparison of two source
files: a response carrying a sentinel per lifted name is turned into chunks by
the register, the terminal chunk is handed to the real handler with the real
NAT message validator, and the JSON the socket receives is what is asserted on.
So a field lost anywhere along the way — dropped from the chunk, not pulled by
the handler, or refused by the message model (which the handler swallows with
only a warning) — fails here.
"""

from __future__ import annotations

from contextlib import asynccontextmanager

import pytest

from aiq_agent.common import _create_chat_response
from aiq_agent.turn.streaming import STREAM_EXTRA_FIELDS
from aiq_agent.turn.streaming import live_chunk
from aiq_agent.turn.streaming import response_to_chunks
from aiq_api import websocket_reconnect
from aiq_api.websocket_reconnect import ReconnectableWebSocketMessageHandler
from aiq_api.websocket_reconnect import WebSocketSessionRegistry
from nat.data_models.api_server import ChatResponseChunk
from nat.data_models.api_server import WebSocketMessageStatus

CONVERSATION_ID = "conv-crossing"


class _Socket:
    """Records the JSON frames the client would have received."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.scope: dict = {"headers": [], "type": "websocket"}

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


class _SessionManager:
    """Minimal session manager the NAT handler needs to initialise."""

    def get_workflow_single_output_schema(self):
        return None

    def get_workflow_streaming_output_schema(self):
        return None

    @asynccontextmanager
    async def session(self, **_kwargs):
        yield object()


class _StepAdaptor:
    """Minimal step adaptor stub."""


class _Worker:
    """Minimal FastApiFrontEndPluginWorker stand-in."""

    def set_conversation_handler(self, _conversation_id: str, _handler: object) -> None:
        return None

    def get_conversation_handler(self, _conversation_id: str) -> object | None:
        return None

    def remove_conversation_handler(self, _conversation_id: str) -> None:
        return None


async def _frame_for(extras: dict[str, object], monkeypatch) -> dict:
    """The websocket frame produced by a finished answer carrying ``extras``.

    Runs the whole backend half of the crossing: the register's chunking, the
    aiq_api handler's lift, and the registry send that serialises the message.
    """
    response = _create_chat_response("die Antwort", response_id="r1", model="chat_researcher")
    for name, value in extras.items():
        setattr(response, name, value)
    terminal = response_to_chunks(response, stream=True)[-1]
    return await _send(terminal, WebSocketMessageStatus.COMPLETE, monkeypatch)


async def _send(chunk: ChatResponseChunk, status: WebSocketMessageStatus, monkeypatch) -> dict:
    """The websocket frame the real handler sends for ``chunk``."""
    socket = _Socket()
    registry = WebSocketSessionRegistry()
    monkeypatch.setattr(websocket_reconnect, "_registry", registry)
    await registry.set_socket(CONVERSATION_ID, socket)

    handler = ReconnectableWebSocketMessageHandler(
        socket=socket,
        session_manager=_SessionManager(),
        step_adaptor=_StepAdaptor(),
        worker=_Worker(),
    )
    handler._conversation_id = CONVERSATION_ID
    await handler.create_websocket_message(data_model=chunk, status=status)

    assert socket.sent, "the chunk never reached the socket at all"
    return socket.sent[-1]


async def test_every_lifted_extra_reaches_the_frame(monkeypatch) -> None:
    """Each name in ``STREAM_EXTRA_FIELDS`` arrives on the client's frame."""
    sentinels = {name: f"sentinel::{name}" for name in STREAM_EXTRA_FIELDS}
    frame = await _frame_for(sentinels, monkeypatch)

    for name in STREAM_EXTRA_FIELDS:
        assert name in frame, (
            f"{name!r} is lifted onto the terminal chunk by STREAM_EXTRA_FIELDS "
            f"(src/aiq_agent/turn/streaming.py) but never reaches the websocket "
            f"frame: nothing downstream reads it. Add it to _TRANSPARENCY_EXTRA_FIELDS / "
            f"_SKILLS_EXTRA_FIELDS in frontends/aiq_api/src/aiq_api/websocket_reconnect.py, or "
            f"correct the name here — the two sides must agree, and only this test says so."
        )
        assert frame[name] == sentinels[name], (
            f"{name!r} reaches the frame but not with the value the answer carried "
            f"(got {frame[name]!r}) — the crossing rewrote or emptied it."
        )


async def test_a_name_the_handler_does_not_lift_never_reaches_the_frame(monkeypatch) -> None:
    """The teeth: an extra nobody downstream reads is dropped in silence.

    Without this, the test above could be passing because everything on a
    terminal chunk reaches the client regardless. ``research_cutoff`` is the
    exact typo the guard exists to catch — set on the answer, carried on the
    chunk, and gone by the time the frame is sent, with nothing raised or
    logged as an error.
    """
    frame = await _frame_for({"research_cutoff": "sentinel::research_cutoff"}, monkeypatch)

    assert "research_cutoff" not in frame
    assert "research_truncated" not in frame


SOURCE = {"citation_key": "oib-rl_2", "index": 1}
MASTHEAD = {"verdict": {"status": "erfüllt"}}
CARD = {"type": "summary"}


@pytest.mark.parametrize(
    ("chunk", "carried"),
    [
        (live_chunk("Ein Satz "), {}),
        (live_chunk("Gesetzt [1].", sources=[SOURCE]), {"stream_replace": True, "sources": [SOURCE]}),
        (live_chunk("", sources=[]), {"stream_replace": True}),
        (live_chunk("", answer_meta=MASTHEAD), {"answer_meta": MASTHEAD}),
        (live_chunk("", cards=[CARD]), {"cards": [CARD]}),
    ],
    ids=["delta", "snapshot", "retraction", "masthead", "cards"],
)
async def test_every_kind_of_live_chunk_reaches_the_frame_while_the_answer_streams(chunk, carried, monkeypatch) -> None:
    """A live chunk (ADR-0066) crosses on an IN_PROGRESS frame with what makes it that kind.

    Without ``stream_replace`` a snapshot reads as a delta and appends the
    settled prose to the raw prose; without ``answer_meta`` or ``cards`` the
    masthead and the cards wait for the terminal frame.
    """
    frame = await _send(chunk, WebSocketMessageStatus.IN_PROGRESS, monkeypatch)

    assert frame["status"] == WebSocketMessageStatus.IN_PROGRESS
    assert frame["content"]["text"] == chunk.choices[0].delta.content
    for name, value in carried.items():
        assert frame.get(name) == value, f"{name!r} did not reach the live frame"
    for name in {"stream_replace", "sources", "answer_meta", "cards"} - carried.keys():
        assert name not in frame, f"{name!r} reached a live frame that did not carry it"
