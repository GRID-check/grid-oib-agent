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

"""Per-organization runtime model overrides (``X-Grid-Model-Overrides``).

Org admins can re-point each *agent group* at a different OpenRouter model at
runtime (see docs/architecture/org-model-configuration.md and ADR-0014). The
BFF resolves the org's active configuration version at the WebSocket upgrade
and forwards it as the base64url-encoded JSON header::

    X-Grid-Model-Overrides: base64url({"shallow_research": "vendor/model", ...})

The backend treats the header as advisory *model selection only*: every other
generation parameter (max_tokens, reasoning_effort, base_url, api_key) still
comes from the workflow YAML, so an override can never re-point traffic at a
different provider or credential. Unknown groups and malformed ids are
dropped; a missing/broken header means "use the YAML defaults" (fail-open to
defaults, never an error — model selection must not take chat down).
"""

import base64
import json
import logging
import re
from enum import StrEnum

logger = logging.getLogger(__name__)

MODEL_OVERRIDES_HEADER = "x-grid-model-overrides"

# Model ids are OpenRouter's `author/slug` (optional `:variant` suffix, e.g.
# `meta-llama/llama-4:free`) OR — for orgs on a BYOK credential (ADR-0022) —
# a provider-native id without a slash (`gpt-4o`, `ft:gpt-4o:acme::abc`,
# Azure deployment names). Anything else is dropped — defense in depth
# behind the BFF's catalog validation. Mirrors MODEL_ID_PATTERN in
# `frontends/ui/src/lib/model-config/agent-groups.ts`.
_MODEL_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}(/[A-Za-z0-9_.:-]{1,128})?$")


class AgentGroup(StrEnum):
    """Semantic agent groups an org admin can independently re-model.

    Groups deliberately sit *above* the YAML LLM names: they are stable,
    user-meaningful override points, while the YAML remains free to reshuffle
    which named LLM serves which role. The registry mirror lives in
    ``frontends/ui/src/lib/model-config/agent-groups.ts`` (which additionally
    carries the OpenRouter capability requirements per group) — keep the two
    id sets in sync.
    """

    INTENT = "intent"
    CLARIFIER = "clarifier"
    SHALLOW_RESEARCH = "shallow_research"
    DEEP_RESEARCH = "deep_research"
    DEEP_RESEARCH_ROUTER = "deep_research_router"
    MEMORY_REFLECTION = "memory_reflection"


def parse_model_overrides(raw: str | None) -> dict[str, str]:
    """Decode and sanitize a raw header value into ``{group: model_id}``.

    Tolerates padded/unpadded base64url. Silently drops unknown group ids and
    model ids that don't look like OpenRouter slugs.
    """
    if not raw:
        return {}
    try:
        padded = raw + "=" * (-len(raw) % 4)
        decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
        data = json.loads(decoded)
    except Exception:
        logger.warning("Ignoring malformed %s header", MODEL_OVERRIDES_HEADER, exc_info=True)
        return {}
    return sanitize_model_overrides(data)


def sanitize_model_overrides(data: object) -> dict[str, str]:
    """Reduce an untrusted mapping to ``{known_group: plausible_model_id}``."""
    if not isinstance(data, dict):
        logger.warning("Ignoring model overrides: expected JSON object, got %s", type(data).__name__)
        return {}

    valid_groups = {g.value for g in AgentGroup}
    overrides: dict[str, str] = {}
    for group, model_id in data.items():
        if group not in valid_groups:
            logger.debug("Dropping model override for unknown agent group %r", group)
            continue
        if not isinstance(model_id, str) or not _MODEL_ID_RE.match(model_id):
            logger.warning("Dropping invalid model id %r for agent group %r", model_id, group)
            continue
        overrides[group] = model_id
    return overrides


def get_model_overrides_from_context() -> dict[str, str]:
    """Read the current request's model overrides from NAT context.

    Returns ``{}`` outside a request context or when the header is absent —
    callers then use the YAML-configured models unchanged.
    """
    from aiq_agent.project_context import _read_header

    return parse_model_overrides(_read_header(MODEL_OVERRIDES_HEADER))


def override_model(llm: object, model_id: str) -> object:
    """Return a copy of a LangChain chat model pointed at ``model_id``.

    Uses pydantic ``model_copy`` so the returned object is a real chat model
    (``bind_tools``/``with_structured_output`` keep working) that shares the
    underlying HTTP client with the original — the model name only changes the
    per-request payload. Returns the original llm unchanged when it doesn't
    expose a recognizable model field.
    """
    field = None
    if hasattr(llm, "model_name"):
        field = "model_name"
    elif hasattr(llm, "model"):
        field = "model"
    if field is None or not hasattr(llm, "model_copy"):
        logger.warning("Cannot apply model override to %s: no model field/model_copy", type(llm).__name__)
        return llm
    try:
        return llm.model_copy(update={field: model_id})
    except Exception:
        logger.warning("Failed to apply model override %r to %s", model_id, type(llm).__name__, exc_info=True)
        return llm


def apply_model_override(llm: object, group: AgentGroup, overrides: dict[str, str] | None = None) -> object:
    """Apply the current request's override for ``group`` to ``llm``, if any.

    ``overrides`` may be passed explicitly when the caller already read them
    (e.g. captured before scheduling background work); defaults to reading the
    live request context.
    """
    if overrides is None:
        overrides = get_model_overrides_from_context()
    model_id = overrides.get(group.value)
    if not model_id:
        return llm
    logger.info("Model override active: agent group %s -> %s", group.value, model_id)
    return override_model(llm, model_id)
