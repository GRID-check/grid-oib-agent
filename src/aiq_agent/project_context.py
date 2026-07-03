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

"""Project context extraction from the ``X-Grid-Project-Context`` header.

The Next.js BFF sends an internal header::

    X-Grid-Project-Context: <project context string>

In Python/NAT this header is accessed lowercased via ``Context`` metadata.
When the header is missing the system falls back to returning ``None``, and
prompt templates skip the project context block.
"""

import logging

PROJECT_CONTEXT_HEADER = "x-grid-project-context"

logger = logging.getLogger(__name__)


def normalize_project_context(value: str | None, *, max_chars: int = 4000) -> str | None:
    """Normalize and limit project context string."""
    if not value:
        return None
    value = value.strip()
    if not value:
        return None
    if len(value) > max_chars:
        value = value[:max_chars].rsplit("\n", 1)[0]
    return value


def get_project_context_from_context() -> str | None:
    """Read X-Grid-Project-Context from NAT Context metadata headers."""
    try:
        from nat.builder.context import Context

        ctx = Context.get()
        if ctx is None or ctx.metadata is None:
            return None
        raw = ctx.metadata.headers.get(PROJECT_CONTEXT_HEADER)
        return normalize_project_context(raw)
    except Exception:
        logger.debug("Failed to read project context from NAT context", exc_info=True)
        return None
