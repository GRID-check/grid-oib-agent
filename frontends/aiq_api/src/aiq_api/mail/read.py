"""Read one raw message (RFC 5322 bytes) into a :class:`~.models.MailRead`.

:func:`read_message` is the whole reading, synchronous and total: whatever the
bytes are, it returns a ``MailRead``, and a part it could not read is named in
``unreadable_reasons`` rather than raised.

:func:`read_message_within` is how the route runs it: in a child process
(``python -I -m aiq_api.mail.read``, the bytes on stdin, the JSON on stdout),
under a deadline (:data:`~.limits.READ_TIMEOUT_SECONDS`), at most
:data:`~.limits.MAX_CONCURRENT_READS` at a time. A thread would not do. The
caps bound each parser's input, but not every parser's worst case on it:
``mail-parser-reply``'s German "Am … schrieb …:" pattern is cubic in a line
that repeats "schrieb" (a 3,000-character line took 64 s; found by the seeded
mutation loop in ``tests/mail/test_hostile.py``), and ``asyncio.wait_for``
over a thread only stops waiting: the CPU keeps burning in the process that
also serves people's requests. A child is killed at the deadline, whatever
parser it is stuck in, and the read is ``unreadable`` (``timeout``). It
starts with an empty environment, so no secret of the API process is in
reach of the stranger's bytes. ``multiprocessing`` was tried first and left:
its ``spawn`` and ``forkserver`` children re-import the parent's ``__main__``
(NAT's CLI here), and ``fork`` copies a process full of threads.

The body is chosen as the archive does it, plain before HTML before RTF
(:mod:`.body_text`), from the parts Python's ``email`` package names as the
body (``get_body``: the alternatives of the message, not its attachments, not a
forwarded message inside it). ``format=flowed`` plain text (RFC 3676) is
unwrapped first, so a paragraph is one line again. Calendar parts are read
wherever they are in the message, except inside a forwarded one, and an event
Outlook sends twice (inline and as ``invite.ics``) is kept once.

What the bytes are made of beyond the body (headers, the sender's
authentication, the attachments) is the BFF's to read; nothing here looks at it.
No log line carries a byte of the message.
"""

from __future__ import annotations

import asyncio
import codecs
import logging
import sys
from collections.abc import Iterator
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser

from pydantic import ValidationError

from . import limits
from .body_text import body_text
from .body_text import decode
from .calendar import calendar_events
from .models import CalendarEvent
from .models import MailRead
from .models import QuotedBlock
from .models import UnreadableReason
from .replies import split_replies

logger = logging.getLogger(__name__)

#: Content types a calendar invitation comes as.
CALENDAR_TYPES = frozenset({"text/calendar", "application/ics"})
#: Content types of an RTF body.
RTF_TYPES = frozenset({"text/rtf", "application/rtf"})
#: Content types whose body cannot be read without a key this tier never has.
ENCRYPTED_TYPES = frozenset({"multipart/encrypted", "application/pkcs7-mime", "application/x-pkcs7-mime"})

#: Charsets a mail client declares for text that is often UTF-8 or Windows-1252
#: in fact; their bytes are decoded as :func:`~.body_text.decode` does it.
_LOOSE_CHARSETS = frozenset({"us-ascii", "ascii", "iso-8859-1", "latin-1", "latin1", "iso8859-1"})

#: The longest quoted header kept, in characters.
_MAX_HEADER_CHARS = 4096


_slots: asyncio.Semaphore | None = None


async def read_message_within(raw: bytes, timeout: float = limits.READ_TIMEOUT_SECONDS) -> MailRead:
    """:func:`read_message` in a child process; ``unreadable`` (timeout) past ``timeout`` seconds."""
    global _slots
    if _slots is None:
        _slots = asyncio.Semaphore(limits.MAX_CONCURRENT_READS)
    async with _slots:
        process = await asyncio.create_subprocess_exec(
            sys.executable,
            "-I",
            "-m",
            __name__,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            env={},
        )
        try:
            output, _ = await asyncio.wait_for(process.communicate(raw), timeout=timeout)
        except TimeoutError:
            logger.warning("mail read: stopped after %.0f s (%d bytes)", timeout, len(raw))
            return MailRead.unread(UnreadableReason.TIMEOUT)
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
    if process.returncode != 0:
        # Out of memory, or a crash in C: nothing the child could still report.
        logger.warning("mail read: the reading process ended with %s", process.returncode)
        return MailRead.unread(UnreadableReason.FAILED)
    try:
        return MailRead.model_validate_json(output)
    except ValidationError:
        logger.warning("mail read: the reading process answered something else")
        return MailRead.unread(UnreadableReason.FAILED)


def read_message(raw: bytes) -> MailRead:
    """What ``raw`` says, as far as it can be read. Never raises."""
    if len(raw) > limits.MAX_MESSAGE_BYTES:
        return MailRead.unread(UnreadableReason.MESSAGE_TOO_LARGE)
    try:
        return _read(raw)
    except Exception as error:  # noqa: BLE001 - the contract is total; the reason is recorded
        logger.warning("mail read failed: %s", type(error).__name__)
        return MailRead.unread(UnreadableReason.FAILED)


def _read(raw: bytes) -> MailRead:
    message = BytesParser(policy=policy.default).parsebytes(raw)
    reasons: list[UnreadableReason] = []
    body = body_text(*_body_forms(message, reasons))
    split = split_replies(body.text)
    own = split.own[: limits.MAX_OWN_TEXT_CHARS]
    quoted = [
        QuotedBlock(header=block.header[:_MAX_HEADER_CHARS], text=block.text[: limits.MAX_QUOTED_CHARS])
        for block in split.quoted[: limits.MAX_QUOTED_BLOCKS]
    ]
    events, calendar_truncated = _calendar(message, reasons)
    return MailRead(
        body_source=body.source,
        own_text=own,
        own_text_truncated=body.truncated or len(own) < len(split.own),
        split=split.split,
        signature_removed=split.signature_removed,
        quoted=quoted,
        quoted_truncated=len(split.quoted) > len(quoted)
        or any(len(block.text) > limits.MAX_QUOTED_CHARS for block in split.quoted),
        calendar=events,
        calendar_truncated=calendar_truncated,
        encrypted=_is_encrypted(message),
        unreadable_reasons=reasons,
    )


def _body_forms(message: EmailMessage, reasons: list[UnreadableReason]) -> tuple[str | None, str | None, bytes | None]:
    """The plain, HTML and RTF body, each ``None`` when absent or past its cap."""
    plain_part = message.get_body(preferencelist=("plain",))
    html_part = message.get_body(preferencelist=("html",))
    rtf_part = next((part for part in _parts(message) if _is_body_rtf(part)), None)
    plain = _flowed_text(plain_part) if plain_part is not None else None
    if plain and plain.strip():
        # The text body wins; the others are not parsed, so their caps do not apply.
        return plain, None, None
    html = _capped(html_part, limits.MAX_HTML_BYTES, UnreadableReason.HTML_TOO_LARGE, reasons)
    rtf = _capped(rtf_part, limits.MAX_RTF_BYTES, UnreadableReason.RTF_TOO_LARGE, reasons)
    return plain, _part_text(html_part) if html is not None else None, rtf


def _capped(
    part: EmailMessage | None, cap: int, reason: UnreadableReason, reasons: list[UnreadableReason]
) -> bytes | None:
    if part is None:
        return None
    payload = _payload(part)
    if len(payload) > cap:
        reasons.append(reason)
        return None
    return payload


def _calendar(message: EmailMessage, reasons: list[UnreadableReason]) -> tuple[list[CalendarEvent], bool]:
    """The events of every calendar part, once each, and whether any were left out."""
    events: list[CalendarEvent] = []
    seen: set[tuple[str | None, int | None, str | None, str | None]] = set()
    truncated = False
    calendar_parts = (part for part in _parts(message) if _is_calendar(part))
    for index, part in enumerate(calendar_parts):
        if index >= limits.MAX_CALENDAR_PARTS:
            truncated = True
            break
        payload = _payload(part)
        if len(payload) > limits.MAX_CALENDAR_BYTES:
            _note(reasons, UnreadableReason.CALENDAR_TOO_LARGE)
            continue
        read = calendar_events(payload)
        if read.malformed:
            _note(reasons, UnreadableReason.CALENDAR_MALFORMED)
        truncated = truncated or read.truncated
        for event in read.events:
            key = (event.uid, event.sequence, event.start, event.summary)
            if key in seen:
                continue
            if len(events) >= limits.MAX_CALENDAR_EVENTS:
                truncated = True
                break
            seen.add(key)
            events.append(event)
    return events, truncated


def _note(reasons: list[UnreadableReason], reason: UnreadableReason) -> None:
    if reason not in reasons:
        reasons.append(reason)


def _parts(message: EmailMessage) -> Iterator[EmailMessage]:
    """Every leaf part of the message, not descending into a message it carries."""
    stack = [message]
    while stack:
        part = stack.pop()
        content_type = part.get_content_type()
        if content_type.startswith("multipart/"):
            payload = part.get_payload()
            if isinstance(payload, list):
                stack.extend(reversed(payload))
            continue
        if content_type == "message/rfc822" and part is not message:
            continue
        yield part


def _is_calendar(part: EmailMessage) -> bool:
    if part.get_content_type() in CALENDAR_TYPES:
        return True
    filename = part.get_filename() or ""
    return filename.lower().endswith(".ics")


def _is_body_rtf(part: EmailMessage) -> bool:
    return part.get_content_type() in RTF_TYPES and not part.is_attachment()


def _is_encrypted(message: EmailMessage) -> bool:
    """The message, or the part that would be its body, is S/MIME or PGP encrypted."""
    for part in (message, *_top_parts(message)):
        content_type = part.get_content_type()
        if content_type == "multipart/encrypted":
            return True
        if content_type in ENCRYPTED_TYPES:
            # S/MIME also uses pkcs7-mime for opaque signing; only enveloped data is encrypted.
            smime_type = str(part.get_param("smime-type", "enveloped-data")).lower()
            if smime_type in {"enveloped-data", "authenveloped-data"}:
                return True
    return False


def _top_parts(message: EmailMessage) -> list[EmailMessage]:
    payload = message.get_payload() if message.is_multipart() else None
    return [part for part in payload if isinstance(part, EmailMessage)] if isinstance(payload, list) else []


def _payload(part: EmailMessage) -> bytes:
    """The part's bytes, transfer encoding undone."""
    payload = part.get_payload(decode=True)
    return payload if isinstance(payload, bytes) else b""


def _part_text(part: EmailMessage) -> str:
    """The part's text in its declared charset, or the way :func:`~.body_text.decode` guesses it."""
    payload = _payload(part)
    charset = (part.get_content_charset() or "").strip().lower()
    if not charset or charset in _LOOSE_CHARSETS:
        return decode(payload)
    try:
        codecs.lookup(charset)
        return payload.decode(charset)
    except (LookupError, UnicodeDecodeError, ValueError):
        # An unknown charset, bytes that are not in it, or a name codecs refuses
        # outright (an embedded NUL).
        return decode(payload)


def _flowed_text(part: EmailMessage) -> str:
    """A plain part's text, unwrapped when it is ``format=flowed`` (RFC 3676)."""
    text = _part_text(part)
    if str(part.get_param("format", "")).lower() != "flowed":
        return text
    return unflow(text, delete_space=str(part.get_param("delsp", "")).lower() == "yes")


def unflow(text: str, delete_space: bool = False) -> str:
    """RFC 3676 §4: join soft line breaks, undo space-stuffing, keep the signature separator.

    A line ending in a space continues on the next line of the same quote
    depth; ``delete_space`` (``DelSp=yes``) drops that space when joining. The
    signature separator ``-- `` is never a soft break.
    """
    lines: list[str] = []
    pieces: list[str] = []
    pieces_depth = 0

    def flush() -> None:
        if pieces:
            prefix = ">" * pieces_depth + " " if pieces_depth else ""
            lines.append(prefix + "".join(pieces))
            pieces.clear()

    for raw_line in text.replace("\r\n", "\n").split("\n"):
        depth = len(raw_line) - len(raw_line.lstrip(">"))
        line = raw_line[depth:]
        line = line.removeprefix(" ")
        if pieces and depth != pieces_depth:
            # A change of quote depth ends the paragraph whatever the last line said.
            flush()
        pieces_depth = depth
        if line.endswith(" ") and line != "-- ":
            pieces.append(line[:-1] if delete_space else line)
            continue
        pieces.append(line)
        flush()
    flush()
    return "\n".join(lines)


def _main() -> None:
    """The child of :func:`read_message_within`: raw bytes on stdin, the read as JSON on stdout."""
    raw = sys.stdin.buffer.read(limits.MAX_MESSAGE_BYTES + 1)
    sys.stdout.buffer.write(read_message(raw).model_dump_json().encode())


if __name__ == "__main__":
    _main()
