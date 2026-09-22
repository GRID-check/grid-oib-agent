"""The findings contract: bounded, fail-soft per row, pinned to the shared fixture."""

import json
from pathlib import Path

from aiq_agent.common.findings import FINDINGS_VERSION
from aiq_agent.common.findings import MAX_COMMENT_CHARS
from aiq_agent.common.findings import Findings
from aiq_agent.common.findings import sanitize_findings

FIXTURE = Path(__file__).parents[2] / "fixtures" / "findings" / "wire_payload.json"


class TestTheFixtureIsTheContract:
    def test_the_shared_fixture_validates_and_round_trips(self):
        raw = json.loads(FIXTURE.read_text())
        findings = Findings.model_validate(raw)
        assert findings.v == FINDINGS_VERSION
        assert findings.counts() == {"erfuellt": 1, "nicht_erfuellt": 0, "offen": 1, "nicht_anwendbar": 1}
        assert sanitize_findings(raw) == findings.model_dump(exclude_none=True)


class TestSanitize:
    def test_a_row_the_contract_rejects_is_dropped_and_the_rest_stay(self):
        out = sanitize_findings(
            {
                "items": [
                    {"requirement": "A", "status": "erfuellt", "grounding": "belegt"},
                    {"requirement": "", "status": "erfuellt", "grounding": "belegt"},
                    {"requirement": "C", "status": "maybe", "grounding": "belegt"},
                    "not a row",
                ]
            }
        )
        assert out is not None
        assert [item["requirement"] for item in out["items"]] == ["A"]

    def test_free_text_is_cut_to_the_bound_rather_than_refused(self):
        out = sanitize_findings(
            {"items": [{"requirement": "A", "status": "offen", "grounding": "offen", "comment": "x" * 2000}]}
        )
        assert out is not None
        assert len(out["items"][0]["comment"]) == MAX_COMMENT_CHARS

    def test_citations_keep_only_positive_integers(self):
        out = sanitize_findings(
            {"items": [{"requirement": "A", "status": "offen", "grounding": "offen", "citations": [1, "2", 0, -3, 4]}]}
        )
        assert out is not None
        assert out["items"][0]["citations"] == [1, 4]

    def test_nothing_usable_is_none_not_an_empty_table(self):
        assert sanitize_findings({"items": []}) is None
        assert sanitize_findings({"items": [{"requirement": ""}]}) is None
        assert sanitize_findings("nope") is None

    def test_a_reference_without_a_document_is_dropped(self):
        out = sanitize_findings(
            {"items": [{"requirement": "A", "status": "offen", "grounding": "offen", "reference": {"section": "3.1"}}]}
        )
        assert out is not None
        assert "reference" not in out["items"][0]
