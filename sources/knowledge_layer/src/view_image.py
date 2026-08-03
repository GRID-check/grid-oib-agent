"""NAT function for viewing knowledge images.

Agents retrieve caption-only chunks for image/drawing pages: the caption
describes the image but the model never sees it. This tool returns the source
visual as a multimodal content block (``image_url`` with a data URL), so
vision-capable models can inspect plans, sections, elevations and charts
directly at answer time.

Two source shapes are covered, without re-ingest:

- **PDF pages** — the requested page is rendered from the original PDF on
  demand (max-dim capped). Base-corpus PDFs are read from disk (``data/oib``,
  ``OIB_UPLOADS_DIR``); project/Archiv PDFs are fetched from SeaweedFS and
  rendered from bytes.
- **Standalone images** (PNG/JPG project/Archiv uploads) — the stored bytes
  are fetched from SeaweedFS and returned directly (re-encoded to JPEG).

Storage-key resolution goes through the BFF internal lookup
(``GET /api/internal/document-file``): the backend carries only
``(collection, filename)``, and the mapping to a SeaweedFS ``storage_key``
lives in the frontend's ``documents`` table. Fail-open: every failure returns
a text-only block explaining what went wrong — the tool never raises.
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
# data/oib. Project/Archiv uploads live in SeaweedFS and are fetched via the
# BFF internal lookup + boto3 when no on-disk PDF matches.
_DEFAULT_PDF_DIRS = ["data/oib", os.environ.get("OIB_UPLOADS_DIR", "data/oib_uploads")]

_JPEG_QUALITY = 90

# Standalone-image extensions (an uploaded image file, not a page of a PDF).
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"}

# BFF internal lookup + SeaweedFS (S3) fetch. FRONTEND_INTERNAL_URL +
# GRID_INTERNAL_API_TOKEN are already present on the aiq-agent tier; the
# SEAWEED_* set is injected by the same tier once the backend fetches bytes
# directly. All are read lazily so a base-corpus-only deployment (no project
# uploads) needs none of them.
_FRONTEND_INTERNAL_URL_ENV = "FRONTEND_INTERNAL_URL"
_INTERNAL_TOKEN_ENV = "GRID_INTERNAL_API_TOKEN"
_SEAWEED_ENDPOINT_ENV = "SEAWEED_ENDPOINT"
_SEAWEED_BUCKET_ENV = "SEAWEED_BUCKET"
_SEAWEED_ACCESS_KEY_ENV = "SEAWEED_ACCESS_KEY"
_SEAWEED_SECRET_KEY_ENV = "SEAWEED_SECRET_KEY"
_DEFAULT_SEAWEED_BUCKET = "grid-documents"


def _default_max_dim() -> int:
    try:
        value = int(os.environ.get(_MAX_DIM_ENV, str(_DEFAULT_MAX_DIM)).strip())
    except ValueError:
        return _DEFAULT_MAX_DIM
    return value if value > 0 else _DEFAULT_MAX_DIM


class ViewKnowledgeImageToolConfig(FunctionBaseConfig, name="view_knowledge_image"):
    """Configuration for the knowledge image viewing tool."""

    max_dim: int = Field(
        default_factory=_default_max_dim,
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


def _render_page_from_bytes(pdf_bytes: bytes, page_number: int, max_dim: int) -> tuple[bytes, int, int]:
    """Render one page (1-based) of a PDF held in memory to JPEG bytes.

    Same as :func:`_render_page` but takes raw bytes (a project/Archiv PDF
    fetched from SeaweedFS) instead of a path. pypdfium2 accepts a bytes-like
    object directly.
    """
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(pdf_bytes)
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


def _normalize_image_to_jpeg(image_bytes: bytes, max_dim: int) -> tuple[bytes, int, int]:
    """Re-encode a standalone image (PNG/JPG/…) to max-dim-capped JPEG bytes.

    Mirrors the ingestion-time normalization so the model sees the image at a
    consistent resolution and format regardless of the upload type. Returns
    ``(jpeg_bytes, width_px, height_px)``; raises on any decode failure.
    """
    from PIL import Image

    pil_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    longest = max(pil_image.width, pil_image.height) or 1
    if longest > max_dim:
        scale = max_dim / longest
        pil_image = pil_image.resize((max(1, round(pil_image.width * scale)), max(1, round(pil_image.height * scale))))
    buf = io.BytesIO()
    pil_image.save(buf, format="JPEG", quality=_JPEG_QUALITY)
    return buf.getvalue(), pil_image.width, pil_image.height


async def _resolve_storage_key(collection: str, file_name: str, organization_id: str | None = None) -> str | None:
    """Resolve a ``(collection, filename)`` pair to a SeaweedFS storage key.

    Calls the BFF internal lookup (service-token guarded). Returns ``None`` on
    any failure (unconfigured URL/token, non-200, transport error) — fail-open,
    so a base-corpus-only deployment with no BFF wiring simply never resolves.

    An optional ``organization_id`` is forwarded as the ``organizationId``
    query param (needed to scope Archiv documents); when not passed it is
    derived from the collection prefix (``archiv_org_123`` -> ``org_123``).
    The param is only added to the request when one was derived/provided.
    """
    base_url = os.environ.get(_FRONTEND_INTERNAL_URL_ENV, "").strip()
    token = os.environ.get(_INTERNAL_TOKEN_ENV, "").strip()
    if not base_url or not token:
        return None
    try:
        import httpx

        if organization_id is None and collection.startswith("archiv_"):
            organization_id = collection[len("archiv_") :]
        params = {"collection": collection, "filename": file_name}
        if organization_id:
            params["organizationId"] = organization_id
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{base_url.rstrip('/')}/api/internal/document-file",
                params=params,
                headers={"x-grid-internal-token": token},
            )
        if response.status_code != 200:
            return None
        data = response.json()
        storage_key = data.get("storageKey")
        return storage_key if isinstance(storage_key, str) and storage_key else None
    except Exception:  # noqa: BLE001 - fail-open contract
        logger.warning(
            "view_knowledge_image: storage-key lookup failed for %s/%s", collection, file_name, exc_info=True
        )
        return None


def _fetch_seaweed_bytes(storage_key: str) -> bytes | None:
    """Fetch an object's bytes from SeaweedFS via boto3 (S3, path-style).

    Returns ``None`` on any failure (missing creds, transport error, NoSuchKey)
    so callers degrade to a text-only block. Imports boto3 lazily so the tool
    imports cleanly in a deployment that never fetches.
    """
    endpoint = os.environ.get(_SEAWEED_ENDPOINT_ENV, "").strip()
    access_key = os.environ.get(_SEAWEED_ACCESS_KEY_ENV, "").strip()
    secret_key = os.environ.get(_SEAWEED_SECRET_KEY_ENV, "").strip()
    if not endpoint or not access_key or not secret_key:
        return None
    bucket = os.environ.get(_SEAWEED_BUCKET_ENV, _DEFAULT_SEAWEED_BUCKET).strip() or _DEFAULT_SEAWEED_BUCKET
    try:
        import boto3
        from botocore.config import Config as _BotoConfig

        client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name="us-east-1",
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            config=_BotoConfig(s3={"addressing_style": "path"}),
        )
        response = client.get_object(Bucket=bucket, Key=storage_key)
        return response["Body"].read()
    except Exception:  # noqa: BLE001 - fail-open contract
        logger.warning("view_knowledge_image: SeaweedFS fetch failed for key %s", storage_key, exc_info=True)
        return None


def _is_standalone_image(file_name: str) -> bool:
    """True when the file is an uploaded image (PNG/JPG/…), not a page of a PDF."""
    idx = file_name.rfind(".")
    return idx > 0 and file_name[idx:].lower() in _IMAGE_EXTENSIONS


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

    async def lookup(
        file_name: str,
        page_number: int = 1,
        collection: str = "",
    ) -> list[dict] | str:
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

        # Standalone image upload (PNG/JPG): there is no page to render — fetch
        # the stored bytes from SeaweedFS and return them directly.
        if _is_standalone_image(file_name):
            if not collection:
                return (
                    f"[view_knowledge_image] '{file_name}' is an uploaded image; pass the "
                    "collection it belongs to so the stored bytes can be located."
                )
            storage_key = await _resolve_storage_key(collection, file_name)
            if storage_key is None:
                return (
                    f"[view_knowledge_image] Could not locate the stored file for '{file_name}' "
                    f"in collection '{collection}' (not in the document index, or the document "
                    "service is unreachable)."
                )
            try:
                image_bytes = await asyncio.wait_for(
                    asyncio.to_thread(_fetch_seaweed_bytes, storage_key), timeout=config.timeout
                )
            except Exception as e:  # noqa: BLE001 - fail-open contract
                logger.warning("view_knowledge_image: fetch failed for %s: %s", file_name, e)
                image_bytes = None
            if image_bytes is None:
                return (
                    f"[view_knowledge_image] Could not fetch the stored bytes for '{file_name}' "
                    "from object storage (credentials/endpoint unavailable, or the object is gone)."
                )
            try:
                jpeg_bytes, width, height = await asyncio.wait_for(
                    asyncio.to_thread(_normalize_image_to_jpeg, image_bytes, config.max_dim), timeout=config.timeout
                )
            except Exception as e:  # noqa: BLE001 - fail-open contract
                logger.warning("view_knowledge_image: image decode failed for %s: %s", file_name, e)
                return f"[view_knowledge_image] Could not decode the image '{file_name}': {e}"
            image_b64 = base64.b64encode(jpeg_bytes).decode("ascii")
            return [
                {
                    "type": "text",
                    "text": (
                        f"Uploaded image '{file_name}' from collection '{collection}' "
                        f"({width}x{height}px). This is the actual image the retrieved chunk "
                        "describes — inspect it for plans, drawings, scale and relationships."
                    ),
                },
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
            ]

        # PDF page: render the requested page. Base-corpus PDFs come from disk;
        # a project/Archiv PDF falls back to a SeaweedFS fetch rendered from bytes.
        pdf_path = _find_pdf(config.pdf_dirs, file_name)
        if pdf_path is not None:
            try:
                jpeg_bytes, width, height = await asyncio.wait_for(
                    asyncio.to_thread(_render_page, pdf_path, page_number, config.max_dim), timeout=config.timeout
                )
            except Exception as e:  # noqa: BLE001 - fail-open contract
                logger.warning("view_knowledge_image: render failed for %s page %d: %s", file_name, page_number, e)
                return f"[view_knowledge_image] Could not render page {page_number} of '{file_name}': {e}"
            image_b64 = base64.b64encode(jpeg_bytes).decode("ascii")
            return [
                {
                    "type": "text",
                    "text": (
                        f"Rendered page {page_number} of '{file_name}' "
                        f"({width}x{height}px). "
                        "This is the actual page the retrieved chunk describes — inspect it "
                        "for plans, drawings, scale, dimensions and relationships."
                    ),
                },
                {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
            ]

        # Not on disk: a project/Archiv PDF living only in SeaweedFS.
        if not collection:
            return (
                f"[view_knowledge_image] Could not find the source PDF for '{file_name}'. "
                "Rendering is possible for base-corpus documents (data/oib, OIB_UPLOADS_DIR) "
                "without a collection; pass the collection for a project/Archiv document."
            )
        storage_key = await _resolve_storage_key(collection, file_name)
        if storage_key is None:
            return (
                f"[view_knowledge_image] Could not locate the stored file for '{file_name}' "
                f"in collection '{collection}' (not in the document index, or the document "
                "service is unreachable)."
            )
        try:
            pdf_bytes = await asyncio.wait_for(
                asyncio.to_thread(_fetch_seaweed_bytes, storage_key), timeout=config.timeout
            )
        except Exception as e:  # noqa: BLE001 - fail-open contract
            logger.warning("view_knowledge_image: fetch failed for %s: %s", file_name, e)
            pdf_bytes = None
        if pdf_bytes is None:
            return (
                f"[view_knowledge_image] Could not fetch the stored bytes for '{file_name}' "
                "from object storage (credentials/endpoint unavailable, or the object is gone)."
            )
        try:
            jpeg_bytes, width, height = await asyncio.wait_for(
                asyncio.to_thread(_render_page_from_bytes, pdf_bytes, page_number, config.max_dim),
                timeout=config.timeout,
            )
        except Exception as e:  # noqa: BLE001 - fail-open contract
            logger.warning("view_knowledge_image: render failed for %s page %d: %s", file_name, page_number, e)
            return f"[view_knowledge_image] Could not render page {page_number} of '{file_name}': {e}"
        image_b64 = base64.b64encode(jpeg_bytes).decode("ascii")
        return [
            {
                "type": "text",
                "text": (
                    f"Rendered page {page_number} of '{file_name}' from collection "
                    f"'{collection}' ({width}x{height}px). "
                    "This is the actual page the retrieved chunk describes — inspect it "
                    "for plans, drawings, scale, dimensions and relationships."
                ),
            },
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
        ]

    yield FunctionInfo.from_fn(
        lookup,
        description=(
            "View a knowledge image or PDF page as an image the model can inspect. Use when a "
            "retrieved chunk is an image or drawing (plan, section, elevation, chart) and you need "
            "to see what it shows. For a base-corpus document pass just file_name and page_number; "
            "for a project/Archiv document (an uploaded PDF or image) also pass its collection so "
            "the stored bytes can be fetched. Returns an image content block; fails open with a "
            "text explanation."
        ),
    )
