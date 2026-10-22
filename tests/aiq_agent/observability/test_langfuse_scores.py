"""Runtime checks as Langfuse scores (ADR-0089)."""

import re
from pathlib import Path

import pytest

from aiq_agent.common.citation_events import build_turn_events
from aiq_agent.common.wire_v2 import QuoteStamp
from aiq_agent.common.wire_v2 import TurnResult
from aiq_agent.observability import langfuse_scores
from aiq_agent.observability.langfuse_scores import SCORE_DEFINITIONS
from aiq_agent.observability.langfuse_scores import RuntimeScore
from aiq_agent.observability.langfuse_scores import card_validity_score
from aiq_agent.observability.langfuse_scores import citation_scores
from aiq_agent.observability.langfuse_scores import dialect_scores
from aiq_agent.observability.langfuse_scores import emit_scores
from aiq_agent.observability.langfuse_scores import score_body
from aiq_agent.observability.langfuse_scores import score_id
from aiq_agent.observability.langfuse_scores import thread_reply_scores
from aiq_agent.observability.langfuse_scores import turn_outcome_scores

REPO = Path(__file__).resolve().parents[3]
TRACE = "0" * 31 + "1"


def _by_name(scores):
    return {score.name: score.value for score in scores}


class TestCitationScores:
    def test_a_clean_turn_is_healthy_and_measured(self):
        events = build_turn_events(
            source_count=3,
            cited_count=2,
            retrieved_source_labels=["a", "b", "c", "c"],
            cited_source_labels=["a", "b"],
        )

        scores = _by_name(citation_scores(events))

        assert scores == {
            "citation-health": 1.0,
            "answer-grounded": 1.0,
            "sources-empty": 0.0,
            "citations-removed": 0.0,
            "quotes-unverified": 0.0,
            "retrieval-precision": round(2 / 3, 4),
        }

    def test_a_defect_makes_the_turn_unhealthy_and_says_which(self):
        events = build_turn_events(
            source_count=2,
            cited_count=0,
            removed_citations=[{"reason": "not_in_registry", "citation": "[3] x"}],
            unverified_quote_count=1,
            grounded=False,
        )

        scores = citation_scores(events)
        health = next(score for score in scores if score.name == "citation-health")

        assert health.value == 0.0
        assert health.comment == "answer_ungrounded, citations_removed, quote_unverified"
        assert _by_name(scores)["citations-removed"] == 1.0
        assert _by_name(scores)["answer-grounded"] == 0.0

    def test_an_empty_registry_is_its_own_outcome(self):
        from aiq_agent.common.citation_events import CitationEvent

        scores = _by_name(citation_scores([CitationEvent(kind="registry_empty")]))

        assert scores == {"sources-empty": 1.0, "citation-health": 0.0}


class TestTurnOutcomeScores:
    def test_confidence_cap_and_quote_rate(self):
        result = TurnResult(
            message_id="m",
            text="x",
            answer_confidence="low",
            quote_stamps=[
                QuoteStamp(text="a", status="verbatim"),
                QuoteStamp(text="b", status="not_found"),
                QuoteStamp(text="c", status="unchecked"),
            ],
        )

        assert _by_name(turn_outcome_scores(result)) == {
            "answer-confidence": "low",
            "confidence-capped": "none",
            "quotes-verbatim-rate": 0.5,
        }


class TestRepairScores:
    def test_a_clean_answer_scores_zero_repairs(self):
        assert _by_name(dialect_scores([])) == {"dialect-repairs": 0.0}

    def test_each_card_is_its_own_score(self):
        first = card_validity_score(outcome="dropped", card_type="compliance_check", index=1)
        second = card_validity_score(outcome="repaired", card_type="compliance_check", index=2)

        assert score_id(trace_id=TRACE, writer="piloti", name=first.name, item=first.item) != score_id(
            trace_id=TRACE, writer="piloti", name=second.name, item=second.item
        )


class TestBody:
    def test_the_body_langfuse_expects(self):
        body = score_body(RuntimeScore("citation-health", 1.0), trace_id=TRACE, writer="chat", environment="production")

        assert body["traceId"] == TRACE
        assert body["dataType"] == "BOOLEAN"
        assert body["environment"] == "production"
        assert body["metadata"] == {"writer": "chat"}

    def test_a_repost_upserts_the_same_score(self):
        assert score_id(trace_id=TRACE, writer="chat", name="x") == score_id(trace_id=TRACE, writer="chat", name="x")


class TestEmit:
    def test_a_no_op_without_the_tier(self, monkeypatch):
        monkeypatch.delenv("LANGFUSE_HOST", raising=False)

        assert emit_scores([RuntimeScore("citation-health", 1.0)], writer="chat", trace_id=TRACE) == 0

    def test_queues_defined_scores_and_refuses_undefined_names(self, monkeypatch):
        posted = []
        monkeypatch.setenv("LANGFUSE_HOST", "http://langfuse-web:3000")
        monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk")
        monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk")
        monkeypatch.setattr(langfuse_scores, "_post", lambda host, auth, body: posted.append((host, body["name"])))

        queued = emit_scores(
            [RuntimeScore("citation-health", 1.0), RuntimeScore("made-up", 1.0)], writer="chat", trace_id=TRACE
        )
        langfuse_scores._executor.shutdown(wait=True)
        langfuse_scores._executor = langfuse_scores.ThreadPoolExecutor(max_workers=2)

        assert queued == 1
        assert posted == [("http://langfuse-web:3000", "citation-health")]

    def test_no_trace_no_score(self, monkeypatch):
        monkeypatch.setenv("LANGFUSE_HOST", "http://langfuse-web:3000")
        monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk")
        monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk")

        assert emit_scores([RuntimeScore("citation-health", 1.0)], writer="chat") == 0


class TestThreadReplyScores:
    @pytest.mark.parametrize(
        ("verdict", "scores"),
        [
            ("replied", {"thread-answered-in-place": 1.0}),
            ("skipped", {"thread-answered-in-place": 0.0}),
            ("skipped_withheld", {}),
        ],
    )
    def test_the_verdict_is_a_boolean_and_a_withheld_turn_has_none(self, verdict, scores):
        assert _by_name(thread_reply_scores(verdict)) == scores


class TestOneListOfNames:
    """A score name exists in the definitions, the BFF and the docs, or nowhere."""

    def test_definitions_are_unique_and_typed(self):
        names = [definition.name for definition in SCORE_DEFINITIONS]

        assert len(names) == len(set(names))
        for definition in SCORE_DEFINITIONS:
            assert (definition.data_type == "CATEGORICAL") == bool(definition.categories), definition.name

    def test_every_score_the_bff_writes_is_defined(self):
        source = "\n".join(path.read_text() for path in (REPO / "frontends/ui/src/lib/langfuse").glob("*.ts"))
        # Every score module names its score in one `*_SCORE_NAME` constant, so a new one is found
        # without this test knowing its name; the literals catch a name written inline.
        constants = set(re.findall(r"""_SCORE_NAME = ['"]([a-z-]+)['"]""", source))
        literals = set(
            re.findall(r"""['"](user-feedback[a-z-]*|piloti-decision|revision-notice|document-check)['"]""", source)
        )
        defined = {definition.name for definition in SCORE_DEFINITIONS if definition.writer == "bff"}

        assert len(constants) >= 5
        assert constants | literals <= defined

    @pytest.mark.parametrize("definition", SCORE_DEFINITIONS, ids=lambda definition: definition.name)
    def test_every_score_is_documented(self, definition):
        assert f"`{definition.name}`" in (REPO / "docs/observability/langfuse.md").read_text()


class TestSteerCount:
    def test_a_steered_turn_scores_its_notes_and_says_how_many_were_read(self):
        from aiq_agent.common.steering import SteerInbox
        from aiq_agent.common.steering import SteerNote
        from aiq_agent.observability.langfuse_scores import steer_scores

        inbox = SteerInbox()
        inbox.offer(SteerNote(steer_id="a", text="x"))
        inbox.offer(SteerNote(steer_id="b", text="y"))
        inbox.take()
        inbox.offer(SteerNote(steer_id="c", text="z"))

        [score] = steer_scores(inbox)

        assert (score.name, score.value, score.comment) == ("steer-count", 3.0, "applied 2")
        assert score.data_type == "NUMERIC"

    def test_an_unsteered_turn_writes_no_score(self):
        from aiq_agent.common.steering import SteerInbox
        from aiq_agent.observability.langfuse_scores import steer_scores

        assert steer_scores(SteerInbox()) == []


class TestFileToolsUsed:
    @pytest.mark.parametrize(
        ("tools", "expected"),
        [
            (["knowledge_search"], "search"),
            (["list_files", "read_passage"], "navigate"),
            (["knowledge_search", "list_files"], "both"),
            (["knowledge_search", "read_passage", "list_files"], "both"),
            (["web_search", "ifc_query"], "none"),
        ],
    )
    def test_the_moves_a_turn_made(self, tools, expected):
        from aiq_agent.observability.langfuse_scores import file_tool_scores

        [score] = file_tool_scores(tools)

        assert (score.name, score.value) == ("file-tools-used", expected)
        assert score.data_type == "CATEGORICAL"
        assert expected in next(d for d in SCORE_DEFINITIONS if d.name == "file-tools-used").categories

    def test_a_turn_with_no_tool_calls_writes_no_score(self):
        from aiq_agent.observability.langfuse_scores import file_tool_scores

        assert file_tool_scores([]) == []

    @pytest.mark.parametrize(
        ("tools", "literal", "expected"),
        [
            (["knowledge_search"], 1, "navigate"),
            (["knowledge_search", "knowledge_search"], 1, "both"),
            (["knowledge_search", "read_passage"], 1, "navigate"),
            (["knowledge_search"], 3, "navigate"),
        ],
    )
    def test_a_literal_search_is_navigation_as_the_eval_arms_count_it(self, tools, literal, expected):
        """The files eval's navigate arm is list, read and LITERAL search; ranked search is the search arm."""
        from aiq_agent.observability.langfuse_scores import file_tool_scores

        [score] = file_tool_scores(tools, literal)

        assert score.value == expected
