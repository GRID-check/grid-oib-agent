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

"""Tests for the direct ChatResponse -> ChatResponseChunk converter that
preserves GRID extra fields across NAT's CHAT_STREAM serialization."""

from aiq_agent.common import _create_chat_response
from aiq_agent.common.nat_converters import _PRESERVED_EXTRA_FIELDS
from aiq_agent.common.nat_converters import _chat_response_to_chunk


def test_answer_confidence_is_a_preserved_field():
    assert "answer_confidence" in _PRESERVED_EXTRA_FIELDS


def test_converter_preserves_answer_confidence():
    response = _create_chat_response("The answer.", response_id="r", model="m")
    response.answer_confidence = "high"

    chunk = _chat_response_to_chunk(response)

    assert getattr(chunk, "answer_confidence", None) == "high"
    # Text content still survives.
    assert chunk.choices[0].delta.content == "The answer."


def test_converter_omits_answer_confidence_when_absent():
    response = _create_chat_response("The answer.", response_id="r", model="m")

    chunk = _chat_response_to_chunk(response)

    # Absent extra → not copied onto the chunk (no chip downstream).
    assert getattr(chunk, "answer_confidence", None) is None


def test_converter_preserves_all_extras_together():
    response = _create_chat_response("The answer.", response_id="r", model="m")
    response.cards = [{"type": "summary"}]
    response.deep_research_job_id = "job-1"
    response.answer_confidence = "medium"

    chunk = _chat_response_to_chunk(response)

    assert getattr(chunk, "cards", None) == [{"type": "summary"}]
    assert getattr(chunk, "deep_research_job_id", None) == "job-1"
    assert getattr(chunk, "answer_confidence", None) == "medium"
