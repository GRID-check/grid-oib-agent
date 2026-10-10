"""The topics a document is searched by: the prompt, the reply's parse, and the fail-open call.

The model is the reader, so these tests pin the contract around it: the keys the
prompt asks for are the keys the parser reads, the project's own spelling is
offered back, and the stored result stays inside the rules the prompt states.
Nothing here asserts the model's prose.
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage

from aiq_agent.knowledge.document_classification import ALLOWED_TAGS
from aiq_agent.knowledge.document_classification import CLASSIFY_MAX_INPUT_CHARS
from aiq_agent.knowledge.document_classification import MAX_TOPIC_CHARS
from aiq_agent.knowledge.document_classification import MAX_TOPIC_VOCABULARY
from aiq_agent.knowledge.document_classification import MAX_TOPIC_WORDS
from aiq_agent.knowledge.document_classification import MAX_TOPICS
from aiq_agent.knowledge.document_classification import normalize_topic
from aiq_agent.knowledge.document_classification import parse_topics
from aiq_agent.knowledge.document_classification import suggest_topics


def _topics_json(*items: tuple[str, float]) -> str:
    return json.dumps([{"thema": term, "sicherheit": confidence} for term, confidence in items], ensure_ascii=False)


def _llm(content: str) -> MagicMock:
    llm = MagicMock()
    llm.invoke.return_value = AIMessage(content=content)
    return llm


class TestNormalizeTopic:
    def test_whitespace_is_trimmed_and_collapsed(self):
        assert normalize_topic("  Stahl \t beton  ") == "Stahl beton"

    def test_surrounding_punctuation_and_quotes_are_removed(self):
        assert normalize_topic("„Attika“.") == "Attika"

    @pytest.mark.parametrize("raw", [None, 42, ["Attika"], {"thema": "Attika"}])
    def test_a_non_string_is_no_topic(self, raw):
        assert normalize_topic(raw) is None

    @pytest.mark.parametrize("raw", ["", "   ", "1234", "---", " . , "])
    def test_a_term_without_a_letter_is_no_topic(self, raw):
        assert normalize_topic(raw) is None

    def test_three_words_are_kept_and_four_are_dropped(self):
        assert normalize_topic("a b c") == "a b c"
        assert normalize_topic("a b c d") is None
        assert MAX_TOPIC_WORDS == 3

    def test_forty_characters_are_kept_and_forty_one_are_dropped(self):
        assert normalize_topic("x" * MAX_TOPIC_CHARS) == "x" * MAX_TOPIC_CHARS
        assert normalize_topic("x" * (MAX_TOPIC_CHARS + 1)) is None


class TestParseTopics:
    def test_a_confident_reply_keeps_the_model_order(self):
        reply = _topics_json(("Attika", 0.9), ("Fenster", 0.8), ("Stiege", 0.95))
        assert parse_topics(reply) == ["Attika", "Fenster", "Stiege"]

    def test_a_fenced_reply_is_read(self):
        assert parse_topics("```json\n" + _topics_json(("Attika", 0.9)) + "\n```") == ["Attika"]

    def test_a_bare_fence_is_read(self):
        assert parse_topics("```\n" + _topics_json(("Attika", 0.9)) + "\n```") == ["Attika"]

    def test_english_keys_are_read_as_well(self):
        reply = json.dumps([{"topic": "Attika", "confidence": 0.9}])
        assert parse_topics(reply) == ["Attika"]

    @pytest.mark.parametrize("confidence, expected", [(0.74, None), (0.75, ["Attika"]), (1.0, ["Attika"])])
    def test_the_confidence_threshold_is_inclusive_at_0_75(self, confidence, expected):
        assert parse_topics(_topics_json(("Attika", confidence))) == expected

    @pytest.mark.parametrize("item", [{"thema": "Attika", "sicherheit": "0.99"}, {"thema": "Attika"}])
    def test_a_confidence_that_is_not_a_number_is_no_confidence(self, item):
        assert parse_topics(json.dumps([item])) is None

    @pytest.mark.parametrize("term", ["Das ist kein Thema", "Ein Satz mit deutlich mehr als drei Wörtern"])
    def test_a_sentence_is_no_topic(self, term):
        assert len(term.split()) > MAX_TOPIC_WORDS
        assert parse_topics(_topics_json((term, 0.9))) is None

    @pytest.mark.parametrize("term", sorted(ALLOWED_TAGS))
    def test_a_controlled_tag_is_never_a_topic(self, term):
        assert parse_topics(_topics_json((term, 0.99))) is None

    def test_a_controlled_tag_in_another_case_is_dropped_too(self):
        reply = _topics_json(("grundriss", 0.9), ("Attika", 0.9))
        assert parse_topics(reply) == ["Attika"]

    def test_the_project_spelling_is_reused_case_insensitively(self):
        reply = _topics_json(("HOLZRAHMENBAU", 0.9))
        assert parse_topics(reply, existing=["Holzrahmenbau"]) == ["Holzrahmenbau"]

    def test_a_new_term_keeps_the_spelling_the_model_gave(self):
        assert parse_topics(_topics_json(("Stahlbeton", 0.9)), existing=["Holzrahmenbau"]) == ["Stahlbeton"]

    def test_duplicates_by_case_are_removed_and_the_first_is_kept(self):
        reply = _topics_json(("Attika", 0.9), ("attika", 0.9), ("ATTIKA", 0.8), ("Fenster", 0.9))
        assert parse_topics(reply) == ["Attika", "Fenster"]

    def test_the_cap_counts_kept_topics_not_the_items_of_the_reply(self):
        # Low-confidence and invalid items come first; the six that survive are still all kept.
        noise = [("Rauschen", 0.1), ("Viel zu viele Worte hier drin", 0.9)]
        kept = [(f"Thema{i}", 0.9) for i in range(MAX_TOPICS + 2)]
        result = parse_topics(_topics_json(*noise, *kept))
        assert result == [f"Thema{i}" for i in range(MAX_TOPICS)]

    def test_a_long_reply_is_capped_at_max_topics(self):
        reply = _topics_json(*((f"Thema{i}", 0.9) for i in range(MAX_TOPICS * 2)))
        assert len(parse_topics(reply)) == MAX_TOPICS

    def test_an_empty_or_unparseable_reply_is_none(self):
        assert parse_topics("") is None
        assert parse_topics("Attika, Fenster") is None
        assert parse_topics("[") is None

    @pytest.mark.parametrize("reply", ['{"thema": "Attika", "sicherheit": 0.9}', '"Attika"', "42"])
    def test_a_json_value_that_is_not_an_array_is_none(self, reply):
        assert parse_topics(reply) is None

    def test_items_that_are_not_objects_are_skipped(self):
        assert parse_topics(json.dumps(["Attika", {"thema": "Fenster", "sicherheit": 0.9}])) == ["Fenster"]

    def test_a_reply_where_every_topic_is_dropped_is_none(self):
        assert parse_topics(_topics_json(("Attika", 0.2), ("Fenster", 0.5))) is None

    def test_a_nan_confidence_is_no_confidence(self):
        assert parse_topics('[{"thema": "Attika", "sicherheit": NaN}]') is None

    def test_a_boolean_confidence_is_no_confidence(self):
        assert parse_topics('[{"thema": "Attika", "sicherheit": true}]') is None


class TestSuggestTopics:
    def test_no_llm_asks_nothing_and_returns_none(self):
        assert suggest_topics("Text", "plan.pdf", None) is None

    @pytest.mark.parametrize("text", ["", "   \n\t  "])
    def test_no_text_asks_nothing(self, text):
        llm = _llm(_topics_json(("Attika", 0.9)))
        assert suggest_topics(text, "plan.pdf", llm) is None
        llm.invoke.assert_not_called()

    def test_the_confident_topics_of_the_reply_are_returned(self):
        llm = _llm(_topics_json(("Attika", 0.9), ("Dachrand", 0.5)))
        assert suggest_topics("Attika mit Blech", "detail.pdf", llm) == ["Attika"]

    def test_the_project_spelling_is_reused_through_the_call(self):
        llm = _llm(_topics_json(("attika", 0.9)))
        assert suggest_topics("Attika", "detail.pdf", llm, existing=["Attika"]) == ["Attika"]

    def test_a_failed_call_is_none(self):
        llm = MagicMock()
        llm.invoke.side_effect = RuntimeError("LLM down")
        assert suggest_topics("Text", "plan.pdf", llm) is None

    def test_a_reply_that_is_not_json_is_none(self):
        assert suggest_topics("Text", "plan.pdf", _llm("Ich weiß es nicht")) is None

    def test_the_model_is_called_once_with_one_prompt_string(self):
        llm = _llm(_topics_json(("Attika", 0.9)))
        suggest_topics("Text", "plan.pdf", llm)
        llm.invoke.assert_called_once()
        assert isinstance(llm.invoke.call_args.args[0], str)

    def test_the_prompt_offers_the_existing_vocabulary_verbatim(self):
        llm = _llm("[]")
        suggest_topics("Text", "plan.pdf", llm, existing=["Holzrahmenbau", "Tiefgarage"])
        prompt = llm.invoke.call_args.args[0]
        assert "Holzrahmenbau" in prompt
        assert "Tiefgarage" in prompt

    def test_the_prompt_names_the_keys_the_parser_reads(self):
        llm = _llm("[]")
        suggest_topics("Text", "plan.pdf", llm)
        prompt = llm.invoke.call_args.args[0]
        assert '"thema"' in prompt
        assert '"sicherheit"' in prompt

    def test_the_prompt_carries_the_file_name_and_the_bounded_text(self):
        llm = _llm("[]")
        text = "x" * CLASSIFY_MAX_INPUT_CHARS + "BEYOND-THE-CUT"
        suggest_topics(text, "fassade-nord.pdf", llm)
        prompt = llm.invoke.call_args.args[0]
        assert "fassade-nord.pdf" in prompt
        assert "x" * CLASSIFY_MAX_INPUT_CHARS in prompt
        assert "BEYOND-THE-CUT" not in prompt

    def test_the_offered_vocabulary_is_bounded(self):
        existing = [f"Begriff{i:02d}" for i in range(MAX_TOPIC_VOCABULARY + 5)]
        llm = _llm("[]")
        suggest_topics("Text", "plan.pdf", llm, existing=existing)
        prompt = llm.invoke.call_args.args[0]
        assert f"Begriff{MAX_TOPIC_VOCABULARY - 1:02d}" in prompt
        assert f"Begriff{MAX_TOPIC_VOCABULARY:02d}" not in prompt
