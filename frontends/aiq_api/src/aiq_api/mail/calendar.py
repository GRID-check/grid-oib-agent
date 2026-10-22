"""The events of a calendar invitation (``text/calendar``, ``.ics``), in Vienna time.

An invitation to the Bauverhandlung arrives as a calendar part beside the
text, and its date is the one fact of the message a person most needs. The
part is read with ``icalendar`` (BSD-2-Clause), which knows RFC 5545 and maps
Outlook's Windows zone names ("W. Europe Standard Time") onto IANA ones.

Every time is given in Europe/Vienna with its offset, because that is the
office's clock and the clock the rendition prints. A floating time (no zone)
is taken as Vienna's; an all-day event starts at midnight of its first day.
A recurring event is given once, at its first occurrence, and says it repeats.

Only what a person reads of an invitation is kept: method, summary, times,
place, status, the organizer's name, and UID and SEQUENCE to tell a later
revision of the same invitation. Attendee lists and the description (Outlook
repeats the mail body there) are not.
"""

from __future__ import annotations

import logging
import unicodedata
from dataclasses import dataclass
from datetime import date
from datetime import datetime
from datetime import time
from zoneinfo import ZoneInfo

from icalendar import Calendar
from icalendar import Component

from . import limits
from .models import CalendarEvent

logger = logging.getLogger(__name__)

#: The office's clock.
VIENNA = ZoneInfo("Europe/Vienna")


@dataclass(frozen=True)
class CalendarRead:
    events: tuple[CalendarEvent, ...]
    #: More events than :data:`~.limits.MAX_CALENDAR_EVENTS`; the rest were dropped.
    truncated: bool
    #: The part did not parse as a calendar at all.
    malformed: bool


def calendar_events(data: bytes, limit: int = limits.MAX_CALENDAR_EVENTS) -> CalendarRead:
    """The events of one calendar part, at most ``limit``. Never raises."""
    try:
        calendars = Calendar.from_ical(data, multiple=True)
    except Exception as error:  # noqa: BLE001 - a stranger's bytes; any parser failure is "malformed"
        logger.info("calendar part did not parse: %s", type(error).__name__)
        return CalendarRead(events=(), truncated=False, malformed=True)
    events: list[CalendarEvent] = []
    truncated = False
    for calendar in calendars:
        method = _text(calendar.get("METHOD"), 40)
        for component in calendar.walk("VEVENT"):
            if len(events) >= limit:
                truncated = True
                break
            event = _event(component, method)
            if event is not None:
                events.append(event)
    return CalendarRead(events=tuple(events), truncated=truncated, malformed=False)


def _event(component: Component, method: str | None) -> CalendarEvent | None:
    """One event, or ``None`` when it has nothing a person could read."""
    try:
        start, all_day = _moment(component, "DTSTART")
        end, _ = _moment(component, "DTEND")
        organizer = component.get("ORGANIZER")
        organizer_name = _text(organizer.params.get("CN"), 300) if organizer is not None else None
        sequence = component.get("SEQUENCE")
        event = CalendarEvent(
            method=method,
            summary=_text(component.get("SUMMARY"), 500),
            start=start,
            end=end,
            all_day=all_day,
            location=_text(component.get("LOCATION"), 500),
            status=_text(component.get("STATUS"), 40),
            organizer_name=organizer_name,
            uid=_text(component.get("UID"), 500),
            sequence=int(sequence) if isinstance(sequence, int) else None,
            recurring=component.get("RRULE") is not None or component.get("RDATE") is not None,
        )
    except Exception as error:  # noqa: BLE001 - one broken event must not cost the others
        logger.info("calendar event skipped: %s", type(error).__name__)
        return None
    if event.summary is None and event.start is None:
        return None
    return event


def _moment(component: Component, name: str) -> tuple[str | None, bool]:
    """The property ``name`` as an ISO time in Vienna, and whether it is a whole day."""
    prop = component.get(name)
    if prop is None:
        return None, False
    try:
        value = prop.dt
    except Exception:  # noqa: BLE001 - icalendar raises its own error on a broken value
        return None, False
    if isinstance(value, datetime):
        moment = value.replace(tzinfo=VIENNA) if value.tzinfo is None else value.astimezone(VIENNA)
        return moment.isoformat(), False
    if isinstance(value, date):
        return datetime.combine(value, time(), tzinfo=VIENNA).isoformat(), True
    return None, False


def _text(value: object, bound: int) -> str | None:
    """A property's text, control characters dropped, whitespace folded, bounded."""
    if value is None:
        return None
    text = "".join(" " if unicodedata.category(char).startswith("C") else char for char in str(value))
    text = " ".join(text.split())
    return text[:bound] or None
