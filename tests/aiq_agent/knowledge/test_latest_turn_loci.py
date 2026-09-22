"""The digest names what the last turn opened; a follow-up re-opens exactly that."""

from __future__ import annotations

from aiq_agent.knowledge.already_read import format_digest_line
from aiq_agent.knowledge.already_read import latest_turn_loci


def test_the_latest_turns_punkte_become_read_passage_arguments_in_order():
    digest = [
        format_digest_line("oib-rl_2_ausgabe_mai_2023.pdf", "oib_knowledge", {12, 13}, {"3.1", "2.2"}, 2),
        format_digest_line("Bescheid.pdf", "proj", {3}, set(), 1),
    ]
    assert latest_turn_loci(digest) == [
        {"document": "oib-rl_2_ausgabe_mai_2023.pdf", "punkt": "2.2"},
        {"document": "oib-rl_2_ausgabe_mai_2023.pdf", "punkt": "3.1"},
    ]


def test_pages_when_there_are_no_punkte_and_the_outline_when_there_is_neither():
    digest = [
        format_digest_line("Bescheid.pdf", "proj", {3, 1}, set(), 2),
        format_digest_line("Plan.pdf", "proj", set(), set(), 2),
    ]
    assert latest_turn_loci(digest) == [
        {"document": "Bescheid.pdf", "page": 1},
        {"document": "Bescheid.pdf", "page": 3},
        {"document": "Plan.pdf"},
    ]


def test_the_cap_and_the_empty_cases():
    digest = [format_digest_line("a.pdf", "c", set(), {str(i) for i in range(1, 9)}, 1)]
    assert len(latest_turn_loci(digest, limit=4)) == 4
    assert latest_turn_loci(None) == [] and latest_turn_loci(["not a digest line"]) == []
