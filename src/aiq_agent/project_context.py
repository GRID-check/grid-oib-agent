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
PROJECT_MEMORY_HEADER = "x-grid-project-memory"
PROJECT_ID_HEADER = "x-grid-project-id"

logger = logging.getLogger(__name__)


def normalize_project_context(value: str | None, *, max_chars: int = 4000) -> str | None:
    """Normalize and limit project context string."""
    if not value:
        return None
    value = value.strip()
    if not value:
        return None
    if len(value) > max_chars:
        value = value[:max_chars]
        value = value.rsplit("\n", 1)[0]
    return value


def _read_header(name: str) -> str | None:
    """Read a raw header value from NAT Context metadata."""
    try:
        from nat.builder.context import Context

        ctx = Context.get()
        if ctx is None or ctx.metadata is None:
            return None
        return ctx.metadata.headers.get(name)
    except Exception:
        logger.debug("Failed to read %s from NAT context", name, exc_info=True)
        return None


def get_project_context_from_context() -> str | None:
    """Compose the injected agent context from the request headers.

    Combines the intake-profile context (``X-Grid-Project-Context``) with the
    project memory core digest (``X-Grid-Project-Memory``, see
    docs/architecture/project-memory-design.md). Composed here so every
    existing caller and prompt template picks memory up transparently as part
    of the single ``project_context`` blob.
    """
    context = normalize_project_context(_read_header(PROJECT_CONTEXT_HEADER))
    memory = normalize_project_context(_read_header(PROJECT_MEMORY_HEADER), max_chars=2000)

    if context and memory:
        return f"{context}\n\n{memory}"
    return context or memory


def get_project_id_from_context() -> str | None:
    """Read the current project's id (``X-Grid-Project-Id``).

    Used by project-scoped tools (e.g. ``remember``) to write rows for the
    right project. None outside a project-scoped conversation.
    """
    raw = _read_header(PROJECT_ID_HEADER)
    if not raw:
        return None
    raw = raw.strip()
    return raw or None


def get_organization_id_from_context() -> str | None:
    """Read the caller's organization id (``X-Grid-Organization-Id``).

    Set by server.js on the WS upgrade for authenticated sessions. Used by
    organization-scoped memory writes. None in anonymous mode.
    """
    raw = _read_header("x-grid-organization-id")
    if not raw:
        return None
    raw = raw.strip()
    return raw or None


def get_conversation_id_from_context() -> str | None:
    """Best-effort read of the active conversation id for provenance."""
    try:
        from nat.builder.context import Context

        ctx = Context.get()
        if ctx is None:
            return None
        conversation_id = getattr(ctx, "conversation_id", None)
        return str(conversation_id) if conversation_id else None
    except Exception:
        logger.debug("Failed to read conversation id from NAT context", exc_info=True)
        return None
