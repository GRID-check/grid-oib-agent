"""The model's two steps over Fassungen: the judge and the change summary.

The model is the reader, so these tests pin the contract around it: which
candidates a prompt carries and how many, that an answer naming a file the
prompt never offered is dropped, where the threshold sits, that every failure is
a plain ``None``. Nothing asserts the model's prose.
"""

from __future__ import annotations

import json
import re
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage

from aiq_agent.knowledge.document_revisions import MAX_CHANGE_LINE_CHARS
from aiq_agent.knowledge.document_revisions import MAX_CHANGE_LINES
from aiq_agent.knowledge.document_revisions import MAX_PROMPT_SUMMARY_CHARS
from aiq_agent.knowledge.document_revisions import MAX_REASON_CHARS
from aiq_agent.knowledge.document_revisions import MAX_REVISION_CANDIDATES
from aiq_agent.knowledge.document_revisions import NO_CHANGE_TEXT
from aiq_agent.knowledge.document_revisions import REVISION_THRESHOLD
from aiq_agent.knowledge.document_revisions import RevisionDocument
from aiq_agent.knowledge.document_revisions import build_change_prompt
from aiq_agent.knowledge.document_revisions import build_judge_prompt
from aiq_agent.knowledge.document_revisions import judge_revision
from aiq_agent.knowledge.document_revisions import parse_change_summary
from aiq_agent.knowledge.document_revisions import rank_candidates
from aiq_agent.knowledge.document_revisions import settled_change
from aiq_agent.knowledge.document_revisions import summarize_change

NEW = RevisionDocument(
    file_name="Grundriss_EG_Index_C.pdf",
    summary="Grundriss Erdgeschoss, M 1:100, Stiege nach Norden verschoben.",
    doc_class="sonstiges",
    tags=("Grundriss",),
    revision="Index C",
    series_key="grundriss eg",
)
SERIES = RevisionDocument(
    file_name="Grundriss_EG_Index_B.pdf",
    summary="Grundriss Erdgeschoss, M 1:100.",
    doc_class="sonstiges",
    tags=("Grundriss",),
    revision="Index B",
    series_key="grundriss eg",
)
OTHER = RevisionDocument(
    file_name="Schnitt_AA.pdf",
    summary="Schnitt A-A durch das Stiegenhaus.",
    tags=("Schnitt",),
    series_key="schnitt aa",
)


def _doc(name: str, **kwargs) -> RevisionDocument:
    return RevisionDocument(file_name=name, summary=kwargs.pop("summary", f"Beschreibung von {name}."), **kwargs)


def _llm(content: str) -> MagicMock:
    llm = MagicMock()
    llm.invoke.return_value = AIMessage(content=content)
    return llm


def _answer(of, confidence=0.9, reason="Gleicher Grundriss in neuerem Stand.") -> str:
    return json.dumps({"of": of, "confidence": confidence, "reason": reason}, ensure_ascii=False)


class TestRankCandidates:
    def test_a_name_series_match_leads_then_the_same_class_then_shared_tags(self):
        same_class = _doc("b.pdf", doc_class="sonstiges")
        shared_tags = _doc("c.pdf", tags=("Grundriss", "Detail"))
        unrelated = _doc("d.pdf")
        series = _doc("z.pdf", series_key="grundriss eg")

        ranked = rank_candidates(NEW, [unrelated, shared_tags, same_class, series])

        assert [doc.file_name for doc in ranked] == ["z.pdf", "b.pdf", "c.pdf", "d.pdf"]

    def test_the_series_key_decides_not_the_extension(self):
        by_key = _doc("Grundriss EG Index B.dwg", series_key="grundriss eg")
        ranked = rank_candidates(NEW, [_doc("a.pdf", doc_class="sonstiges"), by_key])
        assert ranked[0] is by_key

    def test_at_most_eight_candidates_survive_and_the_likeliest_ones(self):
        crowd = [_doc(f"datei_{i:02d}.pdf") for i in range(20)]
        ranked = rank_candidates(NEW, [*crowd, SERIES])
        assert len(ranked) == MAX_REVISION_CANDIDATES == 8
        assert ranked[0] is SERIES

    def test_the_new_document_itself_and_repeated_names_are_never_candidates(self):
        ranked = rank_candidates(NEW, [NEW, SERIES, SERIES, _doc("")])
        assert ranked == [SERIES]

    def test_the_order_is_stable_for_equal_candidates(self):
        a, b = _doc("b.pdf"), _doc("a.pdf")
        assert [doc.file_name for doc in rank_candidates(NEW, [a, b])] == ["a.pdf", "b.pdf"]


class TestJudgePrompt:
    def test_it_names_every_candidate_with_its_summary_and_the_new_document(self):
        prompt = build_judge_prompt(NEW, [SERIES, OTHER])
        for doc in (NEW, SERIES, OTHER):
            assert doc.file_name in prompt
            assert doc.summary in prompt
        assert "Index B" in prompt  # the label read from the name travels as a hint

    def test_it_asks_for_the_keys_the_parser_reads(self):
        prompt = build_judge_prompt(NEW, [SERIES])
        for key in ('"of"', '"confidence"', '"reason"'):
            assert key in prompt

    def test_it_carries_no_more_than_eight_candidates(self):
        crowd = [_doc(f"datei_{i:02d}.pdf") for i in range(12)]
        prompt = build_judge_prompt(NEW, crowd)
        assert sum(1 for doc in crowd if doc.file_name in prompt) == MAX_REVISION_CANDIDATES

    def test_a_long_summary_is_cut_before_it_enters_the_prompt(self):
        long = _doc("lang.pdf", summary="x" * (MAX_PROMPT_SUMMARY_CHARS * 3) + "BEYOND")
        prompt = build_judge_prompt(NEW, [long])
        assert "BEYOND" not in prompt
        assert "x" * (MAX_PROMPT_SUMMARY_CHARS - 1) in prompt

    def test_a_document_without_facts_leaves_out_their_keys(self):
        prompt = build_judge_prompt(NEW, [RevisionDocument(file_name="leer.pdf")])
        line = next(line for line in prompt.splitlines() if "leer.pdf" in line)
        assert json.loads(line) == {"file_name": "leer.pdf"}

    def test_no_prompt_calls_a_file_a_plan(self):
        prompts = [build_judge_prompt(NEW, [SERIES]), build_change_prompt(SERIES, NEW)]
        assert not any(re.search(r"\bplan(s|stand)?\b", prompt, re.IGNORECASE) for prompt in prompts)


class TestJudgeRevision:
    def test_a_valid_candidate_above_the_threshold_is_the_verdict(self):
        verdict = judge_revision(NEW, [SERIES, OTHER], _llm(_answer("Grundriss_EG_Index_B.pdf")))
        assert verdict is not None
        assert verdict.of == "Grundriss_EG_Index_B.pdf"
        assert verdict.confidence == 0.9
        assert verdict.reason

    def test_the_basis_is_name_for_a_series_match_and_content_otherwise(self):
        by_name = judge_revision(NEW, [SERIES], _llm(_answer(SERIES.file_name)))
        by_content = judge_revision(NEW, [OTHER], _llm(_answer(OTHER.file_name)))
        assert by_name.basis == "name"
        assert by_content.basis == "content"

    def test_a_name_the_model_made_up_is_never_accepted(self):
        assert judge_revision(NEW, [SERIES], _llm(_answer("Grundriss_EG_Index_Z.pdf"))) is None

    def test_a_candidate_cut_by_the_bound_cannot_be_chosen(self):
        crowd = [_doc(f"datei_{i:02d}.pdf") for i in range(12)]
        offered = {doc.file_name for doc in rank_candidates(NEW, crowd)}
        left_out = next(doc.file_name for doc in crowd if doc.file_name not in offered)
        assert judge_revision(NEW, crowd, _llm(_answer(left_out))) is None

    def test_the_name_must_match_exactly(self):
        assert judge_revision(NEW, [SERIES], _llm(_answer(SERIES.file_name.lower()))) is None
        assert judge_revision(NEW, [SERIES], _llm(_answer(f" {SERIES.file_name}"))) is None

    @pytest.mark.parametrize(
        "confidence, accepted",
        [(REVISION_THRESHOLD - 0.01, False), (REVISION_THRESHOLD, True), (1.0, True), (0.0, False)],
    )
    def test_the_threshold_is_inclusive_at_0_7(self, confidence, accepted):
        verdict = judge_revision(NEW, [SERIES], _llm(_answer(SERIES.file_name, confidence)))
        assert (verdict is not None) is accepted
        assert REVISION_THRESHOLD == 0.7

    @pytest.mark.parametrize("confidence", ["0.95", True, None, float("nan")])
    def test_a_confidence_that_is_not_a_number_is_none(self, confidence):
        reply = f'{{"of": "Grundriss_EG_Index_B.pdf", "confidence": {json.dumps(confidence)}, "reason": "x"}}'
        assert judge_revision(NEW, [SERIES], _llm(reply)) is None

    def test_a_null_answer_is_none(self):
        assert judge_revision(NEW, [SERIES], _llm(_answer(None, 0.0, ""))) is None

    def test_an_empty_reason_is_none(self):
        assert judge_revision(NEW, [SERIES], _llm(_answer(SERIES.file_name, 0.95, "   "))) is None

    def test_a_long_reason_is_cut_to_the_bound(self):
        verdict = judge_revision(NEW, [SERIES], _llm(_answer(SERIES.file_name, 0.9, "Gleich. " * 100)))
        assert len(verdict.reason) <= MAX_REASON_CHARS

    def test_a_fenced_reply_is_read(self):
        reply = "```json\n" + _answer(SERIES.file_name) + "\n```"
        assert judge_revision(NEW, [SERIES], _llm(reply)).of == SERIES.file_name

    @pytest.mark.parametrize("reply", ["", "Ja, Index B.", "[1, 2]", "{", '"Grundriss_EG_Index_B.pdf"'])
    def test_a_reply_that_is_not_the_object_asked_for_is_none(self, reply):
        assert judge_revision(NEW, [SERIES], _llm(reply)) is None

    def test_a_failed_call_is_none(self):
        llm = MagicMock()
        llm.invoke.side_effect = RuntimeError("model down")
        assert judge_revision(NEW, [SERIES], llm) is None

    def test_no_model_and_no_candidates_ask_nothing(self):
        assert judge_revision(NEW, [SERIES], None) is None
        llm = _llm(_answer(SERIES.file_name))
        assert judge_revision(NEW, [], llm) is None
        assert judge_revision(NEW, [NEW], llm) is None
        llm.invoke.assert_not_called()

    def test_one_call_with_one_prompt_string_that_names_the_ranked_candidates_only(self):
        crowd = [_doc(f"datei_{i:02d}.pdf") for i in range(12)]
        llm = _llm(_answer(None, 0.0, ""))
        judge_revision(NEW, [*crowd, SERIES], llm)
        llm.invoke.assert_called_once()
        prompt = llm.invoke.call_args.args[0]
        assert isinstance(prompt, str)
        assert SERIES.file_name in prompt
        assert sum(1 for doc in crowd if doc.file_name in prompt) == MAX_REVISION_CANDIDATES - 1

    def test_the_suggestion_record_is_the_five_keys_the_store_reads_and_not_dismissed(self):
        verdict = judge_revision(NEW, [SERIES], _llm(_answer(SERIES.file_name)))
        assert set(verdict.as_suggestion()) == {"of", "confidence", "reason", "basis", "dismissed"}
        assert verdict.as_suggestion()["dismissed"] is False


class TestParseChangeSummary:
    def test_bullet_lines_are_normalised_to_dash_lines(self):
        assert parse_change_summary("• Stiege verschoben\n* Fenster neu\n1. Tür entfällt") == (
            "- Stiege verschoben\n- Fenster neu\n- Tür entfällt"
        )

    def test_at_most_five_lines_of_at_most_160_characters(self):
        reply = "\n".join(f"- {'y' * 400}{i}" for i in range(9))
        lines = parse_change_summary(reply).splitlines()
        assert len(lines) == MAX_CHANGE_LINES == 5
        assert all(len(line) <= len("- ") + MAX_CHANGE_LINE_CHARS for line in lines)

    def test_the_no_difference_sentence_is_kept_as_it_is_without_a_bullet(self):
        assert parse_change_summary(NO_CHANGE_TEXT) == NO_CHANGE_TEXT
        assert parse_change_summary("keine inhaltliche änderung aus den zusammenfassungen erkennbar") == NO_CHANGE_TEXT
        assert NO_CHANGE_TEXT == "Keine inhaltliche Änderung aus den Zusammenfassungen erkennbar."

    def test_blank_lines_and_a_fence_are_dropped(self):
        assert parse_change_summary("```\n- eins\n\n- zwei\n```") == "- eins\n- zwei"

    @pytest.mark.parametrize("reply", ["", "  \n ", "- \n-"])
    def test_a_reply_without_a_line_is_none(self, reply):
        assert parse_change_summary(reply) is None


class TestSummarizeChange:
    OLDER = _doc("a.pdf", summary="Grundriss EG, Stiege im Süden.")
    NEWER = _doc("b.pdf", summary="Grundriss EG, Stiege im Norden, neuer Lift.")

    def test_the_replies_bullets_come_back(self):
        llm = _llm("- Stiege von Süd nach Nord\n- Lift neu")
        assert summarize_change(self.OLDER, self.NEWER, llm) == "- Stiege von Süd nach Nord\n- Lift neu"

    def test_the_prompt_carries_both_descriptions_and_the_fallback_sentence(self):
        llm = _llm("- x")
        summarize_change(self.OLDER, self.NEWER, llm)
        prompt = llm.invoke.call_args.args[0]
        for doc in (self.OLDER, self.NEWER):
            assert doc.file_name in prompt
            assert doc.summary in prompt
        assert NO_CHANGE_TEXT in prompt
        assert str(MAX_CHANGE_LINES) in prompt

    def test_excerpts_travel_only_when_both_sides_have_one(self):
        both = summarize_prompt(_doc("a.pdf", excerpt="ALT-ANFANG"), _doc("b.pdf", excerpt="NEU-ANFANG"))
        one = summarize_prompt(_doc("a.pdf"), _doc("b.pdf", excerpt="NEU-ANFANG"))
        assert "ALT-ANFANG" in both and "NEU-ANFANG" in both
        assert "NEU-ANFANG" not in one

    def test_identical_descriptions_answer_no_change_without_a_call(self):
        llm = _llm("- erfunden")
        same = _doc("b.pdf", summary=self.OLDER.summary)
        assert summarize_change(self.OLDER, same, llm) == NO_CHANGE_TEXT
        llm.invoke.assert_not_called()
        assert settled_change(self.OLDER, same) == (True, NO_CHANGE_TEXT)

    def test_a_missing_description_compares_nothing(self):
        llm = _llm("- erfunden")
        assert summarize_change(_doc("a.pdf", summary=""), self.NEWER, llm) is None
        assert summarize_change(self.OLDER, _doc("b.pdf", summary="  "), llm) is None
        llm.invoke.assert_not_called()
        assert settled_change(_doc("a.pdf", summary=""), self.NEWER) == (True, None)

    def test_different_descriptions_are_not_settled(self):
        assert settled_change(self.OLDER, self.NEWER) == (False, None)

    def test_a_failed_call_and_no_model_are_none(self):
        llm = MagicMock()
        llm.invoke.side_effect = RuntimeError("model down")
        assert summarize_change(self.OLDER, self.NEWER, llm) is None
        assert summarize_change(self.OLDER, self.NEWER, None) is None

    def test_an_unusable_reply_is_none(self):
        assert summarize_change(self.OLDER, self.NEWER, _llm("  ")) is None


def summarize_prompt(older: RevisionDocument, newer: RevisionDocument) -> str:
    llm = _llm("- x")
    summarize_change(
        RevisionDocument(file_name=older.file_name, summary="Alt.", excerpt=older.excerpt),
        RevisionDocument(file_name=newer.file_name, summary="Neu.", excerpt=newer.excerpt),
        llm,
    )
    return llm.invoke.call_args.args[0]
