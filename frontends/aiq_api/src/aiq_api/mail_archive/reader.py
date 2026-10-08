"""Walk an Outlook archive in a fixed order, a page of messages at a time.

**The position is the cursor.** Messages are numbered in one depth-first order
over the mail folders (a folder's own messages, then its subfolders, in the
order the archive stores them). The order depends only on the archive, so a
position the BFF saved in one slice names the same message in the next, on
whichever replica opens the archive. Every item counts, mail or not, so that a
calendar entry skipped today cannot shift the numbers under a retry.

**Only the mail tree is walked.** An archive holds more than the folders a
person sees: search folders, views, and in an ``.ost`` a whole ``Root - Public``
store. The walk starts at the person's folder tree, the ``IPM_SUBTREE`` of the
mailbox when there is one, the single non-system top folder of a ``.pst``
otherwise (``Top of Personal Folders``, under whatever name the Outlook that
wrote it used).

**Not every item is a mail.** Appointments, contacts, tasks and notes are
counted and named but not read: the import is for correspondence.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import UTC
from datetime import datetime

import pypff

from .body_text import BodyText
from .body_text import body_text

#: Message classes read as mail. Everything else is counted and skipped.
MAIL_CLASS_PREFIXES = ("IPM.Note", "IPM.Schedule.Meeting", "IPM.Post", "REPORT.IPM.Note")

#: Top-level folders that are never a person's mail.
_SYSTEM_TOP_FOLDERS = frozenset({"SPAM Search Folder 2", "Search Root", "Root - Public"})

# MAPI property tags this module reads.
_PR_MESSAGE_CLASS = 0x001A
_PR_INTERNET_MESSAGE_ID = 0x1035
_PR_SENDER_EMAIL_ADDRESS = 0x0C1F
_PR_SENDER_SMTP_ADDRESS = 0x5D01
_PR_DISPLAY_NAME = 0x3001
_PR_EMAIL_ADDRESS = 0x3003
_PR_SMTP_ADDRESS = 0x39FE
_PR_RECIPIENT_TYPE = 0x0C15
_PR_ATTACH_METHOD = 0x3705
_PR_ATTACH_FILENAME = 0x3704
_PR_ATTACH_MIME_TAG = 0x370E
_PR_ATTACH_CONTENT_ID = 0x3712
_PR_ATTACH_FLAGS = 0x3714
_PR_ATTACHMENT_HIDDEN = 0x7FFE

_ATTACH_EMBEDDED_MSG = 5
_ATTACH_OLE = 6
_ATT_MHTML_REF = 0x4
_RECIPIENT_TO = 1
_RECIPIENT_CC = 2

# MAPI value types libpff reports for an entry.
_INTEGER_TYPES = frozenset({0x0002, 0x0003, 0x0014})
_STRING_TYPES = frozenset({0x001E, 0x001F})
_BOOLEAN_TYPE = 0x000B


@dataclass(frozen=True)
class Address:
    name: str
    address: str


@dataclass(frozen=True)
class AttachmentInfo:
    index: int
    filename: str
    content_type: str | None
    size: int
    #: Pictures the body shows in place (logos, signatures). Not a document.
    inline: bool
    #: A mail attached to a mail. Not read in this version.
    embedded_message: bool


@dataclass(frozen=True)
class ArchiveMessage:
    position: int
    #: ``mail``, ``other`` or ``unreadable``. An ``other`` carries its class and
    #: nothing else; an ``unreadable`` (a damaged item) carries the damage there.
    kind: str
    message_class: str
    folder_path: tuple[str, ...]
    subject: str = ""
    sender: Address | None = None
    to: tuple[Address, ...] = ()
    cc: tuple[Address, ...] = ()
    sent_at: datetime | None = None
    received_at: datetime | None = None
    message_id: str | None = None
    body: BodyText | None = None
    attachments: tuple[AttachmentInfo, ...] = ()


@dataclass(frozen=True)
class MessagePage:
    messages: tuple[ArchiveMessage, ...]
    #: Where the next page starts; ``None`` once the archive is exhausted.
    next_position: int | None
    total: int


@dataclass(frozen=True)
class _Folder:
    folder: pypff.folder
    path: tuple[str, ...]
    count: int


class ArchiveError(ValueError):
    """The file is not an archive libpff can read, or the position names nothing."""


class AttachmentTooLargeError(ArchiveError):
    """The attachment is larger than the caller will take; its bytes were not read."""


class UnreadableItemError(ArchiveError):
    """One item of a readable archive is damaged. The import skips it and goes on."""


class Archive:
    """An open archive. Not thread-safe; callers hold :attr:`lock`."""

    def __init__(self, handle: pypff.file, source: object | None = None) -> None:
        self._handle = handle
        self._source = source
        self._folders = tuple(_mail_folders(handle.get_root_folder()))
        self.total = sum(entry.count for entry in self._folders)
        self.lock = threading.Lock()

    def page(self, start: int, limit: int) -> MessagePage:
        """Up to ``limit`` messages from ``start`` on."""
        if start < 0 or start > self.total:
            raise ArchiveError(f"position {start} is outside an archive of {self.total} items")
        messages = []
        for position, entry, local in self._from(start):
            if len(messages) >= limit:
                break
            messages.append(self._read_or_skip(entry, local, position))
        end = start + len(messages)
        return MessagePage(messages=tuple(messages), next_position=end if end < self.total else None, total=self.total)

    def attachment(self, position: int, index: int, max_bytes: int) -> tuple[AttachmentInfo, bytes]:
        """The attachment ``index`` of the message at ``position``, with its bytes."""
        message = self._message_at(position)
        if index < 0 or index >= message.number_of_attachments:
            raise ArchiveError(f"message {position} has no attachment {index}")
        try:
            attachment = message.get_attachment(index)
            info = _attachment_info(attachment, index, html="")
        except OSError as error:
            raise self._damaged(error, f"attachment {index} of message {position}") from error
        if info.embedded_message:
            raise ArchiveError(f"attachment {index} of message {position} is a mail, not a file")
        if info.size > max_bytes:
            raise AttachmentTooLargeError(f"attachment {index} of message {position} is {info.size} bytes")
        try:
            return info, attachment.read_buffer(info.size) if info.size else b""
        except OSError as error:
            raise self._damaged(error, f"attachment {index} of message {position}") from error

    def close(self) -> None:
        self._handle.close()

    def _read_or_skip(self, entry: _Folder, local: int, position: int) -> ArchiveMessage:
        """The message, or an ``unreadable`` item when this one message is damaged."""
        try:
            return _read_message(entry.folder.get_sub_message(local), position, entry.path)
        except OSError as error:
            damage = self._damaged(error, f"message {position}")
            return ArchiveMessage(
                position=position, kind="unreadable", message_class=str(damage), folder_path=entry.path
            )

    def _damaged(self, error: OSError, what: str) -> UnreadableItemError:
        """``error`` as damage to ``what``, unless the object store caused it (then that is raised)."""
        remote = getattr(self._source, "last_error", None)
        if remote is not None:
            raise remote from error
        return UnreadableItemError(f"{what} is damaged: {error}")

    def _message_at(self, position: int) -> pypff.message:
        located = next(self._from(position), None) if 0 <= position < self.total else None
        if located is None:
            raise ArchiveError(f"position {position} is outside an archive of {self.total} items")
        _, entry, local = located
        return entry.folder.get_sub_message(local)

    def _from(self, start: int) -> Iterator[tuple[int, _Folder, int]]:
        """(position, folder, index in folder) for every message from ``start`` on."""
        offset = 0
        for entry in self._folders:
            if offset + entry.count <= start:
                offset += entry.count
                continue
            for local in range(max(0, start - offset), entry.count):
                yield offset + local, entry, local
            offset += entry.count


def open_archive(file_object) -> Archive:  # noqa: ANN001 - any seekable binary file
    """Open ``file_object`` as an Outlook archive, or raise :class:`ArchiveError`."""
    handle = pypff.file()
    try:
        handle.open_file_object(file_object)
    except OSError as error:
        remote = getattr(file_object, "last_error", None)
        if remote is not None:
            raise remote from error
        raise ArchiveError(f"not a readable Outlook archive: {error}") from error
    return Archive(handle, source=file_object)


def _mail_folders(root: pypff.folder) -> Iterator[_Folder]:
    base = _mail_root(root)
    yield from _walk(base, ())


def _mail_root(root: pypff.folder) -> pypff.folder:
    """The folder a person's mail tree hangs from (see the module notes)."""
    children = [root.get_sub_folder(i) for i in range(root.number_of_sub_folders)]
    for child in children:
        if child.name == "Root - Mailbox":
            subtree = _child_named(child, "IPM_SUBTREE")
            if subtree is not None:
                return subtree
    personal = [child for child in children if child.name not in _SYSTEM_TOP_FOLDERS]
    return personal[0] if len(personal) == 1 else root


def _child_named(folder: pypff.folder, name: str) -> pypff.folder | None:
    for i in range(folder.number_of_sub_folders):
        child = folder.get_sub_folder(i)
        if child.name == name:
            return child
    return None


def _walk(folder: pypff.folder, path: tuple[str, ...]) -> Iterator[_Folder]:
    yield _Folder(folder=folder, path=path, count=folder.number_of_sub_messages)
    for i in range(folder.number_of_sub_folders):
        child = folder.get_sub_folder(i)
        yield from _walk(child, (*path, child.name or "Ordner"))


def _read_message(message: pypff.message, position: int, path: tuple[str, ...]) -> ArchiveMessage:
    props = _properties(
        message, {_PR_MESSAGE_CLASS, _PR_INTERNET_MESSAGE_ID, _PR_SENDER_EMAIL_ADDRESS, _PR_SENDER_SMTP_ADDRESS}
    )
    message_class = str(props.get(_PR_MESSAGE_CLASS) or "IPM.Note")
    if not message_class.startswith(MAIL_CLASS_PREFIXES):
        return ArchiveMessage(position=position, kind="other", message_class=message_class, folder_path=path)
    to, cc = _recipients(message)
    html = _decode_markup(message.html_body)
    return ArchiveMessage(
        position=position,
        kind="mail",
        message_class=message_class,
        folder_path=path,
        subject=(message.subject or "").strip(),
        sender=_sender(message, props),
        to=to,
        cc=cc,
        sent_at=_utc(message.client_submit_time),
        received_at=_utc(message.delivery_time),
        message_id=_text(props.get(_PR_INTERNET_MESSAGE_ID)),
        body=body_text(message.plain_text_body, message.html_body, _rtf(message)),
        attachments=tuple(
            _attachment_info(message.get_attachment(i), i, html) for i in range(message.number_of_attachments)
        ),
    )


def _sender(message: pypff.message, props: dict[int, object]) -> Address | None:
    address = _smtp(props.get(_PR_SENDER_SMTP_ADDRESS), props.get(_PR_SENDER_EMAIL_ADDRESS))
    name = (message.sender_name or "").strip()
    if not name and not address:
        return None
    return Address(name=name or address, address=address)


def _recipients(message: pypff.message) -> tuple[tuple[Address, ...], tuple[Address, ...]]:
    table = message.recipients
    if table is None:
        return (), ()
    wanted = {_PR_DISPLAY_NAME, _PR_EMAIL_ADDRESS, _PR_SMTP_ADDRESS, _PR_RECIPIENT_TYPE}
    to: list[Address] = []
    cc: list[Address] = []
    for record_set in table.record_sets:
        props = _entries(record_set, wanted)
        address = _smtp(props.get(_PR_SMTP_ADDRESS), props.get(_PR_EMAIL_ADDRESS))
        recipient = Address(name=_text(props.get(_PR_DISPLAY_NAME)) or address, address=address)
        kind = props.get(_PR_RECIPIENT_TYPE)
        if kind == _RECIPIENT_TO:
            to.append(recipient)
        elif kind == _RECIPIENT_CC:
            cc.append(recipient)
    return tuple(to), tuple(cc)


def _attachment_info(attachment: pypff.attachment, index: int, html: str) -> AttachmentInfo:
    props = _properties(
        attachment,
        {
            _PR_ATTACH_METHOD,
            _PR_ATTACH_FILENAME,
            _PR_ATTACH_MIME_TAG,
            _PR_ATTACH_CONTENT_ID,
            _PR_ATTACH_FLAGS,
            _PR_ATTACHMENT_HIDDEN,
        },
    )
    method = props.get(_PR_ATTACH_METHOD)
    content_id = _text(props.get(_PR_ATTACH_CONTENT_ID))
    flags = props.get(_PR_ATTACH_FLAGS)
    referenced = bool(content_id) and f"cid:{content_id}" in html
    mhtml_ref = isinstance(flags, int) and bool(flags & _ATT_MHTML_REF)
    inline = bool(props.get(_PR_ATTACHMENT_HIDDEN)) or referenced or mhtml_ref
    filename = (attachment.long_filename or _text(props.get(_PR_ATTACH_FILENAME)) or "").strip()
    return AttachmentInfo(
        index=index,
        filename=filename or f"Anhang {index + 1}",
        content_type=_text(props.get(_PR_ATTACH_MIME_TAG)),
        size=int(attachment.size or 0),
        inline=inline,
        embedded_message=method in (_ATTACH_EMBEDDED_MSG, _ATTACH_OLE),
    )


def _properties(item: pypff.item, wanted: set[int]) -> dict[int, object]:
    """The first value of each wanted tag across the item's record sets."""
    found: dict[int, object] = {}
    for record_set in item.record_sets:
        for tag, value in _entries(record_set, wanted).items():
            found.setdefault(tag, value)
    return found


def _entries(record_set: pypff.record_set, wanted: set[int]) -> dict[int, object]:
    return {entry.entry_type: _value(entry) for entry in record_set.entries if entry.entry_type in wanted}


def _value(entry: pypff.record_entry) -> object:
    kind = entry.value_type
    if kind in _STRING_TYPES:
        return entry.data_as_string
    if kind in _INTEGER_TYPES:
        return entry.data_as_integer
    if kind == _BOOLEAN_TYPE:
        return entry.data_as_boolean
    return entry.data


def _rtf(message: pypff.message) -> bytes | None:
    """The decompressed RTF body. libpff raises on a malformed one; that body is then absent."""
    try:
        return message.rtf_body
    except OSError:
        return None


def _decode_markup(raw: bytes | None) -> str:
    if not raw:
        return ""
    return raw.decode("utf-8", errors="replace")


def _smtp(*candidates: object) -> str:
    """The first candidate that is an internet address (an Exchange DN is not)."""
    for candidate in candidates:
        text = _text(candidate)
        if text and "@" in text:
            return text
    return ""


def _text(value: object) -> str | None:
    if isinstance(value, str):
        return value.strip() or None
    return None


def _utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)
