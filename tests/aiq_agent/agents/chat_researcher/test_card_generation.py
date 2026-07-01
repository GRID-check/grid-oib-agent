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

"""Tests for post-run card generation in ChatResearcherAgent."""

from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.chat_researcher.agent import ChatResearcherAgent
from aiq_agent.agents.chat_researcher.models import ChatResearcherState
from aiq_agent.agents.chat_researcher.models import IntentResult


class TestCardGeneration:
    """Tests for card generation behavior after the graph run."""

    @pytest.fixture
    def mock_llm(self):
        """Create a mock LLM with an async ainvoke method."""
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        return llm

    @pytest.fixture
    def agent_with_mocked_graph(self, mock_llm):
        """Create an agent whose graph ainvoke is controlled by tests."""
        agent = ChatResearcherAgent(
            intent_classifier_fn=AsyncMock(),
            shallow_research_fn=AsyncMock(),
            deep_research_fn=AsyncMock(),
            clarifier_fn=None,
            llm=mock_llm,
        )
        return agent

    @pytest.mark.asyncio
    async def test_valid_cards_attached_after_graph_run(self, agent_with_mocked_graph, mock_llm):
        """When the LLM returns valid card JSON, cards are attached to the result."""
        mock_llm.ainvoke.return_value = AIMessage(
            content='[{"type": "summary", "title": "Answer", "content": "Quick answer."}]'
        )

        async def fake_ainvoke(state, config=None):
            return ChatResearcherState(
                messages=[HumanMessage(content="What is CUDA?"), AIMessage(content="CUDA is a parallel platform.")],
                user_intent=IntentResult(intent="research", raw=None),
                original_query="What is CUDA?",
            )

        agent_with_mocked_graph._graph.ainvoke = fake_ainvoke
        state = ChatResearcherState(messages=[HumanMessage(content="What is CUDA?")])
        result = await agent_with_mocked_graph.run(state, thread_id="test-thread")

        assert result.cards is not None
        assert len(result.cards) == 1
        assert result.cards[0]["type"] == "summary"
        mock_llm.ainvoke.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_invalid_json_results_in_no_cards(self, agent_with_mocked_graph, mock_llm):
        """When the LLM returns invalid JSON, the response succeeds with no cards."""
        mock_llm.ainvoke.return_value = AIMessage(content="not valid json")

        async def fake_ainvoke(state, config=None):
            return ChatResearcherState(
                messages=[HumanMessage(content="What is CUDA?"), AIMessage(content="CUDA is a parallel platform.")],
                user_intent=IntentResult(intent="research", raw=None),
                original_query="What is CUDA?",
            )

        agent_with_mocked_graph._graph.ainvoke = fake_ainvoke
        state = ChatResearcherState(messages=[HumanMessage(content="What is CUDA?")])
        result = await agent_with_mocked_graph.run(state, thread_id="test-thread")

        assert result.cards is None or result.cards == []
        mock_llm.ainvoke.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_no_ai_message_context_results_in_no_cards(self, agent_with_mocked_graph, mock_llm):
        """When the graph result has no assistant message, no cards are generated."""

        async def fake_ainvoke(state, config=None):
            return ChatResearcherState(
                messages=[HumanMessage(content="What is CUDA?")],
                user_intent=IntentResult(intent="research", raw=None),
                original_query="What is CUDA?",
            )

        agent_with_mocked_graph._graph.ainvoke = fake_ainvoke
        state = ChatResearcherState(messages=[HumanMessage(content="What is CUDA?")])
        result = await agent_with_mocked_graph.run(state, thread_id="test-thread")

        assert result.cards is None
        mock_llm.ainvoke.assert_not_awaited()
