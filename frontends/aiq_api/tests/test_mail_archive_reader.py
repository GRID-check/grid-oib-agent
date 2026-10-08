"""The archive walk: positions, the mail tree, and what a message reads as.

Most cases run over stand-ins for libpff's objects, so the order and the paging
are pinned without a binary fixture in the repository. The last test reads real
archives when ``GRID_PST_FIXTURE_DIR`` names a directory of them (the
pst-extractor corpus is what ADR-0085's spike used): a check of libpff itself,
run by hand when its version moves.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from pathlib import Path

import pytest

from aiq_api.mail_archive import reader
from aiq_api.mail_archive.reader import Archive
from aiq_api.mail_archive.reader import ArchiveError
from aiq_api.mail_archive.reader import AttachmentTooLargeError

UNICODE = 0x001F
INT32 = 0x0003
BOOLEAN = 0x000B


@dataclass
class Entry:
    entry_type: int
    value_type: int
    value: object

    @property
    def data_as_string(self):
        return self.value

    @property
    def data_as_integer(self):
        return self.value

    @property
    def data_as_boolean(self):
        return self.value

    @property
    def data(self):
        return self.value


@dataclass
class RecordSet:
    entries: list[Entry]


def props(**tags: tuple[int, object]) -> list[RecordSet]:
    return [RecordSet([Entry(int(tag[1:], 16), kind, value) for tag, (kind, value) in tags.items()])]


@dataclass
class Attachment:
    long_filename: str | None
    payload: bytes = b""
    record_sets: list[RecordSet] = field(default_factory=list)

    @property
    def size(self):
        return len(self.payload)

    def read_buffer(self, size):
        return self.payload[:size]


@dataclass
class Recipients:
    record_sets: list[RecordSet]


@dataclass
class Message:
    subject: str
    message_class: str = "IPM.Note"
    sender_name: str = "Anna Berger"
    plain_text_body: bytes | None = b"Hallo"
    html_body: bytes | None = None
    rtf_body: bytes | None = None
    client_submit_time: datetime | None = datetime(2026, 9, 30, 8, 15)
    delivery_time: datetime | None = datetime(2026, 9, 30, 8, 16)
    attachments: list[Attachment] = field(default_factory=list)
    recipients: Recipients | None = None

    @property
    def record_sets(self):
        return props(x001A=(UNICODE, self.message_class), x5D01=(UNICODE, "anna@buero.at"))

    @property
    def number_of_attachments(self):
        return len(self.attachments)

    def get_attachment(self, index):
        return self.attachments[index]


@dataclass
class Folder:
    name: str | None
    messages: list[Message] = field(default_factory=list)
    folders: list[Folder] = field(default_factory=list)

    @property
    def number_of_sub_messages(self):
        return len(self.messages)

    def get_sub_message(self, index):
        return self.messages[index]

    @property
    def number_of_sub_folders(self):
        return len(self.folders)

    def get_sub_folder(self, index):
        return self.folders[index]


class Handle:
    def __init__(self, root: Folder) -> None:
        self.root = root

    def get_root_folder(self):
        return self.root

    def close(self):
        pass


def pst(*top: Folder) -> Archive:
    root = Folder(
        None,
        folders=[
            Folder("SPAM Search Folder 2"),
            Folder("Top of Personal Folders", folders=list(top)),
            Folder("Search Root"),
        ],
    )
    return Archive(Handle(root))


def test_positions_run_depth_first_over_the_personal_tree_only():
    archive = pst(
        Folder("Posteingang", [Message("a"), Message("b")], [Folder("Behörde", [Message("c")])]),
        Folder("Gesendet", [Message("d")]),
    )

    page = archive.page(0, 10)
    assert archive.total == 4
    assert [(m.position, m.subject, m.folder_path) for m in page.messages] == [
        (0, "a", ("Posteingang",)),
        (1, "b", ("Posteingang",)),
        (2, "c", ("Posteingang", "Behörde")),
        (3, "d", ("Gesendet",)),
    ]
    assert page.next_position is None


def test_a_page_resumes_exactly_where_the_last_one_stopped():
    archive = pst(Folder("Posteingang", [Message(str(i)) for i in range(5)]), Folder("Gesendet", [Message("x")]))

    first = archive.page(0, 4)
    second = archive.page(first.next_position, 4)
    assert first.next_position == 4
    assert [m.subject for m in second.messages] == ["4", "x"]
    assert second.next_position is None


def test_an_ost_walks_the_mailbox_ipm_subtree():
    inbox = Folder("Inbox", [Message("mail")])
    root = Folder(
        None,
        folders=[
            Folder("Root - Public", folders=[Folder("IPM_SUBTREE", [Message("public")])]),
            Folder(
                "Root - Mailbox", folders=[Folder("Finder", [Message("search")]), Folder("IPM_SUBTREE", [], [inbox])]
            ),
        ],
    )

    page = Archive(Handle(root)).page(0, 10)
    assert [(m.subject, m.folder_path) for m in page.messages] == [("mail", ("Inbox",))]


def test_an_appointment_is_counted_and_not_read():
    archive = pst(Folder("Kalender", [Message("Termin", message_class="IPM.Appointment"), Message("Mail")]))

    first, second = archive.page(0, 10).messages
    assert (first.kind, first.message_class, first.subject, first.body) == ("other", "IPM.Appointment", "", None)
    assert (second.kind, second.position) == ("mail", 1)


def test_a_mail_reads_its_headers_recipients_and_attachments():
    message = Message(
        "Brandschutzplan",
        html_body=b'<p>Siehe Plan</p><img src="cid:logo@x">',
        plain_text_body=None,
        recipients=Recipients(
            [
                *props(x3001=(UNICODE, "Bauamt"), x39FE=(UNICODE, "bauamt@wien.gv.at"), x0C15=(INT32, 1)),
                *props(x3001=(UNICODE, "Kollege"), x3003=(UNICODE, "/O=EXCHANGE/CN=K"), x0C15=(INT32, 2)),
            ]
        ),
        attachments=[
            Attachment("Plan.pdf", b"%PDF-1.7", props(x3705=(INT32, 1), x370E=(UNICODE, "application/pdf"))),
            Attachment("logo.png", b"\x89PNG", props(x3705=(INT32, 1), x3712=(UNICODE, "logo@x"))),
            Attachment("Weitergeleitet", b"", props(x3705=(INT32, 5))),
        ],
    )

    mail = pst(Folder("Posteingang", [message])).page(0, 1).messages[0]
    assert mail.sender == reader.Address(name="Anna Berger", address="anna@buero.at")
    assert mail.to == (reader.Address(name="Bauamt", address="bauamt@wien.gv.at"),)
    # An Exchange DN is not an address; the name stays, the address is empty.
    assert mail.cc == (reader.Address(name="Kollege", address=""),)
    assert mail.sent_at.isoformat() == "2026-09-30T08:15:00+00:00"
    assert (mail.body.source, mail.body.text) == ("html", "Siehe Plan")
    pdf, logo, forwarded = mail.attachments
    assert (pdf.filename, pdf.content_type, pdf.size, pdf.inline) == ("Plan.pdf", "application/pdf", 8, False)
    assert logo.inline is True
    assert forwarded.embedded_message is True


def test_an_attachment_is_read_by_position_and_index_and_bounded():
    archive = pst(Folder("Posteingang", [Message("a"), Message("b", attachments=[Attachment(None, b"bytes!")])]))

    info, data = archive.attachment(1, 0, max_bytes=100)
    assert (info.filename, data) == ("Anhang 1", b"bytes!")
    with pytest.raises(AttachmentTooLargeError):
        archive.attachment(1, 0, max_bytes=3)
    with pytest.raises(ArchiveError):
        archive.attachment(0, 0, max_bytes=100)
    with pytest.raises(ArchiveError):
        archive.attachment(2, 0, max_bytes=100)


def test_a_position_past_the_end_is_refused():
    with pytest.raises(ArchiveError):
        pst(Folder("Posteingang", [Message("a")])).page(2, 10)


FIXTURES = os.environ.get("GRID_PST_FIXTURE_DIR")


@pytest.mark.skipif(not FIXTURES, reason="GRID_PST_FIXTURE_DIR names no directory of real archives")
def test_real_archives_page_through_completely():
    for path in sorted(Path(FIXTURES).glob("*.[po]st")):
        with path.open("rb") as file:
            archive = reader.open_archive(file)
            position, seen = 0, 0
            while position is not None:
                page = archive.page(position, 50)
                seen += len(page.messages)
                position = page.next_position
            assert seen == archive.total, path.name
