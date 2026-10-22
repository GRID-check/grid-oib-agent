"""Calendar invitations: every kind of time in Vienna's, and a broken part never fails the read."""

from __future__ import annotations

import pytest

from aiq_api.mail.calendar import calendar_events


def ics(*events: str, method: str = "REQUEST") -> bytes:
    body = "".join(f"BEGIN:VEVENT\r\n{event}END:VEVENT\r\n" for event in events)
    return f"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:{method}\r\n{body}END:VCALENDAR\r\n".encode()


@pytest.mark.parametrize(
    ("dtstart", "expected", "all_day"),
    [
        # UTC in winter and in summer: Vienna's offset changes with the date.
        ("DTSTART:20261103T080000Z", "2026-11-03T09:00:00+01:00", False),
        ("DTSTART:20260715T080000Z", "2026-07-15T10:00:00+02:00", False),
        # An IANA zone of its own, converted.
        ("DTSTART;TZID=America/New_York:20261103T090000", "2026-11-03T15:00:00+01:00", False),
        # Floating (no zone): taken as the office's clock.
        ("DTSTART:20261103T090000", "2026-11-03T09:00:00+01:00", False),
        # A whole day starts at midnight of that day.
        ("DTSTART;VALUE=DATE:20261103", "2026-11-03T00:00:00+01:00", True),
    ],
)
def test_every_kind_of_start_is_given_in_vienna_time(dtstart, expected, all_day):
    (event,) = calendar_events(ics(f"UID:1\r\nSUMMARY:Termin\r\n{dtstart}\r\n")).events

    assert (event.start, event.all_day) == (expected, all_day)


def test_a_cancellation_and_a_recurring_event_say_so():
    read = calendar_events(
        ics("UID:1\r\nSUMMARY:Jour fixe\r\nDTSTART:20261103T080000Z\r\nRRULE:FREQ=WEEKLY\r\n", method="CANCEL")
    )

    (event,) = read.events
    assert (event.method, event.recurring) == ("CANCEL", True)


def test_a_broken_event_is_skipped_and_the_others_are_kept():
    read = calendar_events(
        ics("UID:1\r\nSUMMARY:Kaputt\r\nDTSTART:2026\r\n", "UID:2\r\nSUMMARY:Gut\r\nDTSTART:20261103T080000Z\r\n")
    )

    assert [event.summary for event in read.events] == ["Kaputt", "Gut"]
    assert read.events[0].start is None
    assert read.malformed is False


def test_bytes_that_are_no_calendar_are_malformed_not_an_error():
    read = calendar_events(b"\x00\xffnot a calendar")

    assert (read.events, read.malformed) == ((), True)


def test_events_past_the_limit_are_cut_and_marked():
    events = [f"UID:{index}\r\nSUMMARY:Termin {index}\r\nDTSTART:20261103T080000Z\r\n" for index in range(5)]

    read = calendar_events(ics(*events), limit=3)
    assert (len(read.events), read.truncated) == (3, True)


def test_text_is_cleaned_and_bounded():
    summary = "Bau\x07verhandlung   " + "x" * 600
    (event,) = calendar_events(ics(f"UID:1\r\nSUMMARY:{summary}\r\nDTSTART:20261103T080000Z\r\n")).events

    assert event.summary.startswith("Bau verhandlung x")
    assert len(event.summary) == 500


def test_the_organizer_is_named_and_attendees_and_description_are_not_kept():
    (event,) = calendar_events(
        ics(
            'UID:1\r\nSUMMARY:T\r\nDTSTART:20261103T080000Z\r\nORGANIZER;CN="Huber, Anna":mailto:a@wien.gv.at\r\n'
            "ATTENDEE;CN=Eva:mailto:eva@berger-architektur.at\r\nDESCRIPTION:geheim\r\n"
        )
    ).events

    assert event.organizer_name == "Huber, Anna"
    assert "eva@" not in event.model_dump_json()
    assert "geheim" not in event.model_dump_json()
