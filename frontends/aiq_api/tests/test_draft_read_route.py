"""``GET /v1/drafts/...``: read doors onto the working directory.

The unfiled draft card cannot preview what the model wrote without a route that
exposes the bytes to the browser, so the namespace the ``DELETE`` door sweeps
is also served read-only: ``GET /v1/drafts/{conversation_id}`` lists
``{path, bytes, version}`` without content, and the same URL with ``?path=`` —
or the ``/{path...}`` suffix spelling — returns ``{path, content, version}``
plus ``filing`` once the draft has been filed.

The store is the real ``InMemoryStore`` behind the real ``DraftBackend``,
seeded directly (the way the model writes), because the thing under test is
that the routes expose exactly that namespace: its rows, its version counters,
its filing records — and nothing outside it.
"""

from __future__ import annotations

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from fastapi.testclient import TestClient
from langgraph.store.memory import InMemoryStore

from aiq_agent.tools.documents import draft_store
from aiq_agent.tools.documents.draft_store import DRAFT_ROOT
from aiq_agent.tools.documents.draft_store import FILED_DOCUMENT_KEY
from aiq_agent.tools.documents.draft_store import FILED_HASH_KEY
from aiq_agent.tools.documents.draft_store import FILED_STATE_KEY
from aiq_agent.tools.documents.draft_store import FILED_VERSION_KEY
from aiq_agent.tools.documents.draft_store import MAX_DRAFT_BYTES
from aiq_agent.tools.documents.draft_store import DraftBackend
from aiq_agent.tools.documents.draft_store import draft_namespace
from aiq_api.routes.internal_auth import _DEV_DEFAULT_TOKEN

_TOKEN = "real-internal-secret"
CONVERSATION = "conv-read-1"
OTHER = "conv-read-2"
PATH = f"{DRAFT_ROOT}befund.md"
CONTENT = "# Befund\n\nText.\n"


@pytest.fixture
def store(monkeypatch: pytest.MonkeyPatch) -> InMemoryStore:
    """One store behind the routes and the assertions."""
    memory = InMemoryStore()

    async def _get_store(dsn: str | None = None) -> InMemoryStore:
        return memory

    monkeypatch.setattr(draft_store, "get_draft_store", _get_store)
    return memory


@pytest.fixture
def client(store) -> TestClient:
    from aiq_api.routes.drafts import add_draft_routes

    router = APIRouter()
    add_draft_routes(router)
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def prod_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", _TOKEN)
    monkeypatch.setenv("APP_ENV", "production")


async def _write(store: InMemoryStore, conversation_id: str, name: str, content: str = CONTENT) -> DraftBackend:
    """Seed the way the model writes: through the backend, not around it."""
    backend = DraftBackend(store=store, conversation_id=conversation_id)
    result = await backend.awrite(f"{DRAFT_ROOT}{name}.md", content)
    assert result.error is None
    return backend


def _headers(token: str | None = _TOKEN) -> dict:
    return {} if token is None else {"x-grid-internal-token": token}


def _list(client: TestClient, conversation_id: str = CONVERSATION, token: str | None = _TOKEN):
    return client.get(f"/v1/drafts/{conversation_id}", headers=_headers(token))


def _read(client: TestClient, path: str, conversation_id: str = CONVERSATION, token: str | None = _TOKEN):
    return client.get(f"/v1/drafts/{conversation_id}", params={"path": path}, headers=_headers(token))


def _read_suffix(client: TestClient, path: str, conversation_id: str = CONVERSATION, token: str | None = _TOKEN):
    return client.get(f"/v1/drafts/{conversation_id}/{path.lstrip('/')}", headers=_headers(token))


class TestTheGuard:
    """Internal-token only, failing closed exactly as the delete door does."""

    def test_a_missing_token_is_forbidden_on_the_list(self, client, prod_token) -> None:
        assert _list(client, token=None).status_code == 403

    def test_a_missing_token_is_forbidden_on_the_read(self, client, prod_token) -> None:
        assert _read(client, PATH, token=None).status_code == 403

    def test_a_wrong_token_is_forbidden(self, client, prod_token) -> None:
        assert _list(client, token="nope").status_code == 403
        assert _read(client, PATH, token="nope").status_code == 403

    def test_the_dev_default_outside_a_dev_environment_is_disabled(self, client, monkeypatch) -> None:
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", _DEV_DEFAULT_TOKEN)
        monkeypatch.setenv("APP_ENV", "production")
        assert _list(client).status_code == 503
        assert _read(client, PATH).status_code == 503


class TestTheListing:
    """One conversation's drafts as {path, bytes, version} — and no content."""

    def test_an_empty_namespace_is_a_404(self, client, prod_token) -> None:
        """The 404-means-nothing-to-discard convention, read-side: most
        conversations never wrote a draft, and that is not an error."""
        response = _list(client)
        assert response.status_code == 404

    async def test_one_file_lists_with_path_bytes_and_version(self, client, prod_token, store) -> None:
        await _write(store, CONVERSATION, "befund")

        response = _list(client)

        assert response.status_code == 200
        assert response.json() == {
            "conversation_id": CONVERSATION,
            "drafts": [{"path": PATH, "bytes": len(CONTENT.encode("utf-8")), "version": 1}],
        }

    async def test_the_listing_carries_no_content(self, client, prod_token, store) -> None:
        await _write(store, CONVERSATION, "befund")

        body = _list(client).json()

        assert "content" not in body
        assert all("content" not in entry for entry in body["drafts"])

    async def test_the_version_moves_with_edits(self, client, prod_token, store) -> None:
        backend = await _write(store, CONVERSATION, "befund")
        assert (await backend.aedit(PATH, "Text.", "Text.\n\nMehr.")).error is None

        (entry,) = _list(client).json()["drafts"]

        assert entry["version"] == 2

    async def test_another_conversations_files_are_not_listed(self, client, prod_token, store) -> None:
        # The namespace is the whole of the predicate, read-side too.
        await _write(store, CONVERSATION, "befund")
        await _write(store, OTHER, "protokoll")

        (entry,) = _list(client).json()["drafts"]

        assert entry["path"] == PATH

    async def test_several_files_come_back_sorted(self, client, prod_token, store) -> None:
        await _write(store, CONVERSATION, "protokoll")
        await _write(store, CONVERSATION, "aktenvermerk")
        await _write(store, CONVERSATION, "befund")

        paths = [entry["path"] for entry in _list(client).json()["drafts"]]

        assert paths == sorted(paths)
        assert len(paths) == 3


class TestTheRead:
    """One draft's {path, content, version} — plus filing once it has been filed."""

    async def test_an_existing_file_reads_back_what_was_written(self, client, prod_token, store) -> None:
        await _write(store, CONVERSATION, "befund")

        response = _read(client, PATH)

        assert response.status_code == 200
        assert response.json() == {"path": PATH, "content": CONTENT, "version": 1}

    async def test_an_unfiled_draft_carries_no_filing(self, client, prod_token, store) -> None:
        await _write(store, CONVERSATION, "befund")

        assert "filing" not in _read(client, PATH).json()

    async def test_a_filed_draft_echoes_its_filing_record(self, client, prod_token, store) -> None:
        backend = await _write(store, CONVERSATION, "befund")
        filing = {
            FILED_DOCUMENT_KEY: "doc-1",
            FILED_VERSION_KEY: "ver-1",
            FILED_HASH_KEY: "abc123",
            FILED_STATE_KEY: "open",
        }
        await backend.arecord_filing(PATH, filing)

        response = _read(client, PATH)

        assert response.status_code == 200
        assert response.json()["filing"] == filing

    async def test_a_bare_path_gains_its_leading_slash(self, client, prod_token, store) -> None:
        await _write(store, CONVERSATION, "befund")

        response = _read(client, "entwuerfe/befund.md")

        assert response.status_code == 200
        assert response.json()["path"] == PATH

    async def test_the_suffix_spelling_reads_the_same_file(self, client, prod_token, store) -> None:
        await _write(store, CONVERSATION, "befund")

        response = _read_suffix(client, PATH)

        assert response.status_code == 200
        assert response.json() == {"path": PATH, "content": CONTENT, "version": 1}

    def test_an_unknown_path_is_a_404(self, client, prod_token) -> None:
        assert _read(client, f"{DRAFT_ROOT}gibt-es-nicht.md").status_code == 404

    async def test_a_path_in_another_conversations_namespace_is_a_404(self, client, prod_token, store) -> None:
        await _write(store, OTHER, "befund")

        assert _read(client, PATH).status_code == 404

    def test_an_unknown_conversation_is_a_404(self, client, prod_token) -> None:
        assert _read(client, PATH, conversation_id="conv-never-wrote").status_code == 404

    def test_a_store_failure_is_a_500(self, client, prod_token, monkeypatch) -> None:
        async def _explode(dsn: str | None = None):
            raise RuntimeError("store is down")

        monkeypatch.setattr(draft_store, "get_draft_store", _explode)
        assert _list(client).status_code == 500
        assert _read(client, PATH).status_code == 500


class TestTheRefusals:
    """Traversal and over-size reads are refused, never served and never stored."""

    def test_a_dotdot_conversation_is_refused(self, client, prod_token) -> None:
        assert _list(client, conversation_id="conv..x").status_code == 400

    @pytest.mark.parametrize("path", [f"{DRAFT_ROOT}../secret.md", "/tmp/secret.md", "", "/"])
    def test_a_path_outside_the_working_directory_is_refused(self, client, prod_token, path: str) -> None:
        assert _read(client, path).status_code == 400

    async def test_a_refused_read_writes_nothing(self, client, prod_token, store) -> None:
        assert _read(client, f"{DRAFT_ROOT}../secret.md").status_code == 400
        assert store.search(draft_namespace(CONVERSATION)) == []

    async def test_a_successful_read_changes_nothing(self, client, prod_token, store) -> None:
        await _write(store, CONVERSATION, "befund")

        first = _read(client, PATH).json()
        second = _read(client, PATH).json()
        listing = _list(client).json()

        assert first == second == {"path": PATH, "content": CONTENT, "version": 1}
        assert listing["drafts"] == [{"path": PATH, "bytes": len(CONTENT.encode("utf-8")), "version": 1}]

    async def test_an_oversize_draft_is_a_413_not_a_stream(self, client, prod_token, store) -> None:
        # Unreachable through the backend, which refuses past the same ceiling,
        # so it is placed directly: the route must still refuse to serve it.
        namespace = draft_namespace(CONVERSATION)
        await store.aput(namespace, PATH, {"content": "x" * (MAX_DRAFT_BYTES + 1)})

        assert _read(client, PATH).status_code == 413


class TestAuthRefusedWithoutToken:
    """Read-only does not mean open: no token, no bytes."""

    async def test_an_unauthenticated_list_and_read_answer_403(self, client, prod_token, store) -> None:
        await _write(store, CONVERSATION, "befund")

        assert _list(client, token=None).status_code == 403
        assert _read(client, PATH, token=None).status_code == 403
        assert _read_suffix(client, PATH, token="wrong").status_code == 403
