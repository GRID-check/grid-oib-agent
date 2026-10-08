"""A mail body as plain text, whichever of Outlook's three forms the archive kept.

A message stores its body as plain text, HTML, compressed RTF, or several of
them. The Outlook.com fixture keeps RTF only for most of its 183 items, and the
Enron fixture plain text only, so every form has to read. Plain text wins when
it is there, because it is what the sender's client wrote; HTML is next; RTF,
which libpff hands over decompressed, is last.

Encapsulated HTML (an RTF body with ``\\fromhtml1``) needs no separate path:
its markup lives in ``{\\*\\htmltag ...}`` destinations, which an RTF reader
skips, so what is left is the text a reader saw.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from lxml import html as lxml_html
from lxml.etree import ParserError
from striprtf.striprtf import rtf_to_text

#: The longest body kept, in characters. A body past it is cut and says so.
MAX_BODY_CHARS = 1_000_000

#: Elements whose end is a line break in what a reader sees.
_BLOCK_TAGS = frozenset(
    {
        "address",
        "article",
        "blockquote",
        "br",
        "div",
        "dl",
        "dt",
        "dd",
        "footer",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "header",
        "hr",
        "li",
        "ol",
        "p",
        "pre",
        "section",
        "table",
        "tr",
        "ul",
    }
)

_SKIPPED_TAGS = ("script", "style", "head", "title")
_BLANK_RUN = re.compile(r"\n[ \t]*\n(?:[ \t]*\n)+")
_TRAILING_SPACE = re.compile(r"[ \t]+\n")


@dataclass(frozen=True)
class BodyText:
    text: str
    #: Which of the stored forms the text came from: plain, html, rtf, or none.
    source: str
    truncated: bool


def decode(raw: bytes | str | None) -> str:
    """Bytes from libpff as text: UTF-8 for a Unicode archive, the ANSI code page for an old one."""
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", errors="replace")


def html_to_text(markup: str) -> str:
    """What a mail client shows of ``markup``, line breaks kept."""
    if not markup.strip():
        return ""
    try:
        root = lxml_html.document_fromstring(markup)
    except (ParserError, ValueError):
        return markup
    # Listed first: dropping an element while iterating skips its next sibling.
    for element in list(root.iter(*_SKIPPED_TAGS)):
        element.drop_tree()
    for element in root.iter(*_BLOCK_TAGS):
        element.tail = "\n" + (element.tail or "")
    return root.text_content()


def body_text(plain: bytes | None, markup: bytes | None, rtf: bytes | None) -> BodyText:
    """The body as text, from the best form stored, bounded."""
    for source, convert, raw in (
        ("plain", decode, plain),
        ("html", lambda value: html_to_text(decode(value)), markup),
        ("rtf", lambda value: rtf_to_text(decode(value), errors="ignore"), rtf),
    ):
        if not raw:
            continue
        text = _tidy(convert(raw))
        if text:
            return _bounded(text, source)
    return BodyText(text="", source="none", truncated=False)


def _tidy(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    text = _TRAILING_SPACE.sub("\n", text)
    return _BLANK_RUN.sub("\n\n", text).strip()


def _bounded(text: str, source: str) -> BodyText:
    if len(text) <= MAX_BODY_CHARS:
        return BodyText(text=text, source=source, truncated=False)
    return BodyText(text=text[:MAX_BODY_CHARS], source=source, truncated=True)
