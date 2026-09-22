"""One signed, project-scoped turn for the delegation tool.

The HTTP call is the only thing mocked. The request context, the card registry
and the tool itself are the real ones, because what is under test is the seam:
that the SIGNED bytes leave unchanged, and that a run with no acting person
delegates nothing at all.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any

import pytest

from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.tools.documents.filing import SignedEnvelope
from aiq_agent.tools.tasks import client as task_client
from aiq_agent.tools.tasks import register as task_tools

SECRET = "tasks-test-secret"  # noqa: S105 - test fixture value  # pragma: allowlist secret
CONVERSATION = "conv-1"
PROJECT = "3f8b0d2e-0000-4000-8000-000000000001"


def envelope(payload: dict[str, Any]) -> tuple[str, str]:
    """The BFF's own encoding: base64url(JSON) plus the hex HMAC of the raw JSON."""
    raw = json.dumps(payload)
    header = base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")
    signature = hmac.new(SECRET.encode("utf-8"), raw.encode("utf-8"), hashlib.sha256).hexdigest()
    return header, signature


ENVELOPE_HEADER, ENVELOPE_SIG = envelope(
    {
        "organizationId": "org_1",
        "userId": "user_1",
        "projectId": PROJECT,
        "conversationId": CONVERSATION,
        "issuedAt": 1_757_500_000_000,
    }
)


class _Metadata:
    def __init__(self, headers: dict[str, str]) -> None:
        self.headers = headers


class _Context:
    """The half of NAT's Context this tool reads."""

    def __init__(self, headers: dict[str, str], conversation_id: str | None) -> None:
        self.metadata = _Metadata(headers)
        self.conversation_id = conversation_id


def bind_context(monkeypatch: pytest.MonkeyPatch, *, headers: dict[str, str], conversation_id: str | None) -> None:
    import nat.builder.context as nat_context

    context = _Context(headers, conversation_id)
    monkeypatch.setattr(nat_context.Context, "get", staticmethod(lambda: context))


@pytest.fixture
def calls() -> list[tuple[dict[str, Any], SignedEnvelope]]:
    return []


@pytest.fixture
def registry() -> Any:
    bound = CardRegistry()
    token = set_card_registry(bound)
    yield bound
    reset_card_registry(token)


@pytest.fixture(autouse=True)
def _context(monkeypatch: pytest.MonkeyPatch) -> None:
    """A signed, project-scoped chat turn, as the WS upgrade would leave it."""
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", SECRET)
    bind_context(
        monkeypatch,
        headers={
            "x-grid-project-id": PROJECT,
            "x-grid-request-context": ENVELOPE_HEADER,
            "x-grid-request-context-sig": ENVELOPE_SIG,
        },
        conversation_id=CONVERSATION,
    )


def responder(
    monkeypatch: pytest.MonkeyPatch,
    body: dict[str, Any],
    calls: list[tuple[dict[str, Any], SignedEnvelope]],
) -> None:
    """Record what the tool posts and answer with ``body``."""

    def _post(payload: dict[str, Any], envelope_arg: SignedEnvelope) -> dict[str, Any]:
        calls.append((payload, envelope_arg))
        return body

    monkeypatch.setattr(task_tools, "post_task", _post)


def raiser(monkeypatch: pytest.MonkeyPatch, error: Exception) -> None:
    def _post(payload: dict[str, Any], envelope_arg: SignedEnvelope) -> dict[str, Any]:
        raise error

    monkeypatch.setattr(task_tools, "post_task", _post)


def task_cards(registry: CardRegistry) -> list[dict[str, Any]]:
    return [card for card in registry.snapshot() if card["type"] == "task_created"]


ACCEPTED = {
    "taskId": "task-1",
    "kind": "einreichcheck",
    "title": "Einreichcheck: Bauansuchen Haus A",
    "status": "running",
    "conversationId": "s_conv_2",
    "dueAt": "2026-09-18T23:59:59.999Z",
}

__all__ = [
    "ACCEPTED",
    "CONVERSATION",
    "ENVELOPE_HEADER",
    "ENVELOPE_SIG",
    "PROJECT",
    "SECRET",
    "bind_context",
    "envelope",
    "raiser",
    "responder",
    "task_client",
    "task_cards",
]
