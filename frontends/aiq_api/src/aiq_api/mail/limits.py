"""The bounds on reading one mail, in one place.

A project's address is public: anybody can send it anything, and the receive
job reads it before a person has seen it. Each parser therefore gets a cap on
its input that keeps its worst case at about a second on one core, measured
on hostile input rather than on mail as it usually is. Past a cap the part is
not parsed at all and the read says ``unreadable`` with the reason
(:class:`~aiq_api.mail.models.UnreadableReason`); the person opens the original.

The numbers, and what they were measured against (2026-10-22, one core):

- ``mail-parser-reply`` 1.36 is linear on 400,000 characters of any line
  pattern tried (1.9 s worst), *once* runs of blank lines and of horizontal
  whitespace are bounded (:mod:`.replies`); without that, 20,000 tabs in one
  line took 7.5 s and 8,000 empty lines 12 s, quadratic in the run.
- ``icalendar`` 7.3.0 parses about 2 MB of events in 4.9 s; 256 KiB is about
  half a second, and an invitation is a few kilobytes.
- lxml reads 2 MiB of HTML in well under a second.

Not every worst case is a matter of input size: the reply splitter's German
header pattern is cubic in one line that repeats "schrieb" (3,000 characters,
64 s). That is what the deadline is for, and why it is enforced in a child
process that can be stopped (:mod:`.read`).
"""

from __future__ import annotations

#: The largest raw message read, in bytes: the edge's own ceiling (DECISION A3).
MAX_MESSAGE_BYTES = 26 * 1024 * 1024

#: The largest HTML body parsed, in bytes after transfer decoding (RT-S15).
MAX_HTML_BYTES = 2 * 1024 * 1024

#: The largest RTF body parsed, in bytes after transfer decoding (RT-S15).
MAX_RTF_BYTES = 2 * 1024 * 1024

#: The largest calendar part parsed, in bytes after transfer decoding (RT-S15).
MAX_CALENDAR_BYTES = 256 * 1024

#: Calendar parts read per message, and events kept across them. An invitation
#: is one event; a message with more is a list, cut and marked ``truncated``.
MAX_CALENDAR_PARTS = 5
MAX_CALENDAR_EVENTS = 20

#: The longest text handed to the reply splitter, in characters. A longer body
#: is kept whole as the sender's own text, unsplit (``split`` is false).
MAX_SPLIT_CHARS = 256 * 1024

#: The longest run of horizontal whitespace the reply splitter sees. Its
#: signature pattern starts with ``\\s*^``, which costs the square of a run.
MAX_WHITESPACE_RUN = 16

#: The longest own text kept, in characters: ``mail_thread_entries.own_text``'s CHECK.
MAX_OWN_TEXT_CHARS = 524_288

#: The longest quoted block kept, and how many are kept.
MAX_QUOTED_CHARS = 524_288
MAX_QUOTED_BLOCKS = 50

#: How long one read may take, in seconds, before it is ``unreadable`` (timeout).
READ_TIMEOUT_SECONDS = 20.0

#: Reads running at once per process, each in its own child process: a
#: burst of mail queues here instead of taking every core of the API pod.
MAX_CONCURRENT_READS = 2

#: How long fetching the raw message from the object store may take, in seconds.
FETCH_TIMEOUT_SECONDS = 30.0
