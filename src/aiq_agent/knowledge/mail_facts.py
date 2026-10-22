"""What a filed mail says about a document: the thread it is, or the message it came with.

A conversation a person files from a project's E-Mail-Eingang becomes one
document, the E-Mail-Verlauf, with one Markdown section per message
(``frontends/ui/src/lib/mail-thread/render.ts``, ADR-0134); each attachment the
person files becomes a document of its own. Two records on the document's
metadata row (``document_metadata``) say so, and this module is the one place
that knows what they look like, so the store, the payload, the listing and the
reader cannot disagree:

* ``mail_thread`` on a Verlauf: ``latest_sent_at`` (the newest message's send
  time, already clamped by the BFF to its receipt window), ``message_count`` and
  the thread's ``locale``. ``latest_sent_at`` is the document's own date
  (``document_date`` in the payload): what "the newest correspondence" sorts by.
* ``mail_origin`` on an attachment: the message it came with. ``sent_at``,
  ``received_at``, the sender's display name and domains, the ``sender_trust``
  the receive step established, the Verlauf's BFF id and the thread's locale.

**A domain is authority only when a signature confirmed it** (RT-S2). The line
:func:`mail_origin_label` prints names the SIGNING domain for a verified sender,
and otherwise the From domain with „Domain nicht bestätigt“, the same words and
the same rule as the Verlauf's own section headings. So Piloti can attribute
(„laut E-Mail von Mag. Huber vom 12.05.2026“) and never present a sender
nobody confirmed as the Behörde.

**No address reaches a model.** The records hold a display name and domains
only; the BFF sends nothing else, and :func:`normalise_mail_origin` drops any
key it does not know.

The words are document text in the thread's locale, not interface copy: the
copy table below mirrors the trust words of ``render-copy.ts``
(``tests/aiq_agent/knowledge/test_mail_facts.py`` pins the parity), because a
listing that called a sender „nicht verifiziert“ while the Verlauf says „Domain
nicht bestätigt“ would be two words for one concept.

Pure: no I/O, no framework.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

#: Every ``sender_trust`` a mail can carry, as the BFF stores it
#: (``frontends/ui/src/lib/inbound-mail/inbound-mail-vocabulary.ts``, ``SENDER_TRUSTS``).
#: ``not_checked`` is an Outlook-archive entry's: nothing could be verified, so it claims nothing.
SENDER_TRUSTS: tuple[str, ...] = (
    "member_verified",
    "member_unverified",
    "external_verified",
    "external_unverified",
    "not_checked",
)
#: The trusts that are an aligned DKIM pass: the only ones whose domain a line may name as the sender's.
VERIFIED_SENDER_TRUSTS: frozenset[str] = frozenset({"member_verified", "external_verified"})

#: The locales a thread is rendered in (``frontends/ui/src/i18n/config.ts``). The first is the default.
MAIL_LOCALES: tuple[str, ...] = ("de", "en")

#: The office's clock, which every heading of a Verlauf is written in (``OFFICE_TIME_ZONE``).
_OFFICE_TIME_ZONE = ZoneInfo("Europe/Vienna")
#: A display name is a label, not a paragraph (``render.ts``, ``MAX_NAME_CHARS``).
_MAX_NAME_CHARS = 80
#: A thread holds at most this many entries (``mail_threads.entry_count``).
_MAX_MESSAGE_COUNT = 200
#: Brackets a name or domain could use to fake an authority: ``Huber (ma37.wien.gv.at)``.
_BRACKETS = re.compile(r"[()<>\[\]{}]")
#: What a printed domain may hold: letters, digits, dots and hyphens (``render.ts``, ``cleanDomain``).
_NOT_DOMAIN = re.compile(r"[^\w.-]")
#: A BFF document id: a UUID.
_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


@dataclass(frozen=True)
class MailCopy:
    """The words of the two lines, in one locale."""

    #: The heading suffix for a sender whose domain no signature confirmed (``render-copy.ts``, ``unverifiedDomain``).
    unverified_domain: str
    #: The heading suffix for an Outlook-archive entry (``render-copy.ts``, ``fromArchive``).
    from_archive: str
    #: A sender with no usable name (``render-copy.ts``, ``unknownSender``).
    unknown_sender: str
    #: ``kam mit der E-Mail vom {when} von {who} ({authority})``.
    came_with: str
    #: The format's name, as the Verlauf's own summary line opens (``render-copy.ts``, ``summary``).
    thread: str
    #: ``zuletzt {day}``: the newest message's day.
    latest: str
    one_message: str
    messages: str
    date_time_format: str
    date_format: str


MAIL_COPY: dict[str, MailCopy] = {
    "de": MailCopy(
        unverified_domain="Domain nicht bestätigt",
        from_archive="aus dem Outlook-Archiv",
        unknown_sender="Unbekannt",
        came_with="kam mit der E-Mail vom {when} von {who} ({authority})",
        thread="E-Mail-Verlauf",
        latest="zuletzt {day}",
        one_message="1 E-Mail",
        messages="{count} E-Mails",
        date_time_format="%d.%m.%Y %H:%M",
        date_format="%d.%m.%Y",
    ),
    "en": MailCopy(
        unverified_domain="domain not verified",
        from_archive="from the Outlook archive",
        unknown_sender="Unknown",
        came_with="came with the mail of {when} from {who} ({authority})",
        thread="Mail thread",
        latest="latest {day}",
        one_message="1 mail",
        messages="{count} mails",
        date_time_format="%Y-%m-%d %H:%M",
        date_format="%Y-%m-%d",
    ),
}


def _moment(value: Any) -> datetime | None:
    """An aware UTC datetime from an ISO string (``Z`` or an offset), else ``None``."""
    if isinstance(value, datetime):
        moment = value
    elif isinstance(value, str) and value.strip():
        try:
            moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        except ValueError:
            return None
    else:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC)


def _stamp(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _one_line(value: Any) -> str:
    return " ".join(str(value).split()) if isinstance(value, str) else ""


def clean_name(value: Any) -> str | None:
    """A sender's display name as a line prints it: one line, no brackets, no address, at most 80 characters."""
    name = _one_line(_BRACKETS.sub(" ", value) if isinstance(value, str) else "")
    if not name or "@" in name:
        return None
    return " ".join(name[:_MAX_NAME_CHARS].split()) or None


def clean_domain(value: Any) -> str | None:
    """A domain as printed: lower-case letters, digits, dots and hyphens, so it cannot close a bracket or add a word."""
    if not isinstance(value, str):
        return None
    domain = _NOT_DOMAIN.sub("", value.strip().lower().rstrip("."))[:253]
    return domain or None


def _locale(value: Any) -> str:
    return value if value in MAIL_LOCALES else MAIL_LOCALES[0]


def normalise_mail_thread(raw: Any) -> dict[str, Any] | None:
    """A ``mail_thread`` record as it is stored and read, or ``None`` when it states no newest message.

    ``latest_sent_at`` is required (it is the record's reason to exist: the
    Verlauf's date); ``message_count`` is kept when it is a count a thread can
    have; ``locale`` falls back to the default.
    """
    if not isinstance(raw, Mapping):
        return None
    latest = _moment(raw.get("latest_sent_at"))
    if latest is None:
        return None
    record: dict[str, Any] = {"latest_sent_at": _stamp(latest), "locale": _locale(raw.get("locale"))}
    count = raw.get("message_count")
    if isinstance(count, int) and not isinstance(count, bool) and 1 <= count <= _MAX_MESSAGE_COUNT:
        record["message_count"] = count
    return record


def normalise_mail_origin(raw: Any) -> dict[str, Any] | None:
    """A ``mail_origin`` record as it is stored and read, or ``None`` when it cannot say which message.

    ``sent_at`` and a ``sender_trust`` of :data:`SENDER_TRUSTS` are required: an
    origin with no trust could not be printed honestly, and one with no date
    could not be attributed. Every other key is kept when it is valid and
    dropped when it is not; a key this module does not know is never kept, so
    an address the BFF did not mean to send stops here.
    """
    if not isinstance(raw, Mapping):
        return None
    sent_at = _moment(raw.get("sent_at"))
    trust = raw.get("sender_trust")
    if sent_at is None or trust not in SENDER_TRUSTS:
        return None
    record: dict[str, Any] = {"sent_at": _stamp(sent_at), "sender_trust": trust}
    if (received_at := _moment(raw.get("received_at"))) is not None:
        record["received_at"] = _stamp(received_at)
    if (name := clean_name(raw.get("from_name"))) is not None:
        record["from_name"] = name
    for key in ("from_domain", "signer_domain"):
        if (domain := clean_domain(raw.get(key))) is not None:
            record[key] = domain
    thread = raw.get("thread_document_id")
    if isinstance(thread, str) and _UUID.match(thread.strip()):
        record["thread_document_id"] = thread.strip().lower()
    record["locale"] = _locale(raw.get("locale"))
    return record


def sender_authority(origin: Mapping[str, Any], copy: MailCopy) -> str:
    """What the bracket after the sender's name says: the signing domain, or the From domain and why it is not one.

    The rule of the Verlauf's headings (``render.ts``, ``headingAuthority``): a
    verified sender is named by the domain that signed; an archive entry says
    where it came from; every other sender's From domain carries „Domain nicht
    bestätigt“, because DKIM proves a domain and nothing proved this one.
    """
    from_domain = origin.get("from_domain")
    if origin.get("sender_trust") == "not_checked":
        return ", ".join(part for part in (from_domain, copy.from_archive) if part)
    signer = origin.get("signer_domain")
    if origin.get("sender_trust") in VERIFIED_SENDER_TRUSTS and signer:
        return str(signer)
    return ", ".join(part for part in (from_domain, copy.unverified_domain) if part)


def mail_origin_label(origin: Mapping[str, Any] | None) -> str | None:
    """``kam mit der E-Mail vom 12.05.2026 09:12 von Mag. Anna Huber (ma37.wien.gv.at)``, or ``None``.

    In the thread's locale, at the office's clock, from a record
    :func:`normalise_mail_origin` accepts.
    """
    record = normalise_mail_origin(origin) if origin is not None else None
    if record is None:
        return None
    copy = MAIL_COPY[record["locale"]]
    when = datetime.fromisoformat(record["sent_at"].replace("Z", "+00:00")).astimezone(_OFFICE_TIME_ZONE)
    return copy.came_with.format(
        when=when.strftime(copy.date_time_format),
        who=record.get("from_name") or copy.unknown_sender,
        authority=sender_authority(record, copy),
    )


def mail_thread_label(thread: Mapping[str, Any] | None) -> str | None:
    """``E-Mail-Verlauf · 4 E-Mails, zuletzt 14.05.2026``, or ``None`` for no record."""
    record = normalise_mail_thread(thread) if thread is not None else None
    if record is None:
        return None
    copy = MAIL_COPY[record["locale"]]
    latest = datetime.fromisoformat(record["latest_sent_at"].replace("Z", "+00:00")).astimezone(_OFFICE_TIME_ZONE)
    newest = copy.latest.format(day=latest.strftime(copy.date_format))
    count = record.get("message_count")
    if not count:
        return f"{copy.thread} · {newest}"
    counted = copy.one_message if count == 1 else copy.messages.format(count=count)
    return f"{copy.thread} · {counted}, {newest}"


def mail_thread_date(thread: Mapping[str, Any] | None) -> str | None:
    """The Verlauf's own date: its newest message's send time, RFC 3339 UTC, or ``None``."""
    record = normalise_mail_thread(thread) if thread is not None else None
    return record["latest_sent_at"] if record else None
