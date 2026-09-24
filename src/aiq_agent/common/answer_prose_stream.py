"""The answer's prose while the model is still writing it, safe to show.

The final call writes one ```answer_json envelope whose ``answer`` string comes
first (the schema and every example put it there), then the cards. This reads
that string out of the raw token stream as it grows and hands back what may be
shown NOW: JSON-unescaped, and without the three things only the finished
answer can settle.

- ``[N]`` citation markers. ``verify_citations`` removes the ones it cannot
  back and ``sanitize_report`` renumbers the rest, so a marker shown early is a
  claim about a source nobody has checked yet.
- ``[[card:N]]`` markers. The card registry resolves them after the reply.
- The sources section. It is rebuilt from the registry.

The terminal frame carries the verified answer and REPLACES what was streamed
(``docs/design/streaming-chat-answer.md``), so the stream never has to be right
about anything it withholds, only never show it early. A reply that is not an
envelope streams nothing: a tool-calling round can write a line of preamble
before its tool call, and prose outside an envelope cannot be told apart from
it until the round ends.

Pure and synchronous; ``feed`` returns the delta to show, possibly empty.
"""

from __future__ import annotations

import re

from aiq_agent.common.citation_verification import _REFERENCE_HEADING_LINE_RE

#: How far into the reply the ``"answer"`` key may start. The envelope opens
#: with it; a reply that has not reached it by here put something else first,
#: and streaming the rest would mean guessing where the prose is.
_ANSWER_KEY_WITHIN = 400
_ANSWER_KEY_RE = re.compile(r'"answer"\s*:\s*"')

#: A line is held back until it ends or grows past this, so a sources heading
#: is recognized whole before any of it is shown. Longer than every heading
#: the verifier accepts ("**Quellenangaben:**" is 19).
_LINE_HOLD = 30

#: Markers that are complete and withheld. Horizontal space before a citation
#: goes with it, or the stream would show "Satz ." for "Satz [1].".
_COMPLETE_MARKER_RE = re.compile(r"[^\S\n]*\[\d+(?:\s*[,–-]\s*\d+)*\]|\[\[card:\s*\d+\s*\]\]")
#: A tail that may still become a marker, held until it does or cannot.
_MARKER_PREFIX_RE = re.compile(r"\[(?:\d[\d,\s–-]*|\[(?:c(?:a(?:r(?:d(?::\s*\d*\s*\]?)?)?)?)?)?)?$")

_ESCAPES = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}


class AnswerProseStream:
    """Feed raw reply text; get back the display-safe prose delta."""

    def __init__(self) -> None:
        self._raw = ""  # reply text not yet consumed by the state machine
        self._state = "detect"  # detect -> seek -> answer -> done | off
        self._seen = 0  # reply characters consumed while seeking the key
        self._pending = ""  # decoded prose not yet shown
        self._line_start = True  # whether ``_pending`` begins a line
        self.emitted = ""  # everything shown so far

    @property
    def streaming(self) -> bool:
        """Whether this reply is (still) an answer being shown."""
        return self._state in {"seek", "answer"}

    def feed(self, text: str) -> str:
        """Consume ``text`` and return what may be shown now."""
        if self._state in {"done", "off"} or not text:
            return ""
        self._raw += text
        if self._state == "detect":
            self._detect()
        if self._state == "seek":
            self._seek()
        if self._state != "answer":
            return ""
        closed = self._decode()
        return self._release(final=closed)

    def _detect(self) -> None:
        stripped = self._raw.lstrip()
        if not stripped:
            return
        self._state = "seek" if stripped[0] in "`{" else "off"

    def _seek(self) -> None:
        match = _ANSWER_KEY_RE.search(self._raw)
        if match is None:
            self._seen += len(self._raw)
            if self._seen > _ANSWER_KEY_WITHIN:
                self._state = "off"
            # Keep a tail the key could still straddle.
            self._raw = self._raw[-16:]
            return
        self._raw = self._raw[match.end() :]
        self._state = "answer"

    def _decode(self) -> bool:
        """Move complete JSON-string characters into ``_pending``; True at the closing quote."""
        out: list[str] = []
        raw, i = self._raw, 0
        while i < len(raw):
            char = raw[i]
            if char == '"':
                self._pending += "".join(out)
                self._raw = ""
                self._state = "done"
                return True
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
        return False

    def _release(self, *, final: bool) -> str:
        """Show the longest prefix of ``_pending`` that nothing can still change."""
        pending = _COMPLETE_MARKER_RE.sub("", self._pending)
        shown, rest, hold_line = self._through_lines(pending, final=final)
        if final or self._state == "done":
            shown += "" if self._state == "done" and not final else rest
            rest = ""
        elif not hold_line:
            held = _held_tail(rest)
            shown += rest[: len(rest) - held]
            rest = rest[len(rest) - held :]
        self._pending = rest
        if shown:
            self._line_start = shown.endswith("\n")
        self.emitted += shown
        return shown

    def _through_lines(self, text: str, *, final: bool) -> tuple[str, str, bool]:
        """Split off every complete line; stop for good at a sources heading.

        Returns ``(shown, rest, hold_line)``: ``rest`` is the unfinished last
        line, and ``hold_line`` says it began a line and is still short enough
        to turn out to be a heading, so none of it may be shown yet.
        """
        shown = ""
        line_start = self._line_start
        while True:
            newline = text.find("\n")
            line = text if newline < 0 else text[:newline]
            if line_start and (newline >= 0 or final) and _REFERENCE_HEADING_LINE_RE.fullmatch(line.rstrip()):
                self._state = "done"
                return shown.rstrip("\n") + ("\n" if shown else ""), "", False
            if newline < 0:
                return shown, text, line_start and len(line) <= _LINE_HOLD
            shown += text[: newline + 1]
            text = text[newline + 1 :]
            line_start = True


def _held_tail(text: str) -> int:
    """How many trailing characters must wait: a marker in the making, or spaces."""
    match = _MARKER_PREFIX_RE.search(text)
    if match is not None:
        start = match.start()
        # The space before a citation is withheld with it.
        while start > 0 and text[start - 1] in " \t":
            start -= 1
        return len(text) - start
    stripped = text.rstrip(" \t")
    return len(text) - len(stripped)


def _escape(raw: str, i: int) -> tuple[str, int]:
    """Decode the JSON escape at ``raw[i]``; width 0 when it is not complete yet."""
    if i + 1 >= len(raw):
        return "", 0
    code = raw[i + 1]
    if code in _ESCAPES:
        return _ESCAPES[code], 2
    if code != "u":
        return code, 2  # not JSON; show it rather than stall
    if i + 6 > len(raw):
        return "", 0
    point = int(raw[i + 2 : i + 6], 16)
    if 0xD800 <= point < 0xDC00:  # high surrogate: needs its partner
        if i + 12 > len(raw):
            return "", 0
        low = int(raw[i + 8 : i + 12], 16)
        return chr(0x10000 + ((point - 0xD800) << 10) + (low - 0xDC00)), 12
    return chr(point), 6
