"""Unified document processing pipeline with concurrent VLM enrichment.

Provides a DRY, extensible extraction pipeline that:
- Runs VLM captioning concurrently for embedded images AND rendered drawing pages
  within a single file (biggest latency win: a 20-page plan set goes from 20+
  serial round-trips to 4 concurrent workers per file).
- Content-hash caches every VLM result via ``aiq_agent.common.cache`` so a
  re-ingest or cross-document duplicate image skips the API call entirely. The
  VLM model is part of the cache identity, so a model switch never serves
  stale captions produced by a different model.
- Maintains backward compatibility with ``adapter.py`` module-level functions
  (test patches control adapter attributes; this module accesses them through
  the module reference so patches still fire).
- Failed VLM analyses (exceptions AND the placeholder captions the call sites
  return on error) are SKIPPED rather than indexed, so placeholder text like
  "[Drawing - analysis failed]" never pollutes the vector store.
- The visual-page heuristic accepts pre-extracted page texts (the caller's
  watermark-stripped pdfplumber output) so the PDF's text layer is read once,
  and the documented "watermark-stripped text" threshold actually holds.

Typical usage (inside ``_run_ingestion``)::

    from knowledge_layer.llamaindex.processing import enrich_vlm_batch

    image_records = adapter._extract_images_from_pdf(file_path)
    drawing_pages = render_visual_pages_no_vlm(file_path, ..., page_texts=text_pages)

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
import os
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import as_completed
from typing import Any

from aiq_agent.common.cache import get_json
from aiq_agent.common.cache import set_json

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# @environment_variable AIQ_VLM_BATCH_WORKERS
# @category Knowledge Layer
# @type int
# @default 4
# @required false
# Max concurrent VLM workers per file. Kept modest to avoid saturating the
# provider rate-limit or the process socket pool — architectural plan sets
# typically have 5-20 visual pages and 0-10 embedded images, so 4 workers
# cuts a 20-page serial loop to ~5 rounds.
VLM_BATCH_WORKERS = max(1, int(os.environ.get("AIQ_VLM_BATCH_WORKERS", "4")))

# Content-hash cache TTL: 30 days. Long enough that re-ingesting a changed PDF
# (but with many unchanged images) still hits the cache for the stable images.
_VLM_CACHE_TTL_SECONDS = 30 * 86400


# ---------------------------------------------------------------------------
# Content-hash VLM cache
# ---------------------------------------------------------------------------


# Placeholder captions the adapter's VLM call sites return on failure
# (provider error, missing key, empty response). Compared case-insensitively.
_FAILURE_CAPTION_PREFIXES = ("[image -", "[drawing -")


def is_failed_caption(caption: str | None) -> bool:
    """True when ``caption`` is a failure placeholder, not real VLM output.

    The VLM call sites are fail-open and return strings like
    ``"[Drawing - analysis failed: …]"`` instead of raising. Such placeholders
    must never be embedded into the vector store (they pollute retrieval with
    content-free chunks), so every ingestion path filters on this predicate.
    """
    return bool(caption) and caption.strip().lower().startswith(_FAILURE_CAPTION_PREFIXES)


def _result_carries_failed_caption(result: Any) -> bool:
    """True when a cached-call result carries a failure placeholder caption.

    The two VLM call shapes differ — ``(content_type, caption)`` for images,
    ``(caption, fields)`` for drawings — so every string member is checked
    rather than a fixed position.
    """
    if isinstance(result, str):
        return is_failed_caption(result)
    if isinstance(result, (list, tuple)):
        return any(isinstance(part, str) and is_failed_caption(part) for part in result)
    return False


def vlm_cache_key(image_bytes: bytes, prompt_type: str, model: str = "") -> str:
    """Content-hash cache key for a VLM analysis result.

    ``prompt_type`` distinguishes the prompt/mode that produced the result so a
    caption from one prompt is never served for another: ``"drawing"`` (the
    German drawing-aware prompt) versus ``"image:charts=<bool>"`` (the English
    image prompt, keyed by ``extract_charts`` since the chart-aware and
    descriptive variants yield different content_type/caption for the same bytes).

    ``model`` is part of the identity because different VLMs caption the same
    bytes differently — without it, a model switch (deployment-wide or per-org
    ``ingest_vlm`` override) would serve the old model's captions until TTL
    expiry, and two orgs on different models would share each other's output.
    """
    h = hashlib.sha256(image_bytes).hexdigest()
    return f"vlm:caption:{model}:{prompt_type}:{h}"


def _cached_vlm_call(
    image_bytes: bytes,
    prompt_type: str,
    live_call,
    *args,
    model: str = "",
    **kwargs,
):
    """Wrap a VLM call with content-hash caching.

    On cache hit: returns the stored JSON result directly.
    On cache miss: calls ``live_call(*args, **kwargs)``, stores, and returns.
    On read or store error: degrades to a live call (fail-open — a cache-backend
    hiccup must never block ingest nor masquerade as a VLM analysis failure).
    ``model`` scopes the cache entry to the VLM that produced it (see
    ``vlm_cache_key``).

    Failure placeholders are returned to the caller but never stored: a
    transient provider error would otherwise be cached for the full TTL, so the
    re-ingest that is supposed to recover the file would replay the failure
    from cache without ever calling the VLM again.
    """
    key = vlm_cache_key(image_bytes, prompt_type, model)
    try:
        cached = get_json(key)
    except Exception:
        logger.debug("VLM cache read failed (swallowed) for %s", key[:60])
        cached = None
    if cached is not None:
        logger.debug("VLM cache HIT for %s", key[:60])
        return cached
    result = live_call(*args, **kwargs)
    if _result_carries_failed_caption(result):
        logger.debug("VLM analysis failed; not caching placeholder for %s", key[:60])
        return result
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
    page_texts: dict[int, str] | None = None,
) -> list[dict[str, Any]]:
    """Detect and render visual/vector PDF pages WITHOUT calling the VLM.

    Returns rendered JPEG bytes instead of captioned results so the caller can
    batch VLM calls concurrently.

    ``page_texts`` (1-based page number → text) lets the caller hand in the
    text it already extracted — in ``_run_ingestion`` that is the
    watermark-stripped pdfplumber output, so the PDF's text layer is read once
    and the heuristic's documented "watermark-stripped text" threshold actually
    holds. When omitted, the text is read here via pdfium (raw, unstripped) —
    kept for standalone/test use.

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

    _PAGEOBJ_PATH = 2

    results: list[dict[str, Any]] = []
    rendered = 0
    skipped_pages = 0

    # Opening is its own step so the failure can say what it actually means. A PDF
    # pdfium cannot parse is NOT a failed ingestion: the text layer is read by
    # pdfplumber on a separate path, so the document still ingests and simply
    # contributes no visual pages. Logging that at ERROR filed a GitHub issue for
    # every unusual PDF in the corpus while the ingest it described succeeded.
    try:
        doc = pdfium.PdfDocument(pdf_path)
    except Exception as e:
        logger.warning(
            "Visual-page rendering unavailable for %s (%s: %s); text ingestion is unaffected",
            pdf_path,
            type(e).__name__,
            e,
        )
        return results

    try:
        try:
            for page_num in range(len(doc)):
                # Guarded separately, and this is the defect the guard exists for:
                # `doc[page_num]` raises on a damaged page and used to sit OUTSIDE
                # the try below, so one unreadable page abandoned every page after
                # it. A 40-page drawing set could lose 38 captions to page 2 and
                # report nothing — the caller sees a short list, not an error.
                try:
                    page = doc[page_num]
                except Exception as e:
                    skipped_pages += 1
                    logger.debug("Visual-page render skipped page %d of %s (%s)", page_num + 1, pdf_path, e)
                    continue
                try:
                    if page_texts is not None:
                        text_len = len((page_texts.get(page_num + 1) or "").strip())
                    else:
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
                except Exception as e:
                    # One page's render failing costs that page, not the rest.
                    skipped_pages += 1
                    logger.debug("Visual-page render failed on page %d of %s (%s)", page_num + 1, pdf_path, e)
                finally:
                    page.close()
        finally:
            doc.close()
    except Exception as e:
        # Whatever is left: a failure of the document itself rather than of one
        # page. Still not fatal to ingestion, for the reason given above.
        logger.warning("Visual-page rendering stopped for %s (%s: %s)", pdf_path, type(e).__name__, e)

    if results:
        logger.info("Detected %d visual page(s) in %s", len(results), pdf_path)
    if skipped_pages:
        # Said out loud rather than inferred from a short list: partial output that
        # looks complete is the failure mode this whole function had.
        logger.warning("Skipped %d unreadable page(s) while rendering %s", skipped_pages, pdf_path)

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
          ``"fields"`` keys.

        Items whose VLM analysis failed (exception OR placeholder caption) are
        omitted entirely and logged — a failure placeholder is never indexed.
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
            # The chart-aware and purely-descriptive prompts produce different
            # content_type/caption for identical bytes, so ``extract_charts``
            # is part of the cache identity — otherwise a re-ingest under a
            # different setting would serve the stale other-mode result.
            f"image:charts={extract_charts}",
            _adapter._analyze_image_with_vlm,
            record["image_bytes"],
            vlm_model=vlm_model,
            vlm_base_url=vlm_base_url,
            vlm_api_key=vlm_api_key,
            extract_charts=extract_charts,
            model=vlm_model,
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
            model=vlm_model,
        )
        page["caption"] = caption
        page["fields"] = fields
        return page

    total_tasks = len(image_records) + len(drawing_pages)
    image_results: list[tuple] = []
    enriched_drawings: list[dict] = []
    skipped = 0

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
            except Exception as e:
                logger.warning("VLM enrichment failed for %s (skipped, not indexed): %s", kind, e)
                skipped += 1
                continue
            # Fail-open placeholder captions (provider error/missing key/empty
            # response) are skipped the same way — they carry no retrievable
            # content and would pollute the vector store as real chunks.
            caption = result[2] if kind == "image" else result.get("caption")
            if is_failed_caption(caption):
                logger.warning(
                    "VLM analysis failed for %s on page %s (skipped, not indexed): %s",
                    kind,
                    obj.get("page_number"),
                    (caption or "")[:120],
                )
                skipped += 1
                continue
            if kind == "image":
                image_results.append(result)
            else:
                enriched_drawings.append(result)

    if skipped:
        logger.warning("VLM batch: %d/%d item(s) failed and were skipped (not indexed)", skipped, total_tasks)

    return image_results, enriched_drawings
