"""Tests for the view_knowledge_image NAT function.

The tool re-renders a base-corpus PDF page as a multimodal image content
block. Every failure mode must degrade to a text-only block and never raise.
"""

from __future__ import annotations

import base64

import knowledge_layer.llamaindex.adapter as llm_adapter
import pytest

from sources.knowledge_layer.src.view_image import ViewKnowledgeImageToolConfig
from sources.knowledge_layer.src.view_image import _find_pdf
from sources.knowledge_layer.src.view_image import _is_enabled
from sources.knowledge_layer.src.view_image import _render_page
from sources.knowledge_layer.src.view_image import view_knowledge_image

_JPEG_BYTES = b"\xff\xd8\xff\xe0test-jpeg-payload"


def _config(tmp_path) -> ViewKnowledgeImageToolConfig:
    return ViewKnowledgeImageToolConfig(pdf_dirs=[str(tmp_path)])


def _patch_env(monkeypatch, *, enabled: bool = True, vlm_key: str = "sk-test") -> None:
    monkeypatch.setenv("AIQ_VIEW_IMAGES_ENABLED", "true" if enabled else "false")
    monkeypatch.setattr(llm_adapter, "_get_vlm_api_key", lambda: vlm_key)


async def _invoke(
    monkeypatch,
    tmp_path,
    *,
    file_name: str = "OIB-3.pdf",
    page_number: int = 3,
    image_index: int = 0,
    pdf_path: str | None = None,
    render_result=(_JPEG_BYTES, 100, 50),
    render_raises: Exception | None = None,
    enabled: bool = True,
    vlm_key: str = "sk-test",
) -> list[dict] | str:
    """Drive the NAT async generator and call the wrapped lookup."""
    _patch_env(monkeypatch, enabled=enabled, vlm_key=vlm_key)

    if render_raises is not None:

        def _boom(*_args, **_kwargs):
            raise render_raises

        monkeypatch.setattr("sources.knowledge_layer.src.view_image._render_page", _boom)
    else:
        monkeypatch.setattr(
            "sources.knowledge_layer.src.view_image._render_page",
            lambda _pdf_path, _page_number, _max_dim: render_result,
        )

    monkeypatch.setattr(
        "sources.knowledge_layer.src.view_image._find_pdf",
        lambda _dirs, _name: pdf_path,
    )

    config = _config(tmp_path)
    async with view_knowledge_image(config, None) as info:
        args = info.input_schema(file_name=file_name, page_number=page_number, image_index=image_index)
        return await info.single_fn(args)


@pytest.mark.asyncio
async def test_returns_image_blocks(monkeypatch, tmp_path) -> None:
    result = await _invoke(monkeypatch, tmp_path, pdf_path=str(tmp_path / "OIB-3.pdf"))

    assert isinstance(result, list)
    assert len(result) == 2
    assert result[0]["type"] == "text"
    assert "Rendered page 3" in result[0]["text"]
    assert result[1]["type"] == "image_url"
    url = result[1]["image_url"]["url"]
    assert url.startswith("data:image/jpeg;base64,")
    assert base64.b64decode(url.split(",", 1)[1]) == _JPEG_BYTES


@pytest.mark.asyncio
async def test_missing_pdf_returns_text_only(monkeypatch, tmp_path) -> None:
    result = await _invoke(monkeypatch, tmp_path, pdf_path=None)

    assert isinstance(result, str)
    assert result.startswith("[view_knowledge_image] Could not find the source PDF")


@pytest.mark.asyncio
async def test_render_failure_returns_text_only(monkeypatch, tmp_path) -> None:
    result = await _invoke(monkeypatch, tmp_path, pdf_path="x.pdf", render_raises=RuntimeError("boom"))

    assert isinstance(result, str)
    assert "Could not render page 3" in result
    assert "boom" in result


@pytest.mark.asyncio
async def test_invalid_page_number_returns_text_only(monkeypatch, tmp_path) -> None:
    result = await _invoke(monkeypatch, tmp_path, pdf_path="x.pdf", page_number=0)

    assert isinstance(result, str)
    assert result.startswith("[view_knowledge_image] Invalid page number")


@pytest.mark.asyncio
async def test_disabled_flag_returns_text_only(monkeypatch, tmp_path) -> None:
    result = await _invoke(monkeypatch, tmp_path, enabled=False)

    assert isinstance(result, str)
    assert "Image viewing is disabled" in result


@pytest.mark.asyncio
async def test_no_vlm_key_returns_text_only(monkeypatch, tmp_path) -> None:
    result = await _invoke(monkeypatch, tmp_path, vlm_key="")

    assert isinstance(result, str)
    assert "no vision-model API key is configured" in result


def test_is_enabled_respects_flag(monkeypatch) -> None:
    monkeypatch.delenv("AIQ_VIEW_IMAGES_ENABLED", raising=False)
    assert _is_enabled() is True

    for off in ("0", "false", "no", "off", "OFF"):
        monkeypatch.setenv("AIQ_VIEW_IMAGES_ENABLED", off)
        assert _is_enabled() is False

    monkeypatch.setenv("AIQ_VIEW_IMAGES_ENABLED", "true")
    assert _is_enabled() is True


def test_find_pdf_case_insensitive_recursive(tmp_path) -> None:
    nested = tmp_path / "nested"
    nested.mkdir()
    (nested / "OIB-3-Brandschutz.PDF").write_bytes(b"pdf")

    assert _find_pdf([str(tmp_path)], "oib-3-brandschutz.pdf") is not None
    assert _find_pdf([str(tmp_path)], "nonexistent.pdf") is None
    assert _find_pdf([str(tmp_path / "missing-dir")], "x.pdf") is None


def test_render_page_round_trips_jpeg(monkeypatch, tmp_path) -> None:
    import sys
    from types import ModuleType

    pdf_path = tmp_path / "page.pdf"
    pdf_path.write_bytes(b"pdf")

    class _FakeBitmap:
        def to_pil(self):
            from PIL import Image

            return Image.new("RGB", (10, 20), "white")

    class _FakePage:
        def __init__(self):
            self._closed = False

        def get_size(self):
            return (100.0, 200.0)

        def render(self, *, scale):
            assert abs(scale - 2048 / 200.0) < 1e-9
            return _FakeBitmap()

        def close(self):
            self._closed = True

    class _FakeDoc:
        def __init__(self, page):
            self._page = page
            self._closed = False

        def __getitem__(self, index):
            assert index == 0
            return self._page

        def close(self):
            self._closed = True

    fake_page = _FakePage()
    fake_doc = _FakeDoc(fake_page)
    fake_pdfium = ModuleType("pypdfium2")
    fake_pdfium.PdfDocument = lambda _path: fake_doc
    monkeypatch.setitem(sys.modules, "pypdfium2", fake_pdfium)

    jpeg_bytes, width, height = _render_page(str(pdf_path), 1, 2048)

    assert width == 10
    assert height == 20
    assert jpeg_bytes.startswith(b"\xff\xd8")
    assert fake_doc._closed and fake_page._closed
