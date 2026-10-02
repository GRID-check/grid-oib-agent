"""The restricted memory a conversation's turns were shown (ADR-0078).

The digest is re-ranked per turn and capped, so a restricted note can leave the
prompt and stay in the history. These pin the record that keeps it as evidence:
bounded without forgetting silently, persisted per conversation, and written by
the turn that was shown it.
"""

from __future__ import annotations

from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.memory import shown_notes as S
from aiq_agent.memory.restriction import RestrictedNote
from aiq_agent.memory.shown_notes import ShownNotes
from aiq_agent.memory.shown_notes import load_shown_notes
from aiq_agent.memory.shown_notes import merged
from aiq_agent.memory.shown_notes import persist_shown_notes
from aiq_agent.memory.shown_notes import turn_shown_notes
from aiq_agent.turn.registries import turn_registries

A = "proj_1_r0123456789ab"
B = "proj_1_rba9876543210"


async def _settle() -> None:
    for task in list(S._persist_tasks):
        await task


class TestTheRecord:
    def test_a_note_keeps_the_restricted_collections_it_was_shown_under(self):
        shown = merged(ShownNotes(), ["Honorar 48.000"], ["oib_knowledge", "proj_1", A])
        assert shown.notes == (RestrictedNote("Honorar 48.000", (A,)),)

    def test_a_note_seen_again_under_another_scope_keeps_both(self):
        shown = merged(merged(ShownNotes(), ["Honorar 48.000"], [A]), ["Honorar 48.000"], [B])
        assert shown.notes == (RestrictedNote("Honorar 48.000", (A, B)),)

    def test_nothing_is_recorded_without_a_restricted_scope(self):
        assert merged(ShownNotes(), ["Honorar 48.000"], ["proj_1"]) == ShownNotes()

    def test_a_note_that_no_longer_fits_restricts_every_later_memory(self, monkeypatch):
        monkeypatch.setattr(S, "MAX_NOTES", 2)
        shown = merged(ShownNotes(), ["eins", "zwei"], [A])
        shown = merged(shown, ["drei"], [B])
        assert [note.content for note in shown.notes] == ["zwei", "drei"]
        assert shown.overflowed == (A,)

    def test_it_round_trips_through_the_cache_per_conversation(self):
        shown = merged(ShownNotes(), ["Gehalt 5.200"], [B])
        persist_shown_notes("conv-shown-1", shown)
        assert load_shown_notes("conv-shown-1") == shown
        assert load_shown_notes("conv-shown-2") == ShownNotes()
        assert load_shown_notes(None) == ShownNotes()


class TestTheTurnWritesWhatItWasShown:
    async def test_the_digest_s_restricted_lines_and_restricted_writes_are_recorded_on_exit(self):
        from aiq_agent.knowledge.project_memory import record_turn_memory_write

        digest = (
            "PROJECT_MEMORY v1\n"
            '- [decision | high | unverified] "Flachdach extensiv begrünt."\n'
            '- [restricted | derived_fact | high | unverified] "Honorar LP 5-8 pauschal 184.000 EUR."'
        )
        earlier = ShownNotes(notes=(RestrictedNote("Gehalt 5.200", (B,)),))
        async with turn_registries(
            "conv-shown-3", SourceRegistry(), memory_digest=digest, shown_notes=earlier, restricted_scope=(A,)
        ) as registries:
            # What earlier turns were shown is visible to this turn's tools.
            assert turn_shown_notes() == earlier
            record_turn_memory_write("Vertragsstrafe 0,1 %", restricted=True)
        assert registries.shown_notes == earlier
        assert turn_shown_notes() == ShownNotes()
        await _settle()

        recorded = load_shown_notes("conv-shown-3")
        assert recorded.notes == (
            RestrictedNote("Gehalt 5.200", (B,)),
            RestrictedNote("Honorar LP 5-8 pauschal 184.000 EUR.", (A,)),
            RestrictedNote("Vertragsstrafe 0,1 %", (A,)),
        )

    async def test_an_open_turn_records_nothing(self):
        async with turn_registries("conv-shown-4", SourceRegistry(), memory_digest=None, restricted_scope=()):
            pass
        await _settle()
        assert load_shown_notes("conv-shown-4") == ShownNotes()
