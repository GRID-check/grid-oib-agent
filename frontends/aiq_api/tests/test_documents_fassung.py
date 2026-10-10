"""The Fassung route: a person confirms (or refuses) that one file replaces another.

``PUT /v1/collections/{collection}/fassung`` is the only writer of ``superseded_by``.
Nothing is merged: the older file stays whole and readable by name. A model reads the
two descriptions for the change line, over the summary gateway and traced as a
``change-summary`` generation; its failure never undoes the link. A refusal lifts
the link and marks Piloti's suggestion dismissed so it is not made again.
"""

import asyncio
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import httpx
import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore
from aiq_agent.knowledge.document_revisions import NO_CHANGE_TEXT
from aiq_agent.knowledge.factory import clear_active_ingestor
from aiq_agent.knowledge.factory import configure_summary_db
from aiq_agent.knowledge.factory import set_active_ingestor
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.knowledge.schema import FileInfo
from aiq_agent.knowledge.schema import FileStatus
from aiq_agent.observability import direct_trace
from aiq_api.routes.documents import _merge_summaries
from aiq_api.routes.documents import add_document_routes

COLLECTION = "proj_a"
OLDER = "Grundriss_EG_Index_B.pdf"
NEWER = "Grundriss_EG_Index_C.pdf"
SUGGESTION = {"of": OLDER, "confidence": 0.9, "reason": "Gleicher Grundriss.", "basis": "name", "dismissed": False}


@pytest.fixture
def summary_db():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite:///{Path(tmpdir) / 'fassung.db'}"
        DocumentMetadataStore._tables_initialized.discard(db_url)
        configure_summary_db(db_url)
        yield db_url
        with DocumentMetadataStore._cache_lock:
            for cache in (DocumentMetadataStore._sync_engine_cache, DocumentMetadataStore._async_engine_cache):
                engine = cache.pop(db_url, (None, None))[0]
                if engine is None:
                    continue
                try:
                    disposed = engine.dispose()
                    if asyncio.iscoroutine(disposed):
                        asyncio.run(disposed)
                except (RuntimeError, OSError):
                    pass


@pytest.fixture
def store(summary_db):
    store = DocumentMetadataStore(summary_db)
    store.register(COLLECTION, OLDER, "Grundriss Erdgeschoss, Stiege im Süden.")
    store.register(COLLECTION, NEWER, "Grundriss Erdgeschoss, Stiege im Norden, neuer Lift.")
    return store


@pytest.fixture
def app(summary_db):
    ingestor = MagicMock()
    ingestor.backend_name = "test"
    set_active_ingestor(ingestor)
    app = FastAPI()
    router = APIRouter()
    add_document_routes(router)
    app.include_router(router)
    yield app
    clear_active_ingestor()


@pytest.fixture(autouse=True)
def _llm_key(monkeypatch):
    monkeypatch.setenv("SUMMARY_LLM_API_KEY", "test-key")  # pragma: allowlist secret


def _client(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _gateway(content: str | None = "- Stiege nach Norden\n- Lift neu", error: Exception | None = None):
    response = MagicMock(spec=httpx.Response)
    response.status_code = 200
    response.raise_for_status = MagicMock()
    response.json.return_value = {"choices": [{"message": {"content": content}}]}
    client = MagicMock()
    client.__aenter__ = AsyncMock(return_value=client)
    client.__aexit__ = AsyncMock(return_value=False)
    client.post = AsyncMock(side_effect=error) if error else AsyncMock(return_value=response)
    return MagicMock(return_value=client), client.post


async def _put(app, body, gateway=None, headers=None):
    fake, _ = gateway or _gateway()
    async with _client(app) as client:
        with patch("httpx.AsyncClient", fake):
            return await client.put(f"/v1/collections/{COLLECTION}/fassung", json=body, headers=headers)


def _docs(store) -> dict[str, AvailableDocument]:
    return {doc.file_name: doc for doc in store.get_all(COLLECTION)}


LINK = {"newer": NEWER, "older": OLDER, "linked": True}
UNLINK = {"newer": NEWER, "older": OLDER, "linked": False}


class TestLinking:
    async def test_a_confirmation_links_the_older_file_and_writes_the_change_line(self, app, store):
        gateway = _gateway("- Stiege nach Norden\n- Lift neu")

        res = await _put(app, LINK, gateway)

        assert res.status_code == 200
        assert res.json() == {
            "superseded_by": NEWER,
            "change_summary": "- Stiege nach Norden\n- Lift neu",
            "change_basis": OLDER,
        }
        docs = _docs(store)
        assert docs[OLDER].superseded_by == NEWER
        assert docs[NEWER].supersedes == [OLDER]
        assert (docs[NEWER].change_summary, docs[NEWER].change_basis) == ("- Stiege nach Norden\n- Lift neu", OLDER)

    async def test_the_model_reads_both_descriptions_and_nothing_is_merged(self, app, store):
        gateway = _gateway()
        await _put(app, LINK, gateway)

        _, post = gateway
        sent = post.call_args.kwargs["json"]["messages"][0]["content"]
        for name in (OLDER, NEWER):
            assert name in sent
        assert "Stiege im Süden" in sent and "neuer Lift" in sent
        # Both files keep their rows and their summaries.
        docs = _docs(store)
        assert docs[OLDER].summary == "Grundriss Erdgeschoss, Stiege im Süden."
        assert docs[NEWER].summary.startswith("Grundriss Erdgeschoss, Stiege im Norden")

    async def test_a_suggestion_that_pointed_at_the_older_file_is_cleared(self, app, store):
        store.set_revision_suggestion(COLLECTION, NEWER, SUGGESTION)

        await _put(app, LINK)

        assert _docs(store)[NEWER].revision_suggestion is None

    async def test_a_suggestion_about_another_file_stays(self, app, store):
        other = {**SUGGESTION, "of": "Anderes.pdf"}
        store.set_revision_suggestion(COLLECTION, NEWER, other)

        await _put(app, LINK)

        assert _docs(store)[NEWER].revision_suggestion == other

    async def test_a_failing_model_leaves_the_link_and_no_change_line(self, app, store):
        res = await _put(app, LINK, _gateway(error=httpx.ConnectError("down")))

        assert res.status_code == 200
        assert res.json() == {"superseded_by": NEWER, "change_summary": None, "change_basis": None}
        assert _docs(store)[OLDER].superseded_by == NEWER

    async def test_a_failing_model_keeps_what_the_newer_file_already_says_about_itself(self, app, store):
        store.set_change_summary(COLLECTION, NEWER, "- Alt, gegenüber dem Upload davor", NEWER)

        res = await _put(app, LINK, _gateway(error=httpx.ConnectError("down")))

        assert res.json()["change_summary"] == "- Alt, gegenüber dem Upload davor"
        assert res.json()["change_basis"] == NEWER

    async def test_an_unreadable_answer_is_no_change_line(self, app, store):
        res = await _put(app, LINK, _gateway("   "))
        assert res.json()["change_summary"] is None
        assert _docs(store)[OLDER].superseded_by == NEWER

    async def test_without_a_gateway_key_the_link_is_still_made(self, app, store, monkeypatch):
        for name in ("SUMMARY_LLM_API_KEY", "LLM_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_KEY"):
            monkeypatch.delenv(name, raising=False)
        gateway = _gateway()

        res = await _put(app, LINK, gateway)

        assert res.json()["superseded_by"] == NEWER
        assert res.json()["change_summary"] is None
        gateway[1].assert_not_called()

    async def test_identical_descriptions_say_so_without_spending_a_call(self, app, summary_db):
        store = DocumentMetadataStore(summary_db)
        store.register(COLLECTION, OLDER, "Derselbe Grundriss.")
        store.register(COLLECTION, NEWER, "Derselbe Grundriss.")
        gateway = _gateway()

        res = await _put(app, LINK, gateway)

        assert res.json()["change_summary"] == NO_CHANGE_TEXT
        gateway[1].assert_not_called()

    async def test_a_later_choice_replaces_an_earlier_link_of_the_same_file(self, app, store):
        store.register(COLLECTION, "Grundriss_EG_Index_D.pdf", "Grundriss EG, Index D.")
        await _put(app, LINK)

        await _put(app, {"newer": "Grundriss_EG_Index_D.pdf", "older": OLDER, "linked": True})

        docs = _docs(store)
        assert docs[OLDER].superseded_by == "Grundriss_EG_Index_D.pdf"
        assert docs[NEWER].supersedes is None

    async def test_the_call_queues_for_an_interactive_provider_slot(self, app, store):
        from aiq_agent.common import provider_limiter

        fake, post = _gateway()
        with patch("aiq_api.routes.documents.limited_async_http_client", fake):
            async with _client(app) as client:
                await client.put(f"/v1/collections/{COLLECTION}/fassung", json=LINK)

        assert fake.call_args.kwargs["cls"] == provider_limiter.INTERACTIVE
        post.assert_called_once()

    async def test_the_organization_header_reaches_the_credential_resolution(self, app, store):
        with patch("aiq_api.routes.documents._llm_settings") as settings:
            settings.return_value = MagicMock(api_key="")
            await _put(app, LINK, headers={"x-grid-organization-id": "org_1"})
        settings.assert_called_once_with("org_1")


class TestRefusing:
    async def test_it_lifts_a_link_and_drops_the_change_line_written_against_it(self, app, store):
        store.set_superseded_by(COLLECTION, OLDER, NEWER)
        store.set_change_summary(COLLECTION, NEWER, "- Lift neu", OLDER)
        gateway = _gateway()

        res = await _put(app, UNLINK, gateway)

        assert res.status_code == 200
        assert res.json() == {"superseded_by": None, "change_summary": None, "change_basis": None}
        docs = _docs(store)
        assert docs[OLDER].superseded_by is None
        assert docs[NEWER].supersedes is None
        assert docs[NEWER].change_summary is None
        gateway[1].assert_not_called()

    async def test_a_change_line_against_another_file_is_kept(self, app, store):
        store.set_superseded_by(COLLECTION, OLDER, NEWER)
        store.set_change_summary(COLLECTION, NEWER, "- Gegenüber dem Upload davor", NEWER)

        res = await _put(app, UNLINK)

        assert res.json()["change_summary"] == "- Gegenüber dem Upload davor"
        assert _docs(store)[NEWER].change_summary == "- Gegenüber dem Upload davor"

    async def test_a_link_to_a_third_file_is_not_touched_by_refusing_this_pair(self, app, store):
        store.register(COLLECTION, "Grundriss_EG_Index_D.pdf", "Index D.")
        store.set_superseded_by(COLLECTION, OLDER, "Grundriss_EG_Index_D.pdf")

        res = await _put(app, UNLINK)

        assert res.json()["superseded_by"] == "Grundriss_EG_Index_D.pdf"
        assert _docs(store)[OLDER].superseded_by == "Grundriss_EG_Index_D.pdf"

    async def test_it_marks_the_suggestion_dismissed_and_keeps_its_facts(self, app, store):
        store.set_revision_suggestion(COLLECTION, NEWER, SUGGESTION)

        await _put(app, UNLINK)

        assert _docs(store)[NEWER].revision_suggestion == {**SUGGESTION, "dismissed": True}

    async def test_a_refusal_with_no_stored_suggestion_is_remembered_all_the_same(self, app, store):
        # The suggestion came from the file names and lived only in the UI.
        await _put(app, UNLINK)

        suggestion = _docs(store)[NEWER].revision_suggestion
        assert suggestion["of"] == OLDER and suggestion["dismissed"] is True

    async def test_a_suggestion_about_another_file_is_left_alone(self, app, store):
        other = {**SUGGESTION, "of": "Anderes.pdf"}
        store.set_revision_suggestion(COLLECTION, NEWER, other)

        await _put(app, UNLINK)

        assert _docs(store)[NEWER].revision_suggestion == other

    async def test_a_dismissed_suggestion_is_not_offered_in_the_listing(self, app, store):
        await _put(app, UNLINK)
        files = [_file(OLDER), _file(NEWER)]

        _merge_summaries(files, store.get_all(COLLECTION))

        assert files[1].revision_suggestion is None


class TestValidation:
    async def test_a_file_cannot_replace_itself(self, app, store):
        res = await _put(app, {"newer": NEWER, "older": NEWER, "linked": True})
        assert res.status_code == 400
        assert _docs(store)[NEWER].superseded_by is None

    @pytest.mark.parametrize("which", ["newer", "older"])
    async def test_a_file_that_is_not_in_the_collection_is_404(self, app, store, which):
        res = await _put(app, {**LINK, which: "Gespenst.pdf"})
        assert res.status_code == 404
        assert "Gespenst.pdf" in res.json()["detail"]
        assert _docs(store)[OLDER].superseded_by is None

    async def test_a_file_of_another_collection_is_not_in_this_one(self, app, store):
        store.register("proj_b", "Fremd.pdf", "Ein Dokument eines anderen Projekts.")
        res = await _put(app, {**LINK, "older": "Fremd.pdf"})
        assert res.status_code == 404

    async def test_the_same_pair_the_other_way_round_is_a_loop(self, app, store):
        await _put(app, LINK)

        res = await _put(app, {"newer": OLDER, "older": NEWER, "linked": True})

        assert res.status_code == 409
        assert _docs(store)[NEWER].superseded_by is None

    async def test_a_loop_through_a_third_file_is_refused_too(self, app, store):
        store.register(COLLECTION, "C3.pdf", "Dritter Stand.")
        store.set_superseded_by(COLLECTION, NEWER, "C3.pdf")
        await _put(app, LINK)

        res = await _put(app, {"newer": OLDER, "older": "C3.pdf", "linked": True})

        assert res.status_code == 409

    @pytest.mark.parametrize(
        "body",
        [
            {**LINK, "extra": "x"},
            {"newer": NEWER, "older": OLDER},
            {"newer": "", "older": OLDER, "linked": True},
            {"newer": NEWER, "older": "", "linked": True},
            {"newer": NEWER, "older": OLDER, "linked": "yes please"},
        ],
    )
    async def test_a_malformed_body_is_422(self, app, store, body):
        assert (await _put(app, body)).status_code == 422


def _file(name: str) -> FileInfo:
    return FileInfo(file_id=name, file_name=name, collection_name=COLLECTION, status=FileStatus.SUCCESS)


class TestThePayloadTheBffGets:
    def _merged(self, docs: list[AvailableDocument]) -> dict[str, FileInfo]:
        files = [_file(doc.file_name) for doc in docs]
        _merge_summaries(files, docs)
        return {file.file_name: file for file in files}

    def test_the_link_and_its_reverse_ride_the_listing(self):
        merged = self._merged(
            [
                AvailableDocument(file_name=OLDER, superseded_by=NEWER),
                AvailableDocument(file_name=NEWER, supersedes=[OLDER]),
            ]
        )
        assert merged[OLDER].superseded_by == NEWER and merged[OLDER].supersedes is None
        assert merged[NEWER].supersedes == [OLDER] and merged[NEWER].superseded_by is None

    def test_the_change_line_travels_with_the_file_it_compared_against(self):
        merged = self._merged([AvailableDocument(file_name=NEWER, change_summary="- Lift neu", change_basis=OLDER)])
        assert (merged[NEWER].change_summary, merged[NEWER].change_basis) == ("- Lift neu", OLDER)

    def test_an_open_suggestion_travels_as_four_keys_never_the_dismissed_flag(self):
        merged = self._merged(
            [
                AvailableDocument(file_name=OLDER),
                AvailableDocument(file_name=NEWER, revision_suggestion=SUGGESTION),
            ]
        )
        assert merged[NEWER].revision_suggestion == {
            "of": OLDER,
            "confidence": 0.9,
            "reason": "Gleicher Grundriss.",
            "basis": "name",
        }

    @pytest.mark.parametrize(
        "suggestion, extra",
        [
            ({**SUGGESTION, "dismissed": True}, {}),
            ({**SUGGESTION, "of": "Gespenst.pdf"}, {}),
            (SUGGESTION, {"supersedes": [OLDER]}),
        ],
        ids=["dismissed", "older file is gone", "already replaces it"],
    )
    def test_a_suggestion_with_nothing_to_offer_is_not_sent(self, suggestion, extra):
        merged = self._merged(
            [
                AvailableDocument(file_name=OLDER),
                AvailableDocument(file_name=NEWER, revision_suggestion=suggestion, **extra),
            ]
        )
        assert merged[NEWER].revision_suggestion is None

    def test_a_suggestion_about_a_file_a_person_already_replaced_is_not_sent(self):
        merged = self._merged(
            [
                AvailableDocument(file_name=OLDER, superseded_by="Dritter.pdf"),
                AvailableDocument(file_name="Dritter.pdf", supersedes=[OLDER]),
                AvailableDocument(file_name=NEWER, revision_suggestion=SUGGESTION),
            ]
        )
        assert merged[NEWER].revision_suggestion is None

    def test_a_file_with_none_of_it_has_none_of_it(self):
        merged = self._merged([AvailableDocument(file_name=NEWER, summary="x")])
        file = merged[NEWER]
        assert file.superseded_by is None and file.supersedes is None
        assert file.revision_suggestion is None and file.change_summary is None and file.change_basis is None

    def test_what_the_file_list_already_holds_is_not_overwritten(self):
        file = _file(NEWER)
        file.change_summary, file.change_basis = "- schon da", OLDER
        _merge_summaries([file], [AvailableDocument(file_name=NEWER, change_summary="- Store", change_basis="x.pdf")])
        assert (file.change_summary, file.change_basis) == ("- schon da", OLDER)


class TestTheChangeCallIsTraced:
    @pytest.fixture
    def exporter(self):
        direct_trace.reset_tracer_provider()
        memory = InMemorySpanExporter()
        direct_trace.install_tracer_provider(None, env={}, exporter=memory)
        yield memory
        direct_trace.reset_tracer_provider()

    async def test_the_route_call_is_a_change_summary_generation_with_usage(self, app, store, exporter):
        response = MagicMock(spec=httpx.Response)
        response.raise_for_status = MagicMock()
        response.json.return_value = {
            "choices": [{"message": {"content": "- Lift neu"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 40, "completion_tokens": 6, "total_tokens": 46},
        }
        client = MagicMock()
        client.__aenter__ = AsyncMock(return_value=client)
        client.__aexit__ = AsyncMock(return_value=False)
        client.post = AsyncMock(return_value=response)

        async with _client(app) as http:
            with patch("httpx.AsyncClient", MagicMock(return_value=client)):
                await http.put(f"/v1/collections/{COLLECTION}/fassung", json=LINK)

        direct_trace._provider.force_flush()
        (span,) = exporter.get_finished_spans()
        assert span.attributes["langfuse.trace.name"] == "change-summary"
        assert span.attributes["langfuse.observation.type"] == "generation"
        assert span.attributes["gen_ai.usage.input_tokens"] == 40

    async def test_a_refusal_makes_no_model_call_and_so_no_generation(self, app, store, exporter):
        await _put(app, UNLINK)
        direct_trace._provider.force_flush()
        assert exporter.get_finished_spans() == ()
