"""The server's hold on the answer's Markdown dialect (``common/answer_dialect.py``).

What matters is what the reader can lose, so every repair test also checks
the one invariant the validator promises: it unwraps and strips markers, and
every line of content it was handed is still there.
"""

from __future__ import annotations

import pytest

from aiq_agent.common.answer_dialect import BUDGET
from aiq_agent.common.answer_dialect import DIRECTIVE_BLOCKS
from aiq_agent.common.answer_dialect import PROJECT_KEYS
from aiq_agent.common.answer_dialect import validate_dialect

CHECK = (
    ":::check\n| Anforderung | Nachweis | Status | Fundstelle |\n|---|---|---|---|\n"
    "| Schall ≥ 55 dB | 57 dB | erfüllt | [1] |\n:::"
)
CASES = (
    ":::cases{by=building_class}\n| Gebäudeklasse | Anforderung | Fundstelle |\n|---|---|---|\n"
    "| GK 4 | REI 60 | [1] |\n:::"
)
ACTIONS = (
    ":::actions\n| Wer | Was | bis | Fundstelle |\n|---|---|---|---|\n"
    "| Planer | Konzept nachreichen | vor Einreichung | [2] |\n:::"
)
PROCEDURE = (
    ":::procedure\n1. Einreichung [1] :current\n   :::details[Unterlagen]\n   - Einreichplan\n   :::\n"
    "2. Bauverhandlung [2]\n:::"
)


def _content(text: str) -> list[str]:
    """The lines a reader reads: everything but the fences and blank lines."""
    return [
        line.strip()
        for line in text.split("\n")
        if line.strip() and not line.strip().startswith(":::") and not line.strip().startswith("**")
    ]


def _kept(before: str, after: str) -> bool:
    remaining = after
    for line in _content(before):
        at = remaining.find(line.split(" :")[0])
        if at < 0:
            return False
        remaining = remaining[at:]
    return True


class TestVocabulary:
    def test_the_new_blocks_are_known(self):
        for name in ("actions", "not-found", "subsumption"):
            assert name in DIRECTIVE_BLOCKS

    def test_project_keys_are_english_and_map_to_profile_facts(self):
        assert PROJECT_KEYS["building_class"] == "gebaeudeklasse"
        assert PROJECT_KEYS["escape_level_m"] == "fluchtniveau_m"
        assert "parcel_area_m2" not in PROJECT_KEYS  # the profile records no Grundstücksfläche
        assert all(key.isascii() and key == key.lower() for key in PROJECT_KEYS)


class TestUnknownBlocks:
    def test_an_unknown_block_loses_its_fences_and_keeps_its_content(self):
        text = "Vorab.\n\n:::warning[Achtung]\nDie Frist läuft **binnen 2 Wochen** ab [1].\n:::\n\nDanach."
        result = validate_dialect(text, "walkthrough")
        assert ":::" not in result.text
        assert "**Achtung**" in result.text
        assert "Die Frist läuft **binnen 2 Wochen** ab [1]." in result.text
        assert result.repairs == [{"repair": "unwrap_unknown", "name": "warning"}]
        assert _kept(text, result.text)

    def test_an_unknown_block_inside_a_known_one_leaves_the_outer_block(self):
        text = ":::check\n:::grid\n| a | b |\n:::\n:::"
        result = validate_dialect(text, "walkthrough")
        assert result.text == ":::check\n| a | b |\n:::"

    def test_directive_text_in_code_is_code(self):
        text = "```\n:::weird\n:::current\n```"
        assert validate_dialect(text, "direct").text == text


class TestBudget:
    def test_budget_per_kind(self):
        assert BUDGET["direct"] == (0, 0)
        assert BUDGET["ruling"] == (1, 0)
        assert BUDGET["walkthrough"] == (2, 1)

    def test_a_direct_answer_carries_no_block(self):
        text = f"Kurz: erfüllt [1].\n\n{CHECK}\n\n:::details[Mehr]\nHerleitung.\n:::"
        result = validate_dialect(text, "direct")
        assert ":::" not in result.text
        assert "| Schall ≥ 55 dB | 57 dB | erfüllt | [1] |" in result.text
        assert "**Mehr**" in result.text and "Herleitung." in result.text
        assert {repair["name"] for repair in result.repairs} == {"check", "details"}
        assert _kept(text, result.text)

    def test_a_ruling_keeps_its_first_primary_block_and_its_details(self):
        text = f"**REI 60** [1].\n\n{CASES}\n\n{CHECK}\n\n:::details[Andere Fälle]\n- GK 5\n:::"
        result = validate_dialect(text, "ruling")
        assert CASES in result.text
        assert ":::check" not in result.text and "| Schall ≥ 55 dB | 57 dB | erfüllt | [1] |" in result.text
        assert ":::details[Andere Fälle]" in result.text
        assert result.repairs == [{"repair": "unwrap_over_budget", "name": "check"}]

    def test_a_walkthrough_keeps_two_primary_blocks(self):
        text = f"{CHECK}\n\n{ACTIONS}\n\n{CASES}"
        result = validate_dialect(text, "walkthrough")
        assert CHECK in result.text and ACTIONS in result.text
        assert ":::cases" not in result.text and "| GK 4 | REI 60 | [1] |" in result.text
        assert _kept(text, result.text)

    def test_no_envelope_no_budget(self):
        text = f"{CHECK}\n\n{ACTIONS}\n\n{CASES}"
        assert validate_dialect(text, None).text == text

    def test_a_second_diagram_is_logged_never_removed(self):
        mermaid = "```mermaid\nflowchart TD\n  A --> B\n```"
        text = f"{mermaid}\n\n{mermaid}"
        result = validate_dialect(text, "walkthrough")
        assert result.text == text
        assert result.census["diagrams"] == 2
        assert {"repair": "diagrams_over_budget", "name": "mermaid"} in result.repairs


class TestMarkers:
    def test_current_inside_a_procedure_is_kept_and_logged(self):
        result = validate_dialect(PROCEDURE, "walkthrough")
        assert result.text == PROCEDURE
        assert result.repairs == [{"repair": "current_unverified", "name": "current"}]

    def test_a_marker_outside_its_block_is_stripped(self):
        text = "Schritt eins [1] :current.\n\n| Variante A :recommended | B |\n\nGK 4 :applies"
        result = validate_dialect(text, "walkthrough")
        assert result.text == "Schritt eins [1].\n\n| Variante A | B |\n\nGK 4"
        assert [repair["name"] for repair in result.repairs] == ["current", "recommended", "applies"]

    def test_a_marker_in_an_unwrapped_block_goes_with_it(self):
        text = ":::compare\n| Merkmal | A :recommended | B |\n:::"
        result = validate_dialect(text, "direct")
        assert result.text == "| Merkmal | A | B |"

    def test_look_alikes_are_left_as_written(self):
        text = "Um 10:30 Uhr. Hinweis:Achtung. Siehe `:current` und https://ris.bka.gv.at/x"
        assert validate_dialect(text, "walkthrough").text == text


class TestProjectBinding:
    def test_a_known_key_is_kept(self):
        text = "Ihr Projekt liegt in :project[building_class] bei :project[escape_level_m]."
        result = validate_dialect(text, "direct")
        assert result.text == text and result.repairs == []

    def test_an_unknown_key_becomes_its_plain_text(self):
        result = validate_dialect("Grundstück :project[parcel_area_m2] groß.", "direct")
        assert result.text == "Grundstück parcel_area_m2 groß."
        assert result.repairs == [{"repair": "project_key_unknown", "name": "parcel_area_m2"}]

    def test_an_unknown_cases_key_is_logged(self):
        text = ":::cases{by=zone}\n| Zone | Wert |\n:::"
        result = validate_dialect(text, "ruling")
        assert result.text == text
        assert result.repairs == [{"repair": "cases_by_unknown", "name": "zone"}]


class TestCensus:
    def test_blocks_are_counted_by_name_as_written(self):
        text = f"{PROCEDURE}\n\n{CHECK}\n\n:::foo\nx\n:::"
        result = validate_dialect(text, "walkthrough")
        assert result.census == {"procedure": 1, "details": 1, "check": 1, "foo": 1}
        assert result.as_trace() == {
            "blocks": {"procedure": 1, "details": 1, "check": 1, "foo": 1},
            "repairs": {"current_unverified": 1, "unwrap_unknown": 1},
        }

    def test_plain_prose_has_no_census(self):
        result = validate_dialect("Nur Prosa [1].", "ruling")
        assert result.census == {} and result.repairs == []


@pytest.mark.parametrize("kind", ["direct", "ruling", "walkthrough", None])
def test_it_never_deletes_content(kind):
    text = "\n\n".join(
        [
            "Die Antwort [1].",
            CHECK,
            ":::bogus[Titel]\nInhalt, der bleibt.\n:::",
            ACTIONS,
            CASES,
            PROCEDURE,
            "> „Brandabschnitte dürfen höchstens 1.200 m² haben.“ [1]",
            "Ende :applies.",
        ]
    )
    result = validate_dialect(text, kind)
    assert _kept(text, result.text)
    # Idempotent: what it returns needs no repair beyond the logged ones.
    again = validate_dialect(result.text, kind)
    assert again.text == result.text
    assert all(repair["repair"] == "current_unverified" for repair in again.repairs)


class TestTheScannerReadsWhatTheRendererReads:
    """The fence and opener rules of ``lib/text/answer-directives.ts`` and ``code-fence.ts``."""

    def test_a_backtick_line_with_a_backtick_after_it_is_inline_code_not_a_fence(self):
        result = validate_dialect("```a``` inline\n\n:::sonstwas\nInhalt\n:::", "walkthrough")
        assert ":::" not in result.text
        assert "Inhalt" in result.text

    def test_a_space_after_the_colons_and_free_words_are_repaired_to_the_canonical_opener(self):
        result = validate_dialect("::: check Brandschutz\n| a | offen |\n:::", "walkthrough")
        assert result.text.splitlines()[0] == ":::check[Brandschutz]"
        assert {"repair": "opener_canonical", "name": "check"} in result.repairs

    def test_blocks_past_the_depth_bound_are_unwrapped_with_their_content_kept(self):
        depth = 6
        text = "\n".join([*(f":::details[x{at}]" for at in range(depth)), "Inhalt", *(":::" for _ in range(depth))])
        result = validate_dialect(text, None)
        assert sum(1 for line in result.text.splitlines() if line.startswith(":::details")) == 4
        assert "Inhalt" in result.text
        assert sum(1 for repair in result.repairs if repair["repair"] == "unwrap_too_deep") == 2
