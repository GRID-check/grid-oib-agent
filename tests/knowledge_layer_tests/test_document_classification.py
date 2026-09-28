"""Unit tests for the shared document classification helpers.

Covers the tag-classification prompt/call/parse/post-filter and the shared
one-sentence summary helper. The LLM call is always mocked.
"""

import json
from unittest.mock import MagicMock
from unittest.mock import patch

import httpx
import pytest

from aiq_agent.common import decisions
from aiq_agent.knowledge import document_classification
from aiq_agent.knowledge.document_classification import ALLOWED_TAGS
from aiq_agent.knowledge.document_classification import DISCIPLINE_TAGS
from aiq_agent.knowledge.document_classification import DOCUMENT_TYPE_TAGS
from aiq_agent.knowledge.document_classification import _build_tag_prompt
from aiq_agent.knowledge.document_classification import classify_document_tags
from aiq_agent.knowledge.document_classification import fallback_summary_from_text
from aiq_agent.knowledge.document_classification import summarize_document_text

# =============================================================================
# Deterministic fallback summary (used to anchor a tags-only row)
# =============================================================================


class TestFallbackSummaryFromText:
    def test_short_text_returned_verbatim_single_line(self):
        assert fallback_summary_from_text("A short summary line.") == "A short summary line."

    def test_whitespace_collapsed_to_single_line(self):
        assert fallback_summary_from_text("line one\n\nline   two\ttab") == "line one line two tab"

    def test_long_text_truncated_with_ellipsis(self):
        text = "word " * 100  # 500 chars
        result = fallback_summary_from_text(text, max_chars=50)
        assert result.endswith("…")
        # The ellipsis is the only character beyond the cap.
        assert len(result) <= 51
        assert "\n" not in result

    def test_empty_or_none_returns_none(self):
        assert fallback_summary_from_text(None) is None
        assert fallback_summary_from_text("") is None
        assert fallback_summary_from_text("   \n\t ") is None


def _llm_returning(content: str) -> MagicMock:
    llm = MagicMock()
    llm.invoke.return_value = MagicMock(content=content)
    return llm


# =============================================================================
# Vocabulary shape / drift guards
# =============================================================================


class TestVocabulary:
    def test_vocabularies_are_immutable_tuples(self):
        assert isinstance(DOCUMENT_TYPE_TAGS, tuple)
        assert isinstance(DISCIPLINE_TAGS, tuple)

    def test_allowed_tags_is_union(self):
        assert ALLOWED_TAGS == frozenset(DOCUMENT_TYPE_TAGS) | frozenset(DISCIPLINE_TAGS)
        # The six OIB disciplines the user asked for are all present.
        assert "Brandschutz" in ALLOWED_TAGS
        assert "Standsicherheit" in ALLOWED_TAGS

    def test_prompt_contains_every_vocabulary_member(self):
        """Drift guard: the prompt is built from the constants, so every
        allowed tag must literally appear in the prompt text."""
        prompt = _build_tag_prompt("some document text", "plan.pdf")
        for tag in ALLOWED_TAGS:
            assert tag in prompt, f"vocabulary member missing from prompt: {tag}"


# =============================================================================
# Tag classification
# =============================================================================


class TestClassifyDocumentTags:
    """The generative fallback: what runs when no decision did."""

    @pytest.fixture(autouse=True)
    def _no_decision(self):
        with patch.object(document_classification, "decide_document_tags", return_value=None):
            yield

    def test_no_llm_returns_none(self):
        assert classify_document_tags("text", "f.pdf", llm=None) is None

    def test_valid_json_array(self):
        llm = _llm_returning('["Grundriss", "Brandschutz"]')
        assert classify_document_tags("text", "f.pdf", llm) == ["Grundriss", "Brandschutz"]

    def test_fenced_json_is_stripped(self):
        llm = _llm_returning('```json\n["Schnitt", "Schallschutz"]\n```')
        assert classify_document_tags("text", "f.pdf", llm) == ["Schnitt", "Schallschutz"]

    def test_bare_fence_without_language(self):
        llm = _llm_returning('```\n["Foto"]\n```')
        assert classify_document_tags("text", "f.pdf", llm) == ["Foto"]

    def test_invalid_output_returns_none(self):
        llm = _llm_returning("I think this is a floor plan, probably.")
        assert classify_document_tags("text", "f.pdf", llm) is None

    def test_non_array_json_returns_none(self):
        llm = _llm_returning('{"tag": "Grundriss"}')
        assert classify_document_tags("text", "f.pdf", llm) is None

    def test_off_vocabulary_tags_are_dropped(self):
        """The user's core concern: an off-vocabulary tag (a semantic duplicate
        like 'Feuerschutz' for the canonical 'Brandschutz', or any invented
        category) is deterministically dropped and never reaches storage."""
        llm = _llm_returning('["Feuerschutz", "Brandschutz", "MadeUpCategory", "Grundriss"]')
        result = classify_document_tags("text", "f.pdf", llm)
        assert result == ["Brandschutz", "Grundriss"]
        assert "Feuerschutz" not in result
        assert "MadeUpCategory" not in result

    def test_all_invalid_returns_none(self):
        llm = _llm_returning('["Feuerschutz", "Nonsense"]')
        assert classify_document_tags("text", "f.pdf", llm) is None

    def test_duplicates_deduplicated_preserving_order(self):
        llm = _llm_returning('["Grundriss", "Grundriss", "Schnitt"]')
        assert classify_document_tags("text", "f.pdf", llm) == ["Grundriss", "Schnitt"]

    def test_capped_at_five(self):
        llm = _llm_returning('["Grundriss", "Schnitt", "Ansicht", "Detail", "Standsicherheit", "Brandschutz"]')
        result = classify_document_tags("text", "f.pdf", llm)
        assert len(result) == 5

    def test_non_string_items_ignored(self):
        llm = _llm_returning('["Grundriss", 42, null, "Brandschutz"]')
        assert classify_document_tags("text", "f.pdf", llm) == ["Grundriss", "Brandschutz"]

    def test_llm_exception_returns_none(self):
        llm = MagicMock()
        llm.invoke.side_effect = RuntimeError("LLM down")
        assert classify_document_tags("text", "f.pdf", llm) is None


# =============================================================================
# Tags as a decision (ADR-0064)
# =============================================================================


def _decision(type_choice: str, type_probabilities: dict, disciplines: dict[int, float]) -> dict:
    answers = {"type": {"type": "choice", "choice": type_choice, "probabilities": type_probabilities}}
    for index in range(len(DISCIPLINE_TAGS)):
        answers[f"discipline_{index}"] = {"type": "noul", "noul": disciplines.get(index, 0.05)}
    return answers


@pytest.fixture
def endpoint(monkeypatch):
    """The decision endpoint, answered by a handler the test sets."""
    decisions.reset_breaker()
    monkeypatch.delenv(decisions.ENABLED_ENV, raising=False)
    seen: dict = {}

    def install(answers: dict | None, status: int = 200):
        def handler(request: httpx.Request) -> httpx.Response:
            seen["body"] = json.loads(request.content)
            if answers is None:
                return httpx.Response(status)
            return httpx.Response(status, json={"answers": answers, "usage": {"input_tokens": 400, "cost": 0.00005}})

        # ``decide_blocking`` builds a transport of its own per call.
        return patch.object(httpx, "AsyncHTTPTransport", return_value=httpx.MockTransport(handler))

    endpoint_value = decisions._Endpoint(url="https://openrouter.ai/api/alpha/decisions", api_key="k", model="m")
    with (
        patch.object(decisions, "_zdr_only_blocking", return_value=False),
        patch.object(decisions, "_resolve_endpoint_blocking", return_value=(endpoint_value, None)),
    ):
        yield install, seen
    decisions.reset_breaker()


class TestTagsAreDecided:
    def test_the_questions_are_the_vocabulary(self):
        """Drift guard: every type is an option and every discipline a question."""
        questions = document_classification.tag_questions()
        assert list(questions["type"]["criteria"]) == list(DOCUMENT_TYPE_TAGS)
        assert [k for k in questions if k.startswith("discipline_")] == [
            f"discipline_{i}" for i in range(len(DISCIPLINE_TAGS))
        ]

    def test_a_decision_replaces_the_generative_call(self, endpoint):
        install, seen = endpoint
        llm = MagicMock()
        with install(_decision("Gutachten", {"Gutachten": 0.9}, {4: 0.52, 5: 0.96})):
            tags = classify_document_tags("Bauphysikalisches Gutachten …", "bp.pdf", llm)
        # 0.52 is the borderline the threshold leaves out on purpose.
        assert tags == ["Gutachten", "Energieeinsparung/Wärmeschutz"]
        llm.invoke.assert_not_called()
        assert seen["body"]["state"]["file_name"] == "bp.pdf"

    def test_an_unsure_type_is_no_decision_and_the_prompt_tags(self, endpoint):
        """Every decision acts at 0.8: a type below it hands the document to the prompt."""
        install, _ = endpoint
        with install(_decision("Bebauungsplan", {"Bebauungsplan": 0.55, "Flächenwidmungsplan": 0.45}, {})):
            tags = classify_document_tags("Plandokument …", "pd.pdf", _llm_returning('["Flächenwidmungsplan"]'))
        assert tags == ["Flächenwidmungsplan"]

    def test_one_type_only(self, endpoint):
        install, _ = endpoint
        with install(_decision("Sonstiges", {"Sonstiges": 0.85, "Vertrag": 0.15}, {})):
            assert classify_document_tags("Protokoll …", "p.pdf", None) == ["Sonstiges"]

    def test_at_most_three_disciplines_most_likely_first(self, endpoint):
        install, _ = endpoint
        with install(_decision("Gutachten", {"Gutachten": 1.0}, {0: 0.82, 1: 0.95, 2: 0.7, 3: 0.9, 4: 0.85})):
            tags = classify_document_tags("…", "g.pdf", None)
        assert tags == ["Gutachten", "Brandschutz", "Nutzungssicherheit/Barrierefreiheit", "Schallschutz"]

    def test_a_failed_decision_falls_back_to_the_prompt(self, endpoint):
        install, _ = endpoint
        with install(None, status=503):
            tags = classify_document_tags("text", "f.pdf", _llm_returning('["Grundriss"]'))
        assert tags == ["Grundriss"]

    def test_an_answer_outside_the_vocabulary_is_no_decision(self, endpoint):
        install, _ = endpoint
        with install(_decision("Feuerschutz", {"Feuerschutz": 1.0}, {})):
            tags = classify_document_tags("text", "f.pdf", _llm_returning('["Schnitt"]'))
        assert tags == ["Schnitt"]

    def test_empty_text_asks_nothing(self, endpoint):
        install, seen = endpoint
        with install(_decision("Foto", {"Foto": 1.0}, {})):
            assert document_classification.decide_document_tags("   ", "f.pdf") is None
        assert "body" not in seen


# =============================================================================
# Shared summary helper
# =============================================================================


class TestSummarizeDocumentText:
    def test_no_llm_returns_none(self):
        assert summarize_document_text("text", "f.pdf", llm=None) is None

    def test_returns_stripped_summary(self):
        llm = _llm_returning("  A one-sentence summary.  ")
        assert summarize_document_text("text", "f.pdf", llm) == "A one-sentence summary."

    def test_empty_summary_returns_none(self):
        llm = _llm_returning("   ")
        assert summarize_document_text("text", "f.pdf", llm) is None

    def test_llm_exception_returns_none(self):
        llm = MagicMock()
        llm.invoke.side_effect = RuntimeError("boom")
        assert summarize_document_text("text", "f.pdf", llm) is None


class TestTheDokumentartIsSuggested:
    """ADR-0064 use 8: a class for a person to accept, never set on its own."""

    def _answer(self, chosen: str, p: float) -> dict:
        return {"doc_class": {"type": "choice", "choice": chosen, "probabilities": {chosen: p}}}

    def test_the_options_are_the_vocabulary(self, endpoint):
        install, seen = endpoint
        with install(self._answer("gesetz", 1.0)):
            assert document_classification.suggest_doc_class("Bauordnung für Wien …", "BO.pdf") == "gesetz"
        assert list(seen["body"]["questions"]["doc_class"]["criteria"]) == list(
            document_classification.DOCUMENT_CLASSES
        )

    @pytest.mark.parametrize(("chosen", "p"), [("sonstiges", 1.0), ("gesetz", 0.6), ("erfunden", 1.0)])
    def test_nothing_is_offered_for_the_default_an_unsure_pick_or_an_unknown_one(self, endpoint, chosen, p):
        install, _ = endpoint
        with install(self._answer(chosen, p)):
            assert document_classification.suggest_doc_class("text", "f.pdf") is None

    def test_no_decision_offers_nothing(self, endpoint):
        install, _ = endpoint
        with install(None, status=503):
            assert document_classification.suggest_doc_class("text", "f.pdf") is None
