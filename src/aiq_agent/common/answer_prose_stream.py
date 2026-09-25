"""The answer's prose while the model is still writing it, safe to show.

The final call writes one ```answer_json envelope: the masthead fields
(``MASTHEAD_FIELDS`` in :mod:`aiq_agent.common.answer_envelope`) first, then the
``answer`` string, then the cards. The strict schema and every example put them
in that order, and the order is load-bearing (ADR-0066): a masthead written
after ``answer`` cannot stand above the prose until the terminal frame. This
reads the string out of the raw token stream as it grows and hands back what
may be shown NOW, JSON-unescaped.

- ``[N]`` citation markers stream as they are written, whole: a half-written
  ``[1`` is held until its bracket closes. The reader shows them as pending
  citations until the sources section below is verified (ADR-0066).
- ``[[card:N]]`` markers stream whole too, so the reader can hold the card's
  place from the moment it is written; the card fills it once its object
  closes, after the prose.
- The sources section is not shown. It is collected in :attr:`sources_text`,
  so the moment the string closes the caller can verify it against the
  registry and settle every marker already on screen.
- The fields written BEFORE ``answer`` (the masthead: ``kind``, ``topic``,
  ``context``, ``verdict``, ``summary``) are read into :attr:`masthead` the
  moment the ``answer`` key appears, so they can stand above the prose before
  its first word instead of being inserted over it at the end.
- The cards written AFTER it are read one complete object at a time
  (:meth:`take_cards`), so each can fill its place as soon as it is written.

A reply that is not an envelope streams nothing: a tool-calling round can
write a line of preamble before its tool call, and prose outside an envelope
cannot be told apart from it until the round ends.

Pure and synchronous; ``feed`` returns the delta to show, possibly empty.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from aiq_agent.common.citation_verification import _GROUPED_CITATION_RE
from aiq_agent.common.citation_verification import _REFERENCE_HEADING_LINE_RE
from aiq_agent.common.citation_verification import expand_grouped_citations

#: How far into the reply the ``"answer"`` key may start. Only the masthead
#: comes before it (a verdict with its reference and a summary fit well
#: inside); a reply that has not reached it by here put something else first,
#: and streaming the rest would mean guessing where the prose is.
_ANSWER_KEY_WITHIN = 1600
_ANSWER_KEY_RE = re.compile(r'"answer"\s*:\s*"')
_CARDS_KEY_RE = re.compile(r'"cards"\s*:\s*\[')
#: A tail that may still become the ``"answer"`` key, whitespace of any length
#: included, held until it completes or cannot.
_ANSWER_KEY_PREFIX_RE = re.compile(r'"(?:a(?:n(?:s(?:w(?:e(?:r(?:"\s*(?::\s*)?)?)?)?)?)?)?)?$')

#: A line is held back until it ends or grows past this, so a sources heading
#: is recognized whole before any of it is shown. Longer than every heading
#: the verifier accepts ("**Quellenangaben:**" is 19).
_LINE_HOLD = 30

#: A tail that may still become a citation or card marker, held until it
#: completes or cannot.
_MARKER_PREFIX_RE = re.compile(r"\[(?:\d[\d,\s–-]*|\[(?:c(?:a(?:r(?:d(?::\s*\d*\s*\]?)?)?)?)?)?)?$")

#: What may still become the four hex digits of a ``\u`` escape.
_HEX_PREFIX_RE = re.compile(r"[0-9A-Fa-f]{0,4}")

_ESCAPES = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}


class AnswerProseStream:
    """Feed raw reply text; get back the display-safe prose delta."""

    def __init__(self) -> None:
        self._raw = ""  # reply text not yet consumed by the state machine
        self._state = "detect"  # detect -> seek -> prose -> sources | off
        self._pending = ""  # decoded prose not yet shown
        self._line_start = True  # whether ``_pending`` begins a line
        self.emitted = ""  # everything shown so far
        #: The sources section, heading line first, once the prose reached it.
        self.sources_text = ""
        #: Whether the ``answer`` string has closed: no more prose will come.
        self.closed = False
        #: The fields written before ``answer``, once its key appeared; None
        #: when there were none or they did not parse.
        self.masthead: dict | None = None
        self._head = ""  # reply text before the ``answer`` key, for the masthead
        self._tail = ""  # reply text after the ``answer`` string, for the cards
        self._cards_at: int | None = None  # where the cards array's next element starts
        self._cards: list[dict] = []
        #: The scan of the card object still being written, kept across feeds
        #: so each token is read once rather than the object rescanned per token.
        self._card: _ObjectScan | None = None

    def feed(self, text: str) -> str:
        """Consume ``text`` and return what may be shown now."""
        if self._state == "off" or not text:
            return ""
        if self.closed:
            self._tail += text
            self._scan_cards()
            return ""
        self._raw += text
        if self._state == "detect":
            self._detect()
        if self._state == "seek":
            self._seek()
        if self._state not in {"prose", "sources"}:
            return ""
        self._decode()
        if self._state == "sources":
            self.sources_text += self._pending
            self._pending = ""
            return ""
        return self._release()

    def _detect(self) -> None:
        stripped = self._raw.lstrip()
        if not stripped:
            return
        self._state = "seek" if stripped[0] in "`{" else "off"

    def _seek(self) -> None:
        match = _ANSWER_KEY_RE.search(self._raw)
        if match is None:
            # Keep the tail the key could still straddle, however much
            # whitespace it holds; count what was read, once (a per-call count
            # of the kept tail cut off a reply fed a character at a time).
            partial = _ANSWER_KEY_PREFIX_RE.search(self._raw)
            cut = partial.start() if partial else len(self._raw)
            self._head += self._raw[:cut]
            self._raw = self._raw[cut:]
            if len(self._head) + len(self._raw) > _ANSWER_KEY_WITHIN:
                self._state = "off"
            return
        self.masthead = _object_prefix(self._head + self._raw[: match.start()])
        self._head = ""
        self._raw = self._raw[match.end() :]
        self._state = "prose"

    def _decode(self) -> None:
        """Move complete JSON-string characters into ``_pending``; close at the quote."""
        out: list[str] = []
        raw, i = self._raw, 0
        while i < len(raw):
            char = raw[i]
            if char == '"':
                self.closed = True
                self._tail = raw[i + 1 :]
                i = len(raw)
                break
            if char != "\\":
                out.append(char)
                i += 1
                continue
            decoded, width = _escape(raw, i)
            if width == 0:
                break  # an escape split across chunks: wait for the rest
            out.append(decoded)
            i += width
        self._pending += "".join(out)
        self._raw = raw[i:]
        if self.closed:
            self._scan_cards()

    def take_cards(self) -> list[dict]:
        """The cards completed since the last call, in array order."""
        taken, self._cards = self._cards, []
        return taken

    def _scan_cards(self) -> None:
        """Move every complete object of the ``cards`` array out of ``_tail``."""
        if self._cards_at is None:
            match = _CARDS_KEY_RE.search(self._tail)
            if match is None:
                return
            self._cards_at = match.end()
        while True:
            if self._card is None:
                start = self._tail.find("{", self._cards_at)
                if start < 0 or self._tail[self._cards_at : start].strip(" \n\t,"):
                    return  # the array ended, or its next element is not here yet
                self._card = _ObjectScan(start=start, index=start)
            end = self._card.end_in(self._tail)
            if end is None:
                return
            try:
                card = json.loads(self._tail[self._card.start : end])
            except ValueError:
                card = None
            if isinstance(card, dict):
                self._cards.append(card)
            self._cards_at, self._card = end, None

    def _release(self) -> str:
        """Show the longest prefix of ``_pending`` that nothing can still change."""
        shown, rest, hold_line = self._through_lines(self._pending)
        if self._state == "sources":
            self.sources_text += rest
            rest = ""
        elif self.closed:
            shown += rest
            rest = ""
        elif not hold_line:
            held = max(_held_tail(rest), _open_code_tail(rest))
            shown += rest[: len(rest) - held]
            rest = rest[len(rest) - held :]
        self._pending = rest
        # A range marker is held whole (see ``_MARKER_PREFIX_RE``), so it is
        # expanded as it is shown: ``[2–5]`` as four pills. Expanded with what
        # was shown before it, which says whether it is inside code, where
        # ``grid[1, 2]`` is an index and stays one.
        shown = _expanded_after(self.emitted, shown)
        if shown:
            self._line_start = shown.endswith("\n")
        self.emitted += shown
        return shown

    def _through_lines(self, text: str) -> tuple[str, str, bool]:
        """Split off every complete line, and turn to ``sources`` at its heading.

        Returns ``(shown, rest, hold_line)``: ``rest`` is the unfinished last
        line, or everything from the sources heading on; ``hold_line`` says
        the line began a line and is still short enough to turn out to be a
        heading, so none of it may be shown yet.
        """
        shown = ""
        line_start = self._line_start
        while True:
            newline = text.find("\n")
            line = text if newline < 0 else text[:newline]
            ended = newline >= 0 or self.closed
            if line_start and ended and _REFERENCE_HEADING_LINE_RE.fullmatch(line.rstrip()):
                self._state = "sources"
                # The lines before it go out as written: trimming them here
                # would trim only what this chunk carried.
                return shown, text, False
            if newline < 0:
                return shown, text, line_start and len(line) <= _LINE_HOLD
            shown += text[: newline + 1]
            text = text[newline + 1 :]
            line_start = True


def _object_prefix(text: str) -> dict | None:
    """The JSON object whose members ``text`` opens with, closed after its last member.

    ``{"kind": "ruling", "summary": "…",`` → ``{"kind": "ruling", "summary": "…"}``.
    """
    start = text.find("{")
    if start < 0:
        return None
    body = text[start:].rstrip().rstrip(",").rstrip()
    if body == "{":
        return None
    try:
        parsed = json.loads(body + "}")
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


@dataclass
class _ObjectScan:
    """The scan of a JSON object opening at ``start``, resumable as its text grows."""

    start: int
    index: int  # the next character to read
    depth: int = 0
    in_string: bool = False
    escaped: bool = False

    def end_in(self, text: str) -> int | None:
        """The index just past the object, or None while it is incomplete; reads each character once."""
        for index in range(self.index, len(text)):
            char = text[index]
            if self.in_string:
                if self.escaped:
                    self.escaped = False
                elif char == "\\":
                    self.escaped = True
                elif char == '"':
                    self.in_string = False
                continue
            if char == '"':
                self.in_string = True
            elif char == "{":
                self.depth += 1
            elif char == "}":
                self.depth -= 1
                if self.depth == 0:
                    return index + 1
        self.index = len(text)
        return None


def _expanded_after(shown: str, pending: str) -> str:
    """``pending`` with its grouped markers expanded, read in the context of ``shown``.

    Only a grouped marker inside ``pending`` can change it: a marker cannot
    straddle the two, because its unfinished head is held (``_held_tail``) and
    one broken by a newline reads differently from its expansion within
    ``shown``, which sends it down the fallback below. So ``pending`` with no
    candidate is returned as it is, without re-reading everything shown
    before it, which per token made a long answer quadratic on the event loop.
    """
    if _GROUPED_CITATION_RE.search(pending) is None:
        return pending
    whole = expand_grouped_citations(shown + pending, unterminated_fence_is_code=True)
    if whole.startswith(shown):
        return whole[len(shown) :]
    return expand_grouped_citations(pending, unterminated_fence_is_code=True)


def _open_code_tail(line: str) -> int:
    """How many trailing characters of an unfinished line an inline code span still holds open.

    Until its closing backtick arrives, ``m[2, 3]`` cannot be told from a
    grouped citation: shown now, it would be expanded into two pills.
    """
    if line.count("`") % 2 == 0:
        return 0
    return len(line) - line.index("`")


def _held_tail(text: str) -> int:
    """How many trailing characters must wait: a marker still being written."""
    match = _MARKER_PREFIX_RE.search(text)
    if match is None:
        return 0
    return len(text) - match.start()


def _escape(raw: str, i: int) -> tuple[str, int]:
    """Decode the JSON escape at ``raw[i]``; width 0 when it is not complete yet.

    The answering call is not in JSON mode, so the model may write what is not
    JSON: ``C:\\user`` unescaped, a lone surrogate, an unknown escape. Those are
    shown as written, backslash included, rather than stall the stream; the
    terminal frame cannot parse such an envelope either and shows it raw.
    """
    if i + 1 >= len(raw):
        return "", 0
    code = raw[i + 1]
    if code in _ESCAPES:
        return _ESCAPES[code], 2
    if code != "u":
        return raw[i : i + 2], 2  # not JSON; show it as written rather than stall
    if not _HEX_PREFIX_RE.fullmatch(raw[i + 2 : i + 6]):
        return raw[i : i + 2], 2  # ``\u`` not followed by four hex digits
    if i + 6 > len(raw):
        return "", 0
    point = int(raw[i + 2 : i + 6], 16)
    if 0xDC00 <= point < 0xE000:
        return raw[i : i + 6], 6  # a low surrogate with no high one
    if not 0xD800 <= point < 0xDC00:
        return chr(point), 6
    return _surrogate_pair(raw, i, point)


def _surrogate_pair(raw: str, i: int, high: int) -> tuple[str, int]:
    """Join the high surrogate at ``raw[i]`` with its partner, or show it as written."""
    if i + 8 > len(raw):
        return "", 0
    if raw[i + 6 : i + 8] != "\\u":
        return raw[i : i + 6], 6
    if i + 12 > len(raw):
        return "", 0
    digits = raw[i + 8 : i + 12]
    low = int(digits, 16) if _HEX_PREFIX_RE.fullmatch(digits) else 0
    if not 0xDC00 <= low < 0xE000:
        return raw[i : i + 6], 6  # the next escape is decoded on its own
    return chr(0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00)), 12
