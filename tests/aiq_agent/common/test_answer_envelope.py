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

from aiq_agent.agents.piloti.markers import detect_and_strip_confidence_marker
from aiq_agent.common.answer_envelope import ANATOMY_FIELDS
from aiq_agent.common.answer_envelope import CONTEXT_MAX_CHARS
from aiq_agent.common.answer_envelope import ENVELOPE_VERSION
from aiq_agent.common.answer_envelope import SUMMARY_MAX_CHARS
from aiq_agent.common.answer_envelope import TOPIC_MAX_CHARS
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

    def test_a_detail_that_restates_its_claim_is_dropped(self):
        # A row with a `detail` is a button; one that opens onto its own claim
        # teaches the reader the chevrons are decorative. Blank and verbatim are
        # the two forms of that a gate can judge without guessing at quality.
        payload = self._gate(
            {
                "takeaways": [
                    {"text": "Tragende Bauteile mindestens REI 60", "detail": " tragende bauteile mindestens REI 60 "},
                    {"text": "Maßgeblich ist das Fluchtniveau", "detail": "   "},
                ]
            },
            prose_chars=1_000,
        )
        assert payload is not None
        assert all("detail" not in item for item in payload["takeaways"])

    def test_a_detail_that_adds_something_survives(self):
        payload = self._gate({"takeaways": _TAKEAWAYS}, prose_chars=1_000)
        assert payload is not None
        assert payload["takeaways"][1]["detail"] == "In Kellergeschossen gilt REI 90."

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

    def test_walkthrough_drops_verdict(self):
        payload = self._gate({"kind": "walkthrough", "verdict": _VERDICT})
        assert payload == {"v": ENVELOPE_VERSION, "kind": "walkthrough"}

    def test_direct_and_handoff_drop_verdict(self):
        for kind in ("direct", "handoff"):
            payload = self._gate({"kind": kind, "verdict": _VERDICT})
            assert payload == {"v": ENVELOPE_VERSION, "kind": kind}

    def test_ruling_keeps_verdict(self):
        payload = self._gate({"kind": "ruling", "verdict": _VERDICT})
        assert payload == {
            "v": ENVELOPE_VERSION,
            "kind": "ruling",
            "verdict": {"value": "REI 60", "subject": "Feuerwiderstand tragender Bauteile"},
        }

    def test_legacy_no_kind_keeps_verdict(self):
        payload = self._gate({"verdict": _VERDICT})
        assert payload is not None
        assert "kind" not in payload
        assert payload["verdict"]["value"] == "REI 60"

    def test_unknown_kind_is_a_walkthrough_and_drops_the_verdict(self):
        """Garbage is not legacy. Legacy is ABSENT kind.

        Exclusive kinds used to fail open to a ruling the moment the model
        missed the token (``Walkthrough``, ``essay``, ``Durchgang``).
        """
        meta = AnswerMeta.model_validate({"kind": "essay", "verdict": _VERDICT})
        assert meta.kind == "walkthrough"
        payload = gate_answer_meta(meta, prose_chars=1_000)
        assert payload == {"v": ENVELOPE_VERSION, "kind": "walkthrough"}


class TestAVerdictNeverRestsOnADocumentPilotiWrote:
    """The gate that keeps an approved office document from becoming a norm.

    A published Piloti document is real evidence and it is citable — but a
    VERDICT is the one place an answer names a Fundstelle for a value the
    reader copies straight into a Nachweis, and „REI 90, laut
    Brandschutzkonzept Haus B" reads as a requirement whether or not the
    document ever claimed to be one. ``verify_citations`` cannot catch this: it
    proves the source is real, and this source IS real.

    The gate drops the verdict, not the answer — every word of the prose, and
    every citation in it, survives.
    """

    _AGENT_DOCS = frozenset({"brandschutzkonzept haus b"})

    def _gate(self, reference: dict | None, documents: frozenset[str] | None = None) -> dict | None:
        verdict = {**_VERDICT, **({"reference": reference} if reference else {})}
        return gate_answer_meta(
            AnswerMeta.model_validate({"verdict": verdict}),
            prose_chars=1_000,
            agent_authored_documents=self._AGENT_DOCS if documents is None else documents,
        )

    def test_a_verdict_referencing_an_agent_authored_document_is_dropped(self):
        assert self._gate({"document": "Brandschutzkonzept Haus B"}) is None

    def test_the_match_survives_the_spellings_a_model_writes(self):
        assert self._gate({"document": "**Brandschutzkonzept Haus-B.md**"}) is None
        assert self._gate({"document": "Brandschutzkonzept Haus B (Büroarchiv)"}) is None

    def test_a_verdict_referencing_the_OIB_survives_untouched(self):
        payload = self._gate({"document": "OIB-Richtlinie 2", "section": "Tabelle 1b"})
        assert payload is not None
        assert payload["verdict"]["reference"] == {"document": "OIB-Richtlinie 2", "section": "Tabelle 1b"}

    def test_a_verdict_with_no_reference_survives_an_ordinary_turn(self):
        """Nothing agent-authored was retrieved, so there is nothing to launder.

        „Nicht geregelt" is the common unattributed verdict and it must keep
        standing: on a turn whose registry holds no Piloti document, an absent
        Fundstelle is an absent Fundstelle and nothing more.
        """
        payload = self._gate(None, documents=frozenset())
        assert payload is not None
        assert payload["verdict"] == _VERDICT

    def test_a_verdict_with_no_reference_is_dropped_when_piloti_wrote_a_source(self):
        """THE HOLE. The gate above can only judge a reference it was given, so
        omitting it was the cheapest way to the same headline resting on the
        same document — with the evidence that would have failed it left out."""
        assert self._gate(None) is None

    def test_the_unreferenced_drop_is_counted_under_its_own_reason(self, monkeypatch):
        pushed: list[tuple[str, dict]] = []
        monkeypatch.setattr(
            "aiq_agent.common.turn_status.push_custom_step",
            lambda name, payload: pushed.append((name, payload)),
        )
        assert self._gate(None) is None
        assert [payload["values"]["reason"] for _, payload in pushed] == ["unreferenced_with_agent_source"]

    def test_a_norm_reference_still_survives_a_turn_with_an_agent_document(self):
        """The three cases are distinct: a norm Fundstelle is kept even when the
        turn also retrieved something Piloti wrote."""
        payload = self._gate({"document": "OIB-Richtlinie 2", "section": "Tabelle 1b"})
        assert payload is not None
        assert payload["verdict"]["reference"]["document"] == "OIB-Richtlinie 2"

    def test_a_turn_that_retrieved_no_agent_document_gates_nothing(self):
        """The common case, and the one that must cost nothing."""
        payload = self._gate({"document": "Brandschutzkonzept Haus B"}, documents=frozenset())
        assert payload is not None

    def test_the_default_caller_behaves_exactly_as_before(self):
        payload = gate_answer_meta(
            AnswerMeta.model_validate({"verdict": {**_VERDICT, "reference": {"document": "Konzept"}}}),
            prose_chars=1_000,
        )
        assert payload is not None

    def test_a_name_too_short_to_judge_is_left_alone(self):
        """A two-character Fundstelle is not a document name a substring test
        can decide, in either direction."""
        payload = self._gate({"document": "B"}, documents=frozenset({"b"}))
        assert payload is not None

    def test_the_drop_is_counted_as_a_technical_event(self, monkeypatch):
        """A gate that drops silently makes „how often does this happen?"
        unanswerable, and that rate is what says whether the wording works."""
        pushed: list[tuple[str, dict]] = []
        monkeypatch.setattr(
            "aiq_agent.common.turn_status.push_custom_step",
            lambda name, payload: pushed.append((name, payload)),
        )
        assert self._gate({"document": "Brandschutzkonzept Haus B"}) is None
        assert pushed == [
            (
                "status:verdict:dropped",
                {
                    "kind": "status",
                    "channel": "technical",
                    "slot": "verdict:dropped",
                    "values": {"reason": "agent_authored_reference"},
                },
            )
        ]

    def test_a_surviving_verdict_emits_nothing(self, monkeypatch):
        pushed: list[tuple[str, dict]] = []
        monkeypatch.setattr(
            "aiq_agent.common.turn_status.push_custom_step",
            lambda name, payload: pushed.append((name, payload)),
        )
        assert self._gate({"document": "OIB-Richtlinie 2"}) is not None
        assert pushed == []


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
        for name in ("answer*", "confidence", "escalate_to_deep", "kind", "verdict", "takeaways", "callout"):
            assert name in schema
        # And the enum values the frontend switches on.
        assert '"hinweis" | "achtung" | "frist" | "tipp"' in schema
        assert '"low" | "medium" | "high"' in schema
        assert '"direct" | "walkthrough" | "ruling" | "handoff"' in schema
        assert "kind=ruling" in schema

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
            "kind": fixture["kind"],
            "summary": fixture["summary"],
            "verdict": fixture["verdict"],
            "topic": fixture["topic"],
            "context": fixture["context"],
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
        assert "kind=ruling" in schema["properties"]["kind"]["description"]
        kind = schema["properties"]["kind"]["anyOf"][0]
        assert kind["enum"] == ["direct", "walkthrough", "ruling", "handoff"]

    def test_an_enforced_reply_parses_through_the_same_validator(self):
        """Strict mode spells absence as null; extraction must not care."""
        reply = json.dumps(
            {
                "answer": "Die Antwort [1].",
                "kind": None,
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


class TestTopicContextGates:
    """The masthead slots: nominal title plus one-line scope, both optional."""

    def test_values_survive_stripped(self):
        meta = AnswerMeta.model_validate(
            {"topic": "  Brandschutz  ", "context": "  OIB-RL 2, Ausgabe Mai 2023 · Wien  "}
        )
        payload = gate_answer_meta(meta, prose_chars=100)
        assert payload == {
            "v": ENVELOPE_VERSION,
            "topic": "Brandschutz",
            "context": "OIB-RL 2, Ausgabe Mai 2023 · Wien",
        }

    def test_over_limit_values_are_dropped_whole(self):
        meta = AnswerMeta.model_validate(
            {"topic": "x" * (TOPIC_MAX_CHARS + 1), "context": "y" * (CONTEXT_MAX_CHARS + 1)}
        )
        assert gate_answer_meta(meta, prose_chars=100) is None

    def test_blank_values_are_absent_not_empty(self):
        meta = AnswerMeta.model_validate({"topic": "   ", "context": "\t "})
        assert gate_answer_meta(meta, prose_chars=100) is None

    def test_gated_out_fields_are_absent_not_null(self):
        meta = AnswerMeta.model_validate(
            {"topic": "x" * (TOPIC_MAX_CHARS + 1), "context": "OIB-RL 2", "summary": "REI 60."}
        )
        payload = gate_answer_meta(meta, prose_chars=100)
        assert payload is not None
        assert "topic" not in payload
        assert payload["context"] == "OIB-RL 2"
        assert payload["summary"] == "REI 60."

    def test_no_gate_interaction_with_kind(self):
        # Backend keeps both; the frontend prefers the verdict masthead when it
        # shows. The model decides content, never placement.
        for kind in ("direct", "walkthrough", "ruling", "handoff"):
            meta = AnswerMeta.model_validate(
                {"kind": kind, "topic": "Brandschutz", "context": "OIB-RL 2", "verdict": _VERDICT}
            )
            payload = gate_answer_meta(meta, prose_chars=100)
            assert payload is not None
            assert payload["topic"] == "Brandschutz"
            assert payload["context"] == "OIB-RL 2"
        # And without any kind at all (legacy envelope).
        meta = AnswerMeta.model_validate({"topic": "Brandschutz", "context": "OIB-RL 2"})
        payload = gate_answer_meta(meta, prose_chars=100)
        assert payload is not None
        assert payload["topic"] == "Brandschutz"


class TestTopicContextRegistry:
    def test_registry_order_is_the_render_order_contract(self):
        assert [field.name for field in ANATOMY_FIELDS] == [
            "kind",
            "summary",
            "verdict",
            "topic",
            "context",
            "callout",
            "takeaways",
        ]

    def test_the_taught_schema_names_topic_and_context(self):
        schema = render_envelope_schema()
        assert "\n  topic: string (" in schema
        assert "\n  context: string (" in schema

    def test_wire_payload_carries_topic_and_context(self):
        meta = AnswerMeta.model_validate({"topic": "Brandschutz", "context": "OIB-RL 2"})
        payload = gate_answer_meta(meta, prose_chars=100)
        assert payload == {"v": ENVELOPE_VERSION, "topic": "Brandschutz", "context": "OIB-RL 2"}

    def test_strict_format_round_trips_topic_and_context(self):
        fmt = render_envelope_response_format()
        properties = fmt["json_schema"]["schema"]["properties"]
        assert "topic" in properties
        assert "context" in properties
        reply = json.dumps(
            {
                "answer": "Die Antwort [1].",
                "kind": None,
                "summary": None,
                "verdict": None,
                "topic": "Brandschutz",
                "context": "OIB-RL 2, Ausgabe Mai 2023 · Wien",
                "confidence": None,
                "escalate_to_deep": None,
                "escalation_reason": None,
                "callout": None,
                "takeaways": None,
            }
        )
        prose, meta = extract_answer_envelope(reply)
        assert prose == "Die Antwort [1]."
        assert meta is not None
        assert meta.topic == "Brandschutz"
        assert meta.context == "OIB-RL 2, Ausgabe Mai 2023 · Wien"
        payload = gate_answer_meta(meta, prose_chars=100)
        assert payload is not None
        assert payload["topic"] == "Brandschutz"
        assert payload["context"] == "OIB-RL 2, Ausgabe Mai 2023 · Wien"
