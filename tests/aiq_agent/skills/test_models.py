"""STRICT SKILL.md parsing — the GRID substrate contract (agentskills.io)."""

from __future__ import annotations

import pytest

from aiq_agent.skills.models import GRID_METADATA_KEYS
from aiq_agent.skills.models import MAX_DESCRIPTION_CHARS
from aiq_agent.skills.models import SkillValidationError
from aiq_agent.skills.models import build_skill_from_payload
from aiq_agent.skills.models import parse_skill_md
from aiq_agent.skills.models import preferred_cards

VALID_MD = """---
name: forecast-analysis
description: >-
  Prognose der baurechtlichen Entwicklung: Trendlinien, Sensitivität und
  Risikohinweise aus den angegebenen Bau- und Genehmigungsdaten.
license: Proprietary
compatibility: R1 line and B2 zone
metadata:
  grid-execution: chat
  grid-agents: shallow_researcher
---

# Prognose

Schritte:
1. Prüfe die Datenlage.
2. Berechne die Trendlinie.
3. Nenne die Risiken.
"""


def test_parse_valid_skill_md() -> None:
    skill = parse_skill_md(VALID_MD, expected_dir_name="forecast-analysis")
    assert skill.name == "forecast-analysis"
    assert skill.description.startswith("Prognose der baurechtlichen Entwicklung")
    assert len(skill.description) > 10
    assert skill.origin == "platform"
    assert skill.collection is None
    assert skill.metadata == {"grid-execution": "chat", "grid-agents": "shallow_researcher"}
    assert skill.compatibility == "R1 line and B2 zone"
    assert skill.license == "Proprietary"
    assert skill.body.startswith("# Prognose")
    assert "3. Nenne die Risiken." in skill.body


def test_parse_folded_yaml_description_is_joined() -> None:
    skill = parse_skill_md(VALID_MD)
    # Folded YAML gets unfolded by yaml.safe_load (spaces, no newlines).
    assert "\n" not in skill.description
    assert "Trendlinien, Sensitivität" in skill.description


def test_missing_frontmatter_is_a_strict_error() -> None:
    with pytest.raises(SkillValidationError, match="frontmatter"):
        parse_skill_md("# Nur Inhalt\n\nohne Metadaten")


def test_invalid_yaml_is_a_strict_error() -> None:
    with pytest.raises(SkillValidationError, match="YAML"):
        parse_skill_md("---\nname: [unclosed\n---\nbody")


def test_name_must_match_directory() -> None:
    with pytest.raises(SkillValidationError, match="directory name"):
        parse_skill_md(VALID_MD, expected_dir_name="other-name")


def test_name_pattern_is_enforced() -> None:
    for bad in ("UPPER", "with_underscore", "leading-", "-trailing", "double--dash", ""):
        with pytest.raises(SkillValidationError):
            parse_skill_md(VALID_MD.replace("forecast-analysis", bad))


def test_name_length_limit() -> None:
    long_name = "a" * (64 + 1)
    with pytest.raises(SkillValidationError, match="characters"):
        parse_skill_md(VALID_MD.replace("forecast-analysis", long_name))


def test_empty_description_is_a_strict_error() -> None:
    no_desc = VALID_MD.replace(
        ">-\n  Prognose der baurechtlichen Entwicklung: Trendlinien, Sensitivität und\n  "
        "Risikohinweise aus den angegebenen Bau- und Genehmigungsdaten.",
        "",
    )
    assert "description:" in no_desc
    with pytest.raises(SkillValidationError, match="description"):
        parse_skill_md(no_desc)


def test_description_length_limit() -> None:
    long_desc = "x" * (MAX_DESCRIPTION_CHARS + 1)
    with pytest.raises(SkillValidationError, match="description"):
        parse_skill_md(
            VALID_MD.replace(
                "Prognose der baurechtlichen Entwicklung: Trendlinien, Sensitivität und\n  "
                "Risikohinweise aus den angegebenen Bau- und Genehmigungsdaten.",
                long_desc,
            )
        )


def test_bad_grid_execution_value_is_rejected() -> None:
    with pytest.raises(SkillValidationError, match="grid-execution"):
        parse_skill_md(VALID_MD.replace("chat", "browser"))


def test_metadata_must_map_strings_to_strings() -> None:
    with pytest.raises(SkillValidationError, match="metadata"):
        parse_skill_md(VALID_MD.replace("grid-execution: chat", "grid-execution: 42"))


def test_compatibility_too_long_is_rejected() -> None:
    with pytest.raises(SkillValidationError, match="compatibility"):
        parse_skill_md(VALID_MD.replace("R1 line and B2 zone", "x" * 501))


def test_empty_body_is_allowed() -> None:
    head = VALID_MD.split("\n---", 2)[0] + "\n---\n"
    skill = parse_skill_md(head)
    assert skill.body == ""


def test_build_skill_from_payload_roundtrip() -> None:
    skill = build_skill_from_payload(
        {
            "name": "org-skill",
            "description": "Ein Org-Skill.",
            "body": "Body",
            "metadata": {"grid-agents": "shallow_researcher"},
            "license": "MIT",
        },
        origin="org",
        collection=None,
    )
    assert skill.origin == "org"
    assert skill.metadata == {"grid-agents": "shallow_researcher"}


def test_build_skill_from_payload_rejects_garbage() -> None:
    with pytest.raises(SkillValidationError):
        build_skill_from_payload({"name": 7})
    with pytest.raises(SkillValidationError):
        build_skill_from_payload({"name": "ok", "description": ""})


def test_reserved_key_registry() -> None:
    assert GRID_METADATA_KEYS == {"grid-execution", "grid-schedulable", "grid-agents", "grid-cards"}


def _with_cards(value: str) -> str:
    return VALID_MD.replace("  grid-agents: shallow_researcher", f"  grid-cards: {value}")


def test_grid_cards_accepts_known_card_types() -> None:
    skill = parse_skill_md(_with_cards("summary, comparison_table"))
    assert preferred_cards(skill.metadata) == ("summary", "comparison_table")


def test_grid_cards_deduplicates_and_keeps_author_order() -> None:
    skill = parse_skill_md(_with_cards("comparison_table,summary,comparison_table"))
    assert preferred_cards(skill.metadata) == ("comparison_table", "summary")


def test_unknown_card_type_is_a_strict_error_for_a_file_skill() -> None:
    with pytest.raises(SkillValidationError, match="grid-cards"):
        parse_skill_md(_with_cards("summary, gibt_es_nicht"))


def test_system_card_type_is_rejected_even_though_it_is_a_real_card() -> None:
    # `memory_proposal` IS a union member — it is only ever emitted by a tool,
    # so a skill asking the model for one is asking it to fabricate one.
    for system_card in ("memory_proposal", "document_grid"):
        with pytest.raises(SkillValidationError, match="grid-cards"):
            parse_skill_md(_with_cards(system_card))


def test_org_row_drops_unknown_card_types_instead_of_dying() -> None:
    skill = build_skill_from_payload(
        {
            "name": "org-skill",
            "description": "Ein Org-Skill.",
            "body": "Body",
            "metadata": {"grid-cards": "summary, memory_proposal, gibt_es_nicht"},
        },
        origin="org",
    )
    assert skill.metadata["grid-cards"] == "summary"


def test_org_row_with_only_unknown_card_types_drops_the_key() -> None:
    skill = build_skill_from_payload(
        {
            "name": "org-skill",
            "description": "Ein Org-Skill.",
            "body": "Body",
            "metadata": {"grid-cards": "gibt_es_nicht"},
        },
        origin="org",
    )
    assert "grid-cards" not in skill.metadata
