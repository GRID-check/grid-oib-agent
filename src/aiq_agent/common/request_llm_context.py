"""What one request changes about the boot LLM provider, read off the event loop.

Four per-org dials reach a turn: the runtime model overrides, the platform
thinking level (with the asker's own level for this turn laid over the chat
answer's group, `with_turn_effort`), the org's BYOK credential and its ZDR
routing bit (ADR-0014, ADR-0022). Each lookup is header-first (the platform efforts cache-first), but
each falls back to a blocking BFF call (5 s timeout, 60 s in-process TTL) under
a threading lock. Called from a coroutine, a cold miss froze the event loop for
every turn on the replica, not only the one that missed.

So every agent that applies them reads them here: each on its own thread hop,
concurrently, and each failing on its own. A lost override costs the model
choice and a lost credential falls back to the env chain; a failed ZDR lookup
fails CLOSED. ContextVars travel with each hop, which is what lets the readers
see the request headers from the worker thread.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from dataclasses import field

from aiq_agent.common.llm_credentials import OrgLLMCredential
from aiq_agent.common.llm_credentials import get_org_llm_credential_from_context
from aiq_agent.common.llm_provider import LLMProvider
from aiq_agent.common.model_overrides import AgentGroup
from aiq_agent.common.model_overrides import get_model_overrides_from_context
from aiq_agent.common.model_overrides import get_zdr_only_from_context
from aiq_agent.common.reasoning_settings import get_reasoning_efforts
from aiq_agent.common.reasoning_settings import get_turn_reasoning_effort

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RequestLLMContext:
    """The four per-request dials, already resolved."""

    model_overrides: dict[str, str] = field(default_factory=dict)
    reasoning_efforts: dict[str, str] = field(default_factory=dict)
    credential: OrgLLMCredential | None = None
    zdr_only: bool = False

    def apply(self, provider: LLMProvider) -> LLMProvider:
        """The provider this request runs on.

        Each step returns the provider unchanged when its dial is inactive, so a
        caller's identity check (``active is provider``) still means "nothing
        to apply" and keeps its boot-time binding.
        """
        return (
            provider.with_model_overrides(self.model_overrides)
            .with_reasoning_efforts(self.reasoning_efforts)
            .with_credential(self.credential)
            .with_zdr(self.zdr_only)
        )


async def read_request_llm_context() -> RequestLLMContext:
    """Resolve the four dials for the current request, none of them on the loop."""
    model_overrides, efforts, credential, zdr_only = await asyncio.gather(
        _read_model_overrides(),
        _read_reasoning_efforts(),
        _read_org_credential(),
        _read_zdr_only(),
    )
    return RequestLLMContext(
        model_overrides=model_overrides,
        reasoning_efforts=efforts,
        credential=credential,
        zdr_only=zdr_only,
    )


async def _read_model_overrides() -> dict[str, str]:
    try:
        return await asyncio.to_thread(get_model_overrides_from_context)
    except Exception:  # noqa: BLE001 - a lost override costs the model choice, never the turn
        logger.debug("Model-overrides lookup failed; continuing without", exc_info=True)
        return {}


async def _read_org_credential() -> OrgLLMCredential | None:
    try:
        return await asyncio.to_thread(get_org_llm_credential_from_context)
    except Exception:  # noqa: BLE001 - see above; the env chain still has a credential
        logger.debug("Org-credential lookup failed; continuing without", exc_info=True)
        return None


async def _read_reasoning_efforts() -> dict[str, str]:
    try:
        efforts = await asyncio.to_thread(get_reasoning_efforts)
    except Exception:  # noqa: BLE001 - a lost effort costs the thinking level, never the turn
        logger.debug("Reasoning-efforts lookup failed; continuing with the configured levels", exc_info=True)
        efforts = {}
    return with_turn_effort(efforts, get_turn_reasoning_effort())


def with_turn_effort(efforts: dict[str, str], turn_effort: str | None) -> dict[str, str]:
    """``efforts`` with the asker's level on the chat answer's group, when one was chosen.

    Only the answering agent's group: the dial is "how hard should Piloti think
    about my question", not a lever over the clarifier, the card pass or the
    post-answer stages, which keep their platform levels.
    """
    if turn_effort is None:
        return efforts
    return {**efforts, AgentGroup.RESEARCH.value: turn_effort}


async def _read_zdr_only() -> bool:
    try:
        return await asyncio.to_thread(get_zdr_only_from_context)
    except Exception:  # noqa: BLE001 - fails CLOSED, unlike its three siblings
        # A missing override costs the org its model choice; a missing ZDR bit
        # sends the org's prompts to endpoints that may retain them, which is
        # the ADR-0014 control itself. This is NOT the "BFF is down" path --
        # `resolve_org_zdr_only` already answers False for that, deliberately.
        # Reaching here means the lookup itself broke unexpectedly, so it logs
        # at error rather than debug: a privacy control that switches itself
        # off must never do it quietly.
        logger.error("ZDR lookup failed; pinning ZDR routing for this turn", exc_info=True)
        return True
