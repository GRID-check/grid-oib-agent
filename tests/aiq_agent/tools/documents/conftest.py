"""Shared doubles for the filing tools: one working directory, one signed turn.

In ``conftest`` rather than in ``test_filing`` because the wire-contract test
(``test_wire_contract.py``) drives the same tool against the BFF's own JSON
Schema, and a fixture imported from another test module is not a fixture — pytest
resolves them by conftest, not by import.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any

import pytest
from langgraph.store.memory import InMemoryStore

from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.tools.documents import draft_store
from aiq_agent.tools.documents import filing
from aiq_agent.tools.documents import register as filing_tools
from aiq_agent.tools.documents.draft_store import DRAFT_ROOT
from aiq_agent.tools.documents.draft_store import DraftBackend

DRAFT = f"{DRAFT_ROOT}aktenvermerk.md"
BODY = "# Aktenvermerk – Fluchtweg\n\nDie Länge beträgt 42 m.\n"
SECRET = "filing-test-secret"  # noqa: S105 - test fixture value  # pragma: allowlist secret
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
    """The half of NAT's Context these tools read."""

    def __init__(self, headers: dict[str, str], conversation_id: str | None) -> None:
        self.metadata = _Metadata(headers)
        self.conversation_id = conversation_id


@pytest.fixture
def calls() -> list[tuple[dict[str, Any], filing.SignedEnvelope]]:
    return []


@pytest.fixture
def registry() -> Any:
    """A bound card registry, reset with the test."""
    bound = CardRegistry()
    token = set_card_registry(bound)
    yield bound
    reset_card_registry(token)


def _draft_cards(registry: CardRegistry) -> list[dict[str, Any]]:
    return [card for card in registry.snapshot() if card["type"] == "document_draft"]


@pytest.fixture(autouse=True)
def _one_store(monkeypatch: pytest.MonkeyPatch) -> InMemoryStore:
    """One working directory for the whole test, shared by the tool and the assertions."""
    store = InMemoryStore()

    async def _backend(conversation_id: str, dsn: str | None = None) -> DraftBackend:
        return DraftBackend(store=store, conversation_id=conversation_id)

    monkeypatch.setattr(draft_store, "get_draft_backend", _backend)
    monkeypatch.setattr(filing_tools, "get_draft_backend", _backend)
    return store


@pytest.fixture(autouse=True)
def _context(monkeypatch: pytest.MonkeyPatch) -> None:
    """A signed, project-scoped chat turn, as the WS upgrade would leave it."""
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", SECRET)
    _bind_context(
        monkeypatch,
        headers={
            "x-grid-project-id": PROJECT,
            "x-grid-request-context": ENVELOPE_HEADER,
            "x-grid-request-context-sig": ENVELOPE_SIG,
        },
        conversation_id=CONVERSATION,
    )


def _bind_context(monkeypatch: pytest.MonkeyPatch, *, headers: dict[str, str], conversation_id: str | None) -> None:
    import nat.builder.context as nat_context

    context = _Context(headers, conversation_id)
    monkeypatch.setattr(nat_context.Context, "get", staticmethod(lambda: context))


def _responder(responses: list[dict[str, Any]], calls: list) -> Any:
    def _post(payload: dict[str, Any], signed: filing.SignedEnvelope) -> dict[str, Any]:
        calls.append((payload, signed))
        return responses[len(calls) - 1]

    return _post


def _version(version_id: str, state: str, content_hash: str) -> dict[str, Any]:
    return {"id": version_id, "documentId": "doc-1", "state": state, "contentHash": content_hash}


async def _write(store: InMemoryStore, text: str = BODY) -> None:
    backend = DraftBackend(store=store, conversation_id=CONVERSATION)
    result = await backend.awrite(DRAFT, text)
    assert result.error is None


async def _edit(store: InMemoryStore, old: str, new: str) -> None:
    backend = DraftBackend(store=store, conversation_id=CONVERSATION)
    result = await backend.aedit(DRAFT, old, new)
    assert result.error is None


def _stored(store: InMemoryStore) -> dict:
    item = store.get(draft_store.draft_namespace(CONVERSATION), DRAFT)
    assert item is not None
    return item.value


async def _file(monkeypatch: pytest.MonkeyPatch, responses: list[dict], calls: list, title: str = "") -> str:
    monkeypatch.setattr(filing_tools, "post_document_version", _responder(responses, calls))
    return await filing_tools.run_file_draft(DRAFT, title)


async def _submit(monkeypatch: pytest.MonkeyPatch, responses: list[dict], calls: list) -> str:
    monkeypatch.setattr(filing_tools, "post_document_version", _responder(responses, calls))
    return await filing_tools.run_submit_draft(DRAFT)
