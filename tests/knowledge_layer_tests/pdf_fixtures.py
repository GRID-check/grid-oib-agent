"""Hand-built PDFs with real fonts and sizes, for tests that read type, not just text.

No PDF library is installed for writing (reportlab is not a dependency), so this emits
the few objects a page needs: the base-14 Helvetica faces, which every reader knows
without embedding, in WinAnsiEncoding so German text survives as cp1252 bytes.
"""

from __future__ import annotations

from pathlib import Path

#: ``(font, size, text)``; font ``"R"`` is Helvetica, ``"B"`` Helvetica-Bold.
PdfLine = tuple[str, float, str]

_PAGE_TOP = 800.0
_LEFT = 50.0
_LEADING = 1.45


def _escape(text: str) -> bytes:
    raw = text.encode("cp1252")
    return raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def _content(lines: list[PdfLine]) -> bytes:
    out = bytearray()
    y = _PAGE_TOP
    for font, size, text in lines:
        y -= size * _LEADING
        out += f"BT /F{font} {size} Tf {_LEFT} {y:.1f} Td (".encode("ascii") + _escape(text) + b") Tj ET\n"
    return bytes(out)


def build_pdf(pages: list[list[PdfLine]]) -> bytes:
    """A PDF with one page per list of lines, top to bottom."""
    count = len(pages)
    fonts = "<< /FR 3 0 R /FB 4 0 R >>"
    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        (
            "<< /Type /Pages /Kids [" + " ".join(f"{5 + 2 * i} 0 R" for i in range(count)) + f"] /Count {count} >>"
        ).encode(),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    ]
    for index, lines in enumerate(pages):
        content = _content(lines)
        objects.append(
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font {fonts} >> "
                f"/Contents {6 + 2 * index} 0 R >>"
            ).encode()
        )
        objects.append(b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream")
    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode()
    for offset in offsets:
        out += f"{offset:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
    return bytes(out)


def body_lines(tag: str, count: int) -> list[PdfLine]:
    """``count`` distinct 10 pt body lines, each a whole sentence tagged ``tag-NN``."""
    return [
        ("R", 10, f"Satz {tag}-{n:02d}: Die Anforderungen an Bauteile sind gemäß Tabelle einzuhalten.")
        for n in range(1, count + 1)
    ]


def footer(page: int) -> PdfLine:
    return ("R", 8, f"Brandschutzkonzept Musterstraße, Seite {page}")


def brandschutzkonzept_pages() -> list[list[PdfLine]]:
    """A three-page German report: title 18 pt, chapters 14 pt, sub-sections 12 pt, body 10 pt.

    Section 1.1 starts on page 1 and ends on page 2; a line opening with ``1.200 m²``
    sits in 1.2's body; every page carries the same footer.
    """
    page_one = [
        ("B", 18, "Brandschutzkonzept Wohnanlage Musterstraße"),
        ("R", 10, "Projekt Wohnanlage Musterstraße 12, 1010 Wien, Fassung vom 3. März 2026."),
        ("B", 14, "1 Allgemeines"),
        *body_lines("1", 4),
        ("B", 12, "1.1 Gebäudebeschreibung"),
        *body_lines("1.1a", 30),
        footer(1),
    ]
    page_two = [
        *body_lines("1.1b", 10),
        ("B", 12, "1.2 Rechtsgrundlagen"),
        ("R", 10, "Maßgeblich ist die OIB-Richtlinie 2, Ausgabe Mai 2023, für Brandabschnitte bis"),
        ("R", 10, "1.200 m² Netto-Grundfläche je Geschoß und die Wiener Bauordnung in geltender Fassung."),
        *body_lines("1.2", 6),
        ("B", 14, "2 Brandabschnitte"),
        *body_lines("2", 5),
        footer(2),
    ]
    page_three = [
        ("B", 10, "2.1 Brandabschnittsbildende Wände"),
        *body_lines("2.1", 12),
        ("B", 10, "§ 3"),
        ("B", 10, "Fluchtwege"),
        *body_lines("3", 6),
        footer(3),
    ]
    return [page_one, page_two, page_three]


def write_pdf(path: Path, pages: list[list[PdfLine]]) -> Path:
    path.write_bytes(build_pdf(pages))
    return path
