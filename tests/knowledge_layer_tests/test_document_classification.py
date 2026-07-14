# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Unit tests for the shared document classification helpers.

Covers the tag-classification prompt/call/parse/post-filter and the shared
one-sentence summary helper. The LLM call is always mocked.
"""

from unittest.mock import MagicMock

from aiq_agent.knowledge.document_classification import ALLOWED_TAGS
from aiq_agent.knowledge.document_classification import DISCIPLINE_TAGS
from aiq_agent.knowledge.document_classification import DOCUMENT_TYPE_TAGS
from aiq_agent.knowledge.document_classification import _build_tag_prompt
from aiq_agent.knowledge.document_classification import classify_document_tags
from aiq_agent.knowledge.document_classification import summarize_document_text


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
