"""`POST /v1/ingest` carries what a filed mail says about the document (ADR-0134).

A filed E-Mail-Verlauf arrives with `mail_thread`: the route stamps the job's `source_format`
(the chunks' lane, `project_mail`) and hands the record to the job, which stores it on the
metadata row. A file a person filed from a mail arrives with `mail_origin`: the message it came
with, which `list_files` and `read_passage` print. Neither carries an address, and the route
refuses one before a job exists, as it refuses a key it does not know.
"""

from typing import get_args
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from httpx import ASGITransport
from httpx import AsyncClient

from aiq_agent.knowledge.factory import clear_active_ingestor
from aiq_agent.knowledge.factory import set_active_ingestor
from aiq_agent.knowledge.mail_facts import MAIL_LOCALES
from aiq_agent.knowledge.mail_facts import SENDER_TRUSTS
from aiq_agent.knowledge.mail_facts import normalise_mail_origin
from aiq_agent.knowledge.mail_facts import normalise_mail_thread
from aiq_api.models.requests import MailLocale
from aiq_api.models.requests import SenderTrust
from aiq_api.routes.ingest import add_ingest_routes

BODY = {
    "file_ref": "http://seaweedfs.test/bucket/Verlauf.md?X-Amz-Signature=abc",
    "collection": "proj_test123",
    "document_id": "doc-1",
}
THREAD = {"latest_sent_at": "2026-05-14T14:40:00Z", "message_count": 5, "locale": "de"}
ORIGIN = {
    "sent_at": "2026-05-04T06:30:00Z",
    "received_at": "2026-05-04T06:31:00Z",
    "from_name": "Ing. Paul Gruber",
    "from_domain": "verkehrsplanung-gruber.at",
    "signer_domain": "verkehrsplanung-gruber.at",
    "sender_trust": "external_verified",
    "thread_document_id": "6d1f0c4e-2b1a-4c3e-9a51-0000000000a0",
}


@pytest.fixture
def mock_ingestor():
    ingestor = MagicMock()
    ingestor.backend_name = "test"
    ingestor.submit_job.return_value = "job_mail_1"
    set_active_ingestor(ingestor)
    yield ingestor
    clear_active_ingestor()


@pytest.fixture
def app(mock_ingestor, monkeypatch):
    monkeypatch.setenv("SEAWEED_PUBLIC_ENDPOINT", "http://seaweedfs.test")
    monkeypatch.setenv("SEAWEED_ENDPOINT", "http://seaweedfs.test")
    app = FastAPI()
    router = APIRouter()
    add_ingest_routes(router)
    app.include_router(router)
    return app


async def _ingest(app, body: dict) -> httpx.Response:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        return await client.post("/v1/ingest", json=body)


def _config(mock_ingestor) -> dict:
    return mock_ingestor.submit_job.call_args.kwargs["config"]


@pytest.mark.asyncio
async def test_a_verlauf_is_stamped_as_mail_and_carries_its_newest_message(app, mock_ingestor):
    response = await _ingest(app, {**BODY, "mail_thread": THREAD})

    assert response.status_code == 202
    config = _config(mock_ingestor)
    assert config["source_format"] == "mail"
    assert normalise_mail_thread(config["mail_thread"]) == THREAD
    assert "mail_origin" not in config


@pytest.mark.asyncio
async def test_an_attachment_carries_the_message_it_came_with(app, mock_ingestor):
    response = await _ingest(app, {**BODY, "mail_origin": ORIGIN})

    assert response.status_code == 202
    config = _config(mock_ingestor)
    assert normalise_mail_origin(config["mail_origin"]) == {**ORIGIN, "locale": "de"}
    assert "source_format" not in config and "mail_thread" not in config


@pytest.mark.asyncio
async def test_a_document_that_came_by_no_mail_carries_neither(app, mock_ingestor):
    response = await _ingest(app, BODY)

    assert response.status_code == 202
    assert not {"source_format", "mail_thread", "mail_origin"} & set(_config(mock_ingestor))


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body",
    [
        # An address is never sent: not as a name, not under a key of its own.
        {"mail_origin": {**ORIGIN, "from_name": "gruber@verkehrsplanung-gruber.at"}},
        {"mail_origin": {**ORIGIN, "from_address": "gruber@verkehrsplanung-gruber.at"}},
        {"mail_origin": {**ORIGIN, "sender_trust": "verified"}},
        {"mail_origin": {**ORIGIN, "sent_at": "2026-05-04T06:30:00"}},  # no offset: whose clock?
        {"mail_thread": {**THREAD, "message_count": 0}},
        {"mail_thread": {**THREAD, "locale": "fr"}},
        # A Verlauf IS the mails; an attachment came WITH one.
        {"mail_thread": THREAD, "mail_origin": ORIGIN},
    ],
)
async def test_what_cannot_be_stored_honestly_is_refused_before_a_job_exists(app, mock_ingestor, body):
    response = await _ingest(app, {**BODY, **body})

    assert response.status_code == 422
    mock_ingestor.submit_job.assert_not_called()


def test_the_wire_vocabulary_is_the_stores():
    """The route's literals are spelled out; the store's tuples are the source."""
    assert get_args(SenderTrust) == SENDER_TRUSTS
    assert get_args(MailLocale) == MAIL_LOCALES
