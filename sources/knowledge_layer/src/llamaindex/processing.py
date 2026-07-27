"""Unified document processing pipeline with concurrent VLM enrichment.

Provides a DRY, extensible extraction pipeline that:
- Runs VLM captioning concurrently for embedded images AND rendered drawing pages
  within a single file (biggest latency win: a 20-page plan set goes from 20+
  serial round-trips to 4 concurrent workers per file).
- Content-hash caches every VLM result via ``aiq_agent.common.cache`` so a
  re-ingest or cross-document duplicate image skips the API call entirely.
- Maintains backward compatibility with ``adapter.py`` module-level functions
  (test patches control adapter attributes; this module accesses them through
  the module reference so patches still fire).
- Keeps the single-pass-per-library optimisation as a future follow-up — today
  the existing per-function extraction calls are reused as-is.

Typical usage (inside ``_run_ingestion``)::

    from knowledge_layer.llamaindex.processing import enrich_vlm_batch

    image_records = adapter._extract_images_from_pdf(file_path)
    drawing_pages = render_visual_pages_no_vlm(file_path, ...)

    image_results, drawing_pages = enrich_vlm_batch(
        image_records=image_records,
        drawing_pages=drawing_pages,
        vlm_model=vlm_model,
        vlm_base_url=vlm_base_url,
        vlm_api_key=vlm_api_key,
        extract_charts=extract_charts,
    )
    # image_results: list of (record, content_type, caption)
    # drawing_pages: list already enriched with caption/fields
"""

from __future__ import annotations

import hashlib
import logging
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import as_completed
from typing import Any

from aiq_agent.common.cache import get_json
from aiq_agent.common.cache import set_json

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Max concurrent VLM workers per file. Kept modest to avoid saturating the
# provider rate-limit or the process socket pool — architectural plan sets
# typically have 5-20 visual pages and 0-10 embedded images, so 4 workers
# cuts a 20-page serial loop to ~5 rounds.
VLM_BATCH_WORKERS = 4

# Content-hash cache TTL: 30 days. Long enough that re-ingesting a changed PDF
# (but with many unchanged images) still hits the cache for the stable images.
_VLM_CACHE_TTL_SECONDS = 30 * 86400


# ---------------------------------------------------------------------------
# Content-hash VLM cache
# ---------------------------------------------------------------------------


def vlm_cache_key(image_bytes: bytes, prompt_type: str) -> str:
    """Content-hash cache key for a VLM analysis result.

    ``prompt_type`` distinguishes ``"image"`` (the English chart/caption prompt)
    from ``"drawing"`` (the German drawing-aware prompt) so a caption produced
    by one prompt is never served for the other.
    """
    h = hashlib.sha256(image_bytes).hexdigest()
    return f"vlm:caption:{prompt_type}:{h}"


def _cached_vlm_call(
    image_bytes: bytes,
    prompt_type: str,
    live_call,
    *args,
    **kwargs,
):
    """Wrap a VLM call with content-hash caching.

    On cache hit: returns the stored JSON result directly.
    On cache miss: calls ``live_call(*args, **kwargs)``, stores, and returns.
    On store error: degrades to live call (fail-open — cache never blocks ingest).
    """
    key = vlm_cache_key(image_bytes, prompt_type)
    cached = get_json(key)
    if cached is not None:
        logger.debug("VLM cache HIT for %s", key[:60])
        return cached
    result = live_call(*args, **kwargs)
    try:
        set_json(key, result, _VLM_CACHE_TTL_SECONDS)
    except Exception:
        logger.debug("VLM cache write failed (swallowed) for %s", key[:60])
    return result


# ---------------------------------------------------------------------------
# Drawing-page renderer (VLM-free variant)
# ---------------------------------------------------------------------------


def render_visual_pages_no_vlm(
    pdf_path: str,
    max_dim: int = 2048,
    min_text_chars: int = 200,
    min_paths: int = 300,
    max_pages: int = 20,
) -> list[dict[str, Any]]:
    """Detect and render visual/vector PDF pages WITHOUT calling the VLM.

    Mirrors ``adapter._render_visual_pdf_pages`` but returns rendered JPEG bytes
    instead of captioned results so the caller can batch VLM calls concurrently.

    Returns a list of dicts:
      ``{"image_bytes": bytes, "page_number": int, "width": int, "height": int}``.
    Empty list when pypdfium2 is unavailable or the PDF has no visual pages.
    """
    try:
        import io

        import pypdfium2 as pdfium
    except ImportError:
        logger.warning("pypdfium2 not installed; visual page detection disabled")
        return []

    _PAGEOBJ_TEXT = 1
    _PAGEOBJ_PATH = 2

    results: list[dict[str, Any]] = []
    rendered = 0
    try:
        doc = pdfium.PdfDocument(pdf_path)
        try:
            for page_num in range(len(doc)):
                page = doc[page_num]
                try:
                    text_page = page.get_textpage()
                    try:
                        raw_text = text_page.get_text_range()
                    finally:
                        text_page.close()
                    text_len = len((raw_text or "").strip())

                    path_count = 0
                    for obj in page.get_objects():
                        if obj.type == _PAGEOBJ_PATH:
                            path_count += 1
                            if path_count >= min_paths:
                                break

                    is_visual = text_len < min_text_chars or path_count >= min_paths
                    if not is_visual:
                        continue

                    if rendered >= max_pages:
                        logger.debug("Visual-page render cap (%d) reached", max_pages)
                        break

                    width_pt, height_pt = page.get_size()
                    longest_pt = max(width_pt, height_pt) or 1.0
                    scale = max_dim / longest_pt
                    bitmap = page.render(scale=scale)
                    pil_image = bitmap.to_pil().convert("RGB")
                    buf = io.BytesIO()
                    pil_image.save(buf, format="JPEG", quality=90)

                    results.append(
                        {
                            "image_bytes": buf.getvalue(),
                            "page_number": page_num + 1,
                            "width": pil_image.width,
                            "height": pil_image.height,
                        }
                    )
                    rendered += 1
                finally:
                    page.close()
        finally:
            doc.close()
        if results:
            logger.info("Detected %d visual page(s) in %s", len(results), pdf_path)
    except Exception as e:
        logger.error("Error rendering visual pages: %s", e)

    return results


# ---------------------------------------------------------------------------
# Concurrent VLM batch enrichment
# ---------------------------------------------------------------------------


def enrich_vlm_batch(
    image_records: list[dict[str, Any]],
    drawing_pages: list[dict[str, Any]],
    vlm_model: str,
    vlm_base_url: str,
    vlm_api_key: str | None,
    extract_charts: bool = True,
):
    """Run ALL VLM calls for a file concurrently — embedded images AND rendered
    drawing pages — with content-hash caching.

    Args:
        image_records: Output of ``_extract_images_from_pdf`` (raw bytes, no VLM yet).
        drawing_pages: Output of ``render_visual_pages_no_vlm`` (rendered JPEG, no VLM).
        vlm_model: VLM model name.
        vlm_base_url: VLM endpoint base URL.
        vlm_api_key: Resolved VLM API key (BYOK-aware).
        extract_charts: Whether to use the chart-aware prompt for images.

    Returns:
        ``(image_results, drawing_pages)`` where:
        - ``image_results`` is a list of ``(record, content_type, caption)`` tuples.
        - ``drawing_pages`` is the input list enriched with ``"caption"`` and
          ``"fields"`` keys — each entry is the same shape as
          ``adapter._render_visual_pdf_pages`` output.
    """
    if not image_records and not drawing_pages:
        return [], []
    if not vlm_api_key:
        logger.warning("VLM not configured; skipping batch enrichment")
        return [], []

    from knowledge_layer.llamaindex import adapter as _adapter

    def _enrich_one_image(record: dict) -> tuple:
        content_type, caption = _cached_vlm_call(
            record["image_bytes"],
            "image",
            _adapter._analyze_image_with_vlm,
            record["image_bytes"],
            vlm_model=vlm_model,
            vlm_base_url=vlm_base_url,
            vlm_api_key=vlm_api_key,
            extract_charts=extract_charts,
        )
        return (record, content_type, caption)

    def _enrich_one_drawing(page: dict) -> dict:
        caption, fields = _cached_vlm_call(
            page["image_bytes"],
            "drawing",
            _adapter._analyze_drawing_page_with_vlm,
            page["image_bytes"],
            vlm_model=vlm_model,
            vlm_base_url=vlm_base_url,
            vlm_api_key=vlm_api_key,
        )
        page["caption"] = caption
        page["fields"] = fields
        return page

    total_tasks = len(image_records) + len(drawing_pages)
    image_results: list[tuple] = []
    enriched_drawings: list[dict] = []

    with ThreadPoolExecutor(max_workers=min(VLM_BATCH_WORKERS, total_tasks or 1)) as pool:
        futures = {}

        for record in image_records:
            fut = pool.submit(_enrich_one_image, record)
            futures[fut] = ("image", record)

        for page in drawing_pages:
            fut = pool.submit(_enrich_one_drawing, page)
            futures[fut] = ("drawing", page)

        for future in as_completed(futures):
            kind, obj = futures[future]
            try:
                result = future.result()
                if kind == "image":
                    image_results.append(result)
                else:
                    enriched_drawings.append(result)
            except Exception as e:
                logger.warning("VLM enrichment failed for %s: %s", kind, e)
                # Fail-open: keep the original obj but with empty enrichment
                if kind == "image":
                    image_results.append((obj, "image", "[Image - analysis failed]"))
                else:
                    obj["caption"] = "[Drawing - analysis failed]"
                    obj["fields"] = {}
                    enriched_drawings.append(obj)

    return image_results, enriched_drawings
