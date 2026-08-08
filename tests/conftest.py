"""Shared fixtures for the backend test suite."""

from __future__ import annotations

import logging
from typing import Any

import pytest
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage
from langchain_core.messages import AIMessageChunk
from langchain_core.outputs import ChatGeneration
from langchain_core.outputs import ChatGenerationChunk
from langchain_core.outputs import ChatResult
from pydantic import Field

from aiq_agent.common.llm_factory import enforce_chat_request_contract

logger = logging.getLogger(__name__)

try:  # pragma: no cover - import guard, not behaviour
    from aiq_agent.common.cache import reset_local_store
except Exception:  # pragma: no cover - only when the agent package is unusable
    reset_local_store = None
    logger.warning("Shared-cache isolation disabled: aiq_agent.common.cache is not importable", exc_info=True)


@pytest.fixture(autouse=True)
def _isolate_shared_cache():
    """Reset the shared cache around every test.

    The ingest pipeline reads/writes the fail-open shared cache
    (``aiq_agent.common.cache``, ADR-0020) — notably the content-hash VLM
    caption cache. Its in-process fallback store (``REDIS_URL`` unset, which is
    how the suite runs) is a module global, so without this a caption produced
    by one test is served to the next whenever the two feed the VLM identical
    image bytes: the second test's stubbed VLM is never called and it asserts
    against the first test's caption. Mirrors
    ``sources/ris_adapter/tests/conftest.py``. No-op on a real Redis backend.
    """
    if reset_local_store is None:
        yield
        return
    reset_local_store()
    yield
    reset_local_store()


# ── provider-contract test double ────────────────────────────────────────────
#
# Every LLM double in this suite used to be a bare ``MagicMock``, which accepts
# any message sequence it is handed. That is why a whole family of production
# 400s (issues #291-#294, #333, #335, #336, #340 — "Requests ending with a model
# turn are not supported") was invisible in CI: the tests exercised our graph
# logic correctly and never once asserted that what we put on the wire is a
# request a real provider would accept.
#
# ``StrictProviderChatModel`` closes that gap. It is a real ``BaseChatModel``
# that enforces the wire contract the strictest provider we route to (Google,
# via OpenRouter) enforces, so a graph that assembles an illegal request fails
# in CI the same way it fails in production.


class ProviderContractError(RuntimeError):
    """Raised by :class:`StrictProviderChatModel` for a request a provider would reject."""


class StrictProviderChatModel(BaseChatModel):
    """A chat model that rejects requests real providers reject.

    Enforced invariants, each mirroring an observed production 400:

    - a request must not end on an assistant turn (Google:
      ``Requests ending with a model turn are not supported``);
    - an assistant turn carrying ``tool_calls`` must be followed by its tool
      results (the OpenAI-compatible tool-loop contract);
    - a request must contain at least one message.

    ``responses`` is a queue of replies to hand back in order; the last one is
    reused once exhausted. ``received`` records every request the model was
    asked to serve, so tests can assert on the exact wire payload.
    """

    responses: list[Any] = Field(default_factory=list)
    received: list[list[Any]] = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "strict-provider"

    def bind_tools(self, tools, **kwargs):
        """Bind tools the way a real provider integration does.

        ``BaseChatModel.bind_tools`` raises by default; agents in this repo call
        it on every model they resolve, so the double has to support it or it
        cannot stand in for a production model.
        """
        return self.bind(tools=list(tools), **kwargs)

    def _validate(self, messages: list[Any]) -> None:
        if not messages:
            raise ProviderContractError("Request contains no messages")

        for earlier, following in zip(messages, messages[1:], strict=False):
            if getattr(earlier, "type", None) == "ai" and getattr(earlier, "tool_calls", None):
                if getattr(following, "type", None) != "tool":
                    raise ProviderContractError(
                        "An assistant turn with tool_calls must be followed by its tool results"
                    )

        last = messages[-1]
        if getattr(last, "type", None) == "ai":
            raise ProviderContractError("Requests ending with a model turn are not supported.")

    def _next_response(self) -> AIMessage:
        if not self.responses:
            return AIMessage(content="ok")
        reply = self.responses[0] if len(self.responses) == 1 else self.responses.pop(0)
        return AIMessage(content=reply) if isinstance(reply, str) else reply

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self._validate(list(messages))
        self.received.append(list(messages))
        return ChatResult(generations=[ChatGeneration(message=self._next_response())])

    async def _agenerate(self, messages, stop=None, run_manager=None, **kwargs):
        self._validate(list(messages))
        self.received.append(list(messages))
        return ChatResult(generations=[ChatGeneration(message=self._next_response())])

    async def _astream(self, messages, stop=None, run_manager=None, **kwargs):
        self._validate(list(messages))
        self.received.append(list(messages))
        yield ChatGenerationChunk(message=AIMessageChunk(content=self._next_response().content))


@pytest.fixture
def strict_provider_llm():
    """A contract-enforcing chat model wired exactly as production wires one.

    Returns a factory so a test can queue the replies it needs. The model is
    passed through :func:`enforce_chat_request_contract` — the same call
    ``get_langchain_llm`` makes for every model in the fleet — so tests exercise
    the production configuration rather than a bare model that would fail on
    inputs production never sees.
    """

    def _make(responses: list[Any] | None = None, *, with_contract: bool = True) -> StrictProviderChatModel:
        model = StrictProviderChatModel(responses=list(responses or []))
        return enforce_chat_request_contract(model) if with_contract else model

    return _make
