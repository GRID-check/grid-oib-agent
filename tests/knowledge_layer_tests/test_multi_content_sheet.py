"""A multi-content sheet, end to end at the seams (issues #437/#440).

The sample file behind #440 (``220725_P4_final.pdf``) carries several distinct
contents on one page — a perspectival detail section, a build-up legend,
ordered process steps, material notes — and must be read and indexed per
depiction, not as one paragraph. The file itself cannot live in the repo, so
this module builds an equivalent fixture: one page, two floor plans side by
side plus a scale note, as vector linework with a sparse text layer.

Two joins are pinned here, and only these two:

- detection: such a sheet IS a visual page (sparse text) and renders to bytes
  the VLM stage can read — it must never silently index as text only (#437).
- mapping: a two-depiction analysis becomes two explicitly labelled chunks
  ("Floor plan 1 of 2", "Floor plan 2 of 2") with their sheet position in the
  metadata — the explicit per-region chunking #440 needs (#440).
"""

import json
from typing import Any

from knowledge_layer.llamaindex import adapter
from knowledge_layer.llamaindex import visual_analysis as va
from knowledge_layer.llamaindex import visual_domains as vd


def two_plan_sheet_pdf() -> bytes:
    """One page, two floor-plan room grids side by side, sparse text layer.

    Hand-built PDF bytes (no extra dependency): two stroked-rectangle grids
    as vector linework plus three short labels. The stripped text stays well
    under the visual-page text threshold, mirroring a plan sheet whose labels
    pdfplumber can read but whose content is the linework.
    """
    lines: list[str] = ["BT /F1 16 Tf 50 800 Td (Grundriss EG    Grundriss OG) Tj ET"]
    for plan in (0, 1):
        origin_x = 50 + plan * 270
        for row in range(4):
            for col in range(3):
                x = origin_x + col * 60
                y = 600 - row * 50
                lines.append(f"{x} {y} 55 45 re S")
    lines.append("BT /F1 10 Tf 50 60 Td (Massstab 1:100) Tj ET")
    content = "\n".join(lines).encode("latin-1")

    objects: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
            b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>"
        ),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n" + content + b"\nendstream",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = [0]
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode("ascii") + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode("ascii")
    for offset in offsets[1:]:
        out += f"{offset:010d} 00000 n \n".encode("ascii")
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode("ascii")
    return bytes(out)


def _two_floor_plan_analysis(registry: vd.DomainRegistry) -> dict[str, Any]:
    """What the VLM stage should return for the fixture: one segment per plan."""
    reply = json.dumps(
        {
            "segments": [
                {
                    "domain": "architecture",
                    "segment_type": "floor_plan",
                    "title": "EG",
                    "scale": "1:100",
                    "summary": "Grundriss des Erdgeschosses, links.",
                    "bbox": [0.02, 0.05, 0.48, 0.95],
                },
                {
                    "domain": "architecture",
                    "segment_type": "floor_plan",
                    "title": "OG",
                    "scale": "1:100",
                    "summary": "Grundriss des Obergeschosses, rechts.",
                    "bbox": [0.52, 0.05, 0.98, 0.95],
                },
            ],
            "document": {"title": "Zwei Grundrisse", "summary": "Vergleichsblatt EG und OG."},
        }
    )
    analysis = va.parse_visual_analysis(reply, registry)
    assert analysis is not None
    return analysis


class TestMultiContentSheetDetection:
    def test_a_two_depiction_sheet_renders_as_one_visual_page(self, tmp_path) -> None:
        """The #440 shape must reach the VLM: sparse text, vector linework."""
        from knowledge_layer.llamaindex import processing as _processing

        pdf = tmp_path / "zwei-grundrisse.pdf"
        pdf.write_bytes(two_plan_sheet_pdf())

        text_pages = adapter._extract_text_from_pdf(str(pdf))
        stripped = {page["page_number"]: adapter._strip_watermark_lines(page["text"]) for page in text_pages}
        assert sum(len(text) for text in stripped.values()) < adapter.VISUAL_PAGE_MIN_TEXT_CHARS

        rendered = _processing.render_visual_pages_no_vlm(str(pdf), page_texts=stripped)

        assert [page["page_number"] for page in rendered] == [1]
        assert len(rendered[0]["image_bytes"]) > 0


class TestMultiContentSheetMapping:
    def test_two_plans_become_two_labelled_chunks(self) -> None:
        """Explicit per-region chunking: each depiction its own chunk, its own
        header ordinal, and its sheet position in the metadata the detail view
        reads back."""
        registry = vd.resolve_registry("architecture,general")
        analysis = _two_floor_plan_analysis(registry)

        docs = adapter.visual_documents(
            "drawing",
            "unused when the analysis parsed",
            {"analysis": analysis},
            file_name="zwei-grundrisse.pdf",
            file_size=1100,
            page_number=1,
        )

        assert [doc.metadata["drawing_type"] for doc in docs] == ["floor_plan", "floor_plan"]
        assert [doc.metadata["segment_index"] for doc in docs] == [0, 1]
        assert {doc.metadata["segment_count"] for doc in docs} == {2}
        # The first chunk also carries the document lead, so its first line is
        # the sheet summary — the ordinal header is the segment's own line.
        headers = [next(line for line in doc.text.splitlines() if line.startswith("Floor plan")) for doc in docs]
        assert headers[0].startswith("Floor plan 1 of 2")
        assert headers[1].startswith("Floor plan 2 of 2")
        assert "Erdgeschosses" in docs[0].text
        assert "Obergeschosses" in docs[1].text
