"""The ``answer_json`` envelope: extraction, validation and the gates.

The envelope is the enforcement point the rhetorical cards moved to, so the
tests mirror its three promises: fail-open in every direction (a malformed
envelope costs the enrichment, never the answer), deterministic gates (a
verdict is a short VALUE, takeaways are earned by length, one callout at
most), and a wire payload that is a NATIVE answer field — it never touches
the card registry.
"""

from __future__ import annotations

import json

from aiq_agent.agents.shallow_researcher.markers import detect_and_strip_confidence_marker
from aiq_agent.common.answer_envelope import ENVELOPE_VERSION
from aiq_agent.common.answer_envelope import SUMMARY_MAX_CHARS
from aiq_agent.common.answer_envelope import AnswerMeta
from aiq_agent.common.answer_envelope import extract_answer_envelope
from aiq_agent.common.answer_envelope import gate_answer_meta
from aiq_agent.common.answer_envelope import render_envelope_response_format
from aiq_agent.common.answer_envelope import render_envelope_schema
from aiq_agent.common.answer_envelope import resolve_callout_marker


def _fenced(payload: dict) -> str:
    return "```answer_json\n" + json.dumps(payload, ensure_ascii=False) + "\n```"


_VERDICT = {"value": "REI 60", "subject": "Feuerwiderstand tragender Bauteile"}
_TAKEAWAYS = [
    {"text": "Maßgeblich ist das Fluchtniveau, nicht die Geschoßzahl"},
    {"text": "Tragende Bauteile mindestens REI 60", "detail": "In Kellergeschossen gilt REI 90."},
]
_CALLOUT = {"kind": "frist", "text": "Die Bauverhandlung ist binnen sechs Wochen anzuberaumen."}


_PROSE = "Die Antwort [1].\n\n**Quellen:**\n- [1] OIB-Richtlinie 2 - https://example.com\n[CONFIDENCE:high]"


class TestExtraction:
    def test_plain_prose_passes_through(self):
        content = "Die Antwort.\n[CONFIDENCE:high]"
        prose, meta = extract_answer_envelope(content)
        assert prose == content
        assert meta is None

    def test_the_contract_shape_splits_into_prose_and_anatomy(self):
        content = _fenced({"answer": _PROSE, "verdict": _VERDICT})
        prose, meta = extract_answer_envelope(content)
        assert prose == _PROSE
        assert meta is not None and meta.verdict is not None
        assert meta.verdict.value == "REI 60"

    def test_the_markers_survive_inside_the_answer_field(self):
        # The envelope splits FIRST; the tail-anchored detectors then run on the
        # prose it returns, so the confidence marker keeps being a signal.
        content = _fenced({"answer": "Die Antwort [1].\n\n[CONFIDENCE:medium | Lücke]", "callout": _CALLOUT})
        prose, meta = extract_answer_envelope(content)
        assert meta is not None and meta.callout is not None
        cleaned, level, reason = detect_and_strip_confidence_marker(prose)
        assert level == "medium"
        assert reason == "Lücke"
        assert "[CONFIDENCE" not in cleaned

    def test_a_bare_object_without_the_fence_still_splits(self):
        content = json.dumps({"answer": _PROSE, "verdict": _VERDICT}, ensure_ascii=False)
        prose, meta = extract_answer_envelope(content)
        assert prose == _PROSE
        assert meta is not None and meta.verdict is not None

    def test_the_trailer_form_keeps_the_outside_prose(self):
        # A model that writes prose and then a fenced meta-only object: the
        # prose is the content minus the fence, the anatomy comes from the fence.
        content = "Die Antwort [1].\n\n" + _fenced({"verdict": _VERDICT})
        prose, meta = extract_answer_envelope(content)
        assert prose == "Die Antwort [1]."
        assert meta is not None and meta.verdict is not None

    def test_unparseable_json_never_loses_the_reply(self):
        content = "```answer_json\n{not json]\n```"
        prose, meta = extract_answer_envelope(content)
        assert prose == content
        assert meta is None

    def test_trailing_junk_after_the_object_is_tolerated(self):
        content = "```answer_json\n" + json.dumps({"answer": _PROSE}) + "\nDone.\n```"
        prose, meta = extract_answer_envelope(content)
        assert prose == _PROSE

    def test_anatomy_validation_failure_costs_the_anatomy_not_the_answer(self):
        content = _fenced({"answer": _PROSE, "callout": {"kind": "not_a_kind", "text": "x"}})
        prose, meta = extract_answer_envelope(content)
        assert prose == _PROSE
        assert meta is None

    def test_unknown_fields_are_ignored_rather_than_fatal(self):
        content = _fenced({"answer": _PROSE, "verdict": {**_VERDICT, "confidence": "high"}, "mood": "great"})
        prose, meta = extract_answer_envelope(content)
        assert prose == _PROSE
        assert meta is not None and meta.verdict is not None

    def test_an_envelope_with_only_an_answer_yields_no_anatomy(self):
        prose, meta = extract_answer_envelope(_fenced({"answer": _PROSE}))
        assert prose == _PROSE
        assert meta is None

    def test_non_string_content_passes_through(self):
        content = [{"type": "text", "text": "hi"}]
        prose, meta = extract_answer_envelope(content)
        assert prose is content
        assert meta is None


class TestGating:
    def _gate(self, meta_payload: dict, prose_chars: int = 1_000) -> dict | None:
        return gate_answer_meta(AnswerMeta.model_validate(meta_payload), prose_chars=prose_chars)

    def test_a_verdict_survives_as_the_versioned_wire_field(self):
        payload = self._gate({"verdict": _VERDICT})
        assert payload == {
            "v": ENVELOPE_VERSION,
            "verdict": {"value": "REI 60", "subject": "Feuerwiderstand tragender Bauteile"},
        }

    def test_a_verdict_reference_rides_along(self):
        payload = self._gate({"verdict": {**_VERDICT, "reference": {"document": "OIB-Richtlinie 2"}}})
        assert payload is not None
        assert payload["verdict"]["reference"] == {"document": "OIB-Richtlinie 2"}

    def test_a_long_verdict_value_is_gated_out(self):
        assert self._gate({"verdict": {"value": "x" * 61, "subject": "s"}}) is None

    def test_takeaways_need_the_prose_floor(self):
        assert self._gate({"takeaways": _TAKEAWAYS}, prose_chars=200) is None
        payload = self._gate({"takeaways": _TAKEAWAYS}, prose_chars=1_000)
        assert payload is not None
        assert [item["text"] for item in payload["takeaways"]] == [t["text"] for t in _TAKEAWAYS]

    def test_a_single_takeaway_is_a_sentence_not_a_block(self):
        assert self._gate({"takeaways": _TAKEAWAYS[:1]}, prose_chars=1_000) is None

    def test_takeaways_are_capped_at_five(self):
        many = [{"text": f"Punkt {i}"} for i in range(8)]
        payload = self._gate({"takeaways": many}, prose_chars=1_000)
        assert payload is not None
        assert len(payload["takeaways"]) == 5

    def test_a_callout_survives_whole(self):
        payload = self._gate({"callout": {**_CALLOUT, "detail": "Die Frist ruht bei Ergänzungsauftrag."}})
        assert payload == {
            "v": ENVELOPE_VERSION,
            "callout": {
                "kind": "frist",
                "text": _CALLOUT["text"],
                "detail": "Die Frist ruht bei Ergänzungsauftrag.",
            },
        }

    def test_gated_out_fields_are_absent_not_null(self):
        payload = self._gate(
            {"verdict": {"value": "x" * 61, "subject": "s"}, "callout": _CALLOUT},
        )
        assert payload is not None
        assert "verdict" not in payload
        assert set(payload) == {"v", "callout"}

    def test_nothing_surviving_yields_none_not_an_empty_object(self):
        assert self._gate({"takeaways": _TAKEAWAYS[:1]}, prose_chars=100) is None


class TestControlFields:
    def test_confidence_rides_the_envelope(self):
        content = _fenced({"answer": _PROSE, "confidence": {"level": "medium", "reason": "Lücke beim Bestand"}})
        prose, meta = extract_answer_envelope(content)
        assert prose == _PROSE
        assert meta is not None and meta.confidence is not None
        assert meta.confidence.level == "medium"
        assert meta.confidence.reason == "Lücke beim Bestand"

    def test_escalation_rides_the_envelope(self):
        content = _fenced({"answer": _PROSE, "escalate_to_deep": True})
        _, meta = extract_answer_envelope(content)
        assert meta is not None
        assert meta.escalate_to_deep is True

    def test_control_fields_never_reach_the_wire_payload(self):
        # Confidence travels as answer_confidence, escalation as routing —
        # the answer_meta wire payload is anatomy only.
        meta = AnswerMeta.model_validate(
            {"confidence": {"level": "high"}, "escalate_to_deep": False, "callout": _CALLOUT}
        )
        payload = gate_answer_meta(meta, prose_chars=1_000)
        assert payload is not None
        assert set(payload) == {"v", "callout"}

    def test_an_invalid_confidence_level_drops_the_whole_anatomy_not_the_answer(self):
        content = _fenced({"answer": _PROSE, "confidence": {"level": "certain"}})
        prose, meta = extract_answer_envelope(content)
        assert prose == _PROSE
        assert meta is None


class TestRenderedSchema:
    def test_the_taught_schema_names_every_field_the_validator_knows(self):
        """One source of truth: a field added to the models MUST reach the
        prompt in the same commit, or the model is validated against a schema
        it was never taught."""
        schema = render_envelope_schema()
        for name in ("answer*", "confidence", "escalate_to_deep", "verdict", "takeaways", "callout"):
            assert name in schema
        # And the enum values the frontend switches on.
        assert '"hinweis" | "achtung" | "frist" | "tipp"' in schema
        assert '"low" | "medium" | "high"' in schema

    def test_the_renderer_injects_the_schema_by_default(self):
        from aiq_agent.common.prompt_utils import render_prompt_template

        rendered = render_prompt_template("{{ answer_envelope_schema }}")
        assert "answer*" in rendered


class TestWireCrossing:
    def test_the_gated_payload_matches_the_shared_fixture(self):
        """`tests/fixtures/answer_meta/wire_payload.json` pins the Python↔TS crossing.

        The frontend's `sanitizeAnswerMeta` asserts the same file survives its
        sanitizer verbatim (`message-answer-meta.spec.ts`), so a renamed key or
        a moved cap on either side fails a test instead of shipping green with
        every anatomy field silently dropped — the exact class of loss the
        `binding_status` rename once proved possible.
        """
        import pathlib

        fixture = json.loads(
            pathlib.Path(__file__)
            .resolve()
            .parents[3]
            .joinpath("tests/fixtures/answer_meta/wire_payload.json")
            .read_text(encoding="utf-8")
        )
        envelope = {
            "answer": "irrelevant here",
            "confidence": {"level": "high", "reason": "OIB-RL 2 direkt belegt"},
            "summary": fixture["summary"],
            "verdict": fixture["verdict"],
            "callout": fixture["callout"],
            "takeaways": fixture["takeaways"],
        }
        payload = gate_answer_meta(AnswerMeta.model_validate(envelope), prose_chars=1_200)
        assert payload == fixture


class TestStrictResponseFormat:
    """The provider-enforced schema, derived from the same models as the gates."""

    def test_the_wrapper_is_openrouter_structured_outputs(self):
        fmt = render_envelope_response_format()
        assert fmt["type"] == "json_schema"
        assert fmt["json_schema"]["name"] == "answer_envelope"
        assert fmt["json_schema"]["strict"] is True

    def test_strict_mode_invariants_hold_everywhere(self):
        """Every object is closed and requires every key — strict's contract."""

        def walk(schema: dict) -> None:
            if schema.get("type") == "object":
                assert schema["additionalProperties"] is False
                assert schema["required"] == list(schema["properties"])
                for prop in schema["properties"].values():
                    walk(prop)
            for member in schema.get("anyOf", []):
                walk(member)
            if "items" in schema:
                walk(schema["items"])

        walk(render_envelope_response_format()["json_schema"]["schema"])

    def test_answer_leads_and_the_enums_survive(self):
        schema = render_envelope_response_format()["json_schema"]["schema"]
        assert next(iter(schema["properties"])) == "answer"
        assert schema["properties"]["answer"]["type"] == "string"
        callout = schema["properties"]["callout"]["anyOf"][0]
        assert callout["properties"]["kind"]["enum"] == ["hinweis", "achtung", "frist", "tipp"]
        confidence = schema["properties"]["confidence"]["anyOf"][0]
        assert confidence["properties"]["level"]["enum"] == ["low", "medium", "high"]

    def test_an_enforced_reply_parses_through_the_same_validator(self):
        """Strict mode spells absence as null; extraction must not care."""
        reply = json.dumps(
            {
                "answer": "Die Antwort [1].",
                "confidence": {"level": "medium", "reason": None},
                "escalate_to_deep": None,
                "verdict": {"value": "REI 60", "subject": "Feuerwiderstand", "reference": None},
                "callout": None,
                "takeaways": None,
            }
        )
        prose, meta = extract_answer_envelope(reply)
        assert prose == "Die Antwort [1]."
        assert meta is not None
        assert meta.confidence is not None and meta.confidence.level == "medium"
        assert meta.verdict is not None and meta.verdict.value == "REI 60"
        assert meta.callout is None and meta.takeaways is None


class TestCalloutMarker:
    """`[[callout]]` placement: at most one placeable marker, or none."""

    def test_no_marker_passes_through_untouched(self):
        prose = "Absatz eins.\n\nAbsatz zwei."
        assert resolve_callout_marker(prose, has_callout=True) == prose

    def test_the_first_own_line_marker_stays_and_the_rest_go(self):
        prose = "Absatz eins.\n\n[[callout]]\n\nAbsatz zwei.\n\n[[callout]]\n\nEnde."
        resolved = resolve_callout_marker(prose, has_callout=True)
        assert resolved.count("[[callout]]") == 1
        assert resolved.index("[[callout]]") < resolved.index("Absatz zwei.")

    def test_every_marker_goes_when_no_callout_survived(self):
        prose = "Absatz eins.\n\n[[callout]]\n\nAbsatz zwei mit [[callout]] mitten im Satz."
        resolved = resolve_callout_marker(prose, has_callout=False)
        assert "[[callout]]" not in resolved
        # The own-line marker took its whole line; the inline one left the
        # sentence intact.
        assert "Absatz zwei mit  mitten im Satz." in resolved

    def test_a_mid_sentence_marker_never_counts_as_placed(self):
        prose = "Ein Satz mit [[callout]] darin.\n\n[[callout]]"
        resolved = resolve_callout_marker(prose, has_callout=True)
        # The own-line one is the kept one, even though the inline one came first.
        assert resolved == "Ein Satz mit  darin.\n\n[[callout]]"


class TestSummaryGate:
    """The near-universal field: owed on every reply, still gated."""

    def test_a_standfirst_survives(self):
        meta = AnswerMeta.model_validate({"summary": "  REI 60 in GK 4; im Keller REI 90.  "})
        payload = gate_answer_meta(meta, prose_chars=100)
        assert payload == {"v": ENVELOPE_VERSION, "summary": "REI 60 in GK 4; im Keller REI 90."}

    def test_a_paragraph_in_disguise_is_dropped_whole(self):
        meta = AnswerMeta.model_validate({"summary": "x" * (SUMMARY_MAX_CHARS + 1), "verdict": _VERDICT})
        payload = gate_answer_meta(meta, prose_chars=100)
        assert payload is not None
        assert "summary" not in payload and payload["verdict"]["value"] == "REI 60"

    def test_blank_is_absent_not_empty(self):
        meta = AnswerMeta.model_validate({"summary": "   ", "verdict": _VERDICT})
        payload = gate_answer_meta(meta, prose_chars=100)
        assert payload is not None and "summary" not in payload
