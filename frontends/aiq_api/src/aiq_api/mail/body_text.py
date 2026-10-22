"""A mail body as plain text, whichever of its three forms the message kept.

Shared by the two places mail arrives: an inbound message to a project's
address (:mod:`aiq_api.mail.read`) and a message in an Outlook archive
(:mod:`aiq_api.mail_archive.reader`). A message stores its body as plain text,
HTML, RTF, or several of them. The Outlook.com fixture keeps RTF only for most
of its 183 items, and the Enron fixture plain text only, so every form has to
read. Plain text wins when it is there, because it is what the sender's client
wrote; HTML is next; RTF (libpff hands it over decompressed) is last.

HTML reads as a browser shows it: the markup's own line breaks and
indentation are one space (outside ``<pre>``), and a block element ends a
line. A table keeps its cells apart: each cell but a row's last ends in
`` | ``, so "Stellplätze | 12" does not read "Stellplätze12" (RT-X3).

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

#: Elements that are one cell of a table row.
_CELL_TAGS = frozenset({"td", "th"})

#: What stands between two cells of a row.
CELL_SEPARATOR = " | "

_SKIPPED_TAGS = ("script", "style", "head", "title")
#: Whitespace in markup, which a browser shows as one space (outside ``<pre>``).
_MARKUP_SPACE = re.compile(r"\s+")
_LINE_START_SPACE = re.compile(r"\n ")
#: Characters XML 1.0 does not allow. libxml2 reads past some of them, and lxml
#: then refuses to write a text node that holds one (``ValueError``).
_NOT_XML = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]")
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
    """What a mail client shows of ``markup``, line breaks and table cells kept apart."""
    markup = _NOT_XML.sub("", markup)
    if not markup.strip():
        return ""
    try:
        root = lxml_html.document_fromstring(markup)
    except ValueError:
        # A str that declares its own encoding (``<?xml ... encoding=...?>``,
        # which Outlook writes) is refused as a str; as bytes it parses.
        root = _parse_bytes(markup)
    except ParserError:
        # Nothing to parse (markup that is only a comment or a doctype).
        return ""
    if root is None:
        return ""
    # Listed first: dropping an element while iterating skips its next sibling.
    for element in list(root.iter(*_SKIPPED_TAGS)):
        element.drop_tree()
    _collapse_whitespace(root)
    for row in root.iter("tr"):
        cells = [child for child in row if child.tag in _CELL_TAGS]
        for cell in cells[:-1]:
            cell.tail = CELL_SEPARATOR + (cell.tail or "")
    for element in root.iter(*_BLOCK_TAGS):
        element.tail = "\n" + (element.tail or "")
    return _LINE_START_SPACE.sub("\n", root.text_content())


def _parse_bytes(markup: str) -> lxml_html.HtmlElement | None:
    try:
        return lxml_html.document_fromstring(markup.encode("utf-8", errors="replace"))
    except (ParserError, ValueError):
        return None


def _collapse_whitespace(root: lxml_html.HtmlElement) -> None:
    """Fold the markup's own line breaks and indentation to one space, as a browser does."""
    for element in root.iter():
        if element.text and isinstance(element.tag, str) and not _preformatted(element):
            element.text = _MARKUP_SPACE.sub(" ", element.text)
        parent = element.getparent()
        if element.tail and (parent is None or not _preformatted(parent)):
            element.tail = _MARKUP_SPACE.sub(" ", element.tail)


def _preformatted(element: lxml_html.HtmlElement) -> bool:
    return element.tag == "pre" or any(True for _ in element.iterancestors("pre"))


def body_text(plain: bytes | str | None, markup: bytes | str | None, rtf: bytes | str | None) -> BodyText:
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
