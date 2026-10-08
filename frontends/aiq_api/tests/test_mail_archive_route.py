"""The two archive-reading routes: the internal token, the wire shape, and the errors."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import UTC
from datetime import datetime
from urllib.parse import unquote

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from fastapi.testclient import TestClient

from aiq_api.mail_archive.body_text import BodyText
from aiq_api.mail_archive.reader import Address
from aiq_api.mail_archive.reader import ArchiveError
from aiq_api.mail_archive.reader import ArchiveMessage
from aiq_api.mail_archive.reader import AttachmentInfo
from aiq_api.mail_archive.reader import AttachmentTooLargeError
from aiq_api.mail_archive.reader import MessagePage
from aiq_api.mail_archive.reader import UnreadableItemError
from aiq_api.mail_archive.remote_file import RemoteFileError
from aiq_api.routes import mail_archive as route

TOKEN = "test-internal-token"
ARCHIVE = {"key": "org/o1/mail-import/i1/archiv.pst", "url": "http://seaweedfs:8333/x?sig", "size": 1000}

MAIL = ArchiveMessage(
    position=3,
    kind="mail",
    message_class="IPM.Note",
    folder_path=("Posteingang",),
    subject="Plan",
    sender=Address("Anna", "anna@buero.at"),
    to=(Address("Bauamt", "bauamt@wien.gv.at"),),
    sent_at=datetime(2026, 9, 30, 8, 15, tzinfo=UTC),
    body=BodyText(text="Hallo", source="plain", truncated=False),
    attachments=(AttachmentInfo(0, "Grundriss Ä.pdf", "application/pdf", 5, inline=False, embedded_message=False),),
)


class FakeArchive:
    def __init__(self, failure: Exception | None = None) -> None:
        import threading

        self.lock = threading.Lock()
        self.failure = failure

    def page(self, start, limit):
        if self.failure:
            raise self.failure
        other = ArchiveMessage(position=4, kind="other", message_class="IPM.Contact", folder_path=("Kontakte",))
        damaged = ArchiveMessage(position=5, kind="unreadable", message_class="message 5 is damaged", folder_path=())
        return MessagePage(messages=(MAIL, other, damaged), next_position=None, total=6)

    def attachment(self, position, index, max_bytes):
        if self.failure:
            raise self.failure
        return MAIL.attachments[0], b"%PDF-"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", TOKEN)
    holder = {"archive": FakeArchive()}

    @contextmanager
    def use_archive(key, url, size):
        yield holder["archive"]

    monkeypatch.setattr(route, "use_archive", use_archive)
    router = APIRouter()
    route.add_mail_archive_routes(router)
    app = FastAPI()
    app.include_router(router)
    test_client = TestClient(app)
    test_client.holder = holder
    return test_client


def test_the_routes_refuse_a_caller_without_the_internal_token(client):
    response = client.post("/v1/mail-archive/messages", json={"archive": ARCHIVE, "start": 0})
    assert response.status_code == 403


def test_a_page_carries_mail_in_full_and_other_items_by_class(client):
    response = client.post(
        "/v1/mail-archive/messages",
        json={"archive": ARCHIVE, "start": 3, "limit": 2},
        headers={"x-grid-internal-token": TOKEN},
    )

    assert response.status_code == 200
    body = response.json()
    assert (body["total"], body["next_position"]) == (6, None)
    mail, other, damaged = body["messages"]
    assert mail["sender"] == {"name": "Anna", "address": "anna@buero.at"}
    assert mail["sent_at"] == "2026-09-30T08:15:00+00:00"
    assert mail["body"] == {"text": "Hallo", "source": "plain", "truncated": False}
    assert mail["attachments"][0]["filename"] == "Grundriss Ä.pdf"
    assert other == {"position": 4, "kind": "other", "message_class": "IPM.Contact", "folder_path": ["Kontakte"]}
    assert damaged == {
        "position": 5,
        "kind": "unreadable",
        "message_class": "",
        "folder_path": [],
        "detail": "message 5 is damaged",
    }


def test_an_attachment_comes_back_raw_with_its_name_in_a_header(client):
    response = client.post(
        "/v1/mail-archive/attachment",
        json={"archive": ARCHIVE, "position": 3, "index": 0},
        headers={"x-grid-internal-token": TOKEN},
    )

    assert response.status_code == 200
    assert response.content == b"%PDF-"
    assert unquote(response.headers["x-attachment-filename"]) == "Grundriss Ä.pdf"


@pytest.mark.parametrize(
    ("failure", "status"),
    [
        (ArchiveError("not a readable Outlook archive"), 422),
        (AttachmentTooLargeError("too big"), 413),
        (UnreadableItemError("attachment 0 of message 3 is damaged"), 409),
        (RemoteFileError("range answered 403"), 502),
    ],
)
def test_failures_are_answers_the_bff_can_act_on(client, failure, status):
    client.holder["archive"] = FakeArchive(failure)
    response = client.post(
        "/v1/mail-archive/attachment",
        json={"archive": ARCHIVE, "position": 3, "index": 0},
        headers={"x-grid-internal-token": TOKEN},
    )
    assert response.status_code == status
