"""Scanned and garbled PDF pages are transcribed, not described, and never lost quietly.

Covers ``page_triage`` (which road each page takes), ``transcription`` (the
vision-model OCR with its cache and caps) and the ``_run_ingestion`` wiring:

- a scanned page becomes ordinary page text, chunked like any other, and never
  enters the drawing schema;
- a ``(cid:n)`` or mojibake text layer is never indexed;
- pages past a cap are counted on the file's job status;
- a scan with no vision key fails with ``vlm_not_configured``, not "no content".

The PDFs are built here, byte by byte or with PIL, so the suite needs no fixture
files and no system fonts. The vision model is mocked throughout.
"""

from __future__ import annotations

import io
import time
from unittest.mock import MagicMock

import pytest
from knowledge_layer.llamaindex import adapter
from knowledge_layer.llamaindex import page_triage
from knowledge_layer.llamaindex import processing
from knowledge_layer.llamaindex import transcription
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor
from knowledge_layer.llamaindex.page_triage import MIN_SKETCH_PATHS
from knowledge_layer.llamaindex.page_triage import PageKind
from knowledge_layer.llamaindex.page_triage import PageSignals
from knowledge_layer.llamaindex.page_triage import classify_page
from knowledge_layer.llamaindex.page_triage import text_quality

from aiq_agent.common.credential_resolution import ResolvedCredential

GERMAN = (
    "Gemäß § 70 der Bauordnung für Wien wird die Bewilligung unter folgenden Auflagen erteilt: "
    "Die Fluchtwege im Erdgeschoß sind mit einer lichten Breite von mindestens 1,20 m auszuführen. "
    "Die Außenwände müssen der Feuerwiderstandsklasse REI 90 entsprechen. Größere Öffnungen in der "
    "Brandwand sind unzulässig; Türen sind selbstschließend in EI2 30-C auszuführen."
)
TRANSCRIPT = (
    "# Baubescheid\n\n1. Die Fluchtwege im Erdgeschoß sind mit 1,20 m auszuführen.\n\n"
    "| Bauteil | REI |\n|---|---|\n| Außenwand | 90 |"
)


# =============================================================================
# PDF builders
# =============================================================================


def _pdf(pages: list[tuple[bytes, bytes]]) -> bytes:
    """A minimal PDF: one ``(content stream, resources dict)`` per page."""
    objects: list[bytes] = [b"<< /Type /Catalog /Pages 2 0 R >>", b""]
    kids = []
    for content, resources in pages:
        page_id = len(objects) + 1
        kids.append(b"%d 0 R" % page_id)
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources %s /Contents %d 0 R >>"
            % (resources, page_id + 1)
        )
        objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(content), content))
    objects[1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(kids), len(kids))
    out = io.BytesIO()
    out.write(b"%PDF-1.7\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n%s\nendobj\n" % (number, body))
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1))
    for offset in offsets:
        out.write(b"%010d 00000 n \n" % offset)
    out.write(b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref))
    return out.getvalue()


_HELVETICA = b"<< /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> >> >>"
# A CID font with Identity-H and NO ToUnicode map: what a CAD export with
# subset fonts looks like. pdfplumber can only report glyph ids: (cid:n).
_CID_FONT = (
    b"<< /Font << /F1 << /Type /Font /Subtype /Type0 /BaseFont /CADFont /Encoding /Identity-H "
    b"/DescendantFonts [<< /Type /Font /Subtype /CIDFontType2 /BaseFont /CADFont "
    b"/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 600 >>] >> >> >>"
)


def _text_content(text: str) -> bytes:
    lines = [text[i : i + 80] for i in range(0, len(text), 80)]
    body = b"".join(
        b"(%s) Tj T* " % line.encode("cp1252").replace(b"(", b"\\(").replace(b")", b"\\)") for line in lines
    )
    return b"BT /F1 10 Tf 14 TL 40 800 Td " + body + b"ET"


def text_page(text: str = GERMAN) -> tuple[bytes, bytes]:
    return _text_content(text), _HELVETICA


def cid_page(glyphs: int = 300) -> tuple[bytes, bytes]:
    codes = "".join(f"{36 + (i % 50):04X}" for i in range(glyphs))
    return b"BT /F1 10 Tf 40 800 Td <" + codes.encode() + b"> Tj ET", _CID_FONT


def drawing_page(paths: int = 400, label: str = "") -> tuple[bytes, bytes]:
    rects = b" ".join(b"%d %d 3 3 re f" % (40 + (i % 50) * 10, 40 + (i // 50) * 10) for i in range(paths))
    label_ops = b" " + _text_content(label) if label else b""
    return rects + label_ops, _HELVETICA if label else b"<< >>"


def scan_pdf(pages: int = 1, size: tuple[int, int] = (240, 340)) -> bytes:
    """An image-only PDF, as a scanner writes it: one full-page raster per page."""
    from PIL import Image
    from PIL import ImageDraw

    images = []
    for number in range(pages):
        image = Image.new("RGB", size, "white")
        ImageDraw.Draw(image).text((10, 10), f"Seite {number + 1} Auflagen", fill="black")
        images.append(image)
    buf = io.BytesIO()
    images[0].save(buf, "PDF", resolution=30.0, save_all=True, append_images=images[1:])
    return buf.getvalue()


def _write(tmp_path, name: str, data: bytes) -> str:
    path = tmp_path / name
    path.write_bytes(data)
    return str(path)


def _plumber_texts(path: str) -> dict[int, str]:
    import pdfplumber

    with pdfplumber.open(path) as pdf:
        return {number: page.extract_text() or "" for number, page in enumerate(pdf.pages, start=1)}


# =============================================================================
# Text quality
# =============================================================================


class TestTextQuality:
    def test_clean_german_is_not_garbled(self):
        quality = text_quality(GERMAN)
        assert not quality.garbled
        assert quality.cid_share == 0 and quality.mojibake_share == 0

    def test_a_cid_run_is_garbled(self):
        assert text_quality("(cid:37)(cid:68)(cid:88)" * 30).garbled

    def test_a_few_cid_tokens_in_real_text_are_not(self):
        # A ligature or a symbol glyph without a mapping: measured at most 0.03
        # of a clean page's characters.
        assert not text_quality(GERMAN + " (cid:3) ").garbled

    def test_mojibake_is_garbled(self):
        mojibake = GERMAN.encode("utf-8").decode("cp1252", errors="replace")
        assert "Ã¤" in mojibake
        assert text_quality(mojibake).garbled

    def test_glyph_ids_shifted_into_letters_are_garbled(self):
        # pdfium's reading of the same unmapped font: every letter moved by the
        # font's glyph offset. Plenty of letters, almost no vowels.
        shifted = "".join(chr(ord(ch) - 29) if ch.isalpha() and ch.isascii() else ch for ch in GERMAN)
        assert text_quality(shifted).garbled

    def test_replacement_characters_are_garbled(self):
        assert text_quality("�" * 10 + GERMAN[:200]).garbled

    def test_a_page_of_numbers_is_not_garbled(self):
        # A cost table has almost no letters and is still real text: a garbled
        # verdict would drop it on a deployment without a vision key.
        assert not text_quality("1,20 2,40 3,60 | 4.800,00 € | 12,5 % " * 10).garbled

    def test_short_text_is_not_judged(self):
        assert not text_quality("(cid:3)(cid:4)").garbled


# =============================================================================
# Classification
# =============================================================================


def _kind(text="", paths=0, raster=0.0):
    return classify_page(PageSignals(1, text, paths, raster), min_text_chars=200, min_paths=300)


class TestClassifyPage:
    def test_text_page(self):
        assert _kind(GERMAN) is PageKind.TEXT

    def test_scan_is_little_text_and_a_page_covering_raster(self):
        assert _kind("", raster=0.98) is PageKind.SCAN

    def test_a_small_photo_on_an_empty_page_is_not_a_scan(self):
        # Not a scan (nothing to transcribe), but a picture: described once as a
        # visual page, and its raster is then not analysed a second time.
        assert _kind("", raster=0.2) is PageKind.DRAWING

    def test_a_simple_sketch_with_little_text_is_a_drawing(self):
        # A detail or a hand sketch has dozens of paths, not hundreds; the CAD
        # threshold must not decide whether it is looked at.
        assert _kind("Detail A 1:10", paths=MIN_SKETCH_PATHS) is PageKind.DRAWING

    def test_a_few_stray_paths_on_an_empty_page_stay_text(self):
        assert _kind("", paths=MIN_SKETCH_PATHS - 1) is PageKind.TEXT

    def test_drawing_needs_many_paths_and_little_text(self):
        assert _kind("Grundriss EG 1:100", paths=5000) is PageKind.DRAWING

    def test_a_table_ruled_text_page_is_text(self):
        # Was OR: 300 cell borders made a text page a "drawing".
        assert _kind(GERMAN, paths=400) is PageKind.TEXT

    def test_an_empty_page_without_paths_is_not_a_drawing(self):
        # Was OR: every near-empty page went through the drawing schema.
        assert _kind("", paths=0) is PageKind.TEXT

    def test_garbled_text_layer(self):
        assert _kind("(cid:37)" * 200) is PageKind.GARBLED

    def test_garbled_and_path_heavy_is_a_cad_sheet(self):
        assert _kind("(cid:37)" * 200, paths=5000) is PageKind.DRAWING

    def test_scan_with_a_searchable_text_layer_is_text(self):
        assert _kind(GERMAN, raster=1.0) is PageKind.TEXT

    def test_scan_with_a_garbled_hidden_layer_is_transcribed(self):
        assert _kind("(cid:37)" * 200, raster=1.0) is PageKind.GARBLED


class TestTriageRealPdfs:
    """The signals read off PDFs built the way scanners and CAD exports write them."""

    def test_each_kind_is_recognised(self, tmp_path):
        mojibake = GERMAN.encode("utf-8").decode("cp1252", errors="replace")
        path = _write(
            tmp_path,
            "mixed.pdf",
            _pdf([text_page(), cid_page(), text_page(mojibake), drawing_page(), text_page(GERMAN * 2)]),
        )
        texts = _plumber_texts(path)
        assert "(cid:" in texts[2]

        triage = page_triage.triage_pdf(path, texts, min_text_chars=200, min_paths=300)

        assert triage.kinds == {
            1: PageKind.TEXT,
            2: PageKind.GARBLED,
            3: PageKind.GARBLED,
            4: PageKind.DRAWING,
            5: PageKind.TEXT,
        }

    def test_an_image_only_pdf_is_a_scan(self, tmp_path):
        path = _write(tmp_path, "scan.pdf", scan_pdf(pages=2))
        triage = page_triage.triage_pdf(path, _plumber_texts(path), min_text_chars=200, min_paths=300)
        assert triage.transcribed == [1, 2]

    def test_an_unopenable_pdf_is_not_triaged(self, tmp_path):
        path = _write(tmp_path, "broken.pdf", b"%PDF-1.4\n% nothing\n")
        assert page_triage.triage_pdf(path, {}, min_text_chars=200, min_paths=300) is None


# =============================================================================
# Transcription: cache, caps, replies
# =============================================================================


@pytest.fixture(autouse=True)
def fresh_vlm_cache(monkeypatch):
    """A cache per test: the in-process fallback outlives a test otherwise."""
    store: dict[str, object] = {}
    monkeypatch.setattr(processing, "get_json", store.get)
    monkeypatch.setattr(processing, "set_json", lambda key, value, ttl: store.__setitem__(key, value))
    return store


def _fake_live(replies=None):
    calls: list[dict] = []

    def live(image_bytes, *, ocr_model, base_url, api_key):
        calls.append({"model": ocr_model, "base_url": base_url, "api_key": api_key})
        if callable(replies):
            return replies(len(calls))
        return TRANSCRIPT if replies is None else replies

    return live, calls


class TestTranscriptionCache:
    def test_a_second_transcription_of_the_same_page_is_served_from_cache(self, monkeypatch, fresh_vlm_cache):
        live, calls = _fake_live()
        monkeypatch.setattr(transcription, "_transcribe_live", live)

        first = transcription.transcribe_image(b"page", model="m", base_url="u", api_key="k")
        second = transcription.transcribe_image(b"page", model="m", base_url="u", api_key="k")

        assert first == second == TRANSCRIPT
        assert len(calls) == 1
        [key] = fresh_vlm_cache
        assert ":ocr:v1:" in key, "a transcription must not share a cache entry with a drawing analysis"

    def test_the_model_is_part_of_the_cache_identity(self, monkeypatch):
        live, calls = _fake_live()
        monkeypatch.setattr(transcription, "_transcribe_live", live)

        transcription.transcribe_image(b"page", model="a", base_url="u", api_key="k")
        transcription.transcribe_image(b"page", model="b", base_url="u", api_key="k")

        assert [call["model"] for call in calls] == ["a", "b"]

    def test_a_failure_is_not_cached(self, monkeypatch, fresh_vlm_cache):
        live, calls = _fake_live("[transcription - failed: APIError]")
        monkeypatch.setattr(transcription, "_transcribe_live", live)

        transcription.transcribe_image(b"page", model="m", base_url="u", api_key="k")
        transcription.transcribe_image(b"page", model="m", base_url="u", api_key="k")

        assert len(calls) == 2
        assert fresh_vlm_cache == {}

    def test_the_prompt_asks_for_a_transcription_not_a_description(self):
        prompt = transcription.TRANSCRIPTION_PROMPT
        assert "wortgetreu" in prompt and "Markdown-Tabellen" in prompt and "[unleserlich]" in prompt
        assert "zusammenfassen" in prompt


class TestTranscribePdfPages:
    def test_every_page_lands_in_one_bucket_and_the_cap_is_counted(self, tmp_path, monkeypatch):
        path = _write(tmp_path, "scan.pdf", scan_pdf(pages=6))
        replies = {1: TRANSCRIPT, 2: "[ZEICHNUNG]", 3: "[KEIN TEXT]", 4: "[transcription - failed: X]"}
        live, _calls = _fake_live(lambda n: replies.get(n, TRANSCRIPT))
        monkeypatch.setattr(transcription, "_transcribe_live", live)

        outcome = transcription.transcribe_pdf_pages(
            path, [1, 2, 3, 4, 5, 6], model="m", base_url="u", api_key="k", max_pages=5, max_dim=400, workers=1
        )

        assert sorted(outcome.texts) == [1, 5]
        assert outcome.drawings == [2]
        assert outcome.blank == [3]
        assert outcome.failed == [4]
        assert outcome.over_cap == [6]
        assert outcome.counts() == {
            "pages_transcribed": 2,
            "pages_transcription_failed": 1,
            "pages_over_ocr_cap": 1,
        }

    def test_garbage_on_an_unmeasurable_pdf_is_dropped_and_counted(self, tmp_path):
        path = _write(tmp_path, "broken.pdf", b"%PDF-1.4\n% nothing\n")
        text_pages = [{"page_number": 1, "text": GERMAN}, {"page_number": 2, "text": "(cid:37)" * 100}]

        routes = transcription.route_pdf_pages(
            path,
            text_pages,
            {page["page_number"]: page["text"] for page in text_pages},
            vlm_api_key="k",
            model="m",
            base_url="u",
            min_text_chars=200,
            min_paths=300,
            max_ocr_pages=10,
            max_dim=400,
        )

        assert [page["page_number"] for page in text_pages] == [1]
        assert routes.drawing_pages is None, "the renderer falls back to its own check"
        assert routes.counts() == {"pages_transcription_failed": 1}

    def test_a_code_fence_around_the_reply_is_removed(self):
        assert transcription.clean_reply("```markdown\n# Titel\nText\n```") == "# Titel\nText"


# =============================================================================
# _run_ingestion wiring
# =============================================================================


@pytest.fixture
def summary_db(tmp_path):
    from aiq_agent.knowledge import configure_summary_db
    from aiq_agent.knowledge import factory

    factory._document_metadata_store = None
    configure_summary_db(f"sqlite:///{tmp_path / 'summaries.db'}")
    yield
    factory._document_metadata_store = None


@pytest.fixture
def indexed(tmp_path, monkeypatch, summary_db):
    """An ingestor with the embedder and vector index mocked; ``.docs`` holds what was indexed."""
    ing = LlamaIndexIngestor({"persist_dir": str(tmp_path / "chroma"), "generate_summary": False})
    ing._embed_model = MagicMock()
    ing._initialized = True
    index_cls = MagicMock()
    monkeypatch.setattr("llama_index.core.VectorStoreIndex", index_cls)
    monkeypatch.setattr("llama_index.core.Settings", MagicMock())

    def docs():
        return [doc for call in index_cls.from_documents.call_args_list for doc in call.args[0]]

    ing.docs = docs
    return ing


def _credential(monkeypatch, api_key="vlm-key"):  # pragma: allowlist secret
    cred = ResolvedCredential(api_key=api_key, base_url="https://vlm.test/v1", model="test-vlm", source="env")
    monkeypatch.setattr(adapter, "resolve_vlm_credential", lambda organization_id=None: cred)
    monkeypatch.setattr(adapter, "_resolve_vlm_model_override", lambda organization_id=None: None)


def _ingest(ing, path: str, name: str, config: dict | None = None):
    job_id = ing.submit_job([path], "coll_ocr", config={"original_filenames": [name], **(config or {})})
    deadline = time.time() + 30
    while time.time() < deadline:
        status = ing.get_job_status(job_id)
        if status.is_terminal:
            return status
        time.sleep(0.05)
    raise AssertionError("ingestion job did not terminate in time")


@pytest.fixture
def no_drawing_vlm(monkeypatch):
    """The drawing analysis must not see a scan: fail the test if it is called."""
    drawing = MagicMock(side_effect=AssertionError("a scanned page went through the drawing schema"))
    monkeypatch.setattr(adapter, "_analyze_drawing_page_with_vlm", drawing)
    monkeypatch.setattr(adapter, "_analyze_image_with_vlm", drawing)
    return drawing


class TestScannedPdfIngestion:
    def test_a_scan_is_indexed_as_its_transcribed_text(self, tmp_path, monkeypatch, indexed, no_drawing_vlm):
        _credential(monkeypatch)
        live, calls = _fake_live()
        monkeypatch.setattr(transcription, "_transcribe_live", live)
        path = _write(tmp_path, "bescheid.pdf", scan_pdf(pages=2))

        status = _ingest(indexed, path, "bescheid.pdf")

        assert status.is_success, status.file_details[0].error_message
        docs = indexed.docs()
        assert [doc.metadata["page_label"] for doc in docs] == ["1", "2"]
        assert all(doc.metadata["content_type"] == "text" for doc in docs)
        assert "Außenwand" in docs[0].get_content()
        assert not any("DRAWING" in doc.get_content() for doc in docs)
        # Same endpoint and key as the VLM; the model defaults to the VLM's.
        expected_key = "vlm-key"  # pragma: allowlist secret
        assert calls[0] == {
            "model": adapter.DEFAULT_VLM_MODEL,
            "base_url": "https://vlm.test/v1",
            "api_key": expected_key,
        }
        assert status.file_details[0].metadata == {"pages_transcribed": 2}

    def test_pages_past_the_ocr_cap_are_counted(self, tmp_path, monkeypatch, indexed, no_drawing_vlm):
        _credential(monkeypatch)
        live, _calls = _fake_live()
        monkeypatch.setattr(transcription, "_transcribe_live", live)
        monkeypatch.setattr(adapter, "MAX_OCR_PAGES", 21)
        path = _write(tmp_path, "akt.pdf", scan_pdf(pages=25, size=(60, 85)))

        status = _ingest(indexed, path, "akt.pdf")

        assert status.is_success
        assert len(indexed.docs()) == 21, "past the old 20-page drawing cap, a scan still indexes"
        assert status.file_details[0].metadata == {"pages_transcribed": 21, "pages_over_ocr_cap": 4}

    def test_ocr_model_setting_is_used(self, tmp_path, monkeypatch, indexed, no_drawing_vlm):
        _credential(monkeypatch)
        monkeypatch.setenv("AIQ_OCR_MODEL", "mistral/ocr-vision")
        live, calls = _fake_live()
        monkeypatch.setattr(transcription, "_transcribe_live", live)

        _ingest(indexed, _write(tmp_path, "s.pdf", scan_pdf()), "s.pdf")

        assert calls[0]["model"] == "mistral/ocr-vision"

    def test_the_org_vision_override_wins(self, tmp_path, monkeypatch, indexed, no_drawing_vlm):
        _credential(monkeypatch)
        monkeypatch.setenv("AIQ_OCR_MODEL", "mistral/ocr-vision")
        monkeypatch.setattr(adapter, "_resolve_vlm_model_override", lambda organization_id=None: "tenant/vision")
        live, calls = _fake_live()
        monkeypatch.setattr(transcription, "_transcribe_live", live)

        _ingest(indexed, _write(tmp_path, "s.pdf", scan_pdf()), "s.pdf", {"organization_id": "org-1"})

        assert calls[0]["model"] == "tenant/vision"

    def test_a_scan_without_a_vision_key_fails_with_a_stable_reason(self, tmp_path, monkeypatch, indexed):
        _credential(monkeypatch, api_key="")

        status = _ingest(indexed, _write(tmp_path, "s.pdf", scan_pdf()), "s.pdf")

        error = status.file_details[0].error_message
        assert error == transcription.SCAN_NEEDS_VLM
        assert error.startswith("vlm_not_configured: ")
        assert indexed.docs() == []

    def test_a_page_the_model_calls_a_drawing_goes_to_the_drawing_analysis(self, tmp_path, monkeypatch, indexed):
        _credential(monkeypatch)
        live, _calls = _fake_live("[ZEICHNUNG]")
        monkeypatch.setattr(transcription, "_transcribe_live", live)
        drawn: list[bytes] = []

        def drawing(image_bytes, **kwargs):
            drawn.append(image_bytes)
            return ("ZEICHNUNGSTYP: grundriss\nZUSAMMENFASSUNG: Bestandsplan EG.", {"drawing_type": "grundriss"})

        monkeypatch.setattr(adapter, "_analyze_drawing_page_with_vlm", drawing)

        status = _ingest(indexed, _write(tmp_path, "plan.pdf", scan_pdf()), "plan.pdf")

        assert status.is_success
        assert len(drawn) == 1, "the scanned plan is analysed once, as a rendered page, not also as its raster"
        assert [doc.metadata["content_type"] for doc in indexed.docs()] == ["drawing"]


class TestGarbledPdfIngestion:
    def test_a_garbled_text_layer_is_replaced_by_its_transcription(self, tmp_path, monkeypatch, indexed):
        _credential(monkeypatch)
        live, calls = _fake_live()
        monkeypatch.setattr(transcription, "_transcribe_live", live)
        path = _write(tmp_path, "cad.pdf", _pdf([text_page(), cid_page()]))

        status = _ingest(indexed, path, "cad.pdf")

        assert status.is_success
        contents = {doc.metadata["page_label"]: doc.get_content() for doc in indexed.docs()}
        assert "(cid:" not in "".join(contents.values())
        assert "Bauordnung" in contents["1"], "the good page keeps its own text layer"
        assert contents["2"] == TRANSCRIPT
        assert len(calls) == 1

    def test_without_a_key_the_garbage_is_dropped_and_counted(self, tmp_path, monkeypatch, indexed):
        _credential(monkeypatch, api_key="")
        path = _write(tmp_path, "cad.pdf", _pdf([text_page(), cid_page()]))

        status = _ingest(indexed, path, "cad.pdf")

        assert status.is_success
        assert [doc.metadata["page_label"] for doc in indexed.docs()] == ["1"]
        assert status.file_details[0].metadata == {"pages_not_transcribed_no_vlm": 1}


class TestDrawingCapIsCounted:
    def test_drawing_pages_past_the_render_cap_are_counted(self, tmp_path, monkeypatch, indexed):
        _credential(monkeypatch)
        monkeypatch.setattr(adapter, "MAX_RENDERED_PAGES", 2)
        monkeypatch.setattr(
            adapter,
            "_analyze_drawing_page_with_vlm",
            lambda image_bytes, **k: ("ZEICHNUNGSTYP: grundriss", {"drawing_type": "grundriss"}),
        )
        path = _write(tmp_path, "plans.pdf", _pdf([drawing_page(label="Grundriss") for _ in range(3)]))

        status = _ingest(indexed, path, "plans.pdf")

        assert status.is_success
        assert status.file_details[0].metadata == {"drawing_pages_over_cap": 1}
