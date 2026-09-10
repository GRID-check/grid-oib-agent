"""The metadata contract for an agent-authored, human-approved document.

Two things are locked here. The PARSER tolerates absence in every direction —
a producer that sends nothing, sends half, or sends a human document must not
be able to raise or to invent an author. And the German LABEL is one line with
no sentence in it: the grounding block is text a model copies, so an approval
clause phrased as a sentence is an approval clause that arrives in an answer.
"""

from __future__ import annotations

import pytest

from aiq_agent.common.provenance import AGENT_AUTHOR
from aiq_agent.common.provenance import AgentProvenance
from aiq_agent.common.provenance import german_date
from aiq_agent.common.provenance import is_agent_author
from aiq_agent.common.provenance import is_agent_authored
from aiq_agent.common.provenance import normalize_document_name
from aiq_agent.common.provenance import parse_agent_provenance
from aiq_agent.common.provenance import provenance_label
from aiq_agent.common.provenance import provenance_metadata
from aiq_agent.common.source_kinds import AGENT_AUTHORED_LANE_LABEL

_STAMPED = {
    "authored_by": "agent",
    "approved_by": "Maria Huber",
    "approved_at": "2026-09-01",
    "producer": "piloti-chat",
}


class TestParsing:
    def test_a_stamped_document_parses_whole(self):
        provenance = parse_agent_provenance(_STAMPED)
        assert provenance == AgentProvenance(
            authored_by=AGENT_AUTHOR,
            approved_by="Maria Huber",
            approved_at="2026-09-01",
            producer="piloti-chat",
        )

    @pytest.mark.parametrize(
        "metadata",
        [
            {},
            {"collection": "proj_abc"},
            {"authored_by": "human"},
            {"authored_by": ""},
            {"authored_by": None},
            {"approved_by": "Maria Huber"},  # approval without an agent author
            None,
            "authored_by: agent",
            42,
        ],
    )
    def test_everything_else_has_no_provenance(self, metadata: object):
        """A human document is the overwhelming majority, and it must stay
        byte-for-byte unchanged: no provenance object, so no line, no lane and
        no gate anywhere downstream."""
        assert parse_agent_provenance(metadata) is None
        assert is_agent_authored(metadata) is False

    def test_the_author_token_is_read_case_and_whitespace_tolerantly(self):
        assert is_agent_author(" Agent ") is True
        assert is_agent_author("agentic") is False
        assert is_agent_author(None) is False

    def test_an_agent_document_missing_its_approval_still_parses(self):
        """The lifecycle forbids a published version without an approver — but a
        parser that trusts its producer is a parser that raises in production."""
        provenance = parse_agent_provenance({"authored_by": "agent"})
        assert provenance is not None
        assert provenance.approved_by is None and provenance.approved_at is None

    def test_metadata_round_trips_through_the_wire_shape(self):
        provenance = parse_agent_provenance(_STAMPED)
        assert provenance is not None
        assert provenance_metadata(provenance) == _STAMPED
        assert parse_agent_provenance(provenance_metadata(provenance)) == provenance

    def test_empty_fields_are_dropped_from_the_wire_shape(self):
        provenance = AgentProvenance(approved_by="Maria Huber")
        assert provenance_metadata(provenance) == {"authored_by": "agent", "approved_by": "Maria Huber"}


class TestLabel:
    def test_the_line_names_the_document_kind_the_approver_and_the_date(self):
        provenance = parse_agent_provenance(_STAMPED)
        assert provenance is not None
        assert provenance_label(provenance) == "Piloti-Dokument · freigegeben von Maria Huber am 01.09.2026"

    def test_the_label_starts_with_the_lane_label_the_taxonomy_owns(self):
        """The citation parser reads exactly this leading token back."""
        provenance = parse_agent_provenance(_STAMPED)
        assert provenance is not None
        assert provenance_label(provenance).startswith(AGENT_AUTHORED_LANE_LABEL)

    def test_it_is_one_line_and_not_a_sentence(self):
        provenance = parse_agent_provenance(_STAMPED)
        assert provenance is not None
        label = provenance_label(provenance)
        assert "\n" not in label
        assert not label.endswith(".")

    @pytest.mark.parametrize(
        "metadata,expected",
        [
            ({"authored_by": "agent"}, "Piloti-Dokument"),
            ({"authored_by": "agent", "approved_by": "Maria Huber"}, "Piloti-Dokument · freigegeben von Maria Huber"),
            ({"authored_by": "agent", "approved_at": "2026-09-01"}, "Piloti-Dokument · freigegeben am 01.09.2026"),
        ],
    )
    def test_a_missing_field_shortens_the_line_instead_of_leaving_a_hole(self, metadata: dict, expected: str):
        provenance = parse_agent_provenance(metadata)
        assert provenance is not None
        assert provenance_label(provenance) == expected

    @pytest.mark.parametrize(
        "value,expected",
        [
            ("2026-09-01", "01.09.2026"),
            ("2026-09-01T10:30:00Z", "01.09.2026"),
            ("01.09.2026", "01.09.2026"),  # already German: left alone
            ("2026-13-45", "2026-13-45"),  # not a date: left alone, never guessed
            ("", None),
            (None, None),
        ],
    )
    def test_the_date_is_localised_for_the_line_only(self, value: str | None, expected: str | None):
        assert german_date(value) == expected


class TestNormalizeDocumentName:
    """The verdict gate compares a model's free text against stored names."""

    @pytest.mark.parametrize(
        "value",
        ["Brandschutzkonzept Haus B.md", "**Brandschutzkonzept Haus-B**", "  brandschutzkonzept   haus b  "],
        ids=["extension", "markdown-and-hyphen", "whitespace"],
    )
    def test_the_spellings_of_one_name_reduce_to_one_string(self, value: str):
        assert normalize_document_name(value) == "brandschutzkonzept haus b"

    def test_german_letters_survive(self):
        assert normalize_document_name("Prüfbericht Wärmeschutz.pdf") == "prüfbericht wärmeschutz"

    @pytest.mark.parametrize("value", [None, "", "   ", "***"])
    def test_nothing_usable_reduces_to_the_empty_string(self, value: str | None):
        """Which every caller must read as "no match", never as a wildcard."""
        assert normalize_document_name(value) == ""
