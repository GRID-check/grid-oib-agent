"""A stranger's bytes: each cap gives ``unreadable`` with its reason, and nothing ever raises.

DECISION §10's Python half of the hostile corpus: a 5 MB HTML body, a huge
RTF body, a 10,000-event calendar, a message past the edge's ceiling, a read
that overruns its deadline (stopped in its child process), and a seeded
mutation loop over the fixture corpus. Each case asserts its outcome and a
work budget.
"""

from __future__ import annotations

import asyncio
import random
import signal
import time
from email.message import EmailMessage
from pathlib import Path

from aiq_api.mail import limits
from aiq_api.mail.models import MailRead
from aiq_api.mail.models import UnreadableReason
from aiq_api.mail.read import read_message
from aiq_api.mail.read import read_message_within

FIXTURES = Path(__file__).parent / "fixtures"


def timed(raw: bytes, budget: float) -> MailRead:
    started = time.perf_counter()
    read = read_message(raw)
    assert time.perf_counter() - started < budget
    return read


def test_a_5_mb_html_body_is_not_parsed():
    mail = EmailMessage()
    mail.set_content("<table>" + "<tr><td>x</td></tr>" * 300_000 + "</table>", subtype="html")

    read = timed(mail.as_bytes(), budget=3.0)
    assert read.unreadable_reasons == [UnreadableReason.HTML_TOO_LARGE]
    assert (read.body_source, read.own_text) == ("none", "")


def test_a_huge_rtf_body_is_not_parsed():
    mail = EmailMessage()
    rtf = b"{\\rtf1\\ansi " + b"{\\b x}" * 600_000 + b"}"
    mail.set_content(rtf, maintype="text", subtype="rtf", disposition="inline")

    read = timed(mail.as_bytes(), budget=3.0)
    assert read.unreadable_reasons == [UnreadableReason.RTF_TOO_LARGE]


def test_a_10k_event_calendar_is_not_parsed_and_the_body_still_reads():
    events = "".join(
        f"BEGIN:VEVENT\r\nUID:{index}\r\nSUMMARY:Termin {index}\r\nDTSTART:20261103T080000Z\r\nEND:VEVENT\r\n"
        for index in range(10_000)
    )
    mail = EmailMessage()
    mail.set_content("Die Termine anbei.")
    mail.add_attachment(
        f"BEGIN:VCALENDAR\r\nVERSION:2.0\r\n{events}END:VCALENDAR\r\n".encode(),
        maintype="text",
        subtype="calendar",
        filename="termine.ics",
    )

    read = timed(mail.as_bytes(), budget=3.0)
    assert read.unreadable_reasons == [UnreadableReason.CALENDAR_TOO_LARGE]
    assert read.own_text == "Die Termine anbei."
    assert read.calendar == []


def test_a_calendar_just_under_its_cap_is_read_and_cut_at_the_event_limit():
    event = "BEGIN:VEVENT\r\nUID:{0}\r\nSUMMARY:T{0}\r\nDTSTART:20261103T080000Z\r\nEND:VEVENT\r\n"
    count = (limits.MAX_CALENDAR_BYTES - 200) // len(event.format(10_000))
    mail = EmailMessage()
    mail.set_content("x")
    body = "".join(event.format(index) for index in range(count))
    mail.add_attachment(f"BEGIN:VCALENDAR\r\n{body}END:VCALENDAR\r\n".encode(), maintype="text", subtype="calendar")

    read = timed(mail.as_bytes(), budget=3.0)
    assert (len(read.calendar), read.calendar_truncated, read.unreadable) == (
        limits.MAX_CALENDAR_EVENTS,
        True,
        False,
    )


def test_a_message_past_the_edge_ceiling_is_not_parsed():
    read = timed(b"x" * (limits.MAX_MESSAGE_BYTES + 1), budget=1.0)

    assert read.unreadable_reasons == [UnreadableReason.MESSAGE_TOO_LARGE]


#: A line that repeats "schrieb": ``mail-parser-reply``'s German header pattern
#: is cubic in it (3,000 characters, 64 s). The mutation loop found it.
CUBIC_LINE = ("Am " + "schrieb " * 400).encode()


def test_a_read_past_its_deadline_is_stopped_and_unreadable():
    raw = b"Content-Type: text/plain\n\nHallo\n\n" + CUBIC_LINE + b"\n"

    started = time.perf_counter()
    read = asyncio.run(read_message_within(raw, timeout=2.0))
    assert read.unreadable_reasons == [UnreadableReason.TIMEOUT]
    # Stopped at the deadline, not left running for the minute it would take.
    assert time.perf_counter() - started < 5.0


def test_a_read_in_the_child_process_gives_the_same_answer_as_in_process():
    raw = (FIXTURES / "outlook-reply-de.eml").read_bytes()

    assert asyncio.run(read_message_within(raw)) == read_message(raw)


def test_the_child_process_sees_none_of_the_servers_environment(monkeypatch):
    """A stranger's bytes are parsed where no secret of the API process is in reach."""
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "secret-token")
    import aiq_api.mail.read as module

    seen: dict[str, object] = {}
    original = asyncio.create_subprocess_exec

    async def spy(*arguments, **options):
        seen.update(options)
        return await original(*arguments, **options)

    monkeypatch.setattr(module.asyncio, "create_subprocess_exec", spy)
    asyncio.run(read_message_within(b"Content-Type: text/plain\n\nHallo\n"))
    assert seen["env"] == {}


class _Budget(BaseException):
    pass


def _within(raw: bytes, seconds: float) -> MailRead | None:
    """``read_message`` in this process with an alarm, as the child runs it with a kill; ``None`` past it."""

    def stop(_signal, _frame):
        raise _Budget

    previous = signal.signal(signal.SIGALRM, stop)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        return read_message(raw)
    except _Budget:
        return None
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def _mutations(seed: int, count: int) -> list[bytes]:
    """Bit flips, cuts, splices and repeats of the fixture corpus, reproducible from ``seed``."""
    corpus = [path.read_bytes() for path in sorted(FIXTURES.glob("*.eml"))]
    chance = random.Random(seed)
    mutated: list[bytes] = []
    for _ in range(count):
        data = bytearray(chance.choice(corpus))
        for _ in range(chance.randint(1, 8)):
            operation = chance.randrange(5)
            position = chance.randrange(max(1, len(data)))
            if operation == 0 and data:
                data[position] = chance.randrange(256)
            elif operation == 1:
                del data[position:]
            elif operation == 2:
                other = chance.choice(corpus)
                start = chance.randrange(len(other))
                data[position:position] = other[start : start + chance.randint(1, 400)]
            elif operation == 3:
                data[position:position] = data[position : position + 40] * chance.randint(2, 200)
            else:
                data[position:position] = chance.choice([b"\r\n--alt\r\n", b"=?utf-8?b?", b"\x00", b"\n> ", b"\t" * 50])
        mutated.append(bytes(data))
    return mutated


def test_two_thousand_mutated_messages_all_read_without_raising():
    """Each read either answers or meets its deadline (as the child would); none raises or fails."""
    started = time.perf_counter()
    past_deadline = 0
    for raw in _mutations(seed=20261022, count=2_000):
        read = _within(raw, seconds=2.0)
        if read is None:
            past_deadline += 1
            continue
        assert UnreadableReason.FAILED not in read.unreadable_reasons, raw[:200]
    # The seed holds four reads that meet the cubic pattern (5 to 64 s each
    # without a deadline); a handful more is noise, many more a new worst case.
    assert past_deadline <= 8
    assert time.perf_counter() - started < 60.0
