"""The chat wire v2 contract, read from this side (``docs/design/chat-wire-v2.md``).

The fixtures under ``shared/wire/v2/`` are recorded turns, one event per line.
``frontends/ui/src/adapters/api/wire-v2.spec.ts`` reads the same files with the
generated zod schemas, so a field the two sides disagree on fails one of the two
suites. What this side adds: the frame the server would write for a fixture is
the fixture itself (defaults omitted, discriminators kept), the ordering rules
of a turn hold, and the committed JSON Schema is the one the models generate.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from aiq_agent.common.wire_v2 import CLIENT_MESSAGE
from aiq_agent.common.wire_v2 import WIRE_EVENT
from aiq_agent.common.wire_v2 import AnswerRetractedBody
from aiq_agent.common.wire_v2 import EmptyValue
from aiq_agent.common.wire_v2 import StatusStep
from aiq_agent.common.wire_v2 import StepFinishedBody
from aiq_agent.common.wire_v2 import TextMessageContentBody
from aiq_agent.common.wire_v2 import card_key
from aiq_agent.common.wire_v2 import stamp
from aiq_agent.common.wire_v2 import to_frame

ROOT = Path(__file__).resolve().parents[3]
FIXTURES = ROOT / "shared" / "wire" / "v2"
SCHEMA = ROOT / "shared" / "wire" / "v2.schema.json"
TURNS = sorted(FIXTURES.glob("turn-*.jsonl"))
TERMINAL = {"RUN_FINISHED", "RUN_ERROR"}


def _lines(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _events(path: Path) -> list[tuple[str, dict[str, Any]]]:
    return [(f"{path.name}:{n}", raw) for n, raw in enumerate(_lines(path), 1)]


ALL_EVENTS = [item for path in [*TURNS, FIXTURES / "rejected.jsonl"] for item in _events(path)]


def test_there_is_a_fixture_for_every_event_the_contract_names() -> None:
    names = {raw["name"] if raw["type"] == "CUSTOM" else raw["type"] for _, raw in ALL_EVENTS}
    kinds = {raw["step"]["kind"] for _, raw in ALL_EVENTS if "step" in raw}
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))["$defs"]["WireEvent"]
    mapping = schema["discriminator"]["mapping"]
    expected = {name for name in mapping if name != "CUSTOM"} | set(mapping["CUSTOM"]["discriminator"]["mapping"])
    assert names == expected
    assert kinds == {"status", "retrieval", "sources", "tool", "skill", "clarification"}


@pytest.mark.parametrize(("where", "raw"), ALL_EVENTS, ids=[where for where, _ in ALL_EVENTS])
def test_every_recorded_event_is_the_frame_the_server_writes(where: str, raw: dict[str, Any]) -> None:
    event = WIRE_EVENT.validate_python(raw)
    assert to_frame(event) == raw, where


@pytest.mark.parametrize("path", TURNS, ids=[path.name for path in TURNS])
def test_a_turn_is_one_ordered_sequence(path: Path) -> None:
    events = _lines(path)
    assert events[0]["type"] == "RUN_STARTED"
    assert [event["seq"] for event in events] == list(range(1, len(events) + 1))
    assert len({event["turn_id"] for event in events}) == 1
    assert all(a["ts"] <= b["ts"] for a, b in zip(events, events[1:], strict=False))
    terminal = [n for n, event in enumerate(events) if event["type"] in TERMINAL]
    assert len(terminal) == 1
    after = events[terminal[0] + 1 :]
    # Only the post-answer stages outlive the turn; a heartbeat never does.
    assert all(event["type"] == "CUSTOM" and event["name"] == "stage" for event in after)


def test_a_rejection_is_out_of_band() -> None:
    for event in _lines(FIXTURES / "rejected.jsonl"):
        assert event["seq"] == 0
        assert event["name"] == "rejected"


@pytest.mark.parametrize("raw", _lines(FIXTURES / "client.jsonl"))
def test_every_client_message_parses(raw: dict[str, Any]) -> None:
    message = CLIENT_MESSAGE.validate_python(raw)
    assert message.model_dump(mode="json", exclude_defaults=True) == raw


@pytest.mark.parametrize("raw", _lines(FIXTURES / "invalid-events.jsonl"))
def test_what_is_not_a_v2_event_is_refused(raw: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        WIRE_EVENT.validate_python(raw)


@pytest.mark.parametrize("raw", _lines(FIXTURES / "invalid-client.jsonl"))
def test_what_is_not_a_v2_client_message_is_refused(raw: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        CLIENT_MESSAGE.validate_python(raw)


def test_stamp_puts_a_body_under_the_turns_envelope() -> None:
    body = StepFinishedBody(step=StatusStep(id="status:synthesis", slot="synthesis", key="status.synthesis"))
    frame = to_frame(stamp(body, conversation_id="c", turn_id="t", seq=7, ts=1))
    assert frame == {
        "v": 2,
        "type": "STEP_FINISHED",
        "conversation_id": "c",
        "turn_id": "t",
        "seq": 7,
        "ts": 1,
        "step": {"kind": "status", "id": "status:synthesis", "slot": "synthesis", "key": "status.synthesis"},
    }
    delta = to_frame(
        stamp(TextMessageContentBody(message_id="m", delta="x"), conversation_id="c", turn_id="t", seq=8, ts=2)
    )
    assert delta["delta"] == "x"
    retracted = to_frame(stamp(AnswerRetractedBody(value=EmptyValue()), conversation_id="c", turn_id="t", seq=9, ts=3))
    assert retracted["name"] == "answer_retracted"
    assert retracted["value"] == {}


def test_a_card_key_is_its_content() -> None:
    card = {"type": "verdict_header", "subject": "Maximale Fluchtweglänge", "verdict": "40 m"}
    assert card_key(card) == card_key(dict(reversed(list(card.items()))))
    assert card_key(card) != card_key({**card, "verdict": "35 m"})


def test_the_committed_schema_is_the_one_the_models_generate() -> None:
    from scripts.generate_wire_schema import render

    assert SCHEMA.read_text(encoding="utf-8") == render(), (
        "shared/wire/v2.schema.json is stale: run `uv run python scripts/generate_wire_schema.py`, "
        "then `npm run generate:wire` in frontends/ui, and commit both."
    )
