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

"""Tests for merging persisted document summaries into the documents listing.

Covers ``_merge_summaries``, the route-level seam that layers SummaryStore rows
(the source of truth) onto the ingestor's collection file list.
"""

from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.knowledge.schema import FileInfo
from aiq_agent.knowledge.schema import FileStatus
from aiq_api.routes.documents import _merge_summaries


def _file(name: str, summary: str | None = None) -> FileInfo:
    return FileInfo(
        file_id=name,
        file_name=name,
        collection_name="proj_abc",
        status=FileStatus.SUCCESS,
        summary=summary,
    )


def test_merges_summary_onto_matching_file():
    files = [_file("plan.pdf"), _file("specs.pdf")]
    summaries = [
        AvailableDocument(file_name="plan.pdf", summary="A ground-floor plan."),
        AvailableDocument(file_name="specs.pdf", summary="Structural specs."),
    ]

    _merge_summaries(files, summaries)

    assert files[0].summary == "A ground-floor plan."
    assert files[1].summary == "Structural specs."


def test_file_without_summary_row_stays_none():
    files = [_file("plan.pdf"), _file("orphan.pdf")]
    summaries = [AvailableDocument(file_name="plan.pdf", summary="Only this one.")]

    _merge_summaries(files, summaries)

    assert files[0].summary == "Only this one."
    assert files[1].summary is None


def test_empty_summaries_leaves_files_untouched():
    files = [_file("plan.pdf")]

    _merge_summaries(files, [])

    assert files[0].summary is None


def test_summary_row_without_matching_file_is_ignored():
    # A summary persisted for a file no longer in the vector store must not
    # invent a document row.
    files = [_file("plan.pdf")]
    summaries = [AvailableDocument(file_name="deleted.pdf", summary="Stale.")]

    _merge_summaries(files, summaries)

    assert files[0].summary is None
    assert len(files) == 1


def test_existing_summary_is_not_overwritten():
    files = [_file("plan.pdf", summary="Already set.")]
    summaries = [AvailableDocument(file_name="plan.pdf", summary="From store.")]

    _merge_summaries(files, summaries)

    assert files[0].summary == "Already set."


def test_summary_row_with_none_summary_is_skipped():
    files = [_file("plan.pdf")]
    summaries = [AvailableDocument(file_name="plan.pdf", summary=None)]

    _merge_summaries(files, summaries)

    assert files[0].summary is None
