"""What reading a mail gives: :class:`MailRead`, the body of ``POST /v1/mail/read``.

The BFF stages it as the held mail's ``read.json`` and, once a person files
the message, copies ``own_text``, ``quoted`` and ``calendar`` into the thread
entry (``mail_thread_entries``). Field names are this tier's snake_case; the
BFF's read client maps them onto its wire.

Text here is the sender's, unscreened and unredacted: the BFF redacts other
tenants' project addresses in ``own_text`` and in every ``quoted`` block,
header included, before it stages the read (DECISION B8).
"""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel
from pydantic import Field
from pydantic import computed_field

#: Bumped when the same bytes would read differently, so a stored read can be redone.
READER_VERSION = 1

#: Which of the message's forms the body text came from.
BodySource = Literal["plain", "html", "rtf", "none"]


class UnreadableReason(StrEnum):
    """Why part of a message was not read. Any one makes the read ``unreadable``."""

    #: The raw message is past the edge's ceiling; nothing was parsed.
    MESSAGE_TOO_LARGE = "message_too_large"
    #: There was no plain body and the HTML body is past its cap: it was not read.
    HTML_TOO_LARGE = "html_too_large"
    #: There was no plain body and the RTF body is past its cap: it was not read.
    RTF_TOO_LARGE = "rtf_too_large"
    #: A calendar part is past its cap; the body was still read.
    CALENDAR_TOO_LARGE = "calendar_too_large"
    #: A calendar part did not parse; the body was still read.
    CALENDAR_MALFORMED = "calendar_malformed"
    #: The read did not finish within its deadline; nothing of it is kept.
    TIMEOUT = "timeout"
    #: A parser failed in a way nothing above caught; nothing of it is kept.
    FAILED = "failed"


class QuotedBlock(BaseModel):
    """One earlier message the sender quoted below their own text, in the order it appeared."""

    #: The line that introduced it, as the sender's client wrote it
    #: ("Am 02.10.2026 um 10:15 schrieb …:", an Outlook "Von:/Gesendet:" block),
    #: or empty when the quote had none. It names people and addresses.
    header: str = Field(max_length=4096)
    #: The quoted text, quote markers removed.
    text: str = Field(max_length=524_288)


class CalendarEvent(BaseModel):
    """One event of a calendar invitation the message carried."""

    #: The invitation's iTIP method: ``REQUEST``, ``CANCEL``, ``REPLY`` and so on.
    method: str | None = Field(max_length=40)
    summary: str | None = Field(max_length=500)
    #: ISO 8601 with the offset, in Europe/Vienna. An all-day event starts at
    #: midnight of its first day; a floating time is taken as Vienna's.
    start: str | None
    end: str | None
    all_day: bool
    location: str | None = Field(max_length=500)
    #: ``CONFIRMED``, ``TENTATIVE`` or ``CANCELLED``, as the event says.
    status: str | None = Field(max_length=40)
    #: The organizer's display name only; the address stays in the original.
    organizer_name: str | None = Field(max_length=300)
    uid: str | None = Field(max_length=500)
    #: The revision of the invitation (RFC 5545 SEQUENCE); a higher one replaces a lower.
    sequence: int | None
    #: The event repeats (RRULE or RDATE); only its first occurrence is given.
    recurring: bool


class MailRead(BaseModel):
    """What one message says, as far as it could be read."""

    reader_version: int = READER_VERSION
    body_source: BodySource
    #: The sender's own words: the body before the first quoted message, the
    #: signature and disclaimer removed. What a person reviews and files.
    own_text: str
    own_text_truncated: bool
    #: Whether the body went through the reply splitter. A body too long for it
    #: is kept whole in ``own_text``, quotes and signature included.
    split: bool
    signature_removed: bool
    quoted: list[QuotedBlock]
    #: More quoted blocks than are kept, or one cut at its bound.
    quoted_truncated: bool
    calendar: list[CalendarEvent]
    calendar_truncated: bool
    #: The body is S/MIME or PGP encrypted: nothing in it can be read here.
    encrypted: bool
    unreadable_reasons: list[UnreadableReason]

    @computed_field
    @property
    def unreadable(self) -> bool:
        """Part of the message could not be read; a person should open the original."""
        return bool(self.unreadable_reasons)

    @classmethod
    def unread(cls, reason: UnreadableReason) -> MailRead:
        """A read that kept nothing, for ``reason``."""
        return cls(
            body_source="none",
            own_text="",
            own_text_truncated=False,
            split=False,
            signature_removed=False,
            quoted=[],
            quoted_truncated=False,
            calendar=[],
            calendar_truncated=False,
            encrypted=False,
            unreadable_reasons=[reason],
        )
