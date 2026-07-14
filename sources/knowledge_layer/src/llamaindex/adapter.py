# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""
LlamaIndex adapter for the Knowledge Layer.

This adapter provides a lightweight, no-deployment-required local solution.
It uses:
- ChromaDB for local vector storage (file-based, like Milvus-lite)
- NVIDIA embeddings via LlamaIndex's NVIDIA integration
- LlamaIndex's document loaders and chunking
- Optional multimodal extraction (tables, charts, images) with NVIDIA VLM captioning

Configuration options:
    persist_dir: Directory for ChromaDB persistence (default: /tmp/chroma_data)
    embed_model: NVIDIA embedding model (default: nvidia/llama-nemotron-embed-vl-1b-v2)
    embed_base_url: Embedding model base URL (default: https://integrate.api.nvidia.com/v1)
    chunk_size: Chunk size for text splitting (default: 1024, model supports up to 2048 tokens)
    chunk_overlap: Overlap between chunks (default: 128)

Multimodal options:
    extract_tables: Enable table extraction via pdfplumber (default: False)
    extract_charts: Enable chart extraction with VLM data extraction (default: False)
    extract_images: Enable image extraction with VLM captioning (default: False)
    vlm_model: NVIDIA VLM model for captioning (default: nvidia/llama-3.2-90b-vision-instruct)
    vlm_base_url: VLM model base URL (default: https://integrate.api.nvidia.com/v1)

Chart extraction uses the VLM to:
1. Classify images as charts/graphs vs regular images
2. Extract structured data (chart type, axis labels, data points, trends)
"""

import asyncio
import base64
import logging
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC
from datetime import datetime
from pathlib import Path
from typing import Any

from aiq_agent.knowledge.base import BaseIngestor
from aiq_agent.knowledge.base import BaseRetriever
from aiq_agent.knowledge.base import TTLCleanupMixin
from aiq_agent.knowledge.factory import register_ingestor
from aiq_agent.knowledge.factory import register_retriever
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import CollectionInfo
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.schema import FileInfo
from aiq_agent.knowledge.schema import FileProgress
from aiq_agent.knowledge.schema import FileStatus
from aiq_agent.knowledge.schema import IngestionJobStatus
from aiq_agent.knowledge.schema import JobState
from aiq_agent.knowledge.schema import RetrievalResult

logger = logging.getLogger(__name__)

# Default VLM model for image captioning
# nemotron-nano is faster (12B vs 90B) - same as NV-Ingest service mode uses
DEFAULT_VLM_MODEL = os.environ.get("AIQ_VLM_MODEL", "nvidia/nemotron-nano-12b-v2-vl")
# Default VLM model base URL
DEFAULT_VLM_BASE_URL = os.environ.get("AIQ_VLM_BASE_URL", "https://integrate.api.nvidia.com/v1")


# Image extraction settings - filters out small icons/logos
MIN_IMAGE_WIDTH_PX = 100
MIN_IMAGE_HEIGHT_PX = 100

# @environment_variable AIQ_COLLECTION_TTL_HOURS
# @category Knowledge Layer
# @type float
# @default 24
# @required false
# Hours before stale collections are deleted by the TTL cleanup thread.
COLLECTION_TTL_HOURS = float(os.environ.get("AIQ_COLLECTION_TTL_HOURS", "24"))

# @environment_variable AIQ_TTL_CLEANUP_INTERVAL_SECONDS
# @category Knowledge Layer
# @type int
# @default 3600
# @required false
# Seconds between TTL cleanup runs.
TTL_CLEANUP_INTERVAL_SECONDS = int(os.environ.get("AIQ_TTL_CLEANUP_INTERVAL_SECONDS", "3600"))

# Terminal jobs are retained this long for status polling/file listings, then
# pruned so in-memory job tracking doesn't grow for the life of the process.
JOB_RETENTION_SECONDS = 3600  # 1 hour

# Document summarization + tag-classification input limits live in the shared
# aiq_agent.knowledge.document_classification module (CLASSIFY_MAX_INPUT_CHARS).

# ---------------------------------------------------------------------------
# In-process collection write versions.
#
# The retriever's static-collection result cache keys on this version so any
# ingestion/deletion in this process invalidates cached results immediately;
# the cache TTL covers writes from other processes (there are none today —
# one backend process owns the embedded Chroma store).
# ---------------------------------------------------------------------------
_collection_versions: dict[str, int] = {}
_collection_versions_lock = threading.Lock()


def bump_collection_version(collection_name: str) -> None:
    with _collection_versions_lock:
        _collection_versions[collection_name] = _collection_versions.get(collection_name, 0) + 1


def collection_version(collection_name: str) -> int:
    with _collection_versions_lock:
        return _collection_versions.get(collection_name, 0)


def _read_api_key_env(name: str) -> str:
    """Read an API key env var, treating unresolved ``${...}`` placeholders as unset.

    docker compose ``env_file`` does not interpolate ``${VAR}`` references, so a
    line like ``AIQ_VLM_API_KEY=${OPENROUTER_API_KEY}`` reaches the process as a
    literal placeholder string rather than a key.
    """
    key = os.environ.get(name, "")
    if key.startswith("${") and key.endswith("}"):
        logger.error("%s contains an unresolved placeholder %r - treating as unset", name, key)
        return ""
    return key


def _get_nvidia_api_key() -> str:
    """Get NVIDIA API key from environment."""
    key = _read_api_key_env("NVIDIA_API_KEY")
    if not key:
        logger.warning("NVIDIA_API_KEY not set - embeddings may fail")
    return key


def _get_vlm_api_key() -> str:
    """Get VLM API key from environment, falling back to NVIDIA_API_KEY."""
    key = _read_api_key_env("AIQ_VLM_API_KEY")
    if not key:
        key = _get_nvidia_api_key()
    return key


# =============================================================================
# Multimodal Extraction Utilities
# =============================================================================


def _extract_images_from_pdf(
    pdf_path: str,
    min_width: int = MIN_IMAGE_WIDTH_PX,
    min_height: int = MIN_IMAGE_HEIGHT_PX,
) -> list[dict[str, Any]]:
    """
    Extract images from a PDF file using PyPDFium2.

    Args:
        pdf_path: Path to the PDF file.
        min_width: Minimum image width to extract (filters out icons/logos).
        min_height: Minimum image height to extract.

    Returns:
        List of dicts with 'image_bytes', 'page_number', 'image_index', 'format'.
    """
    try:
        import io

        import pypdfium2 as pdfium
    except ImportError:
        logger.warning("pypdfium2 not installed. Install with: pip install pypdfium2")
        return []

    # PDFium C API constant: FPDF_PAGEOBJ_IMAGE = 3
    # Not always exposed as a Python attribute in pypdfium2 v5
    PAGEOBJ_IMAGE = 3

    images = []
    try:
        doc = pdfium.PdfDocument(pdf_path)
        for page_num in range(len(doc)):
            page = doc[page_num]
            img_idx = 0

            for obj in page.get_objects():
                if obj.type != PAGEOBJ_IMAGE:
                    continue

                try:
                    bitmap = obj.get_bitmap()
                    width = bitmap.width
                    height = bitmap.height

                    # Filter small images (likely icons/logos)
                    if width >= min_width and height >= min_height:
                        pil_image = bitmap.to_pil()
                        buf = io.BytesIO()
                        pil_image.save(buf, format="JPEG", quality=95)
                        images.append(
                            {
                                "image_bytes": buf.getvalue(),
                                "page_number": page_num + 1,
                                "image_index": img_idx,
                                "format": "jpeg",
                                "width": width,
                                "height": height,
                            }
                        )
                except Exception as e:
                    logger.debug(f"Could not extract image {img_idx} from page {page_num}: {e}")

                img_idx += 1

            page.close()

        doc.close()
        logger.info(f"Extracted {len(images)} images from {pdf_path}")

    except Exception as e:
        logger.error(f"Error extracting images from PDF: {e}")

    return images


def _extract_tables_from_pdf(pdf_path: str) -> list[dict[str, Any]]:
    """
    Extract tables from a PDF file using pdfplumber.

    Args:
        pdf_path: Path to the PDF file.

    Returns:
        List of dicts with 'table_text' (markdown), 'page_number', 'table_index'.
    """
    try:
        import pdfplumber
    except ImportError:
        logger.warning("pdfplumber not installed. Install with: pip install pdfplumber")
        return []

    tables = []
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page_num, page in enumerate(pdf.pages):
                page_tables = page.extract_tables()

                for table_idx, table in enumerate(page_tables):
                    if table and len(table) > 1:  # Has header and at least one row
                        # Convert to markdown format
                        markdown = _table_to_markdown(table)
                        if markdown:
                            tables.append(
                                {
                                    "table_text": markdown,
                                    "page_number": page_num + 1,
                                    "table_index": table_idx,
                                    "rows": len(table),
                                    "cols": len(table[0]) if table else 0,
                                }
                            )

        logger.info(f"Extracted {len(tables)} tables from {pdf_path}")

    except Exception as e:
        logger.error(f"Error extracting tables from PDF: {e}")

    return tables


def _extract_text_from_pdf(pdf_path: str) -> list[dict[str, Any]]:
    """Extract per-page text from a PDF without falling back to raw PDF bytes."""
    try:
        import pdfplumber
    except ImportError:
        logger.warning("pdfplumber not installed. Install with: pip install pdfplumber")
        return []

    pages: list[dict[str, Any]] = []
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page_num, page in enumerate(pdf.pages, start=1):
                text = (page.extract_text() or "").strip()
                if text:
                    pages.append({"page_number": page_num, "text": text})

        logger.info("Extracted text from %d PDF pages in %s", len(pages), pdf_path)

    except Exception as e:
        logger.error("Error extracting PDF text: %s", e)

    return pages


def _looks_like_pdf(file_path: str) -> bool:
    """Detect PDFs by file magic so presigned/temp files without .pdf still use PDF extraction."""
    try:
        with open(file_path, "rb") as handle:
            return handle.read(5) == b"%PDF-"
    except OSError:
        return False


def _looks_like_raw_pdf_or_binary(text: str) -> bool:
    """Reject raw PDF bytes or binary-looking text before it reaches Chroma."""
    sample = text[:4096]
    if sample.lstrip().startswith("%PDF"):
        return True
    if "endobj" in sample and "xref" in sample:
        return True
    if "\x00" in sample:
        return True
    if not sample:
        return False

    control_count = sum(1 for ch in sample if ord(ch) < 32 and ch not in "\n\r\t")
    return control_count / len(sample) > 0.05


def _table_to_markdown(table: list[list[str]]) -> str:
    """Convert a table (list of lists) to markdown format."""
    if not table or not table[0]:
        return ""

    # Clean cells
    def clean_cell(cell):
        if cell is None:
            return ""
        return str(cell).replace("|", "\\|").replace("\n", " ").strip()

    lines = []

    # Header row
    header = [clean_cell(cell) for cell in table[0]]
    lines.append("| " + " | ".join(header) + " |")
    lines.append("| " + " | ".join(["---"] * len(header)) + " |")

    # Data rows
    for row in table[1:]:
        cells = [clean_cell(cell) for cell in row]
        # Pad if needed
        while len(cells) < len(header):
            cells.append("")
        lines.append("| " + " | ".join(cells[: len(header)]) + " |")

    return "\n".join(lines)


def _analyze_image_with_vlm(
    image_bytes: bytes,
    vlm_model: str = DEFAULT_VLM_MODEL,
    vlm_base_url: str = DEFAULT_VLM_BASE_URL,
    extract_charts: bool = True,
) -> tuple[str, str]:
    """
    Analyze an image using NVIDIA's VLM API - classify AND caption in ONE call.

    This is optimized for the no-deployment workflow:
    - Single VLM call instead of separate classify + caption calls
    - Returns both content type and description

    Args:
        image_bytes: Raw image bytes.
        vlm_model: NVIDIA VLM model name.
        extract_charts: If True, use chart-aware prompt that extracts data.

    Returns:
        Tuple of (content_type, caption) where content_type is "chart" or "image".
    """
    try:
        from openai import OpenAI
    except ImportError:
        logger.warning("openai package not installed. Install with: pip install openai")
        return ("image", "[Image - captioning unavailable]")

    api_key = _get_vlm_api_key()
    if not api_key:
        return ("image", "[Image - VLM API key not set]")

    # Single prompt that handles both classification and captioning
    if extract_charts:
        prompt = """Analyze this image and respond in the following format:

TYPE: [chart/graph/image]

If this is a chart or graph, extract:
- Chart type (bar, line, pie, scatter, etc.)
- Title and axis labels
- Key data points and values
- Main trends or insights

If this is a regular image, describe:
- Main subject and scene
- Key visual elements
- Any text visible

Provide a detailed, structured response."""
    else:
        prompt = "Describe this image in detail, focusing on the main subject, visual elements, and any text visible."

    try:
        # Encode image to base64
        image_b64 = base64.b64encode(image_bytes).decode("utf-8")

        # Call NVIDIA's VLM API
        client = OpenAI(
            base_url=vlm_base_url,
            api_key=api_key,
        )

        response = client.chat.completions.create(
            model=vlm_model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{image_b64}",
                            },
                        },
                    ],
                }
            ],
            max_tokens=512,
            temperature=0.2,
        )

        caption = response.choices[0].message.content
        logger.debug(f"VLM analysis: {caption[:100]}...")

        # Determine content type from response
        content_type = "image"
        if extract_charts:
            caption_lower = caption.lower()
            # Check for chart indicators in the response
            if any(
                indicator in caption_lower
                for indicator in [
                    "type: chart",
                    "type: graph",
                    "bar chart",
                    "line chart",
                    "pie chart",
                    "scatter plot",
                    "histogram",
                    "chart type:",
                    "this chart",
                    "this graph",
                    "the chart",
                    "the graph",
                ]
            ):
                content_type = "chart"

        return (content_type, caption)

    except Exception as e:
        logger.error(f"VLM analysis failed: {e}")
        return ("image", f"[Image - analysis failed: {str(e)[:50]}]")


# Legacy function for backward compatibility
def _caption_image_with_vlm(
    image_bytes: bytes,
    vlm_model: str = DEFAULT_VLM_MODEL,
    vlm_base_url: str = DEFAULT_VLM_BASE_URL,
    prompt: str = "Describe this image in detail.",
    is_chart: bool = False,
) -> str:
    """Legacy wrapper - use _analyze_image_with_vlm for new code."""
    _, caption = _analyze_image_with_vlm(
        image_bytes,
        vlm_model=vlm_model,
        vlm_base_url=vlm_base_url,
        extract_charts=is_chart,
    )
    return caption


# =============================================================================
# Document Summarization
# =============================================================================


def _generate_document_summary(text_content: str, file_name: str, llm=None) -> str | None:
    """
    Generate one-sentence summary from document text.

    Thin wrapper over the shared, backend-agnostic
    ``summarize_document_text`` (prompt + call + parse live in one place so the
    two backends can never drift). LlamaIndex supplies the text from already
    extracted chunks.

    Args:
        text_content: Combined first + last chunk text.
        file_name: Filename for context.
        llm: LangChain LLM object. Required - no default fallback.

    Returns:
        One-sentence summary or None if no LLM provided or generation failed.
    """
    from aiq_agent.knowledge.document_classification import summarize_document_text

    return summarize_document_text(text_content, file_name, llm)


# =============================================================================
# LlamaIndex Ingestor
# =============================================================================


@register_ingestor("llamaindex")
class LlamaIndexIngestor(TTLCleanupMixin, BaseIngestor):
    """
    LlamaIndex-based document ingestor with optional multimodal extraction.

    Uses ChromaDB for vector storage and NVIDIA embeddings.
    Runs entirely in-process with no external deployments required.

    Configuration options:
        persist_dir: ChromaDB persistence directory (default from AIQ_CHROMA_DIR)
        embed_model: NVIDIA embedding model name (default: nvidia/llama-nemotron-embed-vl-1b-v2)
        embed_base_url: Embedding model base URL (default: https://integrate.api.nvidia.com/v1)
        chunk_size: Text chunk size (default: 1024, model supports up to 2048 tokens)
        chunk_overlap: Chunk overlap (default: 128)

    Multimodal options:
        extract_tables: Enable table extraction from PDFs (default: False)
        extract_charts: Enable chart extraction with structured data (default: False)
        extract_images: Enable image extraction with VLM captioning (default: False)
        vlm_model: NVIDIA VLM for captioning (default: nvidia/llama-3.2-90b-vision-instruct)

    Environment variables:
        AIQ_CHROMA_DIR: Default ChromaDB persistence directory
        AIQ_EMBED_MODEL: Default embedding model name
        AIQ_EMBED_BASE_URL: Default embedding model base URL
        AIQ_EXTRACT_TABLES: Enable table extraction ("true"/"false")
        AIQ_EXTRACT_CHARTS: Enable chart extraction ("true"/"false")
        AIQ_EXTRACT_IMAGES: Enable image extraction ("true"/"false")
        AIQ_VLM_MODEL: VLM model for captioning
        AIQ_VLM_BASE_URL: Default VLM base URL
        AIQ_COLLECTION_TTL_HOURS: Hours before stale collections are deleted (default: 24)
        AIQ_TTL_CLEANUP_INTERVAL_SECONDS: Seconds between cleanup runs (default: 3600)
    """

    # @environment_variable AIQ_CHROMA_DIR
    # @category Knowledge Layer
    # @type str
    # @default /tmp/chroma_data
    # @required false
    # ChromaDB persistence directory for LlamaIndex vector storage.
    DEFAULT_PERSIST_DIR = os.environ.get("AIQ_CHROMA_DIR", "/tmp/chroma_data")

    # @environment_variable AIQ_EMBED_MODEL
    # @category Knowledge Layer
    # @type str
    # @default nvidia/llama-nemotron-embed-vl-1b-v2
    # @required false
    # NVIDIA embedding model name for LlamaIndex vector encoding.
    DEFAULT_EMBED_MODEL = os.environ.get("AIQ_EMBED_MODEL", "nvidia/llama-nemotron-embed-vl-1b-v2")

    # @environment_variable AIQ_EMBED_BASE_URL
    # @category Knowledge Layer
    # @type str
    # @default https://integrate.api.nvidia.com/v1
    # @required false
    # Embedding model base URL.
    DEFAULT_EMBED_BASE_URL = os.environ.get("AIQ_EMBED_BASE_URL", "https://integrate.api.nvidia.com/v1")

    # @environment_variable AIQ_EXTRACT_TABLES
    # @category Knowledge Layer
    # @type bool
    # @default false
    # @required false
    # Enable table extraction from PDFs during ingestion.
    DEFAULT_EXTRACT_TABLES = os.environ.get("AIQ_EXTRACT_TABLES", "false").lower() == "true"

    # @environment_variable AIQ_INGEST_MAX_WORKERS
    # @category Knowledge Layer
    # @type int
    # @default 2
    # @required false
    # Maximum concurrent ingestion jobs per process. Excess uploads queue
    # (job status stays PENDING) instead of each spawning a thread.
    INGEST_MAX_WORKERS = max(1, int(os.environ.get("AIQ_INGEST_MAX_WORKERS", "2")))

    # @environment_variable AIQ_EXTRACT_IMAGES
    # @category Knowledge Layer
    # @type bool
    # @default false
    # @required false
    # Enable image extraction from PDFs during ingestion.
    DEFAULT_EXTRACT_IMAGES = os.environ.get("AIQ_EXTRACT_IMAGES", "false").lower() == "true"

    # @environment_variable AIQ_EXTRACT_CHARTS
    # @category Knowledge Layer
    # @type bool
    # @default false
    # @required false
    # Enable chart extraction from PDFs during ingestion.
    DEFAULT_EXTRACT_CHARTS = os.environ.get("AIQ_EXTRACT_CHARTS", "false").lower() == "true"

    backend_name = "llamaindex"

    def __init__(self, config: dict[str, Any] | None = None):
        super().__init__(config)

        # Configuration - read from env vars with fallback to class defaults
        self.persist_dir = self.config.get("persist_dir", self.DEFAULT_PERSIST_DIR)
        self.embed_base_url = self.config.get("embed_base_url", self.DEFAULT_EMBED_BASE_URL)
        self.embed_model_name = self.config.get("embed_model", self.DEFAULT_EMBED_MODEL)
        # llama-nemotron-embed-vl-1b-v2 supports up to 2048 tokens
        self.chunk_size = self.config.get("chunk_size", 1024)
        self.chunk_overlap = self.config.get("chunk_overlap", 128)

        # Multimodal extraction options
        self.extract_tables = self.config.get("extract_tables", self.DEFAULT_EXTRACT_TABLES)
        self.extract_images = self.config.get("extract_images", self.DEFAULT_EXTRACT_IMAGES)
        self.extract_charts = self.config.get("extract_charts", self.DEFAULT_EXTRACT_CHARTS)
        self.vlm_model = self.config.get("vlm_model", DEFAULT_VLM_MODEL)
        self.vlm_base_url = self.config.get("vlm_base_url", DEFAULT_VLM_BASE_URL)

        # Document summarization options
        self.generate_summary_enabled = self.config.get("generate_summary", False)
        self.summary_llm = self.config.get("summary_llm")  # Resolved LangChain LLM (or None)

        # Job and file tracking (in-memory)
        self._jobs: dict[str, IngestionJobStatus] = {}
        self._files: dict[str, FileInfo] = {}
        self._lock = threading.RLock()  # RLock allows same thread to acquire multiple times

        # Bounded ingestion pool: a thread per upload gave N concurrent
        # uploads N threads all embedding against the remote API and writing
        # into the same embedded Chroma store. Excess jobs queue (status stays
        # PENDING until a worker picks them up) instead of piling on threads.
        self._ingest_pool = ThreadPoolExecutor(
            max_workers=self.INGEST_MAX_WORKERS,
            thread_name_prefix="llamaindex-ingest",
        )

        # Lazy-loaded components
        self._embed_model = None
        self._chroma_client = None
        self._initialized = False

        # Build mode description
        mode_parts = ["text"]
        if self.extract_tables:
            mode_parts.append("tables")
        if self.extract_charts:
            mode_parts.append("charts")
        if self.extract_images:
            mode_parts.append("images")
        mode = " + ".join(mode_parts) if len(mode_parts) > 1 else "text-only"

        logger.info(f"LlamaIndexIngestor initialized: persist_dir={self.persist_dir}, mode={mode}")

        # Start background TTL cleanup task
        self._start_ttl_cleanup_task(COLLECTION_TTL_HOURS, TTL_CLEANUP_INTERVAL_SECONDS)

    def _ensure_initialized(self):
        """Lazy initialization of LlamaIndex components."""
        if self._initialized:
            return

        try:
            from llama_index.embeddings.nvidia import NVIDIAEmbedding

            nvidia_api_key = _get_nvidia_api_key()
            if not nvidia_api_key:
                logger.error(
                    "NVIDIA_API_KEY is not set - ingestion/retrieval will fail. "
                    "Set the NVIDIA_API_KEY environment variable to enable embeddings."
                )

            self._embed_model = NVIDIAEmbedding(
                base_url=self.embed_base_url,
                model=self.embed_model_name,
                api_key=nvidia_api_key,
            )

            # Ensure persist directory exists
            os.makedirs(self.persist_dir, exist_ok=True)

            self._initialized = True
            logger.info(f"LlamaIndex components initialized with model: {self.embed_model_name}")

        except ImportError as e:
            raise RuntimeError(
                "LlamaIndex dependencies not installed. "
                "Install with: pip install llama-index llama-index-embeddings-nvidia chromadb"
            ) from e

    def _get_chroma_client(self):
        """Get or create the shared ChromaDB client (thread-safe)."""
        with self._lock:
            if self._chroma_client is None:
                import chromadb
                from chromadb.config import Settings

                os.makedirs(self.persist_dir, exist_ok=True)
                # Disable telemetry to reduce file descriptor usage
                self._chroma_client = chromadb.PersistentClient(
                    path=self.persist_dir,
                    settings=Settings(anonymized_telemetry=False),
                )
            return self._chroma_client

    def _update_file_status(
        self,
        job: IngestionJobStatus,
        file_index: int,
        status: FileStatus,
        chunks_created: int | None = None,
        error: str | None = None,
    ) -> None:
        """Update file status in both job.file_details and _files tracking dict."""
        with self._lock:
            if file_index < len(job.file_details):
                file_detail = job.file_details[file_index]
                file_detail.status = status
                file_detail.progress_percent = 100.0

                if status == FileStatus.SUCCESS and chunks_created is not None:
                    file_detail.chunks_created = chunks_created
                elif status == FileStatus.FAILED and error:
                    file_detail.error_message = error

                # Sync to _files tracking dict for list_files consistency
                tracked_file = self._files.get(file_detail.file_id)
                if tracked_file:
                    tracked_file.status = status
                    if status == FileStatus.SUCCESS and chunks_created is not None:
                        tracked_file.chunk_count = chunks_created
                        tracked_file.ingested_at = datetime.now(tz=UTC)
                    elif status == FileStatus.FAILED and error:
                        tracked_file.error_message = error

            job.processed_files = file_index + 1

    def submit_job(
        self,
        file_paths: list[str],
        collection_name: str,
        config: dict[str, Any] | None = None,
    ) -> str:
        """Submit an ingestion job (non-blocking)."""
        job_id = str(uuid.uuid4())
        job_config = {**self.config, **(config or {})}

        # Validate file paths. The caller-supplied per-file lists
        # (original_filenames / file_ids) are positional, so they must be
        # filtered in lockstep — otherwise a single skipped path shifts every
        # later file onto the wrong name/id (poisoning citations and
        # delete-by-filename).
        original_filenames = job_config.get("original_filenames", [])
        provided_file_ids = job_config.get("file_ids") or []
        validated_paths = []
        aligned_filenames = []
        aligned_file_ids = []
        for idx, path in enumerate(file_paths):
            if os.path.exists(path):
                validated_paths.append(path)
                if idx < len(original_filenames):
                    aligned_filenames.append(original_filenames[idx])
                if idx < len(provided_file_ids):
                    aligned_file_ids.append(provided_file_ids[idx])
            else:
                logger.warning(f"File not found, skipping: {path}")
        original_filenames = aligned_filenames
        provided_file_ids = aligned_file_ids
        # _run_ingestion re-reads these from the config; keep it aligned too.
        job_config["original_filenames"] = aligned_filenames
        job_config["file_ids"] = aligned_file_ids

        if not validated_paths:
            # Create failed job immediately
            job = IngestionJobStatus(
                job_id=job_id,
                status=JobState.FAILED,
                submitted_at=datetime.utcnow(),
                total_files=len(file_paths),
                processed_files=0,
                collection_name=collection_name,
                backend=self.backend_name,
                error_message="No valid file paths provided",
                completed_at=datetime.utcnow().isoformat(),
            )
            with self._lock:
                self._jobs[job_id] = job
            return job_id

        # Create pending job with file details
        # Use original filenames if provided, otherwise extract from path
        single_file_id = job_config.get("file_id")
        file_details = []
        for i, p in enumerate(validated_paths):
            # Use original filename if available, otherwise fall back to path name
            if i < len(original_filenames):
                file_name = original_filenames[i]
            else:
                file_name = Path(p).name
            if i < len(provided_file_ids):
                file_id = provided_file_ids[i]
            elif single_file_id and len(validated_paths) == 1:
                file_id = single_file_id
            else:
                file_id = str(uuid.uuid4())
            file_details.append(
                FileProgress(
                    file_id=file_id,
                    file_name=file_name,
                    status=FileStatus.UPLOADING,
                    progress_percent=0.0,
                )
            )
            # Store file_id → file_name mapping for delete operations
            with self._lock:
                existing_file = self._files.get(file_id)
                if existing_file:
                    existing_file.file_name = file_name
                    existing_file.collection_name = collection_name
                    existing_file.status = FileStatus.UPLOADING
                else:
                    self._files[file_id] = FileInfo(
                        file_id=file_id,
                        file_name=file_name,
                        collection_name=collection_name,
                        status=FileStatus.UPLOADING,
                    )

        job = IngestionJobStatus(
            job_id=job_id,
            status=JobState.PENDING,
            submitted_at=datetime.utcnow(),
            total_files=len(validated_paths),
            processed_files=0,
            collection_name=collection_name,
            backend=self.backend_name,
            file_details=file_details,
        )

        with self._lock:
            self._jobs[job_id] = job

        # Run ingestion on the bounded pool; the job stays PENDING while queued.
        self._ingest_pool.submit(self._run_ingestion, job_id, validated_paths, collection_name, job_config)

        logger.info(f"LlamaIndex ingestion job submitted: {job_id}")
        return job_id

    def _prune_completed_jobs(self) -> None:
        """Remove terminal jobs older than the retention window.

        Without this, a long-lived backend accumulates one IngestionJobStatus
        (with full file_details) per upload for the life of the process.
        Mirrors the FRAG adapter's retention behavior. ``completed_at`` is an
        isoformat string on this adapter (get_file_status round-trips it via
        fromisoformat), so parse before comparing.
        """
        now = datetime.utcnow()
        with self._lock:
            stale = []
            for jid, job in self._jobs.items():
                if job.status not in (JobState.COMPLETED, JobState.FAILED):
                    continue
                completed_at = self._parse_timestamp(job.completed_at) if isinstance(job.completed_at, str) else None
                if completed_at is not None and (now - completed_at).total_seconds() > JOB_RETENTION_SECONDS:
                    stale.append(jid)
            for jid in stale:
                del self._jobs[jid]
        if stale:
            logger.debug("Pruned %d completed job(s) from tracking", len(stale))

    def get_job_status(self, job_id: str) -> IngestionJobStatus:
        """Get current status of an ingestion job."""
        self._prune_completed_jobs()
        with self._lock:
            if job_id not in self._jobs:
                return IngestionJobStatus(
                    job_id=job_id,
                    status=JobState.FAILED,
                    submitted_at=datetime.utcnow(),
                    total_files=0,
                    processed_files=0,
                    collection_name="unknown",
                    backend=self.backend_name,
                    error_message="Job ID not found",
                    completed_at=datetime.utcnow().isoformat(),
                )
            return self._jobs[job_id].model_copy()

    # =========================================================================
    # Collection Management Implementation
    # =========================================================================

    def create_collection(
        self,
        name: str,
        description: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> CollectionInfo:
        """Create a new ChromaDB collection."""
        try:
            self._ensure_initialized()
            client = self._get_chroma_client()

            # Store timestamps as ISO strings in ChromaDB metadata
            now = datetime.utcnow()
            now_iso = now.isoformat()

            # Create collection with cosine similarity and timestamps
            collection_metadata = {
                "hnsw:space": "cosine",
                "created_at": now_iso,
                "updated_at": now_iso,
            }
            if description:
                collection_metadata["description"] = description
            if metadata:
                collection_metadata.update(metadata)

            collection = client.get_or_create_collection(
                name=name,
                metadata=collection_metadata,
            )

            logger.info(f"Created collection: {name}")

            return CollectionInfo(
                name=name,
                description=description,
                file_count=0,
                chunk_count=collection.count(),
                created_at=now,
                updated_at=now,
                backend=self.backend_name,
                metadata={
                    "persist_dir": self.persist_dir,
                    "embed_model": self.embed_model_name,
                    **collection_metadata,
                },
            )

        except Exception as e:
            logger.error(f"Failed to create collection {name}: {e}")
            raise

    def delete_collection(self, name: str) -> bool:
        """Delete a ChromaDB collection (thread-safe)."""
        try:
            with self._lock:
                client = self._get_chroma_client()
                client.delete_collection(name=name)
                # Purge in-memory tracking for the collection: entries left
                # behind leak for the life of the process, and if a deleted
                # collection name is ever reused, list_files would resurrect
                # old FAILED entries as phantom files.
                self._files = {fid: fi for fid, fi in self._files.items() if fi.collection_name != name}
                self._jobs = {jid: job for jid, job in self._jobs.items() if job.collection_name != name}

            # Clear summaries from centralized registry
            from aiq_agent.knowledge import clear_collection_summaries

            clear_collection_summaries(name)
            bump_collection_version(name)

            logger.info(f"Deleted collection: {name}")
            return True

        except Exception as e:
            logger.error(f"Failed to delete collection {name}: {e}")
            return False

    def _parse_timestamp(self, iso_string: str | None) -> datetime | None:
        """Parse an ISO format timestamp string to datetime."""
        if not iso_string:
            return None
        try:
            return datetime.fromisoformat(iso_string)
        except (ValueError, TypeError):
            return None

    @staticmethod
    def _get_all_metadatas(collection) -> list[dict[str, Any]]:
        """Page through ALL chunk metadatas of a Chroma collection.

        ``collection.peek(limit=N)`` only sees the first N chunks, so files
        whose chunks sit past the window vanish from file listings (and the
        OIB status page then misreports fully-ingested documents). Uses
        ``get`` with limit/offset so embeddings are not fetched.
        """
        batch_size = 5000
        metadatas: list[dict[str, Any]] = []
        offset = 0
        total = collection.count()
        while offset < total:
            page = collection.get(include=["metadatas"], limit=batch_size, offset=offset)
            page_metadatas = page.get("metadatas") or []
            if not page_metadatas:
                break
            metadatas.extend(page_metadatas)
            offset += len(page_metadatas)
        return metadatas

    def _update_collection_timestamp(self, collection_name: str) -> None:
        """Update the updated_at timestamp for a collection."""
        try:
            client = self._get_chroma_client()
            collection = client.get_collection(name=collection_name)

            # Get existing metadata and update the timestamp
            # Only include user-defined metadata fields, not ChromaDB internal ones like hnsw:space
            existing_metadata = collection.metadata or {}
            new_metadata = {}

            # Copy over user-defined fields (excluding hnsw:* which are immutable)
            for key, value in existing_metadata.items():
                if not key.startswith("hnsw:"):
                    new_metadata[key] = value

            new_metadata["updated_at"] = datetime.utcnow().isoformat()

            # ChromaDB's modify() only updates the metadata fields we provide
            collection.modify(metadata=new_metadata)

            logger.debug(f"Updated timestamp for collection: {collection_name}")

        except Exception as e:
            logger.warning(f"Failed to update collection timestamp for {collection_name}: {e}")

    def list_collections(self) -> list[CollectionInfo]:
        """List all ChromaDB collections (thread-safe)."""
        try:
            with self._lock:
                client = self._get_chroma_client()
                collections = client.list_collections()

                result = []
                for col in collections:
                    # Get description and timestamps from metadata if available
                    col_metadata = col.metadata or {}
                    description = col_metadata.get("description")
                    created_at = self._parse_timestamp(col_metadata.get("created_at"))
                    updated_at = self._parse_timestamp(col_metadata.get("updated_at"))

                    # Count unique files by examining chunk metadata
                    # This is approximate - based on unique file_name values
                    try:
                        metadatas = self._get_all_metadatas(col)
                        unique_files = set()
                        for m in metadatas:
                            if m and "file_name" in m:
                                unique_files.add(m["file_name"])
                        file_count = len(unique_files)
                    except Exception:
                        file_count = 0

                    result.append(
                        CollectionInfo(
                            name=col.name,
                            description=description,
                            file_count=file_count,
                            chunk_count=col.count(),
                            created_at=created_at,
                            updated_at=updated_at,
                            backend=self.backend_name,
                            metadata={
                                "persist_dir": self.persist_dir,
                                **col_metadata,
                            },
                        )
                    )

            logger.info(f"Listed {len(result)} collections")
            return result

        except Exception as e:
            logger.error(f"Failed to list collections: {e}")
            return []

    def get_collection(self, name: str) -> CollectionInfo | None:
        """Get metadata for a specific collection."""
        try:
            client = self._get_chroma_client()

            try:
                collection = client.get_collection(name=name)
            except Exception:
                return None

            col_metadata = collection.metadata or {}
            description = col_metadata.get("description")
            created_at = self._parse_timestamp(col_metadata.get("created_at"))
            updated_at = self._parse_timestamp(col_metadata.get("updated_at"))

            # Count unique files
            try:
                metadatas = self._get_all_metadatas(collection)
                unique_files = set()
                for m in metadatas:
                    if m and "file_name" in m:
                        unique_files.add(m["file_name"])
                file_count = len(unique_files)
            except Exception:
                file_count = 0

            return CollectionInfo(
                name=name,
                description=description,
                file_count=file_count,
                chunk_count=collection.count(),
                created_at=created_at,
                updated_at=updated_at,
                backend=self.backend_name,
                metadata={
                    "persist_dir": self.persist_dir,
                    **col_metadata,
                },
            )

        except Exception as e:
            logger.error(f"Failed to get collection {name}: {e}")
            return None

    # =========================================================================
    # File Management Implementation
    # =========================================================================

    def upload_file(
        self,
        file_path: str,
        collection_name: str,
        metadata: dict[str, Any] | None = None,
    ) -> FileInfo:
        """
        Upload a file to a collection.

        This creates a FileInfo record and triggers async ingestion.
        The actual ingestion is handled by submit_job in a background thread.
        """
        file_path_obj = Path(file_path)

        if not file_path_obj.exists():
            return FileInfo(
                file_id=str(uuid.uuid4()),
                file_name=file_path_obj.name,
                collection_name=collection_name,
                status=FileStatus.FAILED,
                error_message=f"File not found: {file_path}",
            )

        # Generate file ID
        file_id = str(uuid.uuid4())
        file_name = file_path_obj.name
        file_size = file_path_obj.stat().st_size

        # Create initial FileInfo
        file_info = FileInfo(
            file_id=file_id,
            file_name=file_name,
            collection_name=collection_name,
            status=FileStatus.UPLOADING,
            file_size=file_size,
            uploaded_at=datetime.utcnow(),
            metadata=metadata or {},
        )

        # Store file info for tracking
        with self._lock:
            self._files[file_id] = file_info

        # Start async ingestion
        job_id = self.submit_job(
            file_paths=[file_path],
            collection_name=collection_name,
            config={"file_id": file_id, **(metadata or {})},
        )

        # Update file info with job reference
        with self._lock:
            self._files[file_id].metadata["job_id"] = job_id
            self._files[file_id].status = FileStatus.INGESTING

        logger.info(f"Uploaded file to {collection_name} (file_id={file_id}, job_id={job_id})")

        return self._files[file_id]

    def delete_file(self, file_id: str, collection_name: str) -> bool:
        """
        Delete a file and its chunks from a collection.

        This removes all chunks that have the matching file_name in metadata.
        Handles both exact file names and names with tmp prefix stripped.
        Uses same tmp pattern as Foundational RAG: tmp[8 random chars]_filename

        The file_id parameter may be either a backend UUID or a human-readable
        filename (the frontend sends filenames). Both are handled: UUID is looked
        up directly in self._files, while a filename triggers a value-based search.
        """
        import re

        try:
            client = self._get_chroma_client()

            try:
                collection = client.get_collection(name=collection_name)
            except Exception:
                logger.warning(f"Collection {collection_name} not found")
                return False

            # Resolve file_name from tracking dict.
            # The caller may pass a UUID (direct key) or a filename (value search).
            file_name = None
            tracking_ids_to_remove: list[str] = []
            with self._lock:
                if hasattr(self, "_files"):
                    if file_id in self._files:
                        file_name = self._files[file_id].file_name
                        tracking_ids_to_remove.append(file_id)
                    else:
                        # file_id is likely a filename — search by value
                        for fid, fi in self._files.items():
                            if fi.file_name == file_id and fi.collection_name == collection_name:
                                file_name = fi.file_name
                                tracking_ids_to_remove.append(fid)
            if not file_name:
                file_name = file_id

            # Try exact match first
            results = collection.get(
                where={"file_name": file_name},
                include=["metadatas"],
            )

            if not results["ids"]:
                # Try matching with tmp prefix pattern (same as foundational_rag)
                # Python's tempfile uses 8 random characters: tmp[8chars]_filename
                tmp_pattern = re.compile(rf"^tmp.{{8}}_{re.escape(file_name)}$")
                all_results = collection.get(include=["metadatas"])
                matching_ids = [
                    all_results["ids"][i]
                    for i, meta in enumerate(all_results.get("metadatas", []))
                    if tmp_pattern.match(meta.get("file_name", ""))
                ]
                if not matching_ids:
                    if not tracking_ids_to_remove:
                        logger.warning(f"No chunks found for file_name={file_name}")
                        return False
                    # No chunks in ChromaDB but tracking entries exist (e.g. FAILED files).
                    # Clean them up and report success.
                    with self._lock:
                        for tid in tracking_ids_to_remove:
                            self._files.pop(tid, None)
                    logger.info(f"Removed {len(tracking_ids_to_remove)} tracking entries for file {file_name}")

                    from aiq_agent.knowledge import unregister_summary

                    unregister_summary(collection_name, file_name)
                    return True
                results = {"ids": matching_ids}

            collection.delete(ids=results["ids"])
            bump_collection_version(collection_name)
            logger.info(f"Deleted {len(results['ids'])} chunks for file {file_name}")

            # Remove all matching tracking entries
            with self._lock:
                if hasattr(self, "_files"):
                    for tid in tracking_ids_to_remove:
                        self._files.pop(tid, None)

            # Remove from centralized summary registry
            from aiq_agent.knowledge import unregister_summary

            unregister_summary(collection_name, file_name)

            return True

        except Exception as e:
            logger.error(f"Failed to delete file {file_id}: {e}")
            return False

    def list_files(self, collection_name: str) -> list[FileInfo]:
        """List all files in a collection."""
        try:
            client = self._get_chroma_client()

            try:
                collection = client.get_collection(name=collection_name)
            except Exception:
                return []

            # Get all unique file names from chunks
            metadatas = self._get_all_metadatas(collection)

            # Group chunks by file_name
            files_map: dict[str, dict[str, Any]] = {}
            for i, m in enumerate(metadatas):
                if m and "file_name" in m:
                    file_name = m["file_name"]
                    if file_name not in files_map:
                        files_map[file_name] = {
                            "chunk_count": 0,
                            "content_types": set(),
                            "pages": set(),
                            "file_size": None,
                            "file_type": None,
                            "creation_date": None,
                            "last_modified_date": None,
                        }
                    files_map[file_name]["chunk_count"] += 1
                    if "file_size" in m and files_map[file_name]["file_size"] is None:
                        files_map[file_name]["file_size"] = m["file_size"]
                    if "file_type" in m and files_map[file_name]["file_type"] is None:
                        files_map[file_name]["file_type"] = m["file_type"]
                    if "creation_date" in m and files_map[file_name]["creation_date"] is None:
                        files_map[file_name]["creation_date"] = m["creation_date"]
                    if "last_modified_date" in m and files_map[file_name]["last_modified_date"] is None:
                        files_map[file_name]["last_modified_date"] = m["last_modified_date"]
                    if "content_type" in m:
                        files_map[file_name]["content_types"].add(m["content_type"])
                    if "page_label" in m:
                        files_map[file_name]["pages"].add(m["page_label"])

            # Convert to FileInfo objects
            result = []
            for file_name, info in files_map.items():
                # Try to find existing FileInfo from tracking
                file_id = None
                file_info = None
                with self._lock:
                    if hasattr(self, "_files"):
                        for fid, fi in self._files.items():
                            if fi.file_name == file_name and fi.collection_name == collection_name:
                                file_id = fid
                                file_info = fi
                                break

                # Parse timestamps from chunk metadata
                uploaded_at = self._parse_timestamp(info["creation_date"])
                ingested_at = self._parse_timestamp(info["last_modified_date"])

                if file_info:
                    # Update tracked file with persisted metadata
                    file_info.chunk_count = info["chunk_count"]
                    if info["file_size"] is not None and not file_info.file_size:
                        file_info.file_size = info["file_size"]
                    if uploaded_at and not file_info.uploaded_at:
                        file_info.uploaded_at = uploaded_at
                    if ingested_at and not file_info.ingested_at:
                        file_info.ingested_at = ingested_at
                    result.append(file_info)
                else:
                    # Create new FileInfo from chunk metadata
                    result.append(
                        FileInfo(
                            file_id=file_id or str(uuid.uuid4()),
                            file_name=file_name,
                            collection_name=collection_name,
                            status=FileStatus.SUCCESS,
                            chunk_count=info["chunk_count"],
                            file_size=info["file_size"],
                            uploaded_at=uploaded_at,
                            ingested_at=ingested_at,
                            metadata={
                                "content_types": list(info["content_types"]),
                                "page_count": len(info["pages"]),
                                "file_type": info["file_type"],
                            },
                        )
                    )

            # Also include FAILED files from tracking (they won't have chunks in Chroma).
            # Track seen names to avoid duplicates when the same file was uploaded multiple times.
            with self._lock:
                if hasattr(self, "_files"):
                    existing_names = {f.file_name for f in result}
                    for fid, fi in self._files.items():
                        if (
                            fi.collection_name == collection_name
                            and fi.file_name not in existing_names
                            and fi.status == FileStatus.FAILED
                        ):
                            result.append(fi)
                            existing_names.add(fi.file_name)

            logger.info(f"Listed {len(result)} files in {collection_name}")
            return result

        except Exception as e:
            logger.error(f"Failed to list files in {collection_name}: {e}")
            return []

    def get_file_status(self, file_id: str, collection_name: str) -> FileInfo | None:
        """Get the current status of a file."""
        # Check tracking first
        with self._lock:
            if hasattr(self, "_files") and file_id in self._files:
                file_info = self._files[file_id]

                # Update status based on job status if ingesting
                if file_info.status == FileStatus.INGESTING:
                    job_id = file_info.metadata.get("job_id")
                    if job_id:
                        job_status = self.get_job_status(job_id)
                        if job_status.status == JobState.COMPLETED:
                            file_detail = next(
                                (
                                    detail
                                    for detail in job_status.file_details
                                    if detail.file_id == file_id or detail.file_name == file_info.file_name
                                ),
                                None,
                            )
                            if file_detail:
                                file_info.status = file_detail.status
                                file_info.chunk_count = file_detail.chunks_created
                                file_info.error_message = file_detail.error_message
                            else:
                                file_info.status = FileStatus.SUCCESS
                            # completed_at is now an ISO string, parse it back to datetime
                            if file_info.status == FileStatus.SUCCESS and job_status.completed_at:
                                file_info.ingested_at = datetime.fromisoformat(job_status.completed_at)
                        elif job_status.status == JobState.FAILED:
                            file_detail = next(
                                (
                                    detail
                                    for detail in job_status.file_details
                                    if detail.file_id == file_id or detail.file_name == file_info.file_name
                                ),
                                None,
                            )
                            file_info.status = file_detail.status if file_detail else FileStatus.FAILED
                            file_info.chunk_count = file_detail.chunks_created if file_detail else file_info.chunk_count
                            file_info.error_message = (
                                file_detail.error_message if file_detail else job_status.error_message or ""
                            )

                return file_info

        # Try to find in collection
        files = self.list_files(collection_name)
        for f in files:
            if f.file_id == file_id:
                return f

        return None

    def _run_ingestion(
        self,
        job_id: str,
        file_paths: list[str],
        collection_name: str,
        config: dict[str, Any],
    ):
        """Background ingestion worker with optional multimodal extraction."""
        try:
            # Update job to processing
            with self._lock:
                job = self._jobs[job_id]
                job.status = JobState.PROCESSING
                job.started_at = datetime.utcnow()

            # Initialize components
            self._ensure_initialized()

            # Import LlamaIndex components
            import chromadb
            from llama_index.core import Document
            from llama_index.core import Settings
            from llama_index.core import StorageContext
            from llama_index.core import VectorStoreIndex
            from llama_index.vector_stores.chroma import ChromaVectorStore

            # Configure LlamaIndex settings
            Settings.embed_model = self._embed_model
            Settings.chunk_size = config.get("chunk_size", self.chunk_size)
            Settings.chunk_overlap = config.get("chunk_overlap", self.chunk_overlap)

            # Get multimodal settings from config or instance defaults
            extract_tables = config.get("extract_tables", self.extract_tables)
            extract_images = config.get("extract_images", self.extract_images)
            extract_charts = config.get("extract_charts", self.extract_charts)
            vlm_model = config.get("vlm_model", self.vlm_model)
            vlm_base_url = config.get("vlm_base_url", self.vlm_base_url)

            # Set up ChromaDB client (use shared client if using default persist_dir)
            persist_dir = config.get("persist_dir", self.persist_dir)
            if persist_dir == self.persist_dir:
                chroma_client = self._get_chroma_client()
            else:
                from chromadb.config import Settings as ChromaSettings

                chroma_client = chromadb.PersistentClient(
                    path=persist_dir,
                    settings=ChromaSettings(anonymized_telemetry=False),
                )

            # Get or create collection
            chroma_collection = chroma_client.get_or_create_collection(
                name=collection_name,
                metadata={"hnsw:space": "cosine"},
            )

            # Set up vector store
            vector_store = ChromaVectorStore(chroma_collection=chroma_collection)
            storage_context = StorageContext.from_defaults(vector_store=vector_store)

            # Track extraction stats
            total_chunks = 0
            total_tables = 0
            total_charts = 0
            total_images = 0
            index = None

            # Original filenames for temp file uploads (avoids tmp prefix in metadata)
            original_filenames = config.get("original_filenames", [])

            # Process each file
            for i, file_path in enumerate(file_paths):
                try:
                    file_name = original_filenames[i] if i < len(original_filenames) else Path(file_path).name
                    file_size = os.path.getsize(file_path)
                    is_pdf = (
                        file_name.lower().endswith(".pdf")
                        or Path(file_path).suffix.lower() == ".pdf"
                        or _looks_like_pdf(file_path)
                    )

                    mode_str = "text"
                    if is_pdf and (extract_tables or extract_images):
                        mode_str = "multimodal"
                    logger.info(f"Processing file {i + 1}/{len(file_paths)} (mode={mode_str})")

                    # Update file status to ingesting
                    with self._lock:
                        if i < len(job.file_details):
                            job.file_details[i].status = FileStatus.INGESTING
                            job.file_details[i].progress_percent = (i / len(file_paths)) * 100

                    # Collect all documents for this file
                    all_documents = []

                    # 1. Extract text content. PDFs use pdfplumber directly because
                    # SimpleDirectoryReader can fall back to indexing raw PDF bytes
                    # when optional LlamaIndex file readers are missing.
                    if is_pdf:
                        text_documents = [
                            Document(
                                text=page["text"],
                                metadata={
                                    "file_name": file_name,
                                    "file_size": file_size,
                                    "page_label": str(page["page_number"]),
                                    "content_type": "text",
                                },
                            )
                            for page in _extract_text_from_pdf(file_path)
                        ]
                    else:
                        from llama_index.core import SimpleDirectoryReader

                        text_documents = SimpleDirectoryReader(input_files=[file_path]).load_data()

                        # Override file_name metadata (SimpleDirectoryReader uses temp path)
                        for doc in text_documents:
                            doc.metadata["file_name"] = file_name
                            doc.metadata["file_size"] = file_size

                    all_documents.extend(text_documents)
                    logger.info(f"  Text extraction: {len(text_documents)} documents")

                    # Start summary + tag classification in parallel with VLM
                    # (if enabled). Two separate LLM calls run concurrently on a
                    # 2-worker pool; both are awaited (with their own timeouts)
                    # and are fully fail-open below.
                    summary_future = None
                    tags_future = None
                    executor = None
                    if self.generate_summary_enabled and text_documents:
                        from concurrent.futures import ThreadPoolExecutor

                        from aiq_agent.knowledge.document_classification import classify_document_tags

                        first = text_documents[0].get_content()
                        last = text_documents[-1].get_content() if len(text_documents) > 1 else ""
                        combined = f"{first}\n...\n{last}" if last else first
                        executor = ThreadPoolExecutor(max_workers=2)
                        summary_future = executor.submit(
                            _generate_document_summary, combined, file_name, self.summary_llm
                        )
                        tags_future = executor.submit(classify_document_tags, combined, file_name, self.summary_llm)

                    # 2. Extract tables (PDF only)
                    if is_pdf and extract_tables:
                        tables = _extract_tables_from_pdf(file_path)
                        for table in tables:
                            table_doc = Document(
                                text=f"[TABLE from page {table['page_number']}]\n\n{table['table_text']}",
                                metadata={
                                    "file_name": file_name,
                                    "file_size": file_size,
                                    "page_label": str(table["page_number"]),
                                    "content_type": "table",
                                    "table_index": table["table_index"],
                                    "rows": table["rows"],
                                    "cols": table["cols"],
                                },
                            )
                            all_documents.append(table_doc)
                        total_tables += len(tables)
                        logger.info(f"  Table extraction: {len(tables)} tables")

                    # 3. Extract and analyze images/charts (PDF only)
                    # Uses single VLM call per image for classification + captioning
                    if is_pdf and (extract_images or extract_charts):
                        images = _extract_images_from_pdf(file_path)
                        file_charts = 0
                        file_images = 0

                        for img in images:
                            # Single VLM call that classifies AND captions
                            content_type, caption = _analyze_image_with_vlm(
                                img["image_bytes"],
                                vlm_model=vlm_model,
                                vlm_base_url=vlm_base_url,
                                extract_charts=extract_charts,
                            )

                            is_chart = content_type == "chart"

                            # Skip based on extraction preferences
                            if extract_charts and not extract_images and not is_chart:
                                continue  # Only want charts, this is an image
                            if extract_images and not extract_charts and is_chart:
                                continue  # Only want images, this is a chart

                            prefix = "CHART" if is_chart else "IMAGE"

                            image_doc = Document(
                                text=f"[{prefix} from page {img['page_number']}]\n\n{caption}",
                                metadata={
                                    "file_name": file_name,
                                    "file_size": file_size,
                                    "page_label": str(img["page_number"]),
                                    "content_type": content_type,
                                    "image_index": img["image_index"],
                                    "image_format": img["format"],
                                    "image_width": img["width"],
                                    "image_height": img["height"],
                                },
                            )
                            all_documents.append(image_doc)

                            if is_chart:
                                file_charts += 1
                            else:
                                file_images += 1

                        total_charts += file_charts
                        total_images += file_images
                        logger.info(f"  Visual extraction: {file_charts} charts, {file_images} images")

                    # Wait for summary if started
                    summary = None
                    if summary_future:
                        try:
                            summary = summary_future.result(timeout=30)
                        except TimeoutError:
                            logger.warning("Summary generation timed out for %s", file_name)
                        except Exception as e:
                            logger.warning("Summary generation failed for %s: %s", file_name, e)

                    # Wait for tags if started (independent timeout, fail-open —
                    # a tag failure never affects the summary or the ingestion).
                    tags = None
                    if tags_future:
                        try:
                            tags = tags_future.result(timeout=30)
                        except TimeoutError:
                            logger.warning("Tag classification timed out for %s", file_name)
                        except Exception as e:
                            logger.warning("Tag classification failed for %s: %s", file_name, e)

                    # Clean up executor
                    if executor:
                        executor.shutdown(wait=False)

                    valid_documents = [
                        doc for doc in all_documents if not _looks_like_raw_pdf_or_binary(doc.get_content())
                    ]
                    if len(valid_documents) != len(all_documents):
                        raise ValueError("Raw PDF/binary content detected; refusing to index")
                    if not valid_documents:
                        self._update_file_status(
                            job,
                            i,
                            FileStatus.FAILED,
                            error="No content extracted (file may be password-protected, corrupted, or empty)",
                        )
                        logger.warning("No indexable content extracted from %s", file_name)
                        continue
                    all_documents = valid_documents

                    # Create/update index with all documents
                    if index is None:
                        # First successful file - create new index
                        index = VectorStoreIndex.from_documents(
                            all_documents,
                            storage_context=storage_context,
                            show_progress=False,
                        )
                    else:
                        # Subsequent files - insert into existing index
                        for doc in all_documents:
                            index.insert(doc)

                    # Count chunks (nodes)
                    chunks_created = len(all_documents)
                    total_chunks += chunks_created

                    self._update_file_status(job, i, FileStatus.SUCCESS, chunks_created=chunks_created)
                    # Store summary + tags in FileInfo and centralized registry
                    if summary:
                        # Register in centralized summary registry (backend-agnostic).
                        # Tags ride along in the same upsert (may be None).
                        from aiq_agent.knowledge import register_summary

                        register_summary(collection_name, file_name, summary, tags=tags)

                        # Also store in local FileInfo for backwards compatibility
                        file_id = config.get("file_id")
                        if file_id and file_id in self._files:
                            with self._lock:
                                self._files[file_id].metadata["summary"] = summary
                                if tags:
                                    self._files[file_id].tags = tags
                        else:
                            # Fallback: store by filename when using submit_job directly
                            with self._lock:
                                self._files[file_name] = FileInfo(
                                    file_id=file_name,
                                    file_name=file_name,
                                    collection_name=collection_name,
                                    status=FileStatus.SUCCESS,
                                    chunk_count=chunks_created,
                                    tags=tags,
                                    metadata={"summary": summary},
                                )
                        logger.info(f"  Summary generated ({len(summary)} chars)")

                    logger.info(f"Completed file {i + 1}/{len(file_paths)} ({chunks_created} chunks)")

                except Exception as e:
                    logger.exception(f"Error processing file {file_path}")
                    self._update_file_status(job, i, FileStatus.FAILED, error=str(e))

            # Determine extraction mode
            mode_parts = ["text"]
            if extract_tables:
                mode_parts.append("tables")
            if extract_charts:
                mode_parts.append("charts")
            if extract_images:
                mode_parts.append("images")
            extraction_mode = "multimodal" if len(mode_parts) > 1 else "text-only"

            failed_files = [f for f in job.file_details if f.status == FileStatus.FAILED]
            successful_files = [f for f in job.file_details if f.status == FileStatus.SUCCESS]

            # Mark job as terminal based on per-file results
            with self._lock:
                if failed_files and not successful_files:
                    job.status = JobState.FAILED
                    job.error_message = f"{len(failed_files)}/{len(job.file_details)} file(s) failed"
                else:
                    job.status = JobState.COMPLETED
                # NOTE: assigned as an isoformat STRING (assignment bypasses
                # Pydantic coercion). get_file_status() depends on this — it
                # calls datetime.fromisoformat(job.completed_at), which raises
                # TypeError on a real datetime. Change both together.
                job.completed_at = datetime.utcnow().isoformat()
                job.metadata = {
                    "total_chunks": total_chunks,
                    "text_chunks": total_chunks - total_tables - total_charts - total_images,
                    "tables_extracted": total_tables,
                    "charts_extracted": total_charts,
                    "images_captioned": total_images,
                    "persist_dir": persist_dir,
                    "collection_name": collection_name,
                    "embed_model": self.embed_model_name,
                    "extraction_mode": extraction_mode,
                }

            # Update collection's updated_at timestamp
            self._update_collection_timestamp(collection_name)
            # Invalidate any cached retrieval results for this collection.
            bump_collection_version(collection_name)

            logger.info(
                f"LlamaIndex ingestion completed: {job_id} "
                f"(chunks={total_chunks}, tables={total_tables}, charts={total_charts}, images={total_images})"
            )

        except Exception as e:
            logger.exception("LlamaIndex ingestion failed")
            with self._lock:
                job = self._jobs[job_id]
                job.status = JobState.FAILED
                job.completed_at = datetime.utcnow().isoformat()
                job.error_message = str(e)

        finally:
            # Clean up temp files if requested
            if config.get("cleanup_files", False):
                for file_path in file_paths:
                    try:
                        if os.path.exists(file_path):
                            os.unlink(file_path)
                            logger.debug(f"Cleaned up temp file: {file_path}")
                    except OSError as e:
                        logger.warning(f"Failed to clean up temp file {file_path}: {e}")

    def generate_summary(self, text_content: str, file_name: str) -> str | None:
        """Generate summary using NVIDIA NIM if enabled."""
        if not self.generate_summary_enabled:
            return None
        return _generate_document_summary(text_content, file_name, self.summary_llm)

    async def health_check(self) -> bool:
        """In-process ingestor - always healthy if code is running."""
        return True


# =============================================================================
# LlamaIndex Retriever
# =============================================================================


@register_retriever("llamaindex")
class LlamaIndexRetriever(BaseRetriever):
    """
    LlamaIndex-based document retriever.

    Uses ChromaDB for vector storage and NVIDIA embeddings.

    Configuration options:
        persist_dir: ChromaDB persistence directory (default from AIQ_CHROMA_DIR)
        embed_model: NVIDIA embedding model name (default from AIQ_EMBED_MODEL)
        top_k: Default number of results (default: 10)

    Environment variables:
        AIQ_CHROMA_DIR: Default ChromaDB persistence directory
        AIQ_EMBED_MODEL: Default embedding model name
        AIQ_EMBED_BASE_URL: Default embedding model base URL
        AIQ_RETRIEVER_TOP_K: Default top_k value
    """

    # Default configuration from environment variables
    DEFAULT_PERSIST_DIR = os.environ.get("AIQ_CHROMA_DIR", "/tmp/chroma_data")
    DEFAULT_EMBED_MODEL = os.environ.get("AIQ_EMBED_MODEL", "nvidia/llama-nemotron-embed-vl-1b-v2")
    DEFAULT_EMBED_BASE_URL = os.environ.get("AIQ_EMBED_BASE_URL", "https://integrate.api.nvidia.com/v1")
    # @environment_variable AIQ_RETRIEVER_TOP_K
    # @category Knowledge Layer
    # @type int
    # @default 10
    # @required false
    # Default number of results returned by the LlamaIndex retriever.
    DEFAULT_TOP_K = int(os.environ.get("AIQ_RETRIEVER_TOP_K", "10"))

    backend_name = "llamaindex"

    def __init__(self, config: dict[str, Any] | None = None):
        super().__init__(config)

        self.persist_dir = self.config.get("persist_dir", self.DEFAULT_PERSIST_DIR)
        self.embed_model_name = self.config.get("embed_model", self.DEFAULT_EMBED_MODEL)
        self.embed_base_url = self.config.get("embed_base_url", self.DEFAULT_EMBED_BASE_URL)
        self.default_top_k = self.config.get("top_k", self.DEFAULT_TOP_K)

        # Lazy-loaded components
        self._embed_model = None
        self._chroma_client = None
        self._initialized = False
        self._init_lock = threading.Lock()

        # Rebuilding a VectorStoreIndex per query is pure overhead; cache one
        # per collection. The short TTL heals the rare delete-and-recreate of
        # a collection under the same name.
        self._index_cache: dict[str, tuple[float, Any]] = {}
        self._index_cache_lock = threading.Lock()

        # Query-embedding LRU: the knowledge tool fans one query out across
        # every collection in scope, and each retrieval embedded the same
        # string again through the remote embedding API. Keyed by
        # (embed model, query) so a model change never serves stale vectors.
        self._embed_cache: dict[tuple[str, str], list[float]] = {}
        self._embed_cache_order: list[tuple[str, str]] = []
        self._embed_cache_lock = threading.Lock()

        # Result cache for static corpora (the shared OIB knowledge base):
        # identical questions recur across users and conversations, and the
        # corpus only changes on re-sync. Keyed on the collection write
        # version, so in-process ingestion invalidates immediately.
        self._result_cache: dict[tuple[str, int, str, int], tuple[float, RetrievalResult]] = {}
        self._result_cache_order: list[tuple[str, int, str, int]] = []
        self._result_cache_lock = threading.Lock()

        logger.info(f"LlamaIndexRetriever initialized: persist_dir={self.persist_dir}")

    INDEX_CACHE_TTL_SECONDS = 60
    # @environment_variable AIQ_QUERY_EMBED_CACHE_SIZE
    # @category Knowledge Layer
    # @type int
    # @default 512
    # @required false
    # Maximum cached query embeddings per retriever (LRU).
    EMBED_CACHE_MAX = int(os.environ.get("AIQ_QUERY_EMBED_CACHE_SIZE", "512"))
    # @environment_variable AIQ_STATIC_RESULT_CACHE_COLLECTIONS
    # @category Knowledge Layer
    # @type str
    # @default oib_knowledge
    # @required false
    # Comma-separated collections whose retrieval results may be cached
    # (static corpora only — never project/session collections).
    STATIC_RESULT_CACHE_COLLECTIONS = frozenset(
        name.strip()
        for name in os.environ.get("AIQ_STATIC_RESULT_CACHE_COLLECTIONS", "oib_knowledge").split(",")
        if name.strip()
    )
    # @environment_variable AIQ_STATIC_RESULT_CACHE_TTL_SECONDS
    # @category Knowledge Layer
    # @type int
    # @default 3600
    # @required false
    # TTL for cached static-collection retrieval results.
    STATIC_RESULT_CACHE_TTL_SECONDS = int(os.environ.get("AIQ_STATIC_RESULT_CACHE_TTL_SECONDS", "3600"))
    RESULT_CACHE_MAX = 256

    def _ensure_initialized(self):
        """Lazy initialization of components. Thread-safe: retrieval runs off-loop."""
        if self._initialized:
            return

        with self._init_lock:
            if self._initialized:
                return
            self._initialize_components()

    def _initialize_components(self):
        try:
            import chromadb
            from chromadb.config import Settings as ChromaSettings
            from llama_index.core import Settings
            from llama_index.embeddings.nvidia import NVIDIAEmbedding

            nvidia_api_key = _get_nvidia_api_key()
            if not nvidia_api_key:
                logger.error(
                    "NVIDIA_API_KEY is not set - retrieval/ingestion will fail. "
                    "Set the NVIDIA_API_KEY environment variable to enable embeddings."
                )

            self._embed_model = NVIDIAEmbedding(
                base_url=self.embed_base_url,
                model=self.embed_model_name,
                api_key=nvidia_api_key,
            )
            Settings.embed_model = self._embed_model

            # Disable telemetry to reduce file descriptor usage
            self._chroma_client = chromadb.PersistentClient(
                path=self.persist_dir,
                settings=ChromaSettings(anonymized_telemetry=False),
            )

            self._initialized = True
            logger.info("LlamaIndex retriever components initialized")

        except ImportError as e:
            raise RuntimeError(
                "LlamaIndex dependencies not installed. "
                "Install with: pip install llama-index llama-index-embeddings-nvidia chromadb"
            ) from e

    def _get_index(self, collection_name: str):
        """Return a cached VectorStoreIndex for the collection, or None if missing."""
        from llama_index.core import VectorStoreIndex
        from llama_index.vector_stores.chroma import ChromaVectorStore

        now = time.monotonic()
        with self._index_cache_lock:
            cached = self._index_cache.get(collection_name)
            if cached and now - cached[0] < self.INDEX_CACHE_TTL_SECONDS:
                return cached[1]

        try:
            chroma_collection = self._chroma_client.get_collection(name=collection_name)
        except Exception as e:
            logger.warning(f"Collection '{collection_name}' not found: {e}")
            return None

        vector_store = ChromaVectorStore(chroma_collection=chroma_collection)
        index = VectorStoreIndex.from_vector_store(vector_store)
        with self._index_cache_lock:
            self._index_cache[collection_name] = (now, index)
        return index

    async def retrieve(
        self,
        query: str,
        collection_name: str,
        top_k: int = 10,
        filters: dict[str, Any] | None = None,
    ) -> RetrievalResult:
        """Retrieve documents matching the query.

        The embedding call and the Chroma query are synchronous; they run in a
        worker thread so a retrieval never stalls the server's event loop (and
        the per-collection fan-out in the knowledge tool actually parallelizes).
        """
        return await asyncio.to_thread(self._retrieve_sync, query, collection_name, top_k, filters)

    def _embed_query_cached(self, query: str) -> list[float]:
        """Embed a query once per (model, text); LRU-bounded."""
        key = (self.embed_model_name, query)
        with self._embed_cache_lock:
            if key in self._embed_cache:
                self._embed_cache_order.remove(key)
                self._embed_cache_order.append(key)
                return self._embed_cache[key]

        embedding = self._embed_model.get_query_embedding(query)

        with self._embed_cache_lock:
            if key not in self._embed_cache:
                self._embed_cache[key] = embedding
                self._embed_cache_order.append(key)
                while len(self._embed_cache_order) > self.EMBED_CACHE_MAX:
                    evicted = self._embed_cache_order.pop(0)
                    self._embed_cache.pop(evicted, None)
        return embedding

    def _cached_static_result(self, key: tuple[str, int, str, int]) -> RetrievalResult | None:
        with self._result_cache_lock:
            entry = self._result_cache.get(key)
            if entry is None:
                return None
            cached_at, result = entry
            if time.monotonic() - cached_at >= self.STATIC_RESULT_CACHE_TTL_SECONDS:
                self._result_cache.pop(key, None)
                if key in self._result_cache_order:
                    self._result_cache_order.remove(key)
                return None
            # Deep copy: callers merge/annotate results and must never mutate
            # the cached object.
            return result.model_copy(deep=True)

    def _store_static_result(self, key: tuple[str, int, str, int], result: RetrievalResult) -> None:
        with self._result_cache_lock:
            self._result_cache[key] = (time.monotonic(), result.model_copy(deep=True))
            if key in self._result_cache_order:
                self._result_cache_order.remove(key)
            self._result_cache_order.append(key)
            while len(self._result_cache_order) > self.RESULT_CACHE_MAX:
                evicted = self._result_cache_order.pop(0)
                self._result_cache.pop(evicted, None)

    def _retrieve_sync(
        self,
        query: str,
        collection_name: str,
        top_k: int = 10,
        filters: dict[str, Any] | None = None,
    ) -> RetrievalResult:
        try:
            self._ensure_initialized()

            logger.info(f"LlamaIndexRetriever.retrieve: query='{query[:50]}...', collection={collection_name}")

            cacheable = collection_name in self.STATIC_RESULT_CACHE_COLLECTIONS and not filters
            cache_key = (collection_name, collection_version(collection_name), query, top_k)
            if cacheable:
                cached = self._cached_static_result(cache_key)
                if cached is not None:
                    logger.info(f"Static retrieval cache hit for collection {collection_name}")
                    return cached

            index = self._get_index(collection_name)
            if index is None:
                return RetrievalResult(
                    chunks=[],
                    query=query,
                    backend=self.backend_name,
                    success=False,
                    error_message=f"Collection '{collection_name}' not found",
                )

            from llama_index.core.schema import QueryBundle

            # Embed once (LRU) and hand the vector to the retriever, so the
            # per-collection fan-out of one query hits the embedding API once.
            retriever = index.as_retriever(similarity_top_k=top_k)
            query_bundle = QueryBundle(query_str=query, embedding=self._embed_query_cached(query))
            nodes = retriever.retrieve(query_bundle)

            # Normalize results to Chunk schema
            chunks = [self.normalize(node) for node in nodes]

            logger.info(f"LlamaIndex retrieval returned {len(chunks)} chunks")

            result = RetrievalResult(
                chunks=chunks,
                query=query,
                backend=self.backend_name,
                success=True,
            )
            if cacheable:
                self._store_static_result(cache_key, result)
            return result

        except Exception as e:
            logger.error(f"LlamaIndex retrieval failed: {e}")
            return RetrievalResult(
                chunks=[],
                query=query,
                backend=self.backend_name,
                success=False,
                error_message=f"Retrieval failed: {str(e)[:100]}",
            )

    def normalize(self, raw_result: Any) -> Chunk:
        """Convert LlamaIndex NodeWithScore to universal Chunk."""
        try:
            if raw_result is None:
                raise ValueError("raw_result is None")
            # LlamaIndex returns NodeWithScore objects
            node = getattr(raw_result, "node", None)
            if node is None:
                raise ValueError("raw_result.node is None")
            score = raw_result.score if hasattr(raw_result, "score") else 0.0

            # Extract metadata (node.metadata can be None or non-dict for some nodes)
            _meta = getattr(node, "metadata", None)
            metadata = _meta if isinstance(_meta, dict) else {}
            file_name = metadata.get("file_name", "unknown")
            page_number = metadata.get("page_label")

            # Try to convert page_number to int
            if page_number is not None:
                try:
                    page_number = int(page_number)
                except (ValueError, TypeError):
                    page_number = None

            # Determine content type from metadata
            content_type_str = metadata.get("content_type", "text")
            if content_type_str == "table":
                content_type = ContentType.TABLE
            elif content_type_str == "image":
                content_type = ContentType.IMAGE
            elif content_type_str == "chart":
                content_type = ContentType.CHART
            else:
                content_type = ContentType.TEXT

            # Create display citation based on content type
            if content_type == ContentType.TABLE:
                table_idx = metadata.get("table_index", 0)
                display_citation = f"{file_name}, p.{page_number}, Table {table_idx + 1}"
            elif content_type == ContentType.IMAGE:
                img_idx = metadata.get("image_index", 0)
                display_citation = f"{file_name}, p.{page_number}, Image {img_idx + 1}"
            elif page_number:
                # Add text anchor for easier verification (Ctrl+F in source)
                node_content = node.get_content() if hasattr(node, "get_content") else str(node)
                text_preview = node_content[:40].replace("\n", " ").strip()
                if text_preview:
                    display_citation = f"{file_name}, p.{page_number} ('{text_preview}...')"
                else:
                    display_citation = f"{file_name}, p.{page_number}"
            else:
                display_citation = file_name

            return Chunk(
                chunk_id=node.node_id if hasattr(node, "node_id") else str(uuid.uuid4()),
                content=node.get_content() if hasattr(node, "get_content") else str(node),
                # Cosine similarity is in [-1, 1] (and float rounding can nudge
                # an exact match past 1.0), but Chunk.score enforces [0, 1] —
                # an out-of-range value would raise and swallow the real result.
                score=min(1.0, max(0.0, float(score))) if score else 0.0,
                file_name=file_name,
                page_number=page_number,
                display_citation=display_citation,
                content_type=content_type,
                metadata=metadata,
            )

        except Exception as e:
            logger.error(f"Error normalizing LlamaIndex result: {e}")
            return Chunk(
                chunk_id=str(uuid.uuid4()),
                content=str(raw_result),
                score=0.0,
                file_name="unknown",
                display_citation="Unknown Result",
                content_type=ContentType.TEXT,
            )

    async def health_check(self) -> bool:
        """Check if ChromaDB is accessible."""
        try:
            if self._chroma_client:
                self._chroma_client.heartbeat()
            return True
        except Exception:
            return False


# =============================================================================
# Utility Functions
# =============================================================================


def list_collections(persist_dir: str | None = None) -> list[dict[str, Any]]:
    """List all ChromaDB collections.

    Args:
        persist_dir: ChromaDB persistence directory.
                     Defaults to AIQ_CHROMA_DIR env var or /tmp/chroma_data.
    """
    if persist_dir is None:
        persist_dir = os.environ.get("AIQ_CHROMA_DIR", "/tmp/chroma_data")
    try:
        import chromadb
        from chromadb.config import Settings

        # Disable telemetry to reduce file descriptor usage
        client = chromadb.PersistentClient(
            path=persist_dir,
            settings=Settings(anonymized_telemetry=False),
        )
        collections = client.list_collections()

        return [
            {
                "name": col.name,
                "backend": "llamaindex",
                "count": col.count(),
            }
            for col in collections
        ]
    except Exception as e:
        logger.error(f"Error listing LlamaIndex collections: {e}")
        return []
