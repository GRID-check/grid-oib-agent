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

"""State models for shallow research agent."""

from typing import Annotated
from typing import Any

from langchain_core.messages import AnyMessage
from langgraph.graph.message import add_messages
from pydantic import BaseModel

from aiq_agent.knowledge import AvailableDocument


class ShallowResearchAgentState(BaseModel):
    """
    State for shallow research agent subgraph.

    Attributes:
        messages: Conversation history with LangGraph message reducer.
        data_sources: List of data sources selected by the user.
        user_info: Optional user information.
        tools_info: Information about available tools.
        available_documents: User-uploaded documents with summaries for context.
        collection_name: Knowledge collection name (for fetching documents).
        tool_iterations: Counter for tool-calling iterations.
        requires_sources: Whether this turn must be grounded in captured sources.
            True for research turns (an empty source registry is a failure —
            EmptySourceRegistryError). False for conversational/meta turns, which
            legitimately answer from persona/project context without any sources;
            the orchestrator sets this based on the classified intent. Defaults to
            True so standalone/eval callers keep the strict research contract.
        answer_citation_grounded: Whether the final answer carries at least one
            verified citation after citation verification. Set by ``run()`` — it
            is True only when verification kept a valid citation (or a single
            registry source was appended as the one minimal citation), and False
            when the registry was empty or verification removed every citation.
            The chat node reads it as the deterministic overconfidence guard:
            a model self-reported "high"/"medium" is capped to "low" when the
            answer is not grounded. Defaults to False (conservative).
    """

    messages: Annotated[list[AnyMessage], add_messages]
    data_sources: list[str] | None = None
    user_info: dict[str, Any] | None = None
    tools_info: list[dict[str, Any]] | None = None
    available_documents: list[AvailableDocument] | None = None
    collection_name: str | None = None
    tool_iterations: int = 0
    project_context: str | None = None
    requires_sources: bool = True
    answer_citation_grounded: bool = False
