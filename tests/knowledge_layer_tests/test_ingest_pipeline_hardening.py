"""Tests for the ingestion-pipeline hardening changes.

Covers the defects found in the 2026-07 pipeline review (vision + speed):

- ``processing.vlm_cache_key`` / ``_cached_vlm_call`` — the VLM model is part
  of the cache identity (a model switch never serves stale captions, and two
  orgs on different ``ingest_vlm`` overrides never share output).
- ``processing.is_failed_caption`` + ``enrich_vlm_batch`` — failure placeholder
  captions AND raising VLM calls are skipped, never indexed as real chunks.
- ``processing.render_visual_pages_no_vlm(page_texts=...)`` — the caller-supplied
  watermark-stripped text drives the heuristic (both directions).
- ``adapter._extract_images_from_pdf`` — identical embedded rasters are deduped
  to a single indexed chunk.
- ``adapter._vlm_chat_create`` — one truncation retry at double tokens, partial
  content returned (not raised) when still truncated.
- ``adapter._build_image_caption_document`` — routes through the content-hash
  cache and fails the file (None) on a failure placeholder caption.
- VLM ``OpenAI`` client construction — explicit timeout + bounded retries on
  both call sites (a hung provider must not park an ingest worker ~20 min).
- ``adapter.LlamaIndexIngestor._ensure_initialized`` — embed_batch_size is
  wired (llama-index default of 10 serializes embedding round-trips).
- ``factory.reconcile_collection_summaries(file_names=...)`` — the scoped mode
  skips the full-collection ``list_files`` metadata scan per job.
"""

import sys
import tempfile
import types
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from knowledge_layer.llamaindex import adapter
from knowledge_layer.llamaindex import processing

# =============================================================================
# is_failed_caption / vlm_cache_key
# =============================================================================


class TestIsFailedCaption:
    @pytest.mark.parametrize(
        "caption",
        [
            "[Image - analysis failed]",
            "[Drawing - analysis failed: provider exploded]",
            "[image - vlm not configured]",
            "  [DRAWING - analysis failed]",  # leading whitespace + case-insensitive
        ],
    )
    def test_placeholders_detected(self, caption):
        assert processing.is_failed_caption(caption) is True

    @pytest.mark.parametrize(
        "caption",
        [
            None,
            "",
            "A floor plan of the second storey.",
            "[IMAGE from page 1] shows a section",  # chunk prefix, not a failure
            "Zeichnung: Grundriss EG",
        ],
    )
    def test_real_captions_pass(self, caption):
        assert processing.is_failed_caption(caption) is False


class TestVlmCacheKey:
    def test_model_is_part_of_identity(self):
        key_a = processing.vlm_cache_key(b"bytes", "drawing", model="model-a")
        key_b = processing.vlm_cache_key(b"bytes", "drawing", model="model-b")

        assert key_a != key_b
        assert "model-a" in key_a and "model-b" in key_b

    def test_stable_for_same_inputs(self):
        assert processing.vlm_cache_key(b"x", "image:charts=True", model="m") == processing.vlm_cache_key(
            b"x", "image:charts=True", model="m"
        )

    def test_prompt_type_is_part_of_identity(self):
        assert processing.vlm_cache_key(b"x", "drawing", model="m") != processing.vlm_cache_key(
            b"x", "image:charts=True", model="m"
        )


class TestCachedVlmCall:
    @pytest.fixture
    def cache_store(self, monkeypatch):
        """Deterministic dict-backed cache instead of the shared backend."""
        store: dict[str, object] = {}
        monkeypatch.setattr(processing, "get_json", store.get)
        monkeypatch.setattr(processing, "set_json", lambda key, value, ttl: store.__setitem__(key, value))
        return store

    def test_model_switch_misses_cache(self, cache_store):
        calls = []

        def live():
            calls.append(1)
            return "caption"

        processing._cached_vlm_call(b"img", "drawing", live, model="model-a")
        processing._cached_vlm_call(b"img", "drawing", live, model="model-b")
        processing._cached_vlm_call(b"img", "drawing", live, model="model-a")

        assert len(calls) == 2  # model-a cached; model-b forced a live call

    def test_cache_read_error_falls_back_to_live_call(self, monkeypatch):
        monkeypatch.setattr(
            processing,
            "get_json",
            MagicMock(side_effect=RuntimeError("cache backend down")),
        )
        monkeypatch.setattr(processing, "set_json", MagicMock(side_effect=RuntimeError("down")))

        result = processing._cached_vlm_call(b"img", "drawing", lambda: "live caption", model="m")

        assert result == "live caption"

    @pytest.mark.parametrize(
        "failed_result",
        [
            ("image", "[Image - analysis failed: provider 503]"),
            ("[Drawing - analysis failed: timeout]", {}),
            "[Drawing - VLM not configured]",
        ],
    )
    def test_failure_placeholder_is_never_cached(self, cache_store, failed_result):
        """A transient provider failure must not be cached for the TTL.

        Both failure paths treat the file as retryable via re-ingest, which only
        holds if the placeholder was not stored — otherwise the retry replays
        the failure from cache without ever reaching the VLM again.
        """
        calls = []

        def live():
            calls.append(1)
            return failed_result

        assert processing._cached_vlm_call(b"img", "drawing", live, model="m") == failed_result
        assert processing._cached_vlm_call(b"img", "drawing", live, model="m") == failed_result

        assert len(calls) == 2
        assert cache_store == {}

    def test_successful_result_is_cached(self, cache_store):
        calls = []

        def live():
            calls.append(1)
            return ("image", "A red rectangle.")

        processing._cached_vlm_call(b"img", "image:charts=False", live, model="m")
        processing._cached_vlm_call(b"img", "image:charts=False", live, model="m")

        assert len(calls) == 1
        assert list(cache_store) == [processing.vlm_cache_key(b"img", "image:charts=False", "m")]


# =============================================================================
# enrich_vlm_batch — failures are skipped, never indexed
# =============================================================================


class TestEnrichVlmBatchSkipsFailures:
    @pytest.fixture(autouse=True)
    def fresh_cache(self, monkeypatch):
        """Every test starts with an empty cache so prior suites can't leak hits."""
        monkeypatch.setattr(processing, "get_json", lambda key: None)
        monkeypatch.setattr(processing, "set_json", lambda key, value, ttl: None)

    @staticmethod
    def _image_record():
        return {"image_bytes": b"img-bytes", "page_number": 1, "image_index": 0}

    @staticmethod
    def _drawing_page():
        return {"image_bytes": b"drawing-bytes", "page_number": 2, "width": 100, "height": 100}

    def test_failure_placeholder_caption_is_skipped(self, monkeypatch):
        monkeypatch.setattr(
            adapter,
            "_analyze_image_with_vlm",
            lambda *a, **k: ("image", "[Image - analysis failed]"),
        )

        image_results, drawings = processing.enrich_vlm_batch(
            [self._image_record()], [], "m", "https://vlm.test/v1", "key"
        )

        assert image_results == []
        assert drawings == []

    def test_raising_vlm_call_is_skipped(self, monkeypatch):
        def explode(*a, **k):
            raise RuntimeError("provider 500")

        monkeypatch.setattr(adapter, "_analyze_image_with_vlm", explode)

        image_results, _ = processing.enrich_vlm_batch([self._image_record()], [], "m", "u", "key")

        assert image_results == []

    def test_drawing_failure_placeholder_is_skipped(self, monkeypatch):
        monkeypatch.setattr(
            adapter,
            "_analyze_drawing_page_with_vlm",
            lambda *a, **k: ("[Drawing - analysis failed: timeout]", {}),
        )

        _, drawings = processing.enrich_vlm_batch([], [self._drawing_page()], "m", "u", "key")

        assert drawings == []

    def test_successful_items_survive_alongside_failures(self, monkeypatch):
        def fake_analyze(image_bytes, **kwargs):
            if image_bytes == b"good":
                return ("image", "A detailed floor plan.")
            return ("image", "[Image - analysis failed]")

        monkeypatch.setattr(adapter, "_analyze_image_with_vlm", fake_analyze)

        records = [
            {"image_bytes": b"good", "page_number": 1, "image_index": 0},
            {"image_bytes": b"bad", "page_number": 2, "image_index": 0},
        ]
        image_results, _ = processing.enrich_vlm_batch(records, [], "m", "u", "key")

        assert len(image_results) == 1
        record, content_type, caption = image_results[0]
        assert record["page_number"] == 1
        assert content_type == "image"
        assert caption == "A detailed floor plan."

    def test_drawing_success_is_enriched_in_place(self, monkeypatch):
        monkeypatch.setattr(
            adapter,
            "_analyze_drawing_page_with_vlm",
            lambda *a, **k: ("ZEICHNUNGSTYP: grundriss", {"zeichnungstyp": "grundriss"}),
        )

        page = self._drawing_page()
        _, drawings = processing.enrich_vlm_batch([], [page], "m", "u", "key")

        assert len(drawings) == 1
        assert drawings[0]["caption"] == "ZEICHNUNGSTYP: grundriss"
        assert drawings[0]["fields"] == {"zeichnungstyp": "grundriss"}

    def test_no_vlm_key_returns_empty(self):
        assert processing.enrich_vlm_batch([self._image_record()], [], "m", "u", None) == ([], [])


# =============================================================================
# render_visual_pages_no_vlm(page_texts=...) — watermark-stripped heuristic
# =============================================================================


class _FakePathObj:
    type = 2  # FPDF_PAGEOBJ_PATH


class _FakeTextPage:
    def __init__(self, text):
        self._text = text

    def get_text_range(self):
        return self._text

    def close(self):
        pass


class _FakeRenderBitmap:
    def __init__(self, size):
        from PIL import Image

        self._img = Image.new("RGB", size, "white")

    def to_pil(self):
        return self._img


class _FakeRenderPage:
    def __init__(self, text, n_paths, size=(1000, 700)):
        self._text = text
        self._n_paths = n_paths
        self._size = size
        self.textpage_reads = 0

    def get_textpage(self):
        self.textpage_reads += 1
        return _FakeTextPage(self._text)

    def get_objects(self):
        return [_FakePathObj() for _ in range(self._n_paths)]

    def get_size(self):
        return self._size

    def render(self, scale):
        w, h = self._size
        return _FakeRenderBitmap((max(1, int(w * scale)), max(1, int(h * scale))))

    def close(self):
        pass


def _install_fake_render_pdf(monkeypatch, pages):
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


class TestRenderVisualPagesPageTexts:
    def test_page_texts_override_marks_watermark_page_visual(self, monkeypatch):
        """The pdfium text layer still holds the watermark (looks textful), but
        the caller's watermark-stripped text is empty → the page IS rendered."""
        page = _FakeRenderPage("VECTORWORKS EDUCATIONAL VERSION " * 20, n_paths=0)
        _install_fake_render_pdf(monkeypatch, [page])

        out = processing.render_visual_pages_no_vlm("ignored.pdf", page_texts={1: ""})

        assert len(out) == 1
        assert out[0]["page_number"] == 1
        # The pdfium textpage is never consulted when page_texts is supplied.
        assert page.textpage_reads == 0

    def test_page_texts_override_skips_textful_page(self, monkeypatch):
        """Inverse: pdfium sees almost no text (would look visual), but the
        caller's stripped text is long → the page is NOT rendered."""
        page = _FakeRenderPage("", n_paths=0)
        _install_fake_render_pdf(monkeypatch, [page])

        out = processing.render_visual_pages_no_vlm("ignored.pdf", page_texts={1: "Real content. " * 100})

        assert out == []

    def test_missing_page_in_page_texts_counts_as_empty(self, monkeypatch):
        """A page absent from the extracted-text map (extraction failed for it)
        is treated as text-empty and rendered."""
        _install_fake_render_pdf(monkeypatch, [_FakeRenderPage("Some text", n_paths=0)])

        out = processing.render_visual_pages_no_vlm("ignored.pdf", page_texts={})

        assert len(out) == 1


# =============================================================================
# _extract_images_from_pdf — identical rasters deduped
# =============================================================================


class _FakeImageBitmap:
    def __init__(self, color, size=(200, 200)):
        from PIL import Image

        self._img = Image.new("RGB", size, color)
        self.width, self.height = size

    def to_pil(self):
        return self._img


class _FakeImageObj:
    type = 3  # FPDF_PAGEOBJ_IMAGE

    def __init__(self, color, size=(200, 200)):
        self._bitmap = _FakeImageBitmap(color, size)

    def get_bitmap(self):
        return self._bitmap


class _FakeImagePage:
    def __init__(self, objects):
        self._objects = objects

    def get_objects(self):
        return self._objects

    def close(self):
        pass


def _install_fake_image_pdf(monkeypatch, pages):
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


class TestExtractImagesDedupe:
    def test_identical_images_are_extracted_once(self, monkeypatch):
        pages = [
            _FakeImagePage([_FakeImageObj("white")]),
            _FakeImagePage([_FakeImageObj("white")]),  # identical re-embed (logo on every page)
            _FakeImagePage([_FakeImageObj("black")]),
        ]
        _install_fake_image_pdf(monkeypatch, pages)

        images = adapter._extract_images_from_pdf("ignored.pdf")

        assert len(images) == 2
        assert [img["page_number"] for img in images] == [1, 3]

    def test_small_images_still_filtered(self, monkeypatch):
        pages = [_FakeImagePage([_FakeImageObj("white", size=(50, 50))])]
        _install_fake_image_pdf(monkeypatch, pages)

        assert adapter._extract_images_from_pdf("ignored.pdf") == []


# =============================================================================
# _vlm_chat_create — truncation retry
# =============================================================================


class _FakeChoice:
    def __init__(self, content, finish_reason):
        self.message = types.SimpleNamespace(content=content)
        self.finish_reason = finish_reason


class _FakeCompletions:
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        content, finish_reason = self._responses.pop(0)
        return types.SimpleNamespace(choices=[_FakeChoice(content, finish_reason)])


class TestVlmChatCreate:
    def test_truncated_response_retries_with_double_tokens(self):
        completions = _FakeCompletions(
            [
                ("partial...", "length"),
                ("full caption", "stop"),
            ]
        )
        client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=completions))

        result = adapter._vlm_chat_create(client, model="m", messages=[], max_tokens=1100)

        assert result == "full caption"
        assert len(completions.calls) == 2
        assert completions.calls[0]["max_tokens"] == 1100
        assert completions.calls[1]["max_tokens"] == 2200

    def test_still_truncated_returns_partial_instead_of_raising(self):
        completions = _FakeCompletions(
            [
                ("part1", "length"),
                ("part2", "length"),
            ]
        )
        client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=completions))

        result = adapter._vlm_chat_create(client, model="m", messages=[], max_tokens=512)

        assert result == "part2"
        assert len(completions.calls) == 2  # exactly one retry, no loop

    def test_complete_response_makes_one_call(self):
        completions = _FakeCompletions([("done", "stop")])
        client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=completions))

        result = adapter._vlm_chat_create(client, model="m", messages=[], max_tokens=512)

        assert result == "done"
        assert len(completions.calls) == 1

    def test_failed_truncation_retry_keeps_the_truncated_caption(self):
        """A retry failure must not discard content we already have.

        Failure placeholders are no longer indexed, so raising here would turn a
        partial success into a dropped chunk instead of a slightly short one.
        """

        class _RaisingCompletions(_FakeCompletions):
            def create(self, **kwargs):
                if self.calls:
                    self.calls.append(kwargs)
                    raise RuntimeError("provider 503")
                return super().create(**kwargs)

        completions = _RaisingCompletions([("partial caption", "length")])
        client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=completions))

        result = adapter._vlm_chat_create(client, model="m", messages=[], max_tokens=512)

        assert result == "partial caption"
        assert len(completions.calls) == 2

    def test_empty_retry_response_falls_back_to_the_partial(self):
        completions = _FakeCompletions([("partial caption", "length"), (None, "stop")])
        client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=completions))

        result = adapter._vlm_chat_create(client, model="m", messages=[], max_tokens=512)

        assert result == "partial caption"

    def test_truncation_retry_disables_sdk_retries(self):
        """The first call already spent the client's retry budget; spending it
        again on the retry would double the worst-case latency of one caption."""
        completions = _FakeCompletions([("partial...", "length"), ("full caption", "stop")])
        overrides: list[dict] = []

        class _FakeClient:
            def __init__(self):
                self.chat = types.SimpleNamespace(completions=completions)

            def with_options(self, **kwargs):
                overrides.append(kwargs)
                return self

        result = adapter._vlm_chat_create(_FakeClient(), model="m", messages=[], max_tokens=512)

        assert result == "full caption"
        assert overrides == [{"max_retries": 0}]


# =============================================================================
# VLM OpenAI client construction — timeout + bounded retries on both call sites
# =============================================================================


class TestVlmClientConstruction:
    @pytest.fixture
    def captured_openai(self, monkeypatch):
        captured: dict = {}

        def fake_openai(**kwargs):
            captured.update(kwargs)
            completions = _FakeCompletions([("A caption.", "stop")])
            return types.SimpleNamespace(chat=types.SimpleNamespace(completions=completions))

        openai_module = pytest.importorskip("openai")
        monkeypatch.setattr(openai_module, "OpenAI", fake_openai)
        return captured

    def test_image_call_sets_timeout_and_retries(self, captured_openai):
        adapter._analyze_image_with_vlm(
            b"img",
            vlm_model="m",
            vlm_base_url="https://vlm.test/v1",
            vlm_api_key="key",  # pragma: allowlist secret
        )

        assert captured_openai["timeout"] == adapter.VLM_REQUEST_TIMEOUT_SECONDS
        assert captured_openai["max_retries"] == 1

    def test_drawing_call_sets_timeout_and_retries(self, captured_openai):
        adapter._analyze_drawing_page_with_vlm(
            b"img",
            vlm_model="m",
            vlm_base_url="https://vlm.test/v1",
            vlm_api_key="key",  # pragma: allowlist secret
        )

        assert captured_openai["timeout"] == adapter.VLM_REQUEST_TIMEOUT_SECONDS
        assert captured_openai["max_retries"] == 1


# =============================================================================
# _build_image_caption_document — cached, fails on placeholder caption
# =============================================================================


class TestBuildImageCaptionDocument:
    @pytest.fixture
    def png_file(self, tmp_path):
        from PIL import Image

        path = tmp_path / "plan.png"
        Image.new("RGB", (120, 80), "white").save(path, format="PNG")
        return str(path)

    def test_failure_placeholder_fails_the_file(self, png_file, monkeypatch):
        monkeypatch.setattr(processing, "get_json", lambda key: None)
        monkeypatch.setattr(processing, "set_json", lambda key, value, ttl: None)
        monkeypatch.setattr(
            adapter,
            "_analyze_image_with_vlm",
            lambda *a, **k: ("image", "[Image - analysis failed: provider 500]"),
        )

        doc = adapter._build_image_caption_document(
            png_file,
            "plan.png",
            123,
            "png",
            vlm_api_key="key",  # pragma: allowlist secret
        )

        assert doc is None

    def test_cache_hit_skips_the_live_call(self, png_file, monkeypatch):
        monkeypatch.setattr(processing, "get_json", lambda key: ("image", "cached caption"))
        monkeypatch.setattr(processing, "set_json", lambda key, value, ttl: None)

        def forbidden(*a, **k):
            raise AssertionError("live VLM call must not fire on a cache hit")

        monkeypatch.setattr(adapter, "_analyze_image_with_vlm", forbidden)

        doc = adapter._build_image_caption_document(
            png_file,
            "plan.png",
            123,
            "png",
            vlm_api_key="key",  # pragma: allowlist secret
        )

        assert doc is not None
        assert "cached caption" in doc.text
        assert doc.metadata["content_type"] == "image"


# =============================================================================
# _ensure_initialized — embed_batch_size wired
# =============================================================================


class TestEmbedBatchSizeWired:
    def test_ingestor_passes_embed_batch_size(self, tmp_path, monkeypatch):
        captured: dict = {}

        class FakeNVIDIAEmbedding:
            def __init__(self, **kwargs):
                captured.update(kwargs)

        monkeypatch.setattr("llama_index.embeddings.nvidia.NVIDIAEmbedding", FakeNVIDIAEmbedding)

        ing = adapter.LlamaIndexIngestor({"persist_dir": str(tmp_path / "chroma")})
        ing._ensure_initialized()

        assert captured["embed_batch_size"] == adapter.EMBED_BATCH_SIZE
        assert adapter.EMBED_BATCH_SIZE > 10  # the whole point: beat the llama-index default


# =============================================================================
# reconcile_collection_summaries(file_names=...) — scoped mode
# =============================================================================


class TestScopedReconcile:
    """The per-job reconcile must diff only the job's own files — the unscoped
    mode's list_files reads every chunk metadata in the collection
    (O(collection) on every single-file upload)."""

    @pytest.fixture(autouse=True)
    def reset_summary_store(self):
        from aiq_agent.knowledge import factory

        factory._document_metadata_store = None
        yield
        factory._document_metadata_store = None

    @pytest.fixture
    def temp_db_url(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            yield f"sqlite:///{Path(tmpdir) / 'reconcile_scoped.db'}"

    class _ListFilesForbiddenIngestor:
        def list_files(self, collection_name):
            raise AssertionError("scoped reconcile must not scan the collection")

    def test_scoped_mode_never_calls_list_files(self, temp_db_url):
        from aiq_agent.knowledge import configure_summary_db
        from aiq_agent.knowledge import get_available_documents
        from aiq_agent.knowledge.factory import reconcile_collection_summaries

        configure_summary_db(temp_db_url)

        backfilled = reconcile_collection_summaries(
            self._ListFilesForbiddenIngestor(),
            "coll",
            file_names=["a.pdf", "b.pdf"],
        )

        assert backfilled == 2
        docs = {d.file_name for d in get_available_documents("coll")}
        assert docs == {"a.pdf", "b.pdf"}

    def test_scoped_mode_skips_existing_rows(self, temp_db_url):
        from aiq_agent.knowledge import configure_summary_db
        from aiq_agent.knowledge.factory import reconcile_collection_summaries
        from aiq_agent.knowledge.factory import register_summary

        configure_summary_db(temp_db_url)
        register_summary("coll", "a.pdf", "Already summarized.")

        backfilled = reconcile_collection_summaries(
            self._ListFilesForbiddenIngestor(),
            "coll",
            file_names=["a.pdf", "b.pdf"],
        )

        assert backfilled == 1

    def test_empty_scope_is_a_noop(self, temp_db_url):
        from aiq_agent.knowledge import configure_summary_db
        from aiq_agent.knowledge.factory import reconcile_collection_summaries

        configure_summary_db(temp_db_url)

        assert reconcile_collection_summaries(self._ListFilesForbiddenIngestor(), "coll", file_names=[]) == 0


def test_module_under_test_importable():
    """Guard against accidental import-time breakage in the touched modules."""
    assert "knowledge_layer.llamaindex.adapter" in sys.modules
    assert "knowledge_layer.llamaindex.processing" in sys.modules
