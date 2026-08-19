"""The producer half of the post-answer stage wire contract.

`shared/stages/frames.json` **is** the contract (§9), not a description of one:
one JSON fixture per `(stage, status)` that reaches the wire, read by both
halves. This file is the Python reader — it asserts `build_stage_frame()`
produces those frames field for field. `stage-frame-wire.spec.ts` is the
TypeScript reader and asserts the client accepts them. Neither half can call the
other, so the fixture file is the only thing that can make them disagree out
loud: rename a key, bump the envelope, add a status, and exactly one of the two
fails.

Until this file existed the TypeScript half stood in for it by reading
`runner.py` as text and pinning the frame type, the envelope version and the
builder's key set with regexes. That stand-in is deleted in the same change that
lands this: two tests asserting the same thing by different routes is how one of
them quietly stops meaning anything, and the one that would have stopped meaning
anything is the one that reads a Python file from a `.spec.ts`.

**`rejected` is deliberately not read here.** Those four frames — an unknown
stage, an unknown status, a future `v`, a payload beside a non-`ready` status —
are things a producer must never emit and a client must therefore drop. There is
nothing for a frame builder to assert about a frame it cannot build; they are the
client half's, and inventing Python assertions for them would test this file's
imagination rather than the contract.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from aiq_agent.stages import STAGE_FRAME_TYPE
from aiq_agent.stages import STAGE_FRAME_VERSION
from aiq_agent.stages import build_stage_frame
from aiq_agent.stages import get_stage
from aiq_agent.stages import iter_stages
from aiq_agent.stages.spec import StageOutcome
from aiq_agent.stages.spec import TurnFacts

FIXTURES = Path(__file__).resolve().parents[3] / "shared" / "stages" / "frames.json"

#: The statuses that reach a reader. `timeout` is mapped onto `failed` by the
#: builder and `skipped` / `disabled` never leave the runner at all, so these
#: three are the whole wire surface — and therefore what "one fixture per
#: (stage, status)" has to mean.
WIRE_STATUSES = ("ready", "empty", "failed")

#: A `failed` outcome must name a reason (it is what the span groups by). The
#: value is arbitrary here precisely because none of it may reach the frame.
FAILURE_REASON = "RuntimeError"


def _fixtures() -> dict:
    return json.loads(FIXTURES.read_text(encoding="utf-8"))


def _delivered() -> dict[str, dict]:
    return _fixtures()["delivered"]


def _facts_for(frame: dict) -> TurnFacts:
    """The turn the fixture describes. `parent_id` is the correlation key and the
    only id both halves genuinely share."""
    return TurnFacts(
        conversation_id=frame["conversation_id"],
        ws_parent_id=frame["parent_id"],
        answer="Mindestens 100 cm nach OIB-Richtlinie 4.",
    )


def _outcome_for(stage_id: str, frame: dict) -> StageOutcome:
    status = frame["status"]
    return StageOutcome(
        stage_id=stage_id,
        status=status,
        reason=FAILURE_REASON if status == "failed" else None,
        payload=frame.get("payload") if status == "ready" else None,
    )


def _without_timestamp(frame: dict) -> dict:
    """`timestamp` is stamped at send time, so it is the one field a producer
    test cannot compare. Everything else is compared exactly."""
    return {key: value for key, value in frame.items() if key != "timestamp"}


class TestTheFixtureFileIsReachable:
    def test_it_is_on_disk_where_the_typescript_half_also_looks(self) -> None:
        """A guard on the guard: if the file moves, every parametrised assertion
        below would silently collapse to zero cases instead of failing."""
        assert FIXTURES.is_file(), f"the shared contract file is missing: {FIXTURES}"
        assert _delivered(), "the contract file carries no delivered frames"

    def test_the_envelope_this_producer_stamps_is_the_one_the_fixtures_carry(self) -> None:
        fixtures = _fixtures()
        assert STAGE_FRAME_TYPE == fixtures["type"]
        assert STAGE_FRAME_VERSION == fixtures["v"]


class TestEveryFixtureIsWhatTheBuilderProduces:
    @pytest.mark.parametrize("name", sorted(_delivered()))
    def test_the_builder_produces_this_fixture_field_for_field(self, name: str) -> None:
        frame = _delivered()[name]
        stage_id = frame["stage"]
        spec = get_stage(stage_id)
        assert spec is not None, f"{name} names {stage_id!r}, which no stage declares"

        built = build_stage_frame(spec, _facts_for(frame), _outcome_for(stage_id, frame))

        assert _without_timestamp(built) == _without_timestamp(frame), (
            f"build_stage_frame() no longer produces the {name} fixture. The fixture IS the "
            f"contract: change it and the TypeScript half fails too, which is the point. "
            f"Changing only the builder means the client is now parsing something the backend "
            f"has stopped sending."
        )
        assert "timestamp" in built, "the frame lost its timestamp"

    @pytest.mark.parametrize("name", sorted(_delivered()))
    def test_a_ready_payload_is_a_shape_its_own_stage_could_emit(self, name: str) -> None:
        """Otherwise the fixture is fiction: a payload the stage's own model
        rejects would be validated into `failed` long before it reached a frame,
        and the contract would be describing a frame that cannot exist."""
        frame = _delivered()[name]
        if frame["status"] != "ready":
            pytest.skip("only a ready frame carries a payload")
        spec = get_stage(frame["stage"])
        assert spec is not None
        if spec.payload_model is None:
            pytest.skip(f"{spec.id} declares no payload model")
        spec.payload_model.model_validate(frame["payload"])


class TestTheFixtureSetIsExhaustive:
    def test_every_frame_stage_has_a_fixture_for_every_wire_status(self) -> None:
        """The direction that catches the NEXT stage.

        `memory_reflection` becomes a frame stage in slice 4b. On the day it
        does, this fails and names the fixtures it needs — rather than the stage
        shipping a frame shape no client was ever built against.
        """
        expected = {
            f"{spec.id}.{status}" for spec in iter_stages() if spec.delivery == "frame" for status in WIRE_STATUSES
        }
        assert set(_delivered()) == expected, (
            "shared/stages/frames.json and the registered frame-delivering stages disagree about "
            "which (stage, status) pairs reach the wire"
        )

    def test_no_fixture_describes_a_stage_that_delivers_nothing(self) -> None:
        """The other direction: a `silent` stage writes its own durable state and
        tells nobody, so a frame fixture for one describes traffic that never
        happens."""
        for name, frame in _delivered().items():
            spec = get_stage(frame["stage"])
            assert spec is not None and spec.delivery == "frame", (
                f"{name} describes a frame for {frame['stage']!r}, which does not deliver frames"
            )


class TestTheStatusesThatNeverReachTheWire:
    def test_a_timeout_is_sent_as_failed(self) -> None:
        """The client renders `failed` and `empty` identically and has nothing to
        do with the difference, so `timeout` is a REJECTED fixture rather than a
        fourth delivered one."""
        spec = get_stage("follow_ups")
        assert spec is not None
        frame = _delivered()["follow_ups.failed"]
        built = build_stage_frame(
            spec,
            _facts_for(frame),
            StageOutcome(stage_id="follow_ups", status="timeout"),
        )
        assert built["status"] == "failed"
        assert _without_timestamp(built) == _without_timestamp(frame)
        assert "follow_ups.timeout" not in _delivered()

    def test_a_failed_frame_carries_no_reason_for_the_reader(self) -> None:
        """Failure reasons are machine keys for the ledger. The outcome carries
        one — the span groups by it — and the frame must not."""
        spec = get_stage("follow_ups")
        assert spec is not None
        frame = _delivered()["follow_ups.failed"]
        built = build_stage_frame(spec, _facts_for(frame), _outcome_for("follow_ups", frame))
        assert "reason" not in built
        assert FAILURE_REASON not in json.dumps(built)

    def test_an_empty_frame_carries_no_payload(self) -> None:
        """`empty` is not "no frame arrived", and only the former lets a client
        stop reserving space — but it is still nothing to render."""
        spec = get_stage("follow_ups")
        assert spec is not None
        frame = _delivered()["follow_ups.empty"]
        built = build_stage_frame(spec, _facts_for(frame), _outcome_for("follow_ups", frame))
        assert "payload" not in built
