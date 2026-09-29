"""One lock for every PDFium call in this process.

PDFium is not thread-safe, and pypdfium2 adds no locking of its own: two
threads inside PDFium at once can corrupt its global state and crash the whole
interpreter, not just the call. This process has several threads that reach it:
the ingest pool's workers (page triage, page renders, embedded-image
extraction, the job thumbnail) and the ingest route's background preview
thumbnail. "Call from one thread at a time" written in a docstring held none of
them to it.

So every PDFium call goes through :func:`pdfium_lock`: opening a document,
reading or rendering a page, walking its objects, and closing each of them.
Hold it for the PDFium work only (open, read, render, close), never for a whole
job, a VLM call or an upload; encode and resize the image after releasing it.

Two things escape a ``with`` block unless you mind them:

* pypdfium2 closes an object it was not asked to close when the garbage
  collector finalizes it, on whatever thread that happens. Close pages, text
  pages, bitmaps and documents explicitly, inside the lock.
* ``PdfBitmap.to_pil()`` may share the bitmap's buffer. :func:`detached_pil`
  returns an image that owns its pixels and closes the bitmap, so the image can
  leave the lock.

The lock is reentrant, so a helper that takes it can be called from code that
already holds it.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from contextlib import contextmanager
from typing import TYPE_CHECKING
from typing import Any

if TYPE_CHECKING:
    from PIL import Image

_LOCK = threading.RLock()


@contextmanager
def pdfium_lock() -> Iterator[None]:
    """Hold the process-wide PDFium lock for the block."""
    with _LOCK:
        yield


def detached_pil(bitmap: Any) -> Image.Image:
    """``bitmap`` as a PIL image that owns its pixels; the bitmap is closed. Call inside :func:`pdfium_lock`."""
    try:
        return bitmap.to_pil().copy()
    finally:
        # A PdfBitmap always has close(); a test double standing in for one may not.
        close = getattr(bitmap, "close", None)
        if close is not None:
            close()
