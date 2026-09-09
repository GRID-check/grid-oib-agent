"""The record of what a turn READ out of memory (ADR-0055, contract C3).

The rule this file holds is a wording rule as much as a data one: the shape says
what was read and never what was used. So the assertions are about presence,
bounds and honesty — that a turn with no memory produces no field at all, that
nothing on the wire is larger than the contract allows, and that a missing BFF
half degrades to "we do not know" rather than to a marker claiming zero.
"""

from __future__ import annotations

import pytest

from aiq_agent.knowledge.memory_context import MAX_CARRIED
from aiq_agent.knowledge.memory_context import MAX_CONTENT_CHARS
from aiq_agent.knowledge.memory_context import MemoryCarry
from aiq_agent.knowledge.memory_context import MemoryNote
from aiq_agent.knowledge.memory_context import begin_turn_memory_reads
from aiq_agent.knowledge.memory_context import build_memory_context
from aiq_agent.knowledge.memory_context import end_turn_memory_reads
from aiq_agent.knowledge.memory_context import parse_carry
from aiq_agent.knowledge.memory_context import record_memory_search
from aiq_agent.knowledge.memory_context import turn_memory_searched


@pytest.fixture
def turn():
    token = begin_turn_memory_reads()
    yield
    end_turn_memory_reads(token)


class TestParsingTheDigestsReport:
    def test_it_reads_the_three_fields(self):
        carry = parse_carry(
            {
                "carried": [{"id": "m1", "kind": "decision", "content": "Flachdach"}],
                "omitted": 4,
                "total": 25,
            }
        )
        assert carry.carried == (MemoryNote(id="m1", kind="decision", content="Flachdach"),)
        assert (carry.omitted, carry.total) == (4, 25)

    def test_an_older_bff_leaves_it_empty_rather_than_zeroed(self):
        """Absent is not the same as none: the marker must be absent, not claim
        that the turn read nothing."""
        carry = parse_carry({"digest": "PROJECT_MEMORY v1"})
        assert not carry
        assert build_memory_context(carry, searched=0) is None

    @pytest.mark.parametrize("body", [None, "nope", 7, []])
    def test_an_unreadable_body_is_an_empty_carry(self, body):
        assert not parse_carry(body)

    def test_a_malformed_row_is_dropped_and_the_rest_survives(self):
        carry = parse_carry({"carried": [{"id": "m1", "content": "a"}, {"kind": "decision"}, "x", 3, {"id": "  "}]})
        assert [note.id for note in carry.carried] == ["m1"]

    def test_the_list_and_each_note_are_bounded(self):
        carry = parse_carry({"carried": [{"id": f"m{i}", "kind": "decision", "content": "x" * 500} for i in range(40)]})
        assert len(carry.carried) == MAX_CARRIED
        assert all(len(note.content) == MAX_CONTENT_CHARS for note in carry.carried)

    @pytest.mark.parametrize("value", [True, False, -3, "8", None, 1.5e400])
    def test_a_count_that_is_not_a_count_reads_as_zero(self, value):
        assert parse_carry({"omitted": value, "total": value}).omitted == 0


class TestTheFrameExtra:
    def test_a_turn_with_no_memory_gets_no_field(self):
        assert build_memory_context(MemoryCarry(), searched=0) is None
        assert build_memory_context(None, searched=0) is None

    def test_a_search_alone_is_enough_to_produce_one(self):
        """The digest may be empty and the agent may still have gone looking —
        that is the second path this whole decision exists to add."""
        assert build_memory_context(MemoryCarry(), searched=2) == {
            "carried": [],
            "omitted": 0,
            "total": 0,
            "searched": 2,
        }

    def test_the_shape_is_exactly_the_four_declared_fields(self):
        carry = MemoryCarry(
            carried=(MemoryNote(id="m1", kind="decision", content="Flachdach"),),
            omitted=4,
            total=25,
        )
        assert build_memory_context(carry, searched=3) == {
            "carried": [{"id": "m1", "kind": "decision", "content": "Flachdach"}],
            "omitted": 4,
            "total": 25,
            "searched": 3,
        }

    def test_notes_in_scope_with_none_carried_still_produce_a_field(self):
        """`total > 0, carried == []` is a real state — a store that exists and a
        question none of it matched — and the reader is entitled to be told."""
        assert build_memory_context(MemoryCarry(total=12), searched=0) is not None


class TestThePerTurnTally:
    def test_it_counts_notes_and_not_calls(self, turn):
        record_memory_search((MemoryNote("m1", "decision", "a"), MemoryNote("m2", "decision", "b")))
        record_memory_search((MemoryNote("m2", "decision", "b"), MemoryNote("m3", "decision", "c")))
        assert turn_memory_searched() == 3

    def test_it_returns_this_calls_own_new_count_for_the_status_line(self, turn):
        assert record_memory_search((MemoryNote("m1", "decision", "a"),)) == 1
        assert record_memory_search((MemoryNote("m1", "decision", "a"),)) == 0

    def test_it_does_not_outlive_the_turn(self):
        """Module-level state here would carry one tenant's read counts into the
        next turn (``src/aiq_agent/AGENTS.md``)."""
        token = begin_turn_memory_reads()
        record_memory_search((MemoryNote("m1", "decision", "a"),))
        assert turn_memory_searched() == 1
        end_turn_memory_reads(token)
        assert turn_memory_searched() == 0

    def test_outside_a_turn_it_is_a_no_op_that_still_answers(self):
        assert record_memory_search((MemoryNote("m1", "decision", "a"),)) == 1
        assert turn_memory_searched() == 0
