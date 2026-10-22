"""The sender's own words, apart from what they quoted and without their signature.

A reply carries the whole conversation below it: "Am 02.10.2026 um 10:15
schrieb …:", Outlook's "Von:/Gesendet:/An:/Betreff:" block, "-----Original
Message-----". Filed as it arrived, every message would repeat the ones before
it, and a statement the sender only quoted would read as theirs. So the body is
cut at the first such header: what stands above it is the sender's own text,
what stands below is a list of quoted blocks, each with the header that
introduced it. The signature and a mail disclaimer are cut from the own text.

The splitting is ``mail-parser-reply`` (MIT, German and English rules), bought
rather than written: the header and signature patterns of a dozen mail clients
in two languages are the library's whole job. It is a heuristic, which is why
the original message is kept (DECISION D6). ``keep_hyphen_lists`` stops it
from taking a "- item" list for a signature.

Two things are done before the library sees the text, because its signature
pattern starts with ``\\s*^`` and so costs the square of any whitespace run
(measured: 20,000 tabs in one line, 7.5 s; 8,000 empty lines, 12 s):
blank-line runs are collapsed to one empty line and horizontal whitespace
runs are cut at :data:`~.limits.MAX_WHITESPACE_RUN`. The library strips every
line anyway, so a reader sees the same text. Past
:data:`~.limits.MAX_SPLIT_CHARS` the text is not split at all.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from mailparser_reply.parser import EmailMessage

from . import limits

#: The rule sets the splitter applies. English rules are always on as well.
LANGUAGES = ("de", "en")

#: Characters Python reads as line breaks inside a line (``str.splitlines``).
_LINE_BREAKS = re.compile("[\r\x0b\x0c\x1c\x1d\x1e\x85  ]")
#: Whitespace that is not a line break.
_HORIZONTAL_SPACE = r"[^\S\n]"
_BLANK_RUN = re.compile(r"\n{3,}")
#: A quote marker at the start of a line ("> ", ">> ", "> > ").
_QUOTE_MARKER = re.compile(r"^(?:> ?)+", re.MULTILINE)


@dataclass(frozen=True)
class Quoted:
    header: str
    text: str


@dataclass(frozen=True)
class SplitText:
    own: str
    quoted: tuple[Quoted, ...]
    signature_removed: bool
    #: Whether the splitter ran; a text past its bound is kept whole.
    split: bool


def split_replies(text: str) -> SplitText:
    """``text`` as the sender's own words and the blocks they quoted."""
    if len(text) > limits.MAX_SPLIT_CHARS:
        return SplitText(own=text, quoted=(), signature_removed=False, split=False)
    prepared = _bounded_whitespace(text)
    if not prepared.strip():
        return SplitText(own="", quoted=(), signature_removed=False, split=True)
    message = EmailMessage(text=prepared, languages=list(LANGUAGES), keep_hyphen_lists=True).read()
    replies = message.replies
    # The first reply is the sender's own text unless the body opens with a
    # header (a bare forward): then everything in it is quoted.
    own_reply = replies[0] if replies and not replies[0].headers else None
    quoted = replies[1:] if own_reply is not None else replies
    own = own_reply.body if own_reply is not None else ""
    signature_removed = own_reply is not None and bool(own_reply.signatures or own_reply.disclaimers)
    return SplitText(
        own=own,
        quoted=tuple(Quoted(header=reply.headers, text=_unquoted(reply.body)) for reply in quoted if reply.body),
        signature_removed=signature_removed,
        split=True,
    )


def _bounded_whitespace(text: str) -> str:
    text = _LINE_BREAKS.sub("\n", text.replace("\r\n", "\n"))
    run = limits.MAX_WHITESPACE_RUN
    text = re.sub(f"({_HORIZONTAL_SPACE}{{{run}}}){_HORIZONTAL_SPACE}+", r"\1", text)
    text = "\n".join(line.strip() for line in text.split("\n"))
    return _BLANK_RUN.sub("\n\n", text)


def _unquoted(text: str) -> str:
    """The quoted text without its ``>`` markers."""
    return _QUOTE_MARKER.sub("", text).strip()
