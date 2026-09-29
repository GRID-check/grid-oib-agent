"""PDFium is entered by one thread at a time.

PDFium is not thread-safe, and this process calls it from the ingest pool's
workers and from the ingest route's background thumbnail. Every call site goes
through ``knowledge_layer.llamaindex.pdfium_lock``; these tests run the call
sites concurrently over a fake PDFium that records how many threads are inside
it at once.
"""

from __future__ import annotations

import contextlib
import io
import threading
import time

import pytest
from knowledge_layer.llamaindex import adapter
from knowledge_layer.llamaindex import pdfium_lock as pdfium_lock_module
from knowledge_layer.llamaindex import processing
from PIL import Image

pdfium = pytest.importorskip("pypdfium2")


class _Occupancy:
    """How many threads were inside the fake PDFium at the same time, at most."""

    def __init__(self) -> None:
        self._guard = threading.Lock()
        self._inside = 0
        self.peak = 0

    @contextlib.contextmanager
    def call(self):
        with self._guard:
            self._inside += 1
            self.peak = max(self.peak, self._inside)
        time.sleep(0.005)  # long enough for another thread to walk in, were it allowed
        try:
            yield
        finally:
            with self._guard:
                self._inside -= 1


def _install_fake_pdfium(monkeypatch, occupancy: _Occupancy) -> None:
    class _Bitmap:
        width = 400
        height = 400

        def to_pil(self):
            with occupancy.call():
                return Image.new("RGB", (self.width, self.height), "white")

        def close(self):
            with occupancy.call():
                pass

    class _ImageObject:
        type = 3  # FPDF_PAGEOBJ_IMAGE

        def get_bitmap(self):
            with occupancy.call():
                return _Bitmap()

    class _Page:
        def get_size(self):
            with occupancy.call():
                return (200.0, 300.0)

        def render(self, scale):
            with occupancy.call():
                return _Bitmap()

        def get_objects(self):
            with occupancy.call():
                return [_ImageObject()]

        def close(self):
            with occupancy.call():
                pass

    class _Doc:
        def __init__(self, path):
            with occupancy.call():
                pass

        def __len__(self):
            with occupancy.call():
                return 3

        def __getitem__(self, index):
            with occupancy.call():
                return _Page()

        def close(self):
            with occupancy.call():
                pass

    monkeypatch.setattr(pdfium, "PdfDocument", _Doc)


def _every_call_site():
    from aiq_api.routes import ingest as ingest_route

    return [
        lambda: processing.render_pdf_pages("a.pdf", [1, 2, 3], max_dim=256),
        lambda: processing.render_visual_pages_no_vlm("b.pdf", max_dim=256, only_pages={1, 2, 3}),
        lambda: adapter._extract_images_from_pdf("c.pdf", min_width=10, min_height=10),
        lambda: adapter._render_first_pdf_page("d.pdf", scale=2),
        lambda: ingest_route._render_pdf_thumbnail("e.pdf"),
    ]


def _run_concurrently(calls) -> list[BaseException]:
    """Each call twice, all threads released at once."""
    runs = calls * 2
    errors: list[BaseException] = []
    start = threading.Barrier(len(runs))

    def run(call):
        start.wait()
        try:
            call()
        except BaseException as exc:  # noqa: BLE001 - reported by the test
            errors.append(exc)

    threads = [threading.Thread(target=run, args=(call,)) for call in runs]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=30)
    return errors


def test_concurrent_call_sites_never_overlap_inside_pdfium(monkeypatch):
    occupancy = _Occupancy()
    _install_fake_pdfium(monkeypatch, occupancy)

    errors = _run_concurrently(_every_call_site())

    assert errors == []
    assert occupancy.peak == 1


def test_the_fake_does_see_overlap_without_the_lock(monkeypatch):
    """The check above can fail: with the lock gone, the same run overlaps."""
    occupancy = _Occupancy()
    _install_fake_pdfium(monkeypatch, occupancy)
    for module in (processing, adapter):
        monkeypatch.setattr(module, "pdfium_lock", contextlib.nullcontext)

    _run_concurrently(_every_call_site()[:4])

    assert occupancy.peak > 1


def test_the_lock_is_reentrant():
    with pdfium_lock_module.pdfium_lock(), pdfium_lock_module.pdfium_lock():
        pass


def test_a_detached_image_outlives_its_bitmap():
    """Rendered for real: the image owns its pixels after the bitmap is closed."""
    doc = pdfium.PdfDocument.new()
    doc.new_page(200, 300)
    buf = io.BytesIO()
    doc.save(buf)
    doc.close()

    with pdfium_lock_module.pdfium_lock():
        pdf = pdfium.PdfDocument(buf.getvalue())
        page = pdf[0]
        image = pdfium_lock_module.detached_pil(page.render(scale=1))
        page.close()
        pdf.close()

    assert image.size == (200, 300)
    assert image.getpixel((10, 10)) is not None
