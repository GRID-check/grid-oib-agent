"""NAT function for viewing knowledge images.

Agents retrieve caption-only chunks for image/drawing pages: the caption
describes the image but the model never sees it. This tool re-renders the
source page from the original PDF and returns it as a multimodal content
block (``image_url`` with a data URL), so vision-capable models can inspect
plans, sections, elevations and charts directly at answer time.

Works for the existing corpus without re-ingest: bytes are never persisted
at ingest time, so the tool renders the requested page from the PDF on
demand (max-dim capped) instead. Fail-open: every failure returns a
text-only block explaining what went wrong — the tool never raises.
"""

import asyncio
import base64
import io
import logging
import os
from pathlib import Path

from pydantic import Field

from nat.builder.builder import Builder
from nat.builder.function_info import FunctionInfo
from nat.cli.register_workflow import register_function
from nat.data_models.function import FunctionBaseConfig

logger = logging.getLogger(__name__)

# Long edge of the rendered page, in pixels. Mirrors the ingestion-time
# visual-page render (AIQ_RENDER_VISUAL_PAGES) so the model sees the page at
# the same resolution it was captioned at.
_MAX_DIM_ENV = "AIQ_PAGE_RENDER_MAX_DIM"
_DEFAULT_MAX_DIM = 2048

# Gate env: when "off", the tool is available but answers with a text-only
# block. The capability half of the gate (vision key) is derived, never
# configured: without a VLM key no model in the fleet can consume images.
_VIEW_IMAGES_ENABLED_ENV = "AIQ_VIEW_IMAGES_ENABLED"

# The two writable base-corpus homes the OIB sync scans. Uploads made through
# the platform admin UI live under OIB_UPLOADS_DIR; the repo corpus ships in
# data/oib. Project/Archiv uploads live in SeaweedFS and are not covered by
# this tool (v1 renders base-corpus PDFs only).
_DEFAULT_PDF_DIRS = ["data/oib", os.environ.get("OIB_UPLOADS_DIR", "data/oib_uploads")]

_JPEG_QUALITY = 90


class ViewKnowledgeImageToolConfig(FunctionBaseConfig, name="view_knowledge_image"):
    """Configuration for the knowledge image viewing tool."""

    max_dim: int = Field(
        default=int(os.environ.get(_MAX_DIM_ENV, _DEFAULT_MAX_DIM)),
        description="Long edge (px) of the rendered page; higher is sharper, larger payloads.",
    )
    timeout: float = Field(default=30.0, description="Render timeout in seconds.")
    pdf_dirs: list[str] = Field(
        default_factory=lambda: list(_DEFAULT_PDF_DIRS),
        description=(
            "Directories scanned for the source PDF (searched recursively, case-insensitive on the file name)."
        ),
    )


def _is_enabled() -> bool:
    flag = os.environ.get(_VIEW_IMAGES_ENABLED_ENV, "true").strip().lower()
    return flag not in {"0", "false", "no", "off"}


def _find_pdf(pdf_dirs: list[str], file_name: str) -> str | None:
    """Locate the source PDF by file name (case-insensitive), or ``None``."""
    needle = file_name.lower()
    for directory in pdf_dirs:
        root = Path(directory)
        if not root.is_dir():
            continue
        try:
            for candidate in root.rglob("*"):
                if candidate.is_file() and candidate.name.lower() == needle:
                    return str(candidate)
        except OSError:
            logger.warning("Error scanning PDF directory %s", directory, exc_info=True)
    return None


def _render_page(pdf_path: str, page_number: int, max_dim: int) -> tuple[bytes, int, int]:
    """Render one page (1-based) of a PDF to JPEG bytes.

    Returns ``(jpeg_bytes, width_px, height_px)``. Raises on any failure; the
    caller turns errors into text-only blocks.
    """
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(pdf_path)
    try:
        page = doc[page_number - 1]
        try:
            width_pt, height_pt = page.get_size()
            longest_pt = max(width_pt, height_pt) or 1.0
            scale = max_dim / longest_pt
            bitmap = page.render(scale=scale)
            pil_image = bitmap.to_pil().convert("RGB")
            buf = io.BytesIO()
            pil_image.save(buf, format="JPEG", quality=_JPEG_QUALITY)
            return buf.getvalue(), pil_image.width, pil_image.height
        finally:
            page.close()
    finally:
        doc.close()


@register_function(config_type=ViewKnowledgeImageToolConfig)
async def view_knowledge_image(config: ViewKnowledgeImageToolConfig, _builder: Builder):
    """NAT function: let the agent SEE a retrieved knowledge image.

    WHEN TO USE
    -----------
    A retrieved chunk's content type is IMAGE or DRAWING (a plan, section,
    elevation, perspective or chart), or the citation suggests the answer
    depends on what an image actually shows — the caption alone is not
    enough. This tool returns the rendered page as an image the model can
    inspect directly.

    WHEN NOT TO USE
    ---------------
    Plain text content (TEXT/TABLE chunks carry the text already); you do not
    need to see the image — a caption suffices. Costs one page render plus a
    vision-model input per call, so use it only when seeing matters.
    """

    async def lookup(file_name: str, page_number: int, image_index: int = 0) -> list[dict] | str:
        if not _is_enabled():
            return f"[view_knowledge_image] Image viewing is disabled ({_VIEW_IMAGES_ENABLED_ENV} is off)."
        try:
            from knowledge_layer.llamaindex import adapter as _adapter

            if not _adapter._get_vlm_api_key():
                return (
                    "[view_knowledge_image] Image viewing is unavailable: no vision-model "
                    "API key is configured, so no model in this deployment can consume images."
                )
        except Exception:  # noqa: BLE001 - capability must never block the tool
            return "[view_knowledge_image] Image viewing is unavailable: vision capability could not be determined."

        if page_number < 1:
            return f"[view_knowledge_image] Invalid page number {page_number}: pages are 1-based."

        pdf_path = _find_pdf(config.pdf_dirs, file_name)
        if pdf_path is None:
            return (
                f"[view_knowledge_image] Could not find the source PDF for '{file_name}'. "
                "Rendering is only possible for base-corpus documents (data/oib, OIB_UPLOADS_DIR)."
            )

        try:
            jpeg_bytes, width, height = await asyncio.to_thread(_render_page, pdf_path, page_number, config.max_dim)
        except Exception as e:  # noqa: BLE001 - fail-open contract
            logger.warning("view_knowledge_image: render failed for %s page %d: %s", file_name, page_number, e)
            return f"[view_knowledge_image] Could not render page {page_number} of '{file_name}': {e}"

        image_b64 = base64.b64encode(jpeg_bytes).decode("ascii")
        return [
            {
                "type": "text",
                "text": (
                    f"Rendered page {page_number} of '{file_name}' "
                    f"({width}x{height}px, image_index={image_index}). "
                    "This is the actual page the retrieved chunk describes — inspect it "
                    "for plans, drawings, scale, dimensions and relationships."
                ),
            },
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
        ]

    yield FunctionInfo.from_fn(
        lookup,
        description=(
            "Render a page of a knowledge document as an image. Use when a retrieved "
            "chunk is an image or drawing (plan, section, elevation, chart) and you need "
            "to see what it shows; returns the rendered page as an image content block. "
            "Base-corpus documents only; fails open with a text explanation."
        ),
    )
