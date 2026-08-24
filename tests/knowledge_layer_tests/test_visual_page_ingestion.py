"""Unit tests for visual/vector PDF-page rendering + drawing captioning.

Covers the fix for image-only / vector CAD PDFs (e.g. an architectural
"Perspektivischer Schnitt") whose pages carry thousands of vector paths but
almost no extractable text — often only a licence watermark. The text and
embedded-image extractors both miss such pages, so the document summary used to
describe the watermark ("VECTORWORKS EDUCATIONAL VERSION ...") instead of the
drawing.

Covers:
- ``_strip_watermark_lines`` — licence/watermark boilerplate removal.
- ``_parse_drawing_fields`` — parsing the structured drawing-VLM response.
- ``_summary_from_drawing_fields`` — building a watermark-free document summary
  from rendered-page descriptions.
- ``processing.render_visual_pages_no_vlm`` — the visual-page heuristic (text-sparse OR
  path-heavy) with pypdfium2 mocked.
- The ``_run_ingestion`` drawing branch end-to-end (heavy collaborators mocked):
  a watermark-only PDF is rendered, captioned, and summarised from the drawing
  — never from the watermark.
"""

import time
from unittest.mock import MagicMock

import pytest
from knowledge_layer.llamaindex import adapter
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor
from knowledge_layer.llamaindex.adapter import _parse_drawing_fields
from knowledge_layer.llamaindex.adapter import _scrub_watermark_phrases
from knowledge_layer.llamaindex.adapter import _strip_watermark_lines
from knowledge_layer.llamaindex.adapter import _summary_from_drawing_fields

from aiq_agent.common.credential_resolution import ResolvedCredential


def _patch_vlm_credential(monkeypatch, api_key: str):
    """Point the ingestion path's VLM credential resolver at a fixed key
    (the BYOK-aware chokepoint ingestion consults, not ``_get_vlm_api_key``)."""
    cred = ResolvedCredential(
        api_key=api_key,
        base_url="https://vlm.test/v1",
        model="test-vlm",
        source="env" if api_key else "none",
    )
    monkeypatch.setattr(adapter, "resolve_vlm_credential", lambda organization_id=None: cred)


# A representative structured response from the drawing-aware VLM prompt.
_VLM_DRAWING_RESPONSE = (
    "ZEICHNUNGSTYP: perspektive\n"
    "MASSSTAB: Maßstabsfiguren vorhanden\n"
    "TITEL/PROJEKT: Bildungscampus\n"
    "GESCHOSSE/EBENEN: 5 Obergeschosse und ein Untergeschoss\n"
    "RÄUME/ELEMENTE: Ateliers, zentrales Atrium, Freitreppe, Terrassen\n"
    "ABMESSUNGEN/KOTEN: keine sichtbar\n"
    "RÄUMLICHE BEZIEHUNGEN: Gestapelte Geschosse um ein durchgehendes Atrium, "
    "erschlossen über eine zentrale Treppe.\n"
    "WASSERZEICHEN: VECTORWORKS EDUCATIONAL VERSION\n"
    "ZUSAMMENFASSUNG: Perspektivischer Schnitt durch einen fünfgeschossigen "
    "Bildungsbau mit zentralem Atrium und Freitreppe."
)


# =============================================================================
# Watermark stripping
# =============================================================================


class TestStripWatermarkLines:
    def test_removes_vectorworks_watermark(self):
        text = "VECTORWORKS EDUCATIONAL VERSION\nGrundriss EG\nVECTORWORKS EDUCATIONAL VERSION"
        assert _strip_watermark_lines(text) == "Grundriss EG"

    def test_case_insensitive_and_whitespace_tolerant(self):
        assert _strip_watermark_lines("  vectorworks educational version  ") == ""

    def test_keeps_real_content(self):
        text = "Brandschutzkonzept\nBauteil F90"
        assert _strip_watermark_lines(text) == text

    def test_none_and_empty(self):
        assert _strip_watermark_lines(None) == ""
        assert _strip_watermark_lines("") == ""


# =============================================================================
# Substring watermark scrubbing for VLM captions
# =============================================================================


class TestScrubWatermarkPhrases:
    def test_scrubs_watermark_mid_line(self):
        # The line-level filter never fires here (the stamp is embedded in
        # prose), so without the substring scrub this leaks into the summary.
        caption = "Ein Grundriss EG. VECTORWORKS EDUCATIONAL VERSION im Plan. Zentrales Atrium."
        scrubbed = _scrub_watermark_phrases(caption)
        assert "VECTORWORKS" not in scrubbed.upper()
        assert "EDUCATIONAL VERSION" not in scrubbed.upper()
        assert "Grundriss EG" in scrubbed
        assert "Zentrales Atrium" in scrubbed

    def test_scrubs_watermark_whole_line(self):
        caption = "VECTORWORKS EDUCATIONAL VERSION\nGrundriss EG mit zentralem Atrium."
        scrubbed = _scrub_watermark_phrases(caption)
        assert "VECTORWORKS" not in scrubbed.upper()
        assert scrubbed == "Grundriss EG mit zentralem Atrium."

    def test_clean_caption_unchanged(self):
        caption = "Perspektivischer Schnitt durch einen fünfgeschossigen Bildungsbau."
        assert _scrub_watermark_phrases(caption) == caption

    def test_collapses_whitespace_left_behind(self):
        # Removing the stamp must not leave a double space or a dangling blank line.
        scrubbed = _scrub_watermark_phrases("Grundriss.\nVECTORWORKS EDUCATIONAL VERSION\nSchnitt.")
        assert scrubbed == "Grundriss.\nSchnitt."

    def test_scrub_to_empty_and_none_are_falsy(self):
        # A caption that is nothing but a watermark scrubs to "" (falsy) so the
        # ``caption[:500] or None`` fallback yields None, never an empty summary.
        assert _scrub_watermark_phrases("VECTORWORKS EDUCATIONAL VERSION") == ""
        assert _scrub_watermark_phrases("   ") == ""
        assert _scrub_watermark_phrases(None) == ""
        assert _scrub_watermark_phrases("") == ""


class TestGenericVlmPromptWatermarkExclusion:
    """The generic image-caption prompt (used for standalone JPG/PNG and
    PDF-embedded rasters) must instruct the model to exclude watermark/licence
    text — the drawing path already does, the generic path did not."""

    def _capture_prompt(self, monkeypatch, *, extract_charts):
        captured = {}

        class _FakeCompletions:
            def create(self, *a, **k):
                captured["prompt"] = k["messages"][0]["content"][0]["text"]
                msg = MagicMock()
                msg.content = "TYPE: image\nA plan."
                choice = MagicMock()
                choice.message = msg
                resp = MagicMock()
                resp.choices = [choice]
                return resp

        class _FakeClient:
            def __init__(self, *a, **k):
                self.chat = MagicMock()
                self.chat.completions = _FakeCompletions()

        import openai

        monkeypatch.setattr(openai, "OpenAI", _FakeClient)
        monkeypatch.setattr(adapter, "_get_vlm_api_key", lambda: "k")
        adapter._analyze_image_with_vlm(b"fakeimagebytes", extract_charts=extract_charts)
        return captured["prompt"]

    @pytest.mark.parametrize("extract_charts", [True, False])
    def test_prompt_excludes_watermarks(self, monkeypatch, extract_charts):
        prompt = self._capture_prompt(monkeypatch, extract_charts=extract_charts)
        assert "VECTORWORKS EDUCATIONAL VERSION" in prompt
        # Shifts toward content/meaning rather than transcribing all visible text.
        assert "content" in prompt.lower() or "CONTENT" in prompt
        # The old "any text visible" transcription instruction is gone.
        assert "any text visible" not in prompt.lower()


# =============================================================================
# Drawing-field parsing
# =============================================================================


class TestParseDrawingFields:
    def test_parses_known_fields(self):
        fields = _parse_drawing_fields(_VLM_DRAWING_RESPONSE)
        assert fields["drawing_type"] == "perspektive"
        assert fields["scale"] == "Maßstabsfiguren vorhanden"
        assert fields["title"] == "Bildungscampus"
        assert fields["watermark"] == "VECTORWORKS EDUCATIONAL VERSION"
        assert fields["summary"].startswith("Perspektivischer Schnitt")

    def test_ignores_unknown_lines_and_blanks(self):
        fields = _parse_drawing_fields("ZEICHNUNGSTYP: schnitt\nrandom noise line\nMASSSTAB: \n")
        assert fields == {"drawing_type": "schnitt"}

    def test_empty_response(self):
        assert _parse_drawing_fields("") == {}

    def test_parses_extended_detail_fields(self):
        response = (
            "ZEICHNUNGSTYP: schnitt\n"
            "NUTZUNG: Schule\n"
            "MATERIALIEN/BAUWEISE: Stahlbeton, Glasfassade\n"
            "DETAILBESCHREIBUNG: Ein Längsschnitt durch einen Bildungsbau mit zentralem Atrium und Freitreppe.\n"
        )
        fields = _parse_drawing_fields(response)
        assert fields["use"] == "Schule"
        assert fields["materials"] == "Stahlbeton, Glasfassade"
        assert fields["detail"].startswith("Ein Längsschnitt")


# =============================================================================
# Document summary from drawing fields
# =============================================================================


class TestSummaryFromDrawingFields:
    def test_prefers_zusammenfassung_sentences(self):
        pages = [{"fields": _parse_drawing_fields(_VLM_DRAWING_RESPONSE)}]
        summary = _summary_from_drawing_fields(pages)
        assert summary is not None
        assert summary.startswith("Perspektivischer Schnitt")
        # The watermark must never appear in the summary.
        assert "VECTORWORKS" not in summary.upper()

    def test_synthesises_from_type_and_scale_when_no_sentence(self):
        pages = [{"fields": {"drawing_type": "grundriss", "scale": "1:100"}}]
        summary = _summary_from_drawing_fields(pages)
        assert "grundriss" in summary
        assert "1:100" in summary

    def test_returns_none_without_usable_fields(self):
        assert _summary_from_drawing_fields([{"fields": {}}]) is None
        assert _summary_from_drawing_fields([]) is None


# =============================================================================
# VLM runtime model override (org-scoped, ingest_vlm agent group)
# =============================================================================


class TestVlmModelOverride:
    def test_none_without_org(self):
        assert adapter._resolve_vlm_model_override(None) is None

    def test_reads_ingest_vlm_group_for_org(self, monkeypatch):
        from aiq_agent.common import model_overrides

        monkeypatch.setattr(
            model_overrides, "resolve_org_model_overrides", lambda org: {"ingest_vlm": "tenant/vision-model"}
        )
        assert adapter._resolve_vlm_model_override("org-1") == "tenant/vision-model"

    def test_fails_open_to_none_on_error(self, monkeypatch):
        from aiq_agent.common import model_overrides

        def boom(org):
            raise RuntimeError("BFF unreachable")

        monkeypatch.setattr(model_overrides, "resolve_org_model_overrides", boom)
        assert adapter._resolve_vlm_model_override("org-1") is None


# =============================================================================
# Visual-page render heuristic (pypdfium2 mocked)
# =============================================================================


class _FakeTextPage:
    def __init__(self, text):
        self._text = text

    def get_text_range(self):
        return self._text

    def close(self):
        pass


class _FakeObj:
    def __init__(self, type_):
        self.type = type_


class _FakeBitmap:
    def __init__(self, size):
        from PIL import Image

        self._img = Image.new("RGB", size, "white")

    def to_pil(self):
        return self._img


class _FakePage:
    def __init__(self, text, n_paths, size=(1729, 1417)):
        self._text = text
        self._n_paths = n_paths
        self._size = size

    def get_textpage(self):
        return _FakeTextPage(self._text)

    def get_objects(self):
        return [_FakeObj(adapter._PAGEOBJ_PATH) for _ in range(self._n_paths)]

    def get_size(self):
        return self._size

    def render(self, scale):
        w, h = self._size
        return _FakeBitmap((max(1, int(w * scale)), max(1, int(h * scale))))

    def close(self):
        pass


def _install_fake_pdf(monkeypatch, pages):
    pdfium = pytest.importorskip("pypdfium2")

    class _FakeDoc:
        def __init__(self, path):
            self._pages = pages

        def __len__(self):
            return len(self._pages)

        def __getitem__(self, idx):
            return self._pages[idx]

        def close(self):
            pass

    monkeypatch.setattr(pdfium, "PdfDocument", _FakeDoc)


class TestRenderVisualPagesNoVlm:
    def test_watermark_only_vector_page_is_rendered(self, monkeypatch):
        from knowledge_layer.llamaindex import processing as _processing

        # Only a watermark as text, tens of thousands of vector paths.
        _install_fake_pdf(monkeypatch, [_FakePage("VECTORWORKS EDUCATIONAL VERSION", n_paths=5000)])

        out = _processing.render_visual_pages_no_vlm("ignored.pdf")

        assert len(out) == 1
        assert out[0]["page_number"] == 1
        assert len(out[0]["image_bytes"]) > 0
        # Rendered near the long-edge target (±2px for scale rounding).
        assert abs(max(out[0]["width"], out[0]["height"]) - 2048) <= 2

    def test_text_page_is_skipped(self, monkeypatch):
        from knowledge_layer.llamaindex import processing as _processing

        # Plenty of text, no vector paths → not a visual page.
        _install_fake_pdf(monkeypatch, [_FakePage("A" * 5000, n_paths=0)])

        out = _processing.render_visual_pages_no_vlm("ignored.pdf")

        assert out == []

    def test_render_cap_is_respected(self, monkeypatch):
        from knowledge_layer.llamaindex import processing as _processing

        pages = [_FakePage("", n_paths=1000) for _ in range(5)]
        _install_fake_pdf(monkeypatch, pages)

        out = _processing.render_visual_pages_no_vlm("ignored.pdf", max_pages=2)

        assert len(out) == 2


# =============================================================================
# _run_ingestion drawing branch (heavy collaborators mocked)
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
def ingestor(tmp_path, monkeypatch):
    """A LlamaIndexIngestor with embeddings + vector index mocked out."""

    def fake_invoke(prompt):
        # The tag prompt is the only one containing "klassifizierst".
        if "klassifizierst" not in prompt:
            # Echo that the summary LLM actually saw the drawing description
            # (not the watermark) — the drawing text mentions "Atrium".
            content = "Perspektivischer Schnitt eines Bildungsbaus." if "Atrium" in prompt else "GENERIC"
            return MagicMock(content=content)
        return MagicMock(content='["Schnitt", "Perspektive"]')

    llm = MagicMock()
    llm.invoke.side_effect = fake_invoke

    ing = LlamaIndexIngestor(
        {
            "persist_dir": str(tmp_path / "chroma"),
            "generate_summary": True,
            "summary_llm": llm,
        }
    )
    ing._embed_model = MagicMock()
    ing._initialized = True
    monkeypatch.setattr("llama_index.core.VectorStoreIndex", MagicMock())
    monkeypatch.setattr("llama_index.core.Settings", MagicMock())
    return ing


def _wait_terminal(ing, job_id, timeout=30):
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = ing.get_job_status(job_id)
        if status.is_terminal:
            return status
        time.sleep(0.05)
    raise AssertionError("ingestion job did not terminate in time")


class TestRunIngestionDrawingBranch:
    def test_summary_comes_from_drawing_not_watermark(self, tmp_path, monkeypatch, ingestor, summary_db):
        """The user-reported bug: a watermark-only vector PDF must be summarised
        from its rendered-page drawing description, never from the watermark."""
        from aiq_agent.knowledge import get_available_documents

        _patch_vlm_credential(monkeypatch, "vlm-key")
        # The rendered-page VLM returns the architectural drawing description.
        monkeypatch.setattr(
            adapter,
            "_analyze_drawing_page_with_vlm",
            lambda *a, **k: (_VLM_DRAWING_RESPONSE, _parse_drawing_fields(_VLM_DRAWING_RESPONSE)),
        )
        # Force the page-render path without depending on a real vector PDF:
        # report one visual page for any PDF. The renderer returns raw pages
        # (no VLM) — enrich_vlm_batch enriches them via the mocked VLM above.
        import knowledge_layer.llamaindex.processing as processing_module

        monkeypatch.setattr(
            processing_module,
            "render_visual_pages_no_vlm",
            lambda *a, **k: [
                {
                    "image_bytes": b"fake-rendered-page",
                    "page_number": 1,
                    "width": 2048,
                    "height": 1678,
                }
            ],
        )
        # Text extraction yields nothing usable (watermark already stripped).
        monkeypatch.setattr(adapter, "_extract_text_from_pdf", lambda p: [])

        pdf = tmp_path / "perspektivischer_schnitt.pdf"
        pdf.write_bytes(b"%PDF-1.4\n% minimal\n")

        job_id = ingestor.submit_job(
            [str(pdf)], "coll_draw", config={"original_filenames": ["perspektivischer_schnitt.pdf"]}
        )
        status = _wait_terminal(ingestor, job_id)
        assert status.is_success

        docs = get_available_documents("coll_draw")
        assert len(docs) == 1
        summary = docs[0].summary
        assert summary is not None
        # The summary describes the drawing, never the watermark.
        assert "VECTORWORKS" not in summary.upper()
        assert "Schnitt" in summary or "Bildungsbau" in summary

    def test_missing_vlm_key_skips_render_without_failing(self, tmp_path, monkeypatch, ingestor, summary_db):
        """No VLM key → no page render, but a normal text PDF still ingests."""
        from aiq_agent.knowledge import get_available_documents

        _patch_vlm_credential(monkeypatch, "")
        import knowledge_layer.llamaindex.processing as processing_module

        render = MagicMock()
        monkeypatch.setattr(processing_module, "render_visual_pages_no_vlm", render)
        monkeypatch.setattr(
            adapter,
            "_extract_text_from_pdf",
            lambda p: [{"page_number": 1, "text": "Baubeschreibung: dreigeschossiges Wohngebäude."}],
        )

        pdf = tmp_path / "baubeschreibung.pdf"
        pdf.write_bytes(b"%PDF-1.4\n% minimal\n")

        job_id = ingestor.submit_job([str(pdf)], "coll_text", config={"original_filenames": ["baubeschreibung.pdf"]})
        status = _wait_terminal(ingestor, job_id)
        assert status.is_success

        render.assert_not_called()
        docs = get_available_documents("coll_text")
        assert len(docs) == 1

    def test_visual_details_returns_per_page_descriptions(self, monkeypatch, ingestor):
        """get_document_visual_details returns the drawing/image chunk captions
        (prefix stripped, sorted by page) for the file-preview detail section."""

        class _FakeCollection:
            def get(self, where, include):
                assert where == {"file_name": "plan.pdf"}
                return {
                    "documents": [
                        "[DRAWING from page 2]\n\nZEICHNUNGSTYP: schnitt\nDETAILBESCHREIBUNG: Ausführlich.",
                        "[DRAWING from page 1]\n\nZEICHNUNGSTYP: grundriss",
                        "some plain text chunk",  # content_type text → excluded
                    ],
                    "metadatas": [
                        {
                            "content_type": "drawing",
                            "page_label": "2",
                            "drawing_type": "schnitt",
                            "drawing_scale": "1:100",
                        },
                        {
                            "content_type": "drawing",
                            "page_label": "1",
                            "drawing_type": "grundriss",
                            "drawing_scale": "",
                        },
                        {"content_type": "text", "page_label": "1"},
                    ],
                }

        class _FakeClient:
            def get_collection(self, name):
                return _FakeCollection()

        monkeypatch.setattr(ingestor, "_get_chroma_client", lambda: _FakeClient())

        details = ingestor.get_document_visual_details("coll", "plan.pdf")

        # Text chunk excluded; drawings sorted by page; prefix stripped.
        assert [d["page"] for d in details] == [1, 2]
        assert details[0]["drawing_type"] == "grundriss"
        assert details[1]["drawing_type"] == "schnitt"
        assert details[1]["scale"] == "1:100"
        assert details[1]["text"].startswith("ZEICHNUNGSTYP: schnitt")
        assert "[DRAWING" not in details[1]["text"]

    def test_visual_details_fails_open_to_empty(self, monkeypatch, ingestor):
        def boom():
            raise RuntimeError("chroma down")

        monkeypatch.setattr(ingestor, "_get_chroma_client", boom)
        assert ingestor.get_document_visual_details("coll", "plan.pdf") == []

    def test_org_byok_and_model_override_reach_the_vlm(self, tmp_path, monkeypatch, ingestor, summary_db):
        """The org id captured at /v1/ingest drives the VLM the same way the
        chat models resolve theirs: the org's BYOK key + base URL and its
        runtime model override reach the rendered-page VLM call."""
        seen_org: dict[str, str | None] = {}

        def fake_cred(organization_id=None):
            seen_org["cred"] = organization_id
            return ResolvedCredential(
                api_key="byok-key", base_url="https://tenant.example/v1", model="test-vlm", source="byok"
            )

        def fake_override(organization_id=None):
            seen_org["override"] = organization_id
            return "tenant/vision-model"

        monkeypatch.setattr(adapter, "resolve_vlm_credential", fake_cred)
        monkeypatch.setattr(adapter, "_resolve_vlm_model_override", fake_override)
        monkeypatch.setattr(adapter, "_extract_text_from_pdf", lambda p: [])

        captured: dict[str, object] = {}

        def fake_vlm_call(image_bytes, vlm_model, vlm_base_url, vlm_api_key, **k):
            captured.update(model=vlm_model, base_url=vlm_base_url, api_key=vlm_api_key)
            return ("ZEICHNUNGSTYP: grundriss\nMASSSTAB: keiner", {"drawing_type": "grundriss", "scale": "keiner"})

        monkeypatch.setattr(adapter, "_analyze_drawing_page_with_vlm", fake_vlm_call)

        # render_visual_pages_no_vlm must return at least one raw page so
        # enrich_vlm_batch fires the VLM call (where we capture the creds).
        import knowledge_layer.llamaindex.processing as processing_module

        monkeypatch.setattr(
            processing_module,
            "render_visual_pages_no_vlm",
            lambda *a, **k: [{"image_bytes": b"fake", "page_number": 1, "width": 2048, "height": 1678}],
        )

        pdf = tmp_path / "plan.pdf"
        pdf.write_bytes(b"%PDF-1.4\n% minimal\n")

        job_id = ingestor.submit_job(
            [str(pdf)],
            "coll_byok",
            config={"original_filenames": ["plan.pdf"], "organization_id": "org-9"},
        )
        _wait_terminal(ingestor, job_id)

        assert seen_org == {"cred": "org-9", "override": "org-9"}
        # BYOK swaps the key + base URL; the runtime override swaps the model.
        assert captured == {
            "api_key": "byok-key",
            "base_url": "https://tenant.example/v1",
            "model": "tenant/vision-model",
        }
