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
import hashlib
import json
import logging
import math
import os
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC
from datetime import datetime
from pathlib import Path
from typing import Any

from aiq_agent.knowledge import ingest_status_store
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


# ---------------------------------------------------------------------------
# ChromaDB client construction (embedded vs shared server).
#
# Horizontal scaling: when AIQ_CHROMA_URL (e.g. ``http://chroma:8000``) or
# AIQ_CHROMA_HOST is set, every backend replica and research worker talks to ONE
# shared Chroma server over HTTP instead of each opening its own embedded
# PersistentClient on local disk (which pins the vector store to a single pod).
# Unset -> today's embedded behaviour, unchanged, so local dev and single-node
# deployments are untouched. The returned client is API-compatible either way,
# so every downstream call site (collections, queries, count/peek, heartbeat)
# is identical.
# ---------------------------------------------------------------------------
def retrieval_dependency_faults() -> list[tuple[str, BaseException]]:
    """Describe, per required module, what is actually wrong with it right now.

    ``llama_index`` is a PEP-420 namespace package: the parent import succeeds
    whenever *any* ``llama-index-*`` distribution is present, even when the
    pieces we need are absent. A partial install therefore fails deep inside a
    submodule with ``cannot import name 'core' from 'llama_index' (unknown
    location)`` rather than at the obvious place, so "is it installed?" has to
    be answered per module.

    Each probe is a literal import rather than a loop over module names: the
    four are known when this is written, so computing them bought nothing and
    made the dependency graph invisible to both readers and static analysis.
    The exception type carries the distinction the report needs —
    ``ModuleNotFoundError`` means the module is genuinely absent, any other
    import failure means it is present but cannot be loaded, which is the case
    that was misreported as "not installed" for days.
    """
    faults: list[tuple[str, BaseException]] = []

    def _probe(distribution: str, module: str, load) -> None:
        try:
            load()
        except ModuleNotFoundError as exc:
            # A ModuleNotFoundError does NOT automatically mean this
            # distribution is absent: it also fires when the module imports
            # fine but one of ITS dependencies is missing. Only a failure
            # naming this module (or a parent of it) means "not installed";
            # anything else is a present-but-unusable install, which is the
            # case that has to stay distinguishable because it is the one the
            # old message got wrong.
            missing = exc.name or ""
            if missing and (module == missing or module.startswith(f"{missing}.")):
                faults.append((f"{distribution}: not installed ({exc})", exc))
            else:
                faults.append((f"{distribution}: installed but broken (missing dependency {missing or exc!r})", exc))
        except Exception as exc:  # noqa: BLE001 - the point is to report, not to handle
            faults.append((f"{distribution}: installed but broken ({type(exc).__name__}: {exc})", exc))

    def _core() -> None:
        import llama_index.core  # noqa: F401

    def _embeddings() -> None:
        from llama_index.embeddings.nvidia import NVIDIAEmbedding  # noqa: F401

    def _vector_store() -> None:
        from llama_index.vector_stores.chroma import ChromaVectorStore  # noqa: F401

    def _chroma() -> None:
        import chromadb  # noqa: F401

    _probe("llama-index-core", "llama_index.core", _core)
    _probe("llama-index-embeddings-nvidia", "llama_index.embeddings.nvidia", _embeddings)
    _probe("llama-index-vector-stores-chroma", "llama_index.vector_stores.chroma", _vector_store)
    _probe("chromadb", "chromadb", _chroma)
    return faults


def retrieval_dependency_report() -> list[str]:
    """The human-readable half of :func:`retrieval_dependency_faults`."""
    return [finding for finding, _ in retrieval_dependency_faults()]


def ensure_retrieval_dependencies() -> None:
    """Fail now, with the whole picture, rather than deep in a later call.

    Both initialization paths import only the piece they need first
    (``NVIDIAEmbedding``), so a missing ``llama-index-vector-stores-chroma``
    used to sail through ``_ensure_initialized`` and surface much later inside
    ``_get_index`` or ``_run_ingestion`` — outside the handler that produces the
    good diagnostic, and after the component had already reported itself ready.
    Probing the full set up front means "initialized" means usable.
    """
    faults = retrieval_dependency_faults()
    if not faults:
        return
    # Chained from the FIRST probe failure. Running before the try/except that
    # `_retrieval_dependency_error` serves means this is now the raise most
    # operators will actually see, so it has to carry the original traceback
    # too -- a summary string alone would drop the one frame that says where
    # the import broke.
    raise RuntimeError(
        "LlamaIndex retrieval stack is unusable in this environment.\nModule status:\n  "
        + "\n  ".join(finding for finding, _ in faults)
        + "\nA module reported 'installed but broken' means the distribution is present but incomplete "
        "(commonly a missing llama-index-core under the llama_index namespace package) -- reinstalling "
        "the whole extra, not adding a package, is the fix: uv sync --extra llamaindex"
    ) from faults[0][1]


def _retrieval_dependency_error(cause: BaseException) -> RuntimeError:
    """Build a truthful error for a failed LlamaIndex import.

    The previous message claimed "LlamaIndex dependencies not installed" for
    every ``ImportError``. In production the packages *were* installed and one
    of them was broken (``llama-index-core`` missing under an otherwise
    populated ``llama_index`` namespace), so the advice to reinstall them was
    wrong and the real cause -- present in the chained exception all along --
    went unread for days (issues #330, #331). A diagnostic that misdescribes the
    fault costs more than no diagnostic at all, so this one reports what is
    actually true of the running environment.
    """
    findings = retrieval_dependency_report() or ["no per-module fault found; see the chained exception"]
    return RuntimeError(
        "LlamaIndex retrieval stack is unusable in this environment.\n"
        f"Triggering import error: {type(cause).__name__}: {cause}\n"
        "Module status:\n  " + "\n  ".join(findings) + "\n"
        "A module reported 'installed but broken' means the distribution is present but incomplete "
        "(commonly a missing llama-index-core under the llama_index namespace package) -- reinstalling "
        "the whole extra, not adding a package, is the fix: uv sync --extra llamaindex"
    )


def _make_chroma_client(persist_dir: str):
    """Return a ChromaDB client: shared HTTP server when configured, else embedded."""
    import chromadb
    from chromadb.config import Settings

    settings = Settings(anonymized_telemetry=False)

    url = os.environ.get("AIQ_CHROMA_URL", "").strip()
    host = os.environ.get("AIQ_CHROMA_HOST", "").strip()
    port_env = os.environ.get("AIQ_CHROMA_PORT", "").strip()

    if url:
        from urllib.parse import urlparse

        # A scheme-less value like "chroma:8000" parses with scheme="chroma" and
        # hostname=None, which would silently connect to an empty host. Prepend a
        # scheme so host:port is parsed as authority.
        parsed = urlparse(url if "://" in url else f"http://{url}")
        ssl = parsed.scheme == "https"
        host = parsed.hostname or host
        if not host:
            raise ValueError(f"AIQ_CHROMA_URL has no host: {url!r}")
        # URL port wins; else AIQ_CHROMA_PORT; else scheme default.
        port = parsed.port or (int(port_env) if port_env.isdigit() else (443 if ssl else 8000))
    elif host:
        ssl = os.environ.get("AIQ_CHROMA_SSL", "").lower() in ("1", "true", "yes")
        port = int(port_env) if port_env.isdigit() else (443 if ssl else 8000)
    else:
        os.makedirs(persist_dir, exist_ok=True)
        return chromadb.PersistentClient(path=persist_dir, settings=settings)

    return chromadb.HttpClient(host=host, port=port, ssl=ssl, settings=settings)


# Image extraction settings - filters out small icons/logos
MIN_IMAGE_WIDTH_PX = 100
MIN_IMAGE_HEIGHT_PX = 100

# Cap on the longest edge (px) of an image before it is JPEG-re-encoded and sent
# to the VLM. Larger images are downscaled (aspect preserved, never upscaled) to
# bound the VLM payload/token cost; smaller images pass through untouched. The
# ORIGINAL dimensions are still recorded in the Document metadata.
VLM_MAX_IMAGE_DIM = 1568

# ---------------------------------------------------------------------------
# Visual-page rendering (vector/scanned drawing capture).
#
# Text extraction (pdfplumber) and embedded-image extraction (pypdfium2 image
# XObjects) BOTH miss vector-drawn CAD/architectural pages: the drawing is
# thousands of path objects, not a raster image, and carries almost no
# extractable text (often just a watermark). Such a page is rasterised in full
# — every path, fill and label composited into one bitmap — and handed to the
# VLM so the drawing's content, spatial relationships and scale are captured.
# Detection + rendering is gated so ordinary text PDFs (the bulk OIB corpus)
# are untouched and cost nothing extra.
# ---------------------------------------------------------------------------

# @environment_variable AIQ_RENDER_VISUAL_PAGES
# @category Knowledge Layer
# @type bool
# @default true
# @required false
# Render text-sparse / vector-heavy PDF pages to images and VLM-caption them.
# Effective only when a VLM key resolves; fires only on pages detected as
# visual (below the text threshold or above the path-count threshold).
RENDER_VISUAL_PAGES = os.environ.get("AIQ_RENDER_VISUAL_PAGES", "true").lower() == "true"

# Long-edge target (px) for a full-page render before it is sent to the VLM.
# ~2048px keeps linework, room labels and scale bars legible while staying at
# or below the vision-encoder caps of current VLMs (above this the provider
# just downsamples). Scale is computed per page from its point size so an A0
# sheet and an A4 sheet both land near this target.
PAGE_RENDER_MAX_DIM = int(os.environ.get("AIQ_PAGE_RENDER_MAX_DIM", "2048"))

# A page is treated as "visual" (→ rendered + VLM-captioned) when its
# watermark-stripped extractable text is shorter than this many characters...
VISUAL_PAGE_MIN_TEXT_CHARS = int(os.environ.get("AIQ_VISUAL_PAGE_MIN_TEXT_CHARS", "200"))
# ...OR it carries at least this many vector path objects (a plan/section/
# elevation is typically hundreds-to-tens-of-thousands of paths).
VISUAL_PAGE_MIN_PATHS = int(os.environ.get("AIQ_VISUAL_PAGE_MIN_PATHS", "300"))
# Hard cap on rendered pages per document, to bound VLM cost/latency on large
# plan sets. Excess visual pages are skipped (logged), text still indexed.
MAX_RENDERED_PAGES = int(os.environ.get("AIQ_MAX_RENDERED_PAGES", "20"))

# @environment_variable AIQ_VLM_TIMEOUT_SECONDS
# @category Knowledge Layer
# @type int
# @default 180
# @required false
# Per-request timeout for VLM captioning calls. The OpenAI SDK default (~600s,
# with 2 built-in retries) lets one hung provider pin an enrichment worker for
# up to ~20 minutes; 180s with a single retry bounds a hung request to ~6
# minutes. ``_vlm_chat_create`` may issue one extra request when the first
# response comes back truncated, but that retry runs with SDK retries disabled,
# so the ceiling for one caption is ~9 minutes — and only on the path where the
# provider answered once and then hung. Retries are kept (rather than dropped to
# 0) because a transient 429/5xx now costs an indexed chunk: failure
# placeholders are skipped, not embedded. Clamped like the sibling knobs: a
# misconfigured 0 or negative value would fail every VLM request immediately and
# silently disable captioning altogether.
VLM_REQUEST_TIMEOUT_SECONDS = max(1, int(os.environ.get("AIQ_VLM_TIMEOUT_SECONDS", "180")))

# @environment_variable AIQ_EMBED_BATCH_SIZE
# @category Knowledge Layer
# @type int
# @default 64
# @required false
# Texts per embedding API request. The llama-index default (10) serialises far
# too many round-trips on large documents — a 500-chunk PDF costs ~50
# sequential HTTP calls. Every OpenAI-compatible embeddings endpoint accepts
# far more per call (OpenAI 2048, NVIDIA NIM 259); 64 is conservative.
EMBED_BATCH_SIZE = max(1, int(os.environ.get("AIQ_EMBED_BATCH_SIZE", "64")))

# pypdfium2 page-object type constants (the C API values are not always exposed
# as Python attributes across versions).
_PAGEOBJ_TEXT = 1
_PAGEOBJ_PATH = 2
_PAGEOBJ_IMAGE = 3

# Boilerplate / licence watermark lines stamped into the rendered output by
# some CAD tools (Vectorworks/AutoCAD educational licences, "DRAFT", etc.).
# Stripped before the text-length heuristic and before summarisation so a
# drawing page that is 100% linework does not read as "has text" and so the
# summary never describes the watermark instead of the drawing. Matched
# case-insensitively against whole lines (leading/trailing whitespace ignored).
#
# Each entry is (phrase_fragment, line_suffix): the fragment is the bare
# phrase regex (no anchors) and is the single source of truth for both the
# whole-line patterns below and the substring patterns further down (used to
# scrub the phrase out of VLM captions where it can appear mid-sentence). The
# suffix is what follows the phrase to make a *whole line* match: most
# watermarks are just the phrase itself (``\s*$``), but the Autodesk stamp is
# often followed by extra trailing boilerplate on the same line, so it needs
# ``.*$`` instead.
_WATERMARK_PHRASES: list[tuple[str, str]] = [
    (r"vectorworks\s+educational\s+version", r"\s*$"),
    (r"educational\s+version", r"\s*$"),
    (r"produced\s+by\s+an\s+autodesk\s+(student|educational)\s+(version|product)", r".*$"),
    (r"created\s+(in|with)\s+an?\s+.*(trial|evaluation|educational).*version", r"\s*$"),
    (r"(unregistered|evaluation|trial|demo)\s+version", r"\s*$"),
]

WATERMARK_LINE_PATTERNS = [
    re.compile(rf"^\s*{fragment}{suffix}", re.IGNORECASE) for fragment, suffix in _WATERMARK_PHRASES
]

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

# Terminal per-file tracking entries (self._files) are retained this long, then
# pruned. SUCCESS files are still listable afterwards (list_files rebuilds them
# from Chroma chunks — with a fresh id, exactly as for any never-tracked file);
# FAILED rows drop off the listing once this window passes. Bounds self._files,
# which otherwise grew for the life of the process (scaling review phase-2, #13).
FILE_TRACKING_RETENTION_SECONDS = int(os.environ.get("AIQ_FILE_TRACKING_RETENTION_SECONDS", "86400"))  # 24h

# Document summarization + tag-classification input limits live in the shared
# aiq_agent.knowledge.document_classification module (CLASSIFY_MAX_INPUT_CHARS).


# ---------------------------------------------------------------------------
# Collection write versions (cross-replica).
#
# The premise the in-process counter rested on -- "one backend process owns the
# store" -- is false: AIQ_CHROMA_URL points every backend replica and every
# research worker at ONE Chroma. A version held in a module global is invisible
# to every replica but its own, so a write here would leave the others serving
# superseded results for the whole result-cache TTL. The version now lives in
# the shared cache; these two functions are the adapter's seam onto it.
# ---------------------------------------------------------------------------
def bump_collection_version(collection_name: str) -> None:
    """Record a write so every replica's cached results for this collection stop matching."""
    from aiq_agent.knowledge import collection_version as _collection_version

    _collection_version.bump(collection_name)


def collection_version(collection_name: str) -> int | None:
    """The collection's write version, or ``None`` when it cannot be resolved.

    NOTE the contract: ``None`` means UNKNOWN, not 0. A caller must not build a cache
    key from it and must not store a result. Coercing unknown to 0 is precisely how a
    replica keeps serving superseded legal text through a cache outage -- every entry
    another replica stored under version 0 would match again.
    """
    from aiq_agent.knowledge import collection_version as _collection_version

    return _collection_version.current(collection_name)


#: ``exp(-distance)`` at cosine distance 1.0 — the score of a chunk with no
#: relationship to the query at all. Everything below this maps to 0.0.
_ORTHOGONAL_STORE_SCORE = math.exp(-1.0)


def cosine_similarity_from_store_score(score: Any) -> float:
    """Recover a true cosine similarity from the vector store's reported score.

    ``llama-index-vector-stores-chroma`` reports ``math.exp(-distance)`` as the
    node similarity, not the similarity itself, and this module mirrors that
    transform on the lexical channel so the two agree. With ``hnsw:space=cosine``
    Chroma defines distance as ``1 - cos(q, v)``, so the recovery is exact::

        s = e^-d,  d = 1 - cos   =>   cos = 1 + ln(s)

    This matters because the raw number is not a similarity and never approaches
    zero: an *orthogonal* chunk scores ``e^-1 = 0.37`` and a contradictory one
    ``e^-2 = 0.14``. Printed to the answering LLM as ``Relevance Score: 0.37``
    that reads as a moderate match, and any threshold set against it is set
    against a scale nobody intended -- the one such threshold in this codebase
    (``surface_documents.MIN_SURFACE_SCORE = 0.35``) sits at a cosine of -0.05,
    admitting anti-correlated chunks while documented as a quality gate.

    Anti-correlated results floor at ``0.0`` rather than going negative:
    ``Chunk.score`` is contractually ``[0, 1]``, and "worse than unrelated" and
    "unrelated" are the same decision for every consumer.

    Total on every input -- ``None``, ``NaN``, ``0.0`` and out-of-range values all
    return a float and never raise. That is deliberate rather than defensive:
    ``normalize``'s except-branch does not drop a bad chunk, it substitutes one
    whose content is ``str(raw_result)`` and whose file name is ``"unknown"``,
    which then occupies a top-k slot and can be cited.
    """
    try:
        value = float(score)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(value) or value <= _ORTHOGONAL_STORE_SCORE:
        return 0.0
    if value >= 1.0:
        return 1.0
    return min(1.0, max(0.0, 1.0 + math.log(value)))


def _filters_fingerprint(filters: dict[str, Any] | None) -> str:
    """Stable cache-key fragment for a filter dict (empty string when unfiltered)."""
    if not filters:
        return ""
    return json.dumps(filters, sort_keys=True, default=str)


def _field_metadata_filter(field: str, condition: Any):
    """Translate one ``field: condition`` pair into a ``MetadataFilter``."""
    from llama_index.core.vector_stores.types import FilterOperator
    from llama_index.core.vector_stores.types import MetadataFilter

    operators = {
        "$eq": FilterOperator.EQ,
        "$ne": FilterOperator.NE,
        "$in": FilterOperator.IN,
        "$nin": FilterOperator.NIN,
    }
    if isinstance(condition, dict):
        if len(condition) != 1:
            raise ValueError(f"Unsupported metadata filter condition for field {field!r}: {condition!r}")
        op, value = next(iter(condition.items()))
        if op not in operators:
            raise ValueError(f"Unsupported metadata filter operator: {op!r}")
        return MetadataFilter(key=field, operator=operators[op], value=value)
    return MetadataFilter(key=field, operator=FilterOperator.EQ, value=condition)


def _translate_filter_node(node: dict[str, Any]):
    """Translate one filter node into ``MetadataFilters`` (nested groups supported)."""
    from llama_index.core.vector_stores.types import FilterCondition
    from llama_index.core.vector_stores.types import MetadataFilters

    flat: list[Any] = []
    groups: list[MetadataFilters] = []
    for key, condition in node.items():
        if key == "$and":
            if not isinstance(condition, list) or not condition:
                raise ValueError(f"Unsupported metadata filter operator: {key!r} (expects a non-empty list)")
            children = [_translate_filter_node(child) for child in condition]
            flattened: list[Any] = []
            for child in children:
                if child.condition == FilterCondition.AND:
                    flattened.extend(child.filters)
                else:
                    flattened.append(child)
            groups.append(MetadataFilters(filters=flattened, condition=FilterCondition.AND))
        elif key == "$or":
            if not isinstance(condition, list) or not condition:
                raise ValueError(f"Unsupported metadata filter operator: {key!r} (expects a non-empty list)")
            children = [_translate_filter_node(child) for child in condition]
            groups.append(MetadataFilters(filters=children, condition=FilterCondition.OR))
        elif key.startswith("$"):
            raise ValueError(f"Unsupported metadata filter operator: {key!r}")
        else:
            flat.append(_field_metadata_filter(key, condition))
    combined: list[Any] = flat + groups
    if not combined:
        raise ValueError("Unsupported metadata filter: empty group")
    return MetadataFilters(filters=combined)


def _to_metadata_filters(filters: dict[str, Any] | None):
    """Translate the backend-neutral filter dict into LlamaIndex ``MetadataFilters``.

    Shape (conditions AND-ed within a node; ``$or``/``$and`` group nested nodes)::

        {"field": value}                              -> equality
        {"field": {"$eq"|"$ne": v}}                   -> (not) equal
        {"field": {"$in"|"$nin": [v1, ...]}}          -> (not) in
        {"$and": [node, ...]}                         -> AND group
        {"$or": [node, ...]}                          -> OR group

    Returns ``None`` for empty input. Unknown operators raise ``ValueError``
    (fail loud at the tool boundary rather than silently over-retrieving).
    """
    if not filters:
        return None
    return _translate_filter_node(filters)


#: Metadata keys that exist for filtering, citation or diagnostics and must never be
#: embedded or shown to the LLM.
#:
#: LlamaIndex prepends the whole metadata dict to a node's text before embedding
#: (``MetadataMode.EMBED``) unless a key is excluded, and nothing here set any
#: exclusions -- so every OIB chunk's vector was shifted by ``file_size: 1975942``, and
#: table/image/drawing chunks additionally carried row counts and pixel dimensions.
#: A byte count and a render's pixel width carry no retrieval signal; they are also
#: charged against the chunk's token budget, because ``SentenceSplitter`` subtracts the
#: metadata header from ``chunk_size`` before splitting.
#:
#: ``file_path`` is the sharpest one: ``SimpleDirectoryReader`` sets it to the ingest
#: temp file, so non-PDF uploads embedded a random ``/tmp/tmpk3n8w1qz.docx`` -- different
#: on every re-upload of the same document.
#:
#: ``drawing_type``/``drawing_scale`` are excluded because the VLM caption already states
#: both verbatim in the chunk body; embedding them again only doubles their weight.
#: ``file_name``, ``page_label``, ``content_type`` and ``doc_class`` stay: those are what
#: users actually ask by, and they are the closest thing this corpus has to a context
#: header.
EMBED_EXCLUDED_METADATA_KEYS = (
    "file_size",
    "file_path",
    "table_index",
    "rows",
    "cols",
    "image_index",
    "image_format",
    "image_width",
    "image_height",
    # Where the stored raster lives (image_store.py): an object key and an
    # ordinal, addressing for the view tool and not a word of what the image
    # shows.
    "image_key",
    "stored_image_index",
    "drawing_type",
    "drawing_scale",
    # The v2 structured payload: multi-KB JSON for the detail view / later
    # re-mapping, plus per-sheet segment bookkeeping. Embedding any of it
    # would double the segment text's weight (drawing_data restates the chunk
    # body as JSON) and burn the chunk's token budget on braces.
    "drawing_data",
    "segment_index",
    "segment_count",
)


def _apply_metadata_exclusions(document: Any) -> None:
    """Exclude non-semantic metadata from a document's embed and LLM renderings.

    Extends rather than replaces any existing exclusions -- ``SimpleDirectoryReader``
    already populates ``excluded_embed_metadata_keys`` on the non-PDF path, and
    clobbering it would re-embed the reader's own bookkeeping.

    Both lists are set because the splitter budgets on whichever of the two renderings
    is longer, so excluding from only one would leave the token cost in place.
    """
    for attribute in ("excluded_embed_metadata_keys", "excluded_llm_metadata_keys"):
        existing = list(getattr(document, attribute, None) or [])
        merged = existing + [key for key in EMBED_EXCLUDED_METADATA_KEYS if key not in existing]
        try:
            setattr(document, attribute, merged)
        except (AttributeError, ValueError):  # pragma: no cover - non-llama-index document
            logger.debug("Could not set %s on %r", attribute, type(document).__name__)


#: Collection-metadata keys recording which embedding produced a collection's vectors.
#: Namespaced so they cannot collide with a user-supplied `metadata` dict.
EMBED_FINGERPRINT_KEY = "aiq:embed_fingerprint"
EMBED_MODEL_KEY = "aiq:embed_model"

#: Collections whose fingerprint mismatch has already been reported, so a
#: misconfiguration logs once rather than once per query.
_reported_fingerprint_mismatches: set[str] = set()


def embed_fingerprint(model: str, base_url: str) -> str:
    """Stable digest of the embedding identity a collection's vectors were written with.

    ``base_url`` is part of the identity, not decoration: the same model name served by
    a different provider is a different vector space, and this deployment's code default
    (``nvidia/llama-nemotron-embed-vl-1b-v2`` on NVIDIA) differs from what compose
    actually sets (``openai/text-embedding-3-large`` on OpenRouter), so any deployment
    path that misses the env var writes foreign vectors into a shared collection.
    """
    payload = json.dumps({"model": model, "base_url": (base_url or "").rstrip("/")}, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def embed_fingerprint_metadata(model: str, base_url: str) -> dict[str, str]:
    """Collection metadata recording the embedding identity, human-readable digest first."""
    return {EMBED_FINGERPRINT_KEY: embed_fingerprint(model, base_url), EMBED_MODEL_KEY: model}


def embed_fingerprint_mismatch(collection_metadata: dict[str, Any] | None, model: str, base_url: str) -> str | None:
    """Describe a fingerprint conflict, or ``None`` when the collection is usable.

    Three states, three behaviours. **Absent** -- which is every collection deployed
    before this existed -- is adopted silently rather than failed: "no fingerprint"
    carries no claim, so it can only be wrong in the case that is already wrong today,
    and a naive ``if stored != current: raise`` would brick every live corpus.
    **Equal** proceeds. **Different** is reported.

    A same-dimension model swap is the case that needs this. A different-dimension one
    already fails loudly inside Chroma; swapping two 3072-dimension models, or repointing
    the base URL, produces no error at all -- just silently wrong retrieval, at a score
    distribution that looks entirely normal.
    """
    stored = (collection_metadata or {}).get(EMBED_FINGERPRINT_KEY)
    if not stored:
        return None
    current = embed_fingerprint(model, base_url)
    if stored == current:
        return None
    stored_model = (collection_metadata or {}).get(EMBED_MODEL_KEY, "unknown")
    return (
        f"embedding mismatch: collection was written with {stored_model!r} (fingerprint {stored}), "
        f"but this process is configured for {model!r} at {base_url!r} (fingerprint {current}). "
        f"Stored and query vectors are from different spaces. Restore the previous "
        f"AIQ_EMBED_MODEL/AIQ_EMBED_BASE_URL, or delete and re-ingest the collection."
    )


def _cosine_distances(query_embedding: Any, embeddings: Any, count: int) -> list[float]:
    """Cosine distances between the query vector and each fetched chunk vector.

    The German sparse channel finds chunks by lexical match, so it has no distance of its
    own, and it used to declare 1.0 for all of them. On this pipeline's scale that is a
    cosine of EXACTLY 0.0 -- a positive claim that the chunk is orthogonal to the query,
    not an absence of information. Three things then follow, all wrong: a relevance floor
    above zero deletes every sparse-only hit while leaving overlapping vector hits alone,
    `MIN_SURFACE_SCORE` does the same in the document grid, and the grounding block prints
    `Relevance Score: 0.00` next to a chunk that may be the best answer in the corpus.

    The real distance is computable for free. Chroma returns the stored vectors on the
    same `get` that fetches the text, and the query vector is already in hand -- no extra
    embedding call, no extra round trip.

    Falls back to the neutral 1.0 per chunk if anything is missing or malformed: this is
    the retrieval hot path and a scoring nicety must never break a search.
    """
    try:
        import numpy as np

        if embeddings is None or len(embeddings) != count:
            return [1.0] * count
        matrix = np.asarray(embeddings, dtype=float)
        query = np.asarray(query_embedding, dtype=float)
        norms = np.linalg.norm(matrix, axis=1) * np.linalg.norm(query)
        with np.errstate(divide="ignore", invalid="ignore"):
            cosine = np.where(norms > 0, (matrix @ query) / norms, 0.0)
        return [float(1.0 - value) for value in np.nan_to_num(cosine, nan=0.0)]
    except Exception:  # pragma: no cover - defensive; scoring must not break retrieval
        return [1.0] * count


def _to_chroma_where(filters: dict[str, Any] | None):
    """Translate a backend-neutral filter dict into a Chroma ``where`` expression.

    Routes through the same ``MetadataFilters`` translation the vector channel uses, so
    the lexical channel cannot accept or reject a different filter grammar than its
    partner. Chroma requires exactly one operator per expression and at least two
    operands in an ``$and``/``$or``; LlamaIndex's translation normalises both, which the
    raw dict did not. Returns ``None`` for empty input.
    """
    metadata_filters = _to_metadata_filters(filters)
    if metadata_filters is None:
        return None
    # `_to_chroma_filter` is private to the vendor package and pinned only by a lower
    # bound, so a minor bump can remove it. Raising here would degrade to "hybrid
    # silently off" -- the exact failure this translation exists to eliminate -- so
    # fall back to the local translation instead.
    try:
        from llama_index.vector_stores.chroma.base import _to_chroma_filter

        return _to_chroma_filter(metadata_filters)
    except ImportError:
        logger.warning("llama-index's Chroma filter translation is unavailable; using the local fallback")
        return _local_chroma_where(filters)


def _local_chroma_where(filters: dict[str, Any]) -> dict[str, Any]:
    """Minimal backend-neutral -> Chroma ``where`` translation.

    Mirrors the two normalisations Chroma requires and the raw dict lacks: sibling
    keys in one node become an explicit ``$and``, and a one-operand ``$and``/``$or``
    collapses to the bare expression.
    """
    operands: list[dict[str, Any]] = []
    for key, condition in filters.items():
        if key in {"$and", "$or"}:
            children = [_local_chroma_where(child) for child in condition]
            operands.append(children[0] if len(children) == 1 else {key: children})
        elif isinstance(condition, dict):
            operands.append({key: condition})
        else:
            operands.append({key: {"$eq": condition}})
    if not operands:
        raise ValueError("Unsupported metadata filter: empty group")
    return operands[0] if len(operands) == 1 else {"$and": operands}


def _resolve_embed_api_key(base_url: str, model: str) -> str:
    """Resolve the embeddings API key through the shared credential resolver.

    Chain: explicit ``AIQ_EMBED_API_KEY`` → ``NVIDIA_API_KEY`` fallback →
    provider inference from ``base_url``. Inference only selects the KEY for the
    configured embeddings endpoint; it NEVER changes ``base_url`` (embeddings
    need an embeddings-capable endpoint, so the caller keeps its configured
    base). With the default deployment (NVIDIA base, ``NVIDIA_API_KEY`` set) this
    is byte-identical to the old ``_get_nvidia_api_key()`` behaviour.

    BYOK is intentionally NOT wired here, but no longer for want of an org id:
    ``/v1/ingest`` forwards ``x-grid-organization-id`` into the ingest thread's
    job config, which is what lets :func:`resolve_vlm_credential` reach BYOK on
    the same pipeline. The blocker is the endpoint — a BYOK credential names a
    chat-completions base URL, and embeddings need an embeddings-capable one, so
    there is nothing to point this at yet. Known follow-up — see docs.
    """
    from aiq_agent.common.credential_resolution import resolve_llm_credential

    return resolve_llm_credential(
        primary_env="AIQ_EMBED_API_KEY",
        fallback_envs=("NVIDIA_API_KEY",),
        default_base_url=base_url,
        default_model=model,
        organization_id=None,
    ).api_key


def resolve_vlm_credential(organization_id: str | None = None):
    """Resolve the full VLM credential (key + base URL + model) — the single
    source of truth for the vision endpoint ingestion will call.

    Delegates to the shared resolver (:func:`resolve_llm_credential`) so the VLM
    inherits the SAME resolution the NAT chat models use, including **BYOK**:

      0. **BYOK** — when ``organization_id`` is given and the org has a
         bring-your-own credential, the org's key + base URL win (never the
         model — mirrors ADR-0022/0014).
      1. explicit override           — ``AIQ_VLM_API_KEY``
      2. platform default            — ``NVIDIA_API_KEY``
      3. deployment provider key     — inferred from ``AIQ_VLM_BASE_URL`` (e.g.
         ``OPENROUTER_API_KEY`` when the base URL is openrouter.ai)

    Passing ``organization_id`` is what makes per-project/Archiv uploads use the
    tenant's own key + endpoint; the org-agnostic paths (base OIB corpus sync)
    pass ``None`` and get the deployment default, unchanged.
    """
    from aiq_agent.common.credential_resolution import resolve_llm_credential

    return resolve_llm_credential(
        primary_env="AIQ_VLM_API_KEY",
        fallback_envs=("NVIDIA_API_KEY",),
        default_base_url="https://integrate.api.nvidia.com/v1",
        default_model=DEFAULT_VLM_MODEL,
        base_url_env="AIQ_VLM_BASE_URL",
        model_env="AIQ_VLM_MODEL",
        organization_id=organization_id,
    )


def _resolve_vlm_model_override(organization_id: str | None) -> str | None:
    """The org's runtime model override for the ingestion VLM, or ``None``.

    Mirrors the NAT chat models' ``x-grid-model-overrides`` behaviour for the
    ``ingest_vlm`` agent group (ADR-0014), resolved by org id via the BFF's
    internal endpoint (the ingest thread has no request header). Model selection
    only — the key + base URL still come from BYOK/env. Fail-open to ``None`` so
    a BFF hiccup never blocks ingestion.
    """
    if not organization_id:
        return None
    try:
        from aiq_agent.common.model_overrides import AgentGroup
        from aiq_agent.common.model_overrides import resolve_org_model_overrides

        return resolve_org_model_overrides(organization_id).get(AgentGroup.INGEST_VLM.value)
    except Exception:  # noqa: BLE001 - model selection must never take ingestion down
        logger.warning("VLM model-override resolution failed for org %s", organization_id, exc_info=True)
        return None


def resolve_vlm_api_key() -> str:
    """Resolve the (org-agnostic) VLM API key — the single source of truth for
    "is a vision model reachable?".

    Both the capability endpoint that tells the frontend whether to offer image
    upload and the org-agnostic ingestion gate consult this. Per-request
    ingestion resolves the org-aware credential via
    :func:`resolve_vlm_credential` instead, so a tenant's BYOK key powers its
    own uploads. Returns the resolved key, or ``""`` when none is configured.
    """
    return resolve_vlm_credential(organization_id=None).api_key


def vlm_configured() -> bool:
    """Whether a VLM API key resolves — i.e. image ingestion can run here.

    Derived capability (never a standalone flag): it reflects exactly what
    ``resolve_vlm_api_key`` finds, so extending the resolution chain lights up
    the frontend's image-upload offer automatically.
    """
    return bool(resolve_vlm_api_key())


def _get_vlm_api_key() -> str:
    """Back-compat alias for the ingestion path; delegates to the single source
    of truth in :func:`resolve_vlm_api_key`."""
    return resolve_vlm_api_key()


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
    # Content-hash dedupe: the same raster embedded repeatedly (a logo on every
    # page, a reused plan) is captioned and indexed ONCE. The VLM cache already
    # dedupes the API call; this dedupes the duplicate indexed chunks.
    seen_hashes: set[str] = set()
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
                        # Downscale the longest edge to VLM_MAX_IMAGE_DIM before
                        # re-encoding (aspect preserved, never upscaled) to bound
                        # the VLM payload. thumbnail() is a no-op when already
                        # within bounds. Metadata still records the ORIGINAL size.
                        pil_image.thumbnail((VLM_MAX_IMAGE_DIM, VLM_MAX_IMAGE_DIM))
                        buf = io.BytesIO()
                        pil_image.save(buf, format="JPEG", quality=95)
                        image_bytes = buf.getvalue()
                        digest = hashlib.sha256(image_bytes).hexdigest()
                        if digest in seen_hashes:
                            img_idx += 1
                            continue
                        seen_hashes.add(digest)
                        images.append(
                            {
                                "image_bytes": image_bytes,
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


def _strip_watermark_lines(text: str | None) -> str:
    """Drop licence/watermark boilerplate lines (e.g. "VECTORWORKS EDUCATIONAL
    VERSION") from extracted text.

    Runs before both the visual-page heuristic and summarisation: without it a
    drawing page that is pure linework plus a stamped watermark reads as "has
    text" (so it never reaches the VLM) and its watermark becomes the document
    summary. Only whole lines matching a known pattern are removed; real
    content is never touched.
    """
    if not text:
        return ""
    kept = [line for line in text.splitlines() if not any(p.match(line) for p in WATERMARK_LINE_PATTERNS)]
    return "\n".join(kept).strip()


# Substring counterparts of WATERMARK_LINE_PATTERNS, built from the very same
# `_WATERMARK_PHRASES` fragments (unanchored, no ``^``/``$``/``.*``) so they can
# be matched *anywhere inside* a line via ``re.search``/``re.sub``. VLM captions
# weave the licence stamp into prose (e.g. "... a floor plan. VECTORWORKS
# EDUCATIONAL VERSION overlaid ...") where the line-level filter never fires,
# so the caption needs a substring scrub before it can become a document
# summary. Sharing one source of phrases with WATERMARK_LINE_PATTERNS means the
# two lists can never drift out of sync with each other.
WATERMARK_PHRASE_PATTERNS = [re.compile(fragment, re.IGNORECASE) for fragment, _suffix in _WATERMARK_PHRASES]


def _scrub_watermark_phrases(text: str | None) -> str:
    """Scrub CAD licence/watermark phrases from a VLM caption wherever they
    appear (not only on their own line) so they can never leak into a document
    summary.

    The line-level ``_strip_watermark_lines`` only drops whole watermark lines;
    a caption that mentions "VECTORWORKS EDUCATIONAL VERSION" mid-sentence slips
    straight through it and, when LLM summarisation is off/failed, becomes the
    summary verbatim. This runs on the caption before that can happen. Fail-open:
    returns ``""`` for falsy input and never raises; on any error it returns the
    stripped original rather than losing the caption entirely.
    """
    if not text:
        return ""
    try:
        scrubbed = text
        for pattern in WATERMARK_PHRASE_PATTERNS:
            scrubbed = pattern.sub(" ", scrubbed)
        # Collapse whitespace left behind by the removals while preserving
        # paragraph breaks: squeeze intra-line runs, trim each line, drop the
        # blank lines a removed stamp leaves behind.
        scrubbed = re.sub(r"[^\S\n]+", " ", scrubbed)
        lines = [line.strip() for line in scrubbed.splitlines()]
        return "\n".join(line for line in lines if line).strip()
    except Exception:  # pragma: no cover - defensive, never break ingestion
        return text.strip()


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
                text = _strip_watermark_lines(page.extract_text())
                if text:
                    pages.append({"page_number": page_num, "text": text})

        logger.info("Extracted text from %d PDF pages in %s", len(pages), pdf_path)

    except Exception as e:
        logger.error("Error extracting PDF text: %s", e)

    return pages


def text_documents_for_pages(text_pages: list[dict[str, Any]], file_name: str, file_size: int) -> list[Any]:
    """Build the text Documents for one PDF, structure-aware where the document allows it.

    A numbered corpus cut on its own outline yields one requirement per chunk instead of
    roughly fifteen blended into a 1024-token block, and gives every chunk a Punkt to
    cite rather than only a page. ``punkt_documents`` returns ``None`` for anything
    without a usable outline -- a glossary, a list of standards, any tenant upload -- and
    that is the per-page path below, byte-for-byte what ingestion did before.

    Extracted from ``_run_ingestion`` so the choice between the two strategies is
    testable without a job, a Chroma client or an embedder.
    """
    from knowledge_layer.llamaindex.punkt_chunking import punkt_documents
    from llama_index.core import Document

    structured = punkt_documents(text_pages, file_name, file_size)
    if structured is not None:
        return structured
    return [
        Document(
            text=page["text"],
            metadata={
                "file_name": file_name,
                "file_size": file_size,
                "page_label": str(page["page_number"]),
                "content_type": "text",
            },
        )
        for page in text_pages
    ]


def _looks_like_pdf(file_path: str) -> bool:
    """Detect PDFs by file magic so presigned/temp files without .pdf still use PDF extraction."""
    try:
        with open(file_path, "rb") as handle:
            return handle.read(5) == b"%PDF-"
    except OSError:
        return False


def _looks_like_image(file_path: str) -> str | None:
    """Detect standalone PNG/JPEG/WebP images by file magic (mirrors _looks_like_pdf).

    Returns the normalized format ("png"/"jpeg"/"webp") or None. Standalone
    images must be routed to VLM captioning; without this they slip through to
    SimpleDirectoryReader, which UTF-8-garbles the binary and is then rejected by
    the binary-content guard. The signatures are specific enough (8-byte PNG,
    3-byte JPEG SOI, RIFF????WEBP) that text/PDF inputs never false-positive.
    """
    try:
        with open(file_path, "rb") as handle:
            header = handle.read(12)
    except OSError:
        return None
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if header.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    # RIFF container with a WEBP payload; bytes 4-8 are the file size.
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return "webp"
    return None


def _read_image_as_jpeg(file_path: str, file_name: str) -> tuple[bytes, int, int] | None:
    """Decode a standalone image and re-encode it as a VLM-ready JPEG.

    Returns ``(jpeg_bytes, original_width, original_height)`` or ``None`` when
    the bytes cannot be decoded (corrupt/unsupported). Re-encodes to JPEG (RGB)
    for a uniform VLM payload, exactly like the PDF-embedded-image path
    (``_extract_images_from_pdf``), downscaling the longest edge to
    ``VLM_MAX_IMAGE_DIM`` (aspect preserved, never upscaled); the ORIGINAL
    dimensions are what the caller records in metadata.
    """
    import io

    from PIL import Image

    try:
        with open(file_path, "rb") as handle:
            raw = handle.read()
        with Image.open(io.BytesIO(raw)) as pil_image:
            pil_image.load()
            width, height = pil_image.size
            rgb_image = pil_image.convert("RGB")
            rgb_image.thumbnail((VLM_MAX_IMAGE_DIM, VLM_MAX_IMAGE_DIM))
            buf = io.BytesIO()
            rgb_image.save(buf, format="JPEG", quality=95)
            return (buf.getvalue(), width, height)
    except Exception as e:
        logger.error("Could not decode standalone image %s: %s", file_name, e)
        return None


def _build_image_caption_document(
    file_path: str,
    file_name: str,
    file_size: int,
    image_format: str,
    vlm_model: str = DEFAULT_VLM_MODEL,
    vlm_base_url: str = DEFAULT_VLM_BASE_URL,
    extract_charts: bool = True,
    vlm_api_key: str | None = None,
):
    """Read a standalone image, validate/normalize via PIL, and VLM-caption it.

    Returns a single caption ``Document`` shaped exactly like the PDF-embedded
    image documents (page_label "1", image_index 0), or ``None`` when the bytes
    cannot be decoded as an image (corrupt/unsupported) so the caller can fail
    the file cleanly instead of crashing the job.
    """
    from llama_index.core import Document

    decoded = _read_image_as_jpeg(file_path, file_name)
    if decoded is None:
        return None
    image_bytes, width, height = decoded

    # Same content-hash cache as the PDF-embedded-image batch path: re-uploading
    # an identical image skips the VLM call entirely (and the cache is scoped to
    # the model). Function-scope import — processing imports this module lazily.
    from knowledge_layer.llamaindex import processing as _processing

    content_type, caption = _processing._cached_vlm_call(
        image_bytes,
        f"image:charts={extract_charts}",
        _analyze_image_with_vlm,
        image_bytes,
        vlm_model=vlm_model,
        vlm_base_url=vlm_base_url,
        vlm_api_key=vlm_api_key,
        extract_charts=extract_charts,
        model=vlm_model,
    )
    # The caption is the file's ONLY content — a failure placeholder must fail
    # the file (retryable via re-ingest) rather than index a content-free chunk.
    if _processing.is_failed_caption(caption):
        logger.error("VLM captioning failed for standalone image %s: %s", file_name, caption[:120])
        return None

    prefix = "CHART" if content_type == "chart" else "IMAGE"
    return Document(
        text=f"[{prefix} from page 1]\n\n{caption}",
        metadata={
            "file_name": file_name,
            "file_size": file_size,
            "page_label": "1",
            "content_type": content_type,
            "image_index": 0,
            "image_format": image_format,
            "image_width": width,
            "image_height": height,
        },
    )


def analyze_visual(
    image_bytes: bytes,
    vlm_model: str = DEFAULT_VLM_MODEL,
    vlm_base_url: str = DEFAULT_VLM_BASE_URL,
    vlm_api_key: str | None = None,
    extract_charts: bool = True,
) -> tuple[str, str, dict[str, Any]]:
    """Analyse ONE visual — the single entry point for every image source.

    A rendered PDF page, a raster embedded in a PDF and an uploaded image file
    all arrive here. They used to be analysed by two different prompts: pages
    got the structured schema while embedded rasters got a generic English
    caption, so a scanned plan placed inside a PDF was indexed as one paragraph
    while the identical sheet as a vector page was indexed per drawing. There
    is now one prompt, and photos and diagrams are types WITHIN it.

    Returns ``(content_type, caption, fields)`` where ``content_type`` is
    ``drawing`` / ``chart`` / ``image``, ``caption`` is the text to index and
    ``fields`` carries the flat legacy fields plus, when the reply parsed, the
    full analysis under ``fields["analysis"]``.

    Degradation is layered, cheapest first: a parsed v3 analysis types itself;
    a v1 ``KEY: value`` reply is a drawing by construction; a reply that parses
    as NEITHER — prose from a model that cannot hold the JSON, or an outright
    provider failure — spends one more call on the legacy caption prompt, which
    both keeps charts classified and gives the big prompt a smaller thing to
    fail back to. Only when that also fails is a failure placeholder returned,
    for the caller to skip rather than index.
    """
    from knowledge_layer.llamaindex import processing as _processing
    from knowledge_layer.llamaindex import visual_analysis
    from knowledge_layer.llamaindex import visual_domains

    caption, fields = _processing._cached_vlm_call(
        image_bytes,
        visual_analysis.cache_prompt_type(visual_domains.resolve_registry()),
        _analyze_drawing_page_with_vlm,
        image_bytes,
        vlm_model=vlm_model,
        vlm_base_url=vlm_base_url,
        vlm_api_key=vlm_api_key,
        model=vlm_model,
    )
    fields = fields if isinstance(fields, dict) else {}

    if not _processing.is_failed_caption(caption):
        analysis = fields.get("analysis")
        if analysis:
            return (visual_analysis.content_type_for(analysis), caption, fields)
        if fields:
            # v1 fallback shape: the legacy line format only ever described drawings.
            return ("drawing", caption, fields)

    # Rare by design — the prompt types photos and diagrams itself — so the
    # extra call costs little, and on a hard failure it is the difference
    # between a captioned chunk and no chunk at all.
    logger.info("Structured visual analysis unusable; falling back to the caption prompt")
    content_type, legacy_caption = _processing._cached_vlm_call(
        image_bytes,
        f"image:charts={extract_charts}",
        _analyze_image_with_vlm,
        image_bytes,
        vlm_model=vlm_model,
        vlm_base_url=vlm_base_url,
        vlm_api_key=vlm_api_key,
        extract_charts=extract_charts,
        model=vlm_model,
    )
    return (content_type, legacy_caption, {})


#: Chunk-body prefix per content type. Kept as a map so every source spells the
#: marker the same way — ``get_document_visual_details`` strips it back off.
_VISUAL_PREFIXES = {"drawing": "DRAWING", "chart": "CHART", "image": "IMAGE"}


def visual_documents(
    content_type: str,
    caption: str,
    fields: dict[str, Any],
    *,
    file_name: str,
    file_size: int,
    page_number: int,
    extra_metadata: dict[str, Any] | None = None,
) -> list[Any]:
    """Turn one analysed visual into its indexable chunks — the single builder.

    A structured analysis yields ONE chunk PER SEGMENT (a sheet carrying
    Grundriss + Schnitt + Detail becomes three targeted chunks, each with its
    own scale and its own slice of ``drawing_data``); anything else yields the
    single caption chunk. ``extra_metadata`` is what differs between sources —
    the embedded-image indices and formats, a render's pixel size — and nothing
    else about the shape does.
    """
    from knowledge_layer.llamaindex import visual_analysis
    from llama_index.core import Document

    prefix = _VISUAL_PREFIXES.get(content_type, "IMAGE")
    base = {
        "file_name": file_name,
        "file_size": file_size,
        "page_label": str(page_number),
        "content_type": content_type,
        **(extra_metadata or {}),
    }

    analysis = fields.get("analysis") if fields else None
    if analysis:
        return [
            Document(
                text=f"[{prefix} from page {page_number}]\n\n{payload['text']}",
                metadata={
                    **base,
                    "drawing_type": payload["drawing_type"],
                    "drawing_scale": payload["drawing_scale"],
                    "segment_index": payload["segment_index"],
                    "segment_count": payload["segment_count"],
                    "drawing_data": payload["drawing_data"],
                },
            )
            for payload in visual_analysis.segment_payloads(analysis)
        ]

    metadata = dict(base)
    if fields:
        metadata["drawing_type"] = fields.get("drawing_type", "")
        metadata["drawing_scale"] = fields.get("scale", "")
    return [Document(text=f"[{prefix} from page {page_number}]\n\n{caption}", metadata=metadata)]


def _build_image_documents(
    file_path: str,
    file_name: str,
    file_size: int,
    image_format: str,
    vlm_model: str = DEFAULT_VLM_MODEL,
    vlm_base_url: str = DEFAULT_VLM_BASE_URL,
    extract_charts: bool = True,
    vlm_api_key: str | None = None,
) -> list[Any] | None:
    """Standalone uploaded image → Documents, through the shared analyser.

    Thin by design: decode, then the same :func:`analyze_visual` +
    :func:`visual_documents` every other source uses. Returns ``None`` when the
    image cannot be decoded or its analysis failed outright — the caption is
    the file's only content, so the caller fails the file (retryable via
    re-ingest) rather than indexing a content-free chunk.
    """
    from knowledge_layer.llamaindex import processing as _processing

    decoded = _read_image_as_jpeg(file_path, file_name)
    if decoded is None:
        return None
    image_bytes, width, height = decoded

    content_type, caption, fields = analyze_visual(
        image_bytes,
        vlm_model=vlm_model,
        vlm_base_url=vlm_base_url,
        vlm_api_key=vlm_api_key,
        extract_charts=extract_charts,
    )
    if _processing.is_failed_caption(caption):
        logger.error("VLM analysis failed for standalone image %s: %s", file_name, caption[:120])
        return None

    return visual_documents(
        content_type,
        caption,
        fields,
        file_name=file_name,
        file_size=file_size,
        page_number=1,
        extra_metadata={
            "image_index": 0,
            "image_format": image_format,
            "image_width": width,
            "image_height": height,
        },
    )


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


def _vlm_chat_create(client, *, model: str, messages: list, max_tokens: int, temperature: float = 0.2) -> str:
    """One VLM chat completion with a single truncation retry.

    A response clipped at ``max_tokens`` (``finish_reason == "length"``) loses
    the trailing fields of the structured drawing format — exactly the
    ZUSAMMENFASSUNG the document summary is built from — so retry ONCE with a
    doubled budget. Returns the message content (possibly empty); a still-
    truncated response is returned as-is with a warning rather than silently
    treated as complete.

    The retry is a best-effort improvement on a caption we ALREADY have, so it
    is deliberately cheap and never destructive:

    - It runs with the SDK retries disabled. The first call already spends the
      client's ``max_retries`` budget, and letting the second call spend it
      again would double the worst-case latency of a single caption on top of
      an attempt that, by definition, already succeeded.
    - A failure is swallowed and the truncated first caption is returned.
      Raising here would discard usable content and — since failure placeholders
      are no longer indexed — drop the chunk entirely over a partial success.
    """
    response = client.chat.completions.create(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
        temperature=temperature,
    )
    choice = response.choices[0]
    if getattr(choice, "finish_reason", None) != "length":
        return choice.message.content or ""

    partial = choice.message.content or ""
    logger.warning("VLM response truncated at %d tokens; retrying with %d", max_tokens, max_tokens * 2)
    # ``with_options`` is the OpenAI SDK's per-call override; guarded because
    # the drawing/image call sites are exercised with lightweight fake clients.
    with_options = getattr(client, "with_options", None)
    retry_client = client
    if callable(with_options):
        try:
            retry_client = with_options(max_retries=0)
        except Exception:  # pragma: no cover - defensive, SDK-shape dependent
            retry_client = client
    try:
        response = retry_client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=max_tokens * 2,
            temperature=temperature,
        )
    except Exception as exc:
        logger.warning("VLM truncation retry failed (%s); keeping the truncated caption", exc)
        return partial
    choice = response.choices[0]
    if getattr(choice, "finish_reason", None) == "length":
        logger.warning("VLM response still truncated at %d tokens; storing partial caption", max_tokens * 2)
    return choice.message.content or partial


def _analyze_image_with_vlm(
    image_bytes: bytes,
    vlm_model: str = DEFAULT_VLM_MODEL,
    vlm_base_url: str = DEFAULT_VLM_BASE_URL,
    extract_charts: bool = True,
    vlm_api_key: str | None = None,
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
        vlm_api_key: Pre-resolved key (e.g. an org's BYOK key). When ``None`` the
            org-agnostic deployment key is used.

    Returns:
        Tuple of (content_type, caption) where content_type is "chart" or "image".
    """
    try:
        from openai import OpenAI
    except ImportError:
        logger.warning("openai package not installed. Install with: pip install openai")
        return ("image", "[Image - captioning unavailable]")

    api_key = vlm_api_key if vlm_api_key is not None else _get_vlm_api_key()
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

If this is a regular image (e.g. a plan, map or architectural drawing), describe its CONTENT and meaning:
- Main subject and what the image actually depicts
- Key elements and their spatial / architectural relationships
- Only textual labels that belong to the content (e.g. titles, room names, dimensions)

Do NOT include any licence, watermark or tool-stamp text (e.g. "VECTORWORKS EDUCATIONAL VERSION",
"AutoCAD", "DRAFT") in your description; ignore such overlays entirely and describe only the actual
content and its meaning, not merely what is visible.

Provide a detailed, structured response."""
    else:
        prompt = (
            "Describe this image in detail, focusing on the CONTENT and meaning of what is depicted "
            "(the main subject, its elements, and any spatial or architectural information) rather than "
            "merely listing what is visible. Do NOT include any licence, watermark or tool-stamp text "
            '(e.g. "VECTORWORKS EDUCATIONAL VERSION", "AutoCAD", "DRAFT") in your description; ignore '
            "such overlays entirely."
        )

    try:
        # Encode image to base64
        image_b64 = base64.b64encode(image_bytes).decode("utf-8")

        client = OpenAI(
            base_url=vlm_base_url,
            api_key=api_key,
            timeout=VLM_REQUEST_TIMEOUT_SECONDS,
            max_retries=1,
        )

        caption = _vlm_chat_create(
            client,
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
        )

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
# Visual-page rendering (vector/scanned architectural drawings)
# =============================================================================

# The prompt + schema live in ``visual_analysis`` (domain-neutral kernel) and
# ``visual_domains`` (the vocabulary each domain contributes). This module keeps the legacy
# ``KEY: value`` parser below as the FALLBACK for replies that are not
# parseable schema JSON — a weaker VLM (or an old cached caption) degrades to
# earlier behaviour, never to a lost page.


def _parse_drawing_fields(caption: str) -> dict[str, str]:
    """Parse the v1 ``KEY: value`` lines of a drawing-VLM response into a dict.

    Lenient: unknown/extra lines are ignored and any field the model omitted is
    simply absent. Keys are normalised to lowercase ascii slugs.
    """
    field_map = {
        "zeichnungstyp": "drawing_type",
        "massstab": "scale",
        "maßstab": "scale",
        "titel/projekt": "title",
        "geschosse/ebenen": "levels",
        "nutzung": "use",
        "räume/elemente": "elements",
        "materialien/bauweise": "materials",
        "abmessungen/koten": "dimensions",
        "räumliche beziehungen": "spatial_relations",
        "detailbeschreibung": "detail",
        "wasserzeichen": "watermark",
        "zusammenfassung": "summary",
    }
    out: dict[str, str] = {}
    for line in (caption or "").splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        slug = field_map.get(key.strip().lower())
        if slug and value.strip():
            out[slug] = value.strip()
    return out


def _analyze_drawing_page_with_vlm(
    image_bytes: bytes,
    vlm_model: str = DEFAULT_VLM_MODEL,
    vlm_base_url: str = DEFAULT_VLM_BASE_URL,
    vlm_api_key: str | None = None,
) -> tuple[str, dict[str, Any]]:
    """VLM-analyse a full rendered PDF page as a technical drawing (schema v2).

    Returns ``(caption, fields)``. ``caption`` is the rendered structured text
    (``visual_analysis.render_analysis_text``) stored/embedded in the chunk;
    ``fields`` is the flat dict every pre-schema consumer reads (drawing_type,
    scale, summary, …) plus — when the reply parsed — the full canonical
    analysis under ``fields["analysis"]``. A reply that is not valid schema
    JSON falls back verbatim to the legacy ``KEY: value`` path, so a weaker
    model degrades rather than fails. The domain vocabulary comes from the
    resolved :mod:`visual_domains` registry, so this function is the same for
    architecture and for any other domain. ``vlm_api_key`` is a pre-resolved
    key (e.g. an org's BYOK key); ``None`` uses the org-agnostic deployment
    key. Fail-open: on any error returns a placeholder caption and empty
    fields so the page is still indexed (never crashes the job).
    """
    from knowledge_layer.llamaindex import visual_analysis
    from knowledge_layer.llamaindex import visual_domains

    registry = visual_domains.resolve_registry()

    try:
        from openai import OpenAI
    except ImportError:
        logger.warning("openai package not installed. Install with: pip install openai")
        return ("[Drawing - captioning unavailable]", {})

    api_key = vlm_api_key if vlm_api_key is not None else _get_vlm_api_key()
    if not api_key:
        return ("[Drawing - VLM API key not set]", {})

    try:
        image_b64 = base64.b64encode(image_bytes).decode("utf-8")
        client = OpenAI(
            base_url=vlm_base_url,
            api_key=api_key,
            timeout=VLM_REQUEST_TIMEOUT_SECONDS,
            max_retries=1,
        )
        reply = _vlm_chat_create(
            client,
            model=vlm_model,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": visual_analysis.build_prompt(registry)},
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"}},
                    ],
                }
            ],
            # The JSON reply is bulkier than the legacy twelve-line format; a
            # budget sized for that would truncate mid-object and forfeit the
            # whole structure to the fallback parser on every multi-segment
            # sheet. (_vlm_chat_create still doubles this once on truncation.)
            max_tokens=3000,
        ).strip()
        if not reply:
            return ("[Drawing - empty VLM response]", {})
        logger.debug("Drawing VLM analysis: %s...", reply[:100])
        analysis = visual_analysis.parse_visual_analysis(reply, registry)
        if analysis is None:
            # Legacy fallback: the reply is stored as-is and parsed line-wise.
            return (reply, _parse_drawing_fields(reply))
        fields: dict[str, Any] = visual_analysis.legacy_fields(analysis)
        fields["analysis"] = analysis
        return (visual_analysis.render_analysis_text(analysis), fields)
    except Exception as e:
        logger.error("Drawing VLM analysis failed: %s", e)
        return (f"[Drawing - analysis failed: {str(e)[:50]}]", {})


def _summary_from_drawing_fields(pages: list[dict[str, Any]]) -> str | None:
    """Build a document summary from rendered-page drawing descriptions.

    Prefers the per-page ``ZUSAMMENFASSUNG`` sentences; falls back to a
    ``drawing_type @ scale`` synthesis so a document that is entirely drawings
    still gets a meaningful, watermark-free summary. Returns ``None`` when no
    usable fields were extracted (caller then keeps its text-based fallback).
    """
    sentences = [p["fields"].get("summary", "").strip() for p in pages if p.get("fields")]
    sentences = [s for s in sentences if s]
    if sentences:
        summary = " ".join(sentences[:3])
        return summary[:600].rstrip()

    synth: list[str] = []
    for p in pages:
        fields = p.get("fields") or {}
        dtype = fields.get("drawing_type")
        if not dtype:
            continue
        scale = fields.get("scale")
        synth.append(f"{dtype} (Maßstab {scale})" if scale and scale.lower() != "unbekannt" else dtype)
    if synth:
        return ("Technische Zeichnungen: " + "; ".join(synth[:5]))[:600].rstrip()
    return None


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

        # The whole stack, not just the import this method happens to need --
        # otherwise a missing vector-store package is only discovered later, in
        # a call site with no dependency diagnostic around it.
        ensure_retrieval_dependencies()

        try:
            from llama_index.embeddings.nvidia import NVIDIAEmbedding

            nvidia_api_key = _resolve_embed_api_key(self.embed_base_url, self.embed_model_name)
            if not nvidia_api_key:
                logger.error(
                    "No embeddings API key resolved (AIQ_EMBED_API_KEY / NVIDIA_API_KEY / "
                    "the provider key for AIQ_EMBED_BASE_URL) - ingestion/retrieval will fail."
                )

            self._embed_model = NVIDIAEmbedding(
                base_url=self.embed_base_url,
                model=self.embed_model_name,
                api_key=nvidia_api_key,
                embed_batch_size=EMBED_BATCH_SIZE,
            )

            # Ensure persist directory exists
            os.makedirs(self.persist_dir, exist_ok=True)

            self._initialized = True
            logger.info(f"LlamaIndex components initialized with model: {self.embed_model_name}")

        except ImportError as e:
            raise _retrieval_dependency_error(e) from e

    def _get_chroma_client(self):
        """Get or create the shared ChromaDB client (thread-safe)."""
        with self._lock:
            if self._chroma_client is None:
                # Shared server when AIQ_CHROMA_URL/HOST is set, else embedded.
                self._chroma_client = _make_chroma_client(self.persist_dir)
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

        # Persist outside the lock (DB I/O) so any replica can serve this status.
        ingest_status_store.put(job)

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
            ingest_status_store.put(job)
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

        # Persist the initial PENDING status so a poll to any replica resolves it
        # immediately, even before this replica's pool starts processing.
        ingest_status_store.put(job)

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
            # Also drop the durable cross-replica status row so the ingest_jobs
            # table is bounded by the same retention window. Previously this grew
            # forever: ingest_status_store.delete() existed but had zero callers.
            # Best-effort (delete() swallows its own errors) and done outside the
            # lock since it does DB I/O.
            for jid in stale:
                ingest_status_store.delete(jid)
            logger.debug("Pruned %d completed job(s) from tracking (+ status rows)", len(stale))

    def _prune_stale_files(self) -> None:
        """Drop terminal per-file tracking entries older than the retention window.

        Mirrors ``_prune_completed_jobs`` for ``self._files``, which otherwise
        grew for the life of the process (one entry per upload, never removed
        except on explicit delete). Only SUCCESS/FAILED entries are eligible, and
        only once their completion/upload time is older than
        ``FILE_TRACKING_RETENTION_SECONDS`` — INGESTING/UPLOADING entries (live
        work) are always kept. SUCCESS files stay listable afterwards
        (reconstructed from Chroma), so this loses only a stable file_id, not a
        file.
        """
        now = datetime.now(tz=UTC)
        with self._lock:
            stale = []
            for fid, fi in self._files.items():
                if fi.status not in (FileStatus.SUCCESS, FileStatus.FAILED):
                    continue
                aged_at = fi.ingested_at or fi.uploaded_at
                if aged_at is None:
                    continue
                if aged_at.tzinfo is None:
                    aged_at = aged_at.replace(tzinfo=UTC)
                if (now - aged_at).total_seconds() > FILE_TRACKING_RETENTION_SECONDS:
                    stale.append(fid)
            for fid in stale:
                del self._files[fid]
        if stale:
            logger.debug("Pruned %d stale file tracking entry(ies)", len(stale))

    def _index_tracked_files(self, collection_name: str) -> dict[str, tuple[str, FileInfo]]:
        """``file_name -> (file_id, FileInfo)`` for one collection, first-seen wins.

        Built in a single O(files) pass so ``list_files`` no longer rescans all
        of ``self._files`` per listed file (was O(files²) as the dict grew).
        """
        index: dict[str, tuple[str, FileInfo]] = {}
        with self._lock:
            for fid, fi in self._files.items():
                if fi.collection_name == collection_name and fi.file_name not in index:
                    index[fi.file_name] = (fid, fi)
        return index

    def get_job_status(self, job_id: str) -> IngestionJobStatus:
        """Get current status of an ingestion job."""
        self._prune_completed_jobs()
        self._prune_stale_files()
        with self._lock:
            local = self._jobs.get(job_id)
        if local is not None:
            return local.model_copy()
        # Not on this replica: the job may have been accepted by another replica.
        # Fall back to the shared store so status polls resolve from anywhere.
        shared = ingest_status_store.get(job_id)
        if shared is not None:
            return shared
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

    # =========================================================================
    # Collection Management Implementation
    # =========================================================================

    def _embed_fingerprint_metadata(self) -> dict[str, str]:
        """The embedding identity to stamp on collections this ingestor writes."""
        return embed_fingerprint_metadata(self.embed_model_name, self.embed_base_url)

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
                **self._embed_fingerprint_metadata(),
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

            from aiq_agent.knowledge.chunk_text_store import get_chunk_text_store

            get_chunk_text_store().delete_collection(name)
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
            # Stamp the embedding identity while we already hold the merged metadata, so
            # a collection created by the ingest path -- which cannot carry metadata,
            # since Chroma ignores it for an existing collection -- still acquires one.
            #
            # ONLY WHEN ABSENT. Writing it unconditionally erases the mismatch this
            # feature exists to detect: a collection written with model A, then ingested
            # into by a process misconfigured for model B, would have its fingerprint
            # rewritten to B. Retrieval's check is blocked only until that ingestion, and
            # afterwards the collection holds vectors from two spaces while reporting no
            # conflict -- back to silently wrong retrieval, with the evidence destroyed.
            # A stored fingerprint is a fact about vectors already written; nothing this
            # process does can make it untrue.
            mismatch = embed_fingerprint_mismatch(existing_metadata, self.embed_model_name, self.embed_base_url)
            if mismatch:
                logger.error("Collection %s: %s", collection_name, mismatch)
            elif not existing_metadata.get(EMBED_FINGERPRINT_KEY):
                new_metadata.update(self._embed_fingerprint_metadata())

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
                # The stored file_name metadata can diverge from the requested
                # name in two ways, so normalise both before comparing:
                #   1. a temp-upload prefix — Python's tempfile uses 8 random
                #      chars: tmp[8chars]_filename (same as foundational_rag);
                #   2. percent-encoding — when the name was derived from a
                #      presigned-URL path at ingest time (a space/umlaut was
                #      stored as %20/%C3%…). URL-decoding both sides lets a
                #      document ingested under an encoded name still be deleted
                #      by its real, decoded filename.
                from urllib.parse import unquote

                tmp_prefix = re.compile(r"^tmp.{8}_")
                all_results = collection.get(include=["metadatas"])
                matching_ids = []
                for i, meta in enumerate(all_results.get("metadatas", [])):
                    stored = meta.get("file_name", "") or ""
                    stripped = tmp_prefix.sub("", stored)
                    if file_name in (stripped, unquote(stripped)):
                        matching_ids.append(all_results["ids"][i])
                if not matching_ids:
                    # No chunks in ChromaDB. Whatever else the document left
                    # behind — tracking entries for a FAILED file, the summary
                    # row the inventory is built from, the lexical mirror — is
                    # forgotten regardless: a delete that returned early here
                    # left a file with no chunks in the agent's inventory for
                    # good, and every later delete took the same early exit.
                    if tracking_ids_to_remove:
                        with self._lock:
                            for tid in tracking_ids_to_remove:
                                self._files.pop(tid, None)
                        logger.info(f"Removed {len(tracking_ids_to_remove)} tracking entries for file {file_name}")
                    else:
                        logger.warning(f"No chunks found for file_name={file_name}; clearing its summary and text")

                    from aiq_agent.knowledge import unregister_summary

                    unregister_summary(collection_name, file_name)

                    from aiq_agent.knowledge.chunk_text_store import get_chunk_text_store

                    get_chunk_text_store().delete_by_file(collection_name, file_name)
                    # True only when something of the file was actually removed.
                    return bool(tracking_ids_to_remove)
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

            # Drop the lexical mirror for this file, scoped to THIS collection: the
            # same file_name legitimately exists in the base corpus and in a project
            # upload, and deleting one must not blind the other.
            from aiq_agent.knowledge.chunk_text_store import get_chunk_text_store

            get_chunk_text_store().delete_by_file(collection_name, file_name)

            return True

        except Exception as e:
            logger.error(f"Failed to delete file {file_id}: {e}")
            return False

    def list_files(self, collection_name: str) -> list[FileInfo]:
        """List all files in a collection."""
        try:
            self._prune_stale_files()
            client = self._get_chroma_client()

            try:
                collection = client.get_collection(name=collection_name)
            except Exception:
                return []

            # Correlate tracked FileInfo by name in one pass (was an O(files)
            # rescan of self._files per listed file).
            tracked_by_name = self._index_tracked_files(collection_name)

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
                # O(1) tracked-file lookup from the prebuilt index.
                file_id, file_info = tracked_by_name.get(file_name, (None, None))

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
                            # completed_at is an ISO string on the local path but
                            # Pydantic coerces it back to a datetime when the
                            # status is rehydrated from the shared store (a
                            # cross-replica read), so normalize both forms.
                            if file_info.status == FileStatus.SUCCESS and job_status.completed_at:
                                _completed = job_status.completed_at
                                file_info.ingested_at = (
                                    _completed
                                    if isinstance(_completed, datetime)
                                    else datetime.fromisoformat(_completed)
                                )
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

    def get_document_text_sample(self, collection_name: str, file_name: str, max_chars: int = 4000) -> str | None:
        """Return representative text for an already-indexed file (fail-open).

        Used exclusively by the reconciliation backfill (see
        ``aiq_agent.knowledge.factory.reconcile_collection_summaries``) to derive
        a deterministic fallback summary for a document that is present in the
        vector index but missing from the summaries table. Queries Chroma
        directly for chunks tagged with this ``file_name`` — the same metadata
        key ingestion writes onto every chunk in ``_run_ingestion`` — and
        concatenates their text, capped at ``max_chars``.

        Not part of the ``BaseIngestor`` interface: the reconciliation driver in
        the factory duck-types this method (``getattr(..., None)``) so other
        backends can opt in without a forced interface change. Returns ``None``
        on any lookup failure or when the file has no indexed text chunks.
        """
        try:
            client = self._get_chroma_client()
            collection = client.get_collection(name=collection_name)
        except Exception as e:
            logger.warning(
                "Reconciliation: collection %s not found while sampling text for %s: %s",
                collection_name,
                file_name,
                e,
            )
            return None

        try:
            results = collection.get(where={"file_name": file_name}, include=["documents"], limit=5)
        except Exception as e:
            logger.warning("Reconciliation: failed to fetch chunks for %s in %s: %s", file_name, collection_name, e)
            return None

        documents = [doc for doc in (results.get("documents") or []) if doc]
        if not documents:
            return None

        combined = "\n".join(documents)
        return combined[:max_chars] if combined else None

    def get_document_visual_details(self, collection_name: str, file_name: str) -> list[dict[str, Any]]:
        """Per-page VLM descriptions of a document's visual chunks (fail-open).

        Powers the file-preview "detailed information" section: returns the
        rendered-drawing / image / chart captions ingestion produced, so the
        rich description (drawing type, scale, materials, spatial relationships,
        detailed paragraph) the summary is distilled from is browsable — not just
        reachable via chat retrieval. Duck-typed (not on ``BaseIngestor``) like
        :meth:`get_document_text_sample`. Returns ``[]`` on any lookup failure or
        when the document has no visual chunks.

        Each item: ``{page, content_type, drawing_type, scale, text, segment,
        structured}`` where ``text`` is the caption body (the ``[DRAWING from
        page N]`` prefix stripped), ``segment`` is the drawing's index on its
        sheet (0 for v1 chunks and non-drawings), and ``structured`` is the
        parsed v2 ``drawing_data`` payload (``None`` for v1 chunks and
        non-drawings). Sorted by page, then content type, then segment.
        """
        try:
            client = self._get_chroma_client()
            collection = client.get_collection(name=collection_name)
            results = collection.get(where={"file_name": file_name}, include=["documents", "metadatas"])
        except Exception as e:
            logger.warning("Visual details lookup failed for %s in %s: %s", file_name, collection_name, e)
            return []

        documents = results.get("documents") or []
        metadatas = results.get("metadatas") or []
        items: list[dict[str, Any]] = []
        for text, meta in zip(documents, metadatas):
            meta = meta or {}
            content_type = meta.get("content_type")
            if content_type not in ("drawing", "image", "chart") or not text:
                continue
            # Strip the "[DRAWING from page N]\n\n" / "[IMAGE …]" prefix so the FE
            # shows the description, not the internal marker.
            body = text.split("\n\n", 1)[1] if "\n\n" in text else text
            try:
                page = int(meta.get("page_label") or 0)
            except (TypeError, ValueError):
                page = 0
            try:
                segment = int(meta.get("segment_index") or 0)
            except (TypeError, ValueError):
                segment = 0
            # The v2 structured payload rides along parsed, so the FE never
            # has to know it is stored as a JSON string in Chroma metadata.
            structured = None
            raw_data = meta.get("drawing_data")
            if raw_data:
                try:
                    structured = json.loads(raw_data)
                except (TypeError, ValueError):
                    structured = None
            items.append(
                {
                    "page": page,
                    "content_type": content_type,
                    "drawing_type": meta.get("drawing_type") or "",
                    "scale": meta.get("drawing_scale") or "",
                    "text": body.strip(),
                    "segment": segment,
                    "structured": structured,
                }
            )

        items.sort(key=lambda it: (it["page"], it["content_type"], it["segment"]))
        return items

    @staticmethod
    def _generate_and_upload_thumbnail(
        file_path: str,
        thumbnail_upload_url: str,
    ) -> None:
        """Generate a 400px-wide JPEG thumbnail and upload it via the presigned URL.

        The file cards render the thumbnail header up to ~236px wide, so a 400px
        source keeps it crisp on standard displays and stays reasonable on
        high-DPI (retina) screens where a smaller source would look soft.
        """
        import io

        import httpx
        from PIL import Image

        # Longest-edge cap for the generated thumbnail (px).
        THUMBNAIL_MAX_DIM = 400

        is_pdf = _looks_like_pdf(file_path)
        image_format = _looks_like_image(file_path)
        is_image = image_format is not None

        pil_image: Image.Image | None = None

        if is_pdf:
            try:
                import pypdfium2 as pdfium

                pdf = pdfium.PdfDocument(file_path)
                page = pdf[0]
                # Render at 2x (supersample) so the down-scaled thumbnail keeps
                # crisp, anti-aliased text/lines instead of a soft 72-DPI page.
                bitmap = page.render(scale=2)
                pil_image = bitmap.to_pil()
                pdf.close()
            except Exception:
                logger.warning("Failed to render PDF page for thumbnail", exc_info=True)
                return
        elif is_image:
            try:
                pil_image = Image.open(file_path)
                pil_image.load()
                if pil_image.mode != "RGB":
                    pil_image = pil_image.convert("RGB")
            except Exception:
                logger.warning("Failed to open image for thumbnail", exc_info=True)
                return
        else:
            return  # Not a previewable type

        # Resize to max 400px on the longest edge, maintaining aspect ratio.
        pil_image.thumbnail((THUMBNAIL_MAX_DIM, THUMBNAIL_MAX_DIM))
        buf = io.BytesIO()
        pil_image.save(buf, format="JPEG", quality=80)
        thumbnail_bytes = buf.getvalue()

        try:
            with httpx.Client() as client:
                resp = client.put(
                    thumbnail_upload_url,
                    content=thumbnail_bytes,
                    headers={"Content-Type": "image/jpeg"},
                )
                resp.raise_for_status()
            # NEVER log the upload URL, not even truncated. It is a presigned S3
            # URL — a live bearer credential to that object with no user, org or
            # IP binding. The `[:80]` prefix this used to print was not a
            # control: the cut lands at a different place depending on how long
            # the org/project/document ids in the key are, so whether the
            # signature survived was luck, and the tenant path leaked in full for
            # short keys. Same rule as the download side in
            # frontends/aiq_api/src/aiq_api/routes/ingest.py.
            logger.info("Uploaded thumbnail (%d bytes)", len(thumbnail_bytes))
        except Exception:
            logger.warning("Failed to upload thumbnail", exc_info=True)

    def _replace_previous_versions(self, chroma_collection, collection_name: str, incoming_names: list[str]) -> None:
        """Delete the chunks of any EARLIER upload of these file names, so a
        re-upload REPLACES its predecessor instead of coexisting with it.

        Law does not go stale, it gets replaced — and the OIB sync already has
        replacement semantics through its hash registry. Uploaded office and
        project documents had none: re-uploading `statik-standard.pdf` appended
        a second full set of chunks next to the first, and both versions then
        competed in retrieval on similarity alone, so an answer could cite the
        superseded one with full confidence. The newest upload of a name is the
        version the user means; this enforces exactly that, per collection.

        Matching mirrors delete_file's normalization (tmp[8]_ prefix strip plus
        percent-decoding), because stored names carry either form depending on
        how the file reached the backend. One metadata scan per ingestion JOB,
        not per file. Defensive: replacement failing must never fail the
        ingest — worst case is the pre-existing duplicate behavior, logged.

        Deliberately name-based only: a NEW name is a new document, even when
        its content supersedes an old one. Detecting renamed versions
        semantically would guess, and a wrong guess silently deletes a document
        someone still cites — the human-classification-wins rule applies.
        """
        try:
            from urllib.parse import unquote

            from aiq_agent.knowledge import unregister_summary
            from aiq_agent.knowledge.chunk_text_store import get_chunk_text_store

            tmp_prefix = re.compile(r"^tmp.{8}_")

            def normalize(name: str) -> str:
                return unquote(tmp_prefix.sub("", name or ""))

            targets = {normalize(name) for name in incoming_names if name}
            targets.discard("")
            if not targets:
                return
            existing = chroma_collection.get(include=["metadatas"])
            ids_by_stored: dict[str, list[str]] = {}
            for chunk_id, meta in zip(existing.get("ids", []), existing.get("metadatas", []) or [], strict=False):
                stored = (meta or {}).get("file_name", "") or ""
                if normalize(stored) in targets:
                    ids_by_stored.setdefault(stored, []).append(chunk_id)
            if not ids_by_stored:
                return
            all_ids = [cid for ids in ids_by_stored.values() for cid in ids]
            chroma_collection.delete(ids=all_ids)
            bump_collection_version(collection_name)
            for stored in ids_by_stored:
                unregister_summary(collection_name, stored)
                get_chunk_text_store().delete_by_file(collection_name, stored)
                normalized = normalize(stored)
                if normalized != stored:
                    get_chunk_text_store().delete_by_file(collection_name, normalized)
            logger.info(
                "Replaced previous version(s): removed %d chunk(s) of %s from %s before re-ingest",
                len(all_ids),
                sorted(ids_by_stored),
                collection_name,
            )
        except Exception:  # noqa: BLE001 — replacement must never break ingestion
            logger.warning(
                "Could not remove previous versions before ingest; duplicate chunks may remain",
                exc_info=True,
            )

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
            ingest_status_store.put(job)

            # Initialize components
            self._ensure_initialized()

            # Import LlamaIndex components
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

            # Resolve the VLM the SAME way the NAT chat models resolve theirs —
            # honouring org BYOK (key + base URL) and the org's runtime model
            # override — so per-project/Archiv uploads use the tenant's own
            # vision credential and chosen model. The org id is captured at the
            # request boundary (/v1/ingest) into the job config, because this
            # runs in a detached background thread with no request context. The
            # org-agnostic paths (base OIB corpus sync) carry no org id and get
            # the deployment default, exactly as before.
            organization_id = config.get("organization_id")
            vlm_cred = resolve_vlm_credential(organization_id)
            vlm_api_key = vlm_cred.api_key
            vlm_base_url = config.get("vlm_base_url") or vlm_cred.base_url
            base_vlm_model = config.get("vlm_model", self.vlm_model)
            vlm_model = _resolve_vlm_model_override(organization_id) or base_vlm_model

            # Set up ChromaDB client (use shared client if using default persist_dir).
            # In shared-server mode _make_chroma_client ignores persist_dir and
            # returns the one server client regardless of branch.
            persist_dir = config.get("persist_dir", self.persist_dir)
            if persist_dir == self.persist_dir:
                chroma_client = self._get_chroma_client()
            else:
                chroma_client = _make_chroma_client(persist_dir)

            # Get or create collection
            chroma_collection = chroma_client.get_or_create_collection(
                name=collection_name,
                metadata={"hnsw:space": "cosine"},
            )

            # Refuse to add vectors from a different embedding space to an existing
            # collection. Retrieval performs the same check, but only on the read path
            # and only in the retriever class -- so a misconfigured process could still
            # WRITE foreign vectors here, and the collection would then hold two spaces
            # permanently. Failing the job instead leaves the corpus consistent and the
            # cause named. Absent fingerprint is adopted, as everywhere else.
            mismatch = embed_fingerprint_mismatch(
                chroma_collection.metadata, self.embed_model_name, self.embed_base_url
            )
            if mismatch:
                raise ValueError(f"Refusing to ingest into {collection_name}: {mismatch}")

            # Set up vector store
            vector_store = ChromaVectorStore(chroma_collection=chroma_collection)
            storage_context = StorageContext.from_defaults(vector_store=vector_store)

            # A re-upload replaces its predecessor (same normalized file name,
            # this collection) before anything new is written — see
            # _replace_previous_versions for why versions must not coexist.
            provided_names = config.get("original_filenames", [])
            incoming_names = [
                provided_names[i] if i < len(provided_names) else Path(fp).name for i, fp in enumerate(file_paths)
            ]
            self._replace_previous_versions(chroma_collection, collection_name, incoming_names)

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

                    # Explicit per-document classification ("Dokumentart").
                    # Prefer a human-set stored class over the filename guess;
                    # stamped into every chunk's metadata below and persisted to
                    # the summaries row after ingestion. The guess is for the
                    # base corpus only: on a project, session or Büroarchiv
                    # upload a guessed "sonstiges" is not harmless — it labelled
                    # every user document a "Basisdokument" in the Herleitung.
                    from aiq_agent.common.norm_registry import guess_doc_class
                    from aiq_agent.common.source_kinds import legacy_shelf_for_collection_name
                    from aiq_agent.knowledge import get_document_doc_class

                    stored_doc_class = get_document_doc_class(collection_name, file_name)
                    base_corpus = legacy_shelf_for_collection_name(collection_name) is None
                    doc_class = stored_doc_class or (guess_doc_class(file_name) if base_corpus else None)
                    is_pdf = (
                        file_name.lower().endswith(".pdf")
                        or Path(file_path).suffix.lower() == ".pdf"
                        or _looks_like_pdf(file_path)
                    )
                    # Standalone image detection (magic bytes, else extension) —
                    # only when it is not a PDF. Routes PNG/JPEG to VLM captioning
                    # instead of the text reader (which would garble the binary).
                    image_format = None if is_pdf else _looks_like_image(file_path)
                    if image_format is None and not is_pdf:
                        ext = Path(file_name).suffix.lower()
                        if ext == ".png":
                            image_format = "png"
                        elif ext in (".jpg", ".jpeg"):
                            image_format = "jpeg"
                        elif ext == ".webp":
                            image_format = "webp"
                    is_image = image_format is not None and not is_pdf

                    mode_str = "text"
                    if is_image or (is_pdf and (extract_tables or extract_images)):
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
                    text_pages: list[dict[str, Any]] = []
                    if is_pdf:
                        text_pages = _extract_text_from_pdf(file_path)
                        text_documents = text_documents_for_pages(text_pages, file_name, file_size)
                    elif is_image:
                        # Standalone image: caption via the VLM into a single
                        # Document. The VLM is a hard requirement here (there is
                        # no text to fall back on), so a missing key fails the
                        # file with a specific, machine-readable reason the
                        # failed-doc UX can surface for retry. The key is the
                        # org-aware resolved one (BYOK), not the deployment key.
                        if not vlm_api_key:
                            self._update_file_status(
                                job,
                                i,
                                FileStatus.FAILED,
                                error="vlm_not_configured: image ingestion requires AIQ_VLM_API_KEY",
                            )
                            logger.warning("Image ingestion skipped (VLM not configured): %s", file_name)
                            continue

                        image_docs = _build_image_documents(
                            file_path,
                            file_name,
                            file_size,
                            image_format,
                            vlm_model=vlm_model,
                            vlm_base_url=vlm_base_url,
                            vlm_api_key=vlm_api_key,
                            extract_charts=extract_charts,
                        )
                        if image_docs is None:
                            self._update_file_status(
                                job,
                                i,
                                FileStatus.FAILED,
                                error="Image could not be decoded or captioned (corrupted file or VLM failure)",
                            )
                            logger.warning("Image could not be decoded or captioned: %s", file_name)
                            continue
                        text_documents = image_docs
                        # Keep the job-level visual counters accurate: the file
                        # is ONE visual (an image/chart, or a drawing analysed
                        # into per-segment chunks) — not a text chunk.
                        if image_docs[0].metadata.get("content_type") == "chart":
                            total_charts += 1
                        else:
                            total_images += 1
                    else:
                        # Known office formats first: SimpleDirectoryReader's
                        # per-format readers are an optional distribution this
                        # deployment does not install, and its fallback reads
                        # raw bytes as text — a .docx (a zip) became PK\x03…
                        # garbage that the binary guard rejected, failing every
                        # Word upload. The office extractors handle
                        # docx/xlsx/pptx with the libraries already here;
                        # plain-text formats (.txt/.md/.csv) stay on the
                        # generic reader, which handles them correctly.
                        from knowledge_layer.llamaindex import office_extractors

                        office_documents = office_extractors.extract_office_documents(file_path, file_name, file_size)
                        if office_documents is not None:
                            text_documents = office_documents
                        else:
                            from llama_index.core import SimpleDirectoryReader

                            text_documents = SimpleDirectoryReader(input_files=[file_path]).load_data()

                            # Override file_name metadata (SimpleDirectoryReader uses temp path)
                            for doc in text_documents:
                                doc.metadata["file_name"] = file_name
                                doc.metadata["file_size"] = file_size

                    all_documents.extend(text_documents)
                    logger.info(f"  Text extraction: {len(text_documents)} documents")

                    # Favourable ordering: thumbnail first. This is the quickest
                    # operation (pypdfium2 page-1 render → fire-and-forget PUT to
                    # as soon as the backend has the file.
                    # NOTE: thumbnail is now generated pre-ingest in the
                    # /v1/ingest route handler. That route sets
                    # config["thumbnail_pregenerated"] once it has successfully
                    # uploaded one, so this fallback only fires when pre-ingest
                    # generation was absent or failed — for any caller that
                    # submits jobs without going through that endpoint (tests or
                    # future alternative front doors) or whose pre-render failed.
                    # This avoids rendering + PUTting the thumbnail twice per file.
                    thumbnail_upload_url = config.get("thumbnail_upload_url")
                    if thumbnail_upload_url and (is_pdf or is_image) and not config.get("thumbnail_pregenerated"):
                        self._generate_and_upload_thumbnail(file_path, thumbnail_upload_url)

                    # Summary + tag classification are started AFTER visual
                    # extraction (below) so that for text-sparse drawing PDFs the
                    # rendered-page descriptions — not a watermark — feed the
                    # summary. Rendered visual/vector pages accumulate here.
                    summary_future = None
                    tags_future = None
                    executor = None
                    drawing_pages: list[dict[str, Any]] = []

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

                    # 3+4. Combined image + drawing extraction with concurrent VLM
                    # enrichment. Replaces the old sequential per-image and per-page
                    # VLM loops with a single batch that runs ALL VLM calls for the
                    # file concurrently (4 workers), with content-hash caching so a
                    # re-ingest or cross-document duplicate skips the API call.
                    if is_pdf:
                        # Extract image bytes (no VLM yet)
                        images = _extract_images_from_pdf(file_path) if (extract_images or extract_charts) else []

                        from knowledge_layer.llamaindex import processing as _processing

                        drawing_pages_raw: list[dict[str, Any]] = []
                        if RENDER_VISUAL_PAGES and vlm_api_key:
                            # Hand the renderer the already-extracted
                            # (watermark-stripped) page texts: the PDF's text
                            # layer is read once, and the visual heuristic's
                            # "watermark-stripped text" threshold actually holds.
                            drawing_pages_raw = _processing.render_visual_pages_no_vlm(
                                file_path,
                                min_text_chars=VISUAL_PAGE_MIN_TEXT_CHARS,
                                min_paths=VISUAL_PAGE_MIN_PATHS,
                                max_pages=MAX_RENDERED_PAGES,
                                max_dim=PAGE_RENDER_MAX_DIM,
                                page_texts={p["page_number"]: p["text"] for p in text_pages},
                            )

                        image_results, drawing_pages = _processing.enrich_vlm_batch(
                            image_records=images,
                            drawing_pages=drawing_pages_raw,
                            vlm_model=vlm_model,
                            vlm_base_url=vlm_base_url,
                            vlm_api_key=vlm_api_key,
                            extract_charts=extract_charts,
                        )

                        # Keep the rasters the VLM just captioned, beside the
                        # document, so `view_knowledge_image` can show one at
                        # its own resolution rather than as a page render.
                        # Only a document the BFF dispatched has an id and a
                        # prefix to store under; the corpus sync has neither
                        # and keeps captions only. Fail-open inside.
                        document_id = config.get("document_id")
                        if document_id and image_results:
                            from knowledge_layer.llamaindex import image_store as _image_store

                            _image_store.store_extracted_images(
                                image_results,
                                document_id=str(document_id),
                                collection=collection_name,
                                organization_id=organization_id,
                            )

                        # Build image/chart/drawing documents. An embedded raster
                        # now goes through the SAME analysis as a rendered page,
                        # so a scanned plan placed inside a PDF is indexed per
                        # drawing rather than as one paragraph — the `drawing`
                        # content type is reachable from this branch too.
                        file_charts = 0
                        file_images = 0
                        for record, content_type, caption in image_results:
                            caption = _scrub_watermark_phrases(caption) or "[Image - no describable content]"

                            is_chart = content_type == "chart"

                            # `extract_images` is the switch for every non-chart
                            # visual, drawings included.
                            if extract_charts and not extract_images and not is_chart:
                                continue
                            if extract_images and not extract_charts and is_chart:
                                continue

                            all_documents.extend(
                                visual_documents(
                                    content_type,
                                    caption,
                                    record.get("fields") or {},
                                    file_name=file_name,
                                    file_size=file_size,
                                    page_number=record["page_number"],
                                    extra_metadata={
                                        "image_index": record["image_index"],
                                        "image_format": record["format"],
                                        "image_width": record["width"],
                                        "image_height": record["height"],
                                        # Present only when the raster was stored.
                                        **{
                                            key: record[key]
                                            for key in ("image_key", "stored_image_index")
                                            if key in record
                                        },
                                    },
                                )
                            )
                            if is_chart:
                                file_charts += 1
                            else:
                                file_images += 1

                        total_charts += file_charts
                        total_images += file_images
                        if file_charts or file_images:
                            logger.info(f"  Visual extraction: {file_charts} charts, {file_images} images")

                        # Build rendered-page documents through the same builder
                        # the embedded rasters above use. A rendered page is
                        # nearly always a drawing, but the analysis types it —
                        # a rendered photo page is not forced to claim it is a
                        # plan just because of where its bytes came from.
                        for page in drawing_pages:
                            all_documents.extend(
                                visual_documents(
                                    page.get("content_type") or "drawing",
                                    page.get("caption", ""),
                                    page.get("fields") or {},
                                    file_name=file_name,
                                    file_size=file_size,
                                    page_number=page["page_number"],
                                    extra_metadata={
                                        "image_width": page.get("width", 0),
                                        "image_height": page.get("height", 0),
                                    },
                                )
                            )
                        total_images += len(drawing_pages)
                        if drawing_pages:
                            logger.info(f"  Drawing extraction: {len(drawing_pages)} rendered page(s)")

                    # Start summary + tag classification (if enabled). For a
                    # text-sparse drawing PDF the rendered-page descriptions are
                    # the document's real content, so feed those to the LLM
                    # instead of the near-empty (watermark-stripped) page text —
                    # otherwise the summary describes nothing or a watermark. Both
                    # LLM calls run concurrently on a 2-worker pool and are fully
                    # fail-open below.
                    if self.generate_summary_enabled and (text_documents or drawing_pages):
                        from aiq_agent.knowledge.document_classification import classify_document_tags

                        first = text_documents[0].get_content() if text_documents else ""
                        last = text_documents[-1].get_content() if len(text_documents) > 1 else ""
                        text_source = f"{first}\n...\n{last}" if last else first
                        drawing_source = "\n\n".join(p["caption"] for p in drawing_pages)
                        if drawing_pages and len(text_source.strip()) < VISUAL_PAGE_MIN_TEXT_CHARS:
                            llm_input = drawing_source or text_source
                        else:
                            llm_input = text_source
                        executor = ThreadPoolExecutor(max_workers=2)
                        summary_future = executor.submit(
                            _generate_document_summary, llm_input, file_name, self.summary_llm
                        )
                        tags_future = executor.submit(classify_document_tags, llm_input, file_name, self.summary_llm)

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

                    # Standalone images must appear in the per-turn
                    # available_documents list to be usable in chat (summaries
                    # are the ONLY per-turn file visibility). If summarization is
                    # disabled or failed, fall back to the VLM caption itself so
                    # the image is never silently invisible.
                    if is_image and not summary and text_documents:
                        # Scrub any licence/watermark stamp out of the caption
                        # before it becomes the summary; if scrubbing empties it,
                        # leave summary as None rather than emit an empty summary.
                        caption_text = _scrub_watermark_phrases(text_documents[0].get_content())
                        summary = caption_text[:500] or None

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

                    # Stamp the explicit doc_class ("Dokumentart") into every
                    # chunk's metadata (next to file_name) so it survives into
                    # Chunk.metadata at retrieval and drives the lane/kind
                    # classifiers ahead of the filename guess.
                    for doc in all_documents:
                        doc.metadata["doc_class"] = doc_class
                        _apply_metadata_exclusions(doc)

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

                    # Mirror this file's chunk text into the knowledge database so the
                    # German lexical channel can search it. The ids are read back FROM
                    # Chroma rather than derived from the documents: the node parser runs
                    # inside from_documents/insert, so the llama-index node id -- which is
                    # the chunk_id fusion keys on -- does not exist until after indexing.
                    # Fail-open: a mirror failure must never fail a file that is already
                    # safely in the vector store.
                    try:
                        from aiq_agent.knowledge.chunk_text_store import get_chunk_text_store

                        mirrored = chroma_collection.get(
                            where={"file_name": file_name},
                            include=["documents", "metadatas"],
                        )
                        mirrored_ids = mirrored.get("ids") or []
                        mirrored_docs = mirrored.get("documents") or []
                        mirrored_meta = mirrored.get("metadatas") or []
                        get_chunk_text_store().upsert_many(
                            collection_name,
                            [
                                {
                                    "chunk_id": chunk_id,
                                    "body": mirrored_docs[index] if index < len(mirrored_docs) else "",
                                    # The STORED file_name, not the local one: delete_file
                                    # resolves tmp-prefixed names, and the mirror has to be
                                    # deletable by whatever key delete looks up.
                                    "file_name": (
                                        (mirrored_meta[index] or {}).get("file_name") or file_name
                                        if index < len(mirrored_meta)
                                        else file_name
                                    ),
                                    "page_label": (
                                        (mirrored_meta[index] or {}).get("page_label", "")
                                        if index < len(mirrored_meta)
                                        else ""
                                    ),
                                }
                                for index, chunk_id in enumerate(mirrored_ids)
                            ],
                        )
                    except Exception as mirror_error:
                        logger.warning("Chunk text mirror skipped for %s: %s", file_name, mirror_error)

                    # Count chunks (nodes)
                    chunks_created = len(all_documents)
                    total_chunks += chunks_created

                    self._update_file_status(job, i, FileStatus.SUCCESS, chunks_created=chunks_created)

                    # Drawing PDFs (text-sparse) whose LLM summary failed fall
                    # back to a deterministic, watermark-free summary synthesised
                    # from the rendered-page drawing fields — better than the raw
                    # text backstop below, which would surface a watermark or an
                    # empty string.
                    if not summary and drawing_pages:
                        summary = _summary_from_drawing_fields(drawing_pages)

                    # Structural "ingested ⇒ visible" backstop: ANY successfully
                    # ingested text document must get a summary row, or it becomes
                    # invisible to agents (available_documents is sourced SOLELY
                    # from the summaries table). This fires whenever the LLM
                    # summary is missing — summarization disabled, LLM failure, or
                    # timeout — and deliberately does NOT require tag
                    # classification to have succeeded; tags ride along
                    # independently and may still be None. Standalone images
                    # already fell back to their VLM caption above.
                    if not summary and text_documents:
                        from aiq_agent.knowledge.document_classification import fallback_summary_from_text

                        first_text = text_documents[0].get_content()
                        last_text = text_documents[-1].get_content() if len(text_documents) > 1 else ""
                        fallback_source = f"{first_text}\n{last_text}" if last_text else first_text
                        summary = fallback_summary_from_text(fallback_source)

                    # Store summary + tags in FileInfo and centralized registry
                    if summary:
                        # Register in centralized summary registry (backend-agnostic).
                        # Tags ride along in the same upsert (may be None).
                        from aiq_agent.knowledge import register_summary
                        from aiq_agent.knowledge import set_document_doc_class
                        from aiq_agent.knowledge import set_document_folder_path

                        register_summary(collection_name, file_name, summary, tags=tags)

                        # Persist the doc_class onto the freshly-created summary
                        # row, but never overwrite a human-set stored value —
                        # only stamp the guess when none was stored.
                        if stored_doc_class is None:
                            set_document_doc_class(collection_name, file_name, doc_class)

                        # The folder the BFF filed this document in, carried on
                        # the job config from `POST /v1/ingest` (ADR-0049). It is
                        # the materialised PATH, not a folder id, and it lands on
                        # the metadata row rather than in the chunk vectors —
                        # which is what lets a later rename re-file the document
                        # with no re-ingest. Absent config means "project root".
                        folder_path = (config.get("folder_path") or "").strip() or None
                        if folder_path:
                            set_document_folder_path(collection_name, file_name, folder_path)

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

            # Persist the terminal status so any replica serves the final result.
            ingest_status_store.put(job)

            # Update collection's updated_at timestamp
            self._update_collection_timestamp(collection_name)
            # Invalidate any cached retrieval results for this collection.
            bump_collection_version(collection_name)

            # Reconciliation backstop: catch any document that ingested
            # successfully (visible/searchable in Chroma) but whose summary row
            # silently failed to register — e.g. both the LLM summary and tag
            # classification calls failed. Runs at the end of every ingestion
            # job inside the knowledge layer, so every caller (the Knowledge
            # API, scripts/ingest_oib.py's oib_sync, and any future caller)
            # gets this for free without having to remember to call it. Scoped
            # to THIS job's successful files: the unscoped mode's list_files
            # reads every chunk metadata in the collection — O(collection) per
            # single-file upload, painful on the large oib_knowledge corpus.
            if successful_files:
                try:
                    from aiq_agent.knowledge.factory import reconcile_collection_summaries

                    reconcile_collection_summaries(
                        self,
                        collection_name,
                        file_names=[f.file_name for f in successful_files],
                    )
                except Exception as e:
                    logger.warning("Reconciliation failed for collection %s: %s", collection_name, e)

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
            ingest_status_store.put(job)

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


#: Entries in the exact-term document-frequency cache before it is cleared. The live
#: key set is a handful of terms per collection; the cap only bounds a pathological
#: run of one-off terms.
_EXACT_TERM_DF_CACHE_MAX = 512


@register_retriever("llamaindex")
class LlamaIndexRetriever(BaseRetriever):
    """
    LlamaIndex-based document retriever.

    Uses ChromaDB for vector storage and NVIDIA embeddings.

    Configuration options:
        persist_dir: ChromaDB persistence directory (default from AIQ_CHROMA_DIR)
        embed_model: NVIDIA embedding model name (default from AIQ_EMBED_MODEL)
        top_k: Default number of results (default: 10)
        hybrid_search: Enable lexical+vector hybrid retrieval (default from AIQ_HYBRID_RETRIEVAL)

    Environment variables:
        AIQ_CHROMA_DIR: Default ChromaDB persistence directory
        AIQ_EMBED_MODEL: Default embedding model name
        AIQ_EMBED_BASE_URL: Default embedding model base URL
        AIQ_RETRIEVER_TOP_K: Default top_k value
        AIQ_HYBRID_RETRIEVAL: Enable hybrid lexical+vector retrieval (default: true)
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
    # @environment_variable AIQ_HYBRID_RETRIEVAL
    # @category Knowledge Layer
    # @type bool
    # @default true
    # @required false
    # Enable the lexical+vector hybrid retrieval channel (exact-term Chroma
    # `$contains` passes fused with the vector results via reciprocal rank fusion).
    DEFAULT_HYBRID_SEARCH = os.environ.get("AIQ_HYBRID_RETRIEVAL", "true").strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }

    backend_name = "llamaindex"

    def __init__(self, config: dict[str, Any] | None = None):
        super().__init__(config)

        self.persist_dir = self.config.get("persist_dir", self.DEFAULT_PERSIST_DIR)
        self.embed_model_name = self.config.get("embed_model", self.DEFAULT_EMBED_MODEL)
        self.embed_base_url = self.config.get("embed_base_url", self.DEFAULT_EMBED_BASE_URL)
        self.default_top_k = self.config.get("top_k", self.DEFAULT_TOP_K)
        # Explicit config wins; otherwise the environment default (on).
        self.hybrid_search = bool(self.config.get("hybrid_search", self.DEFAULT_HYBRID_SEARCH))

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

        # Document frequency of each exact term, per collection size, so the
        # `$contains` channel's DF ceiling costs one `get` per new term rather
        # than one per retrieval. See `_selective_exact_terms`.
        self._exact_term_df: dict[tuple[str, int, str], int] = {}

        # Result cache for static corpora (the shared OIB knowledge base):
        # identical questions recur across users and conversations, and the
        # corpus only changes on re-sync. Keyed on the collection write
        # version, so in-process ingestion invalidates immediately.
        self._result_cache: dict[tuple[str, int, str, int, str], tuple[float, RetrievalResult]] = {}
        self._result_cache_order: list[tuple[str, int, str, int, str]] = []
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
        # Same complete preflight as the ingestion path: "initialized" has to
        # mean usable, not "the first import worked".
        ensure_retrieval_dependencies()

        try:
            from llama_index.core import Settings
            from llama_index.embeddings.nvidia import NVIDIAEmbedding

            nvidia_api_key = _resolve_embed_api_key(self.embed_base_url, self.embed_model_name)
            if not nvidia_api_key:
                logger.error(
                    "No embeddings API key resolved (AIQ_EMBED_API_KEY / NVIDIA_API_KEY / "
                    "the provider key for AIQ_EMBED_BASE_URL) - retrieval/ingestion will fail."
                )

            self._embed_model = NVIDIAEmbedding(
                base_url=self.embed_base_url,
                model=self.embed_model_name,
                api_key=nvidia_api_key,
                embed_batch_size=EMBED_BATCH_SIZE,
            )
            Settings.embed_model = self._embed_model

            # Shared server when AIQ_CHROMA_URL/HOST is set, else embedded.
            self._chroma_client = _make_chroma_client(self.persist_dir)

            self._initialized = True
            logger.info("LlamaIndex retriever components initialized")

        except ImportError as e:
            raise _retrieval_dependency_error(e) from e

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

        # Fail loudly rather than answering from a foreign vector space. Raising here
        # surfaces through _retrieve_sync as success=False, so the layer drops out with a
        # WARNING instead of taking the whole chat surface down over a config typo.
        mismatch = embed_fingerprint_mismatch(chroma_collection.metadata, self.embed_model_name, self.embed_base_url)
        if mismatch:
            if collection_name not in _reported_fingerprint_mismatches:
                _reported_fingerprint_mismatches.add(collection_name)
                logger.error("Collection '%s' %s", collection_name, mismatch)
            raise RuntimeError(f"Collection '{collection_name}' {mismatch}")

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

    def _cached_static_result(self, key: tuple[str, int, str, int, str]) -> RetrievalResult | None:
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

    def _store_static_result(self, key: tuple[str, int, str, int, str], result: RetrievalResult) -> None:
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

            # No resolvable write version => no cache key at all. `None` is unknown,
            # not 0: an entry stored or matched against a version we cannot vouch for
            # is how one replica keeps answering from a corpus another replica has
            # already changed. Read through instead -- the cache is an optimisation,
            # the version is a correctness invariant.
            #
            # Membership is tested FIRST because resolving the version is a shared-cache
            # round trip. Every query also fans out across the per-conversation session
            # collection and any project collections, and none of those is cacheable, so
            # resolving first spent one EVAL per non-cacheable collection per query on the
            # retrieval hot path -- and grew a permanent memo entry for each -- to discard
            # the answer immediately afterwards.
            cache_key: tuple[str, int, str, int, str] | None = None
            version = (
                collection_version(collection_name) if collection_name in self.STATIC_RESULT_CACHE_COLLECTIONS else None
            )
            if version is not None:
                cache_key = (
                    collection_name,
                    version,
                    query,
                    top_k,
                    _filters_fingerprint(filters),
                )
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
            retriever_kwargs: dict[str, Any] = {"similarity_top_k": top_k}
            metadata_filters = _to_metadata_filters(filters)
            if metadata_filters is not None:
                retriever_kwargs["filters"] = metadata_filters
            retriever = index.as_retriever(**retriever_kwargs)
            query_bundle = QueryBundle(query_str=query, embedding=self._embed_query_cached(query))
            nodes = retriever.retrieve(query_bundle)

            # Normalize results to Chunk schema
            chunks = [self.normalize(node) for node in nodes]

            if self.hybrid_search:
                chunks = self._hybrid_lexical_boost(query, collection_name, top_k, filters, chunks)

            # State each hit's rank in this collection's FINAL order, after the lexical
            # fusion has had its say. `_rank_channel` in register.py documents reading it
            # here and nothing ever wrote it, so every cross-collection merge fell back to
            # list position. That fallback happens to be correct today -- position is the
            # final order -- but it made the field dead weight and the docstring false,
            # and it left the fuser unable to tell a genuine rank from a coincidence.
            for rank, chunk in enumerate(chunks):
                chunk.retrieval_rank = rank

            logger.info(f"LlamaIndex retrieval returned {len(chunks)} chunks")

            result = RetrievalResult(
                chunks=chunks,
                query=query,
                backend=self.backend_name,
                success=True,
            )
            if cache_key is not None:
                self._store_static_result(cache_key, result)
            return result

        except Exception as e:
            # ``exception``, not ``error``: these failures are routinely chained
            # (a RuntimeError raised *from* the ImportError that actually
            # explains it), and the bare f-string dropped the chain. Combined
            # with the 100-char cut below, issue #330 reached us as the string
            # "LlamaIndex retrieval failed: LlamaIndex dependencies not instal"
            # -- truncated mid-word, cause discarded, and the surviving half was
            # a misdescription of the fault. The log now carries the whole chain;
            # the caller-facing summary stays bounded.
            logger.exception("LlamaIndex retrieval failed")
            return RetrievalResult(
                chunks=[],
                query=query,
                backend=self.backend_name,
                success=False,
                error_message=f"Retrieval failed: {str(e)[:500]}",
            )

    def _selective_exact_terms(self, collection, collection_name: str, terms: list[str]) -> list[str]:
        """Keep the exact terms whose document frequency leaves them worth retrieving.

        One id-only ``collection.get`` per term measures it against the LIVE collection.
        "OIB is noise" is a property of this corpus rather than of German, so the
        frequency is measured and never listed (``german_text``'s module docstring
        states the rule this follows). For the ubiquitous term the measurement REPLACES
        the vector query that used to run, so the common case gets cheaper.

        The cache key is ``(collection, chunk count, term)``. The term set is tiny and
        stays stable while the corpus does, and a changed count invalidates it. An
        in-place edit leaving the count identical keeps the old frequency. That is
        acceptable for a noise heuristic, and it is why nothing downstream treats this
        as a correctness gate.

        It runs unlocked, unlike the caches beside it. Those keep an ordering list a
        race would corrupt; the worst a race costs here is measuring one term twice.
        Locking would hold the lock across a Chroma round trip and serialise the
        per-collection fan-out this retriever exists to run in parallel.

        Fails OPEN. An unmeasurable frequency keeps the term, so a Chroma that cannot
        answer ``get`` degrades to the previous behaviour instead of to no lexical
        channel at all.
        """
        from .hybrid import selective_terms

        try:
            total = collection.count()
        except Exception as e:  # noqa: BLE001 - selectivity is an optimisation, never a gate
            logger.warning("Exact-term frequencies unavailable (%s); keeping all terms", e)
            return terms

        frequencies: dict[str, int] = {}
        for term in terms:
            key = (collection_name, total, term)
            frequency = self._exact_term_df.get(key)
            if frequency is None:
                try:
                    matched = collection.get(where_document={"$contains": term}, include=[])
                    frequency = len(matched.get("ids") or [])
                except Exception as e:  # noqa: BLE001 - see the fail-open note above
                    logger.warning("Frequency of exact term %r unmeasurable (%s); keeping it", term, e)
                    frequencies[term] = 1
                    continue
                if len(self._exact_term_df) >= _EXACT_TERM_DF_CACHE_MAX:
                    self._exact_term_df.clear()
                self._exact_term_df[key] = frequency
            frequencies[term] = frequency

        return selective_terms(frequencies, total)

    def _hybrid_lexical_boost(
        self,
        query: str,
        collection_name: str,
        top_k: int,
        filters: dict[str, Any] | None,
        chunks: list[Chunk],
    ) -> list[Chunk]:
        """Run one Chroma ``$contains`` pass per exact query term and RRF-fuse with the vector results.

        The vector channel stays first so it wins ties. Any failure degrades to the plain
        vector results (fail-open): the lexical channel is an enhancement, never a gate.
        """
        try:
            from .hybrid import extract_exact_terms
            from .hybrid import reciprocal_rank_fusion

            terms = extract_exact_terms(query) if extract_exact_terms is not None else []

            embedding = self._embed_query_cached(query)
            collection = self._chroma_client.get_collection(name=collection_name)
            # Translate through the SAME grammar the vector channel uses. Passing the
            # backend-neutral dict straight to Chroma diverged on two shapes it rejects
            # but LlamaIndex accepts -- a node with sibling keys (an implicit AND) and a
            # single-element `$and`/`$or` group. Since the base collection always carries
            # the `exclude_file_names` clause, any caller filter with two keys made the
            # lexical pass raise, and the fail-open below turned hybrid off for exactly
            # the filtered queries, visible only in a log line.
            where = _to_chroma_where(filters)
            # A `$contains` pass is a FILTER over the dense ranking, so a term that is
            # on nearly every chunk hands the vector channel straight back and RRF then
            # counts that ranking twice -- demoting every chunk only the German sparse
            # channel found. Price the terms against the live collection first, the same
            # rule and the same constants the sparse channel has always used.
            if terms:
                terms = self._selective_exact_terms(collection, collection_name, terms)
            channels: list[list[Chunk]] = [chunks]
            for term in terms:
                raw = collection.query(
                    query_embeddings=[embedding],
                    n_results=top_k,
                    where_document={"$contains": term},
                    where=where,
                )
                channels.append(self._chunks_from_raw_query(raw))

            # German sparse channel: a real lexical index over the mirrored chunk text,
            # solving the inflection, Austrian-ß and umlaut cases Chroma's byte-level
            # `$contains` cannot. An EMPTY result is normal and means "no usable lexical
            # signal" -- the document-frequency ceiling fired, or the query is English --
            # never an error.
            try:
                from aiq_agent.common.query_expansion import expansion_terms
                from aiq_agent.knowledge.chunk_text_store import get_chunk_text_store

                lexical_ids = get_chunk_text_store().search(
                    collection_name, query, limit=top_k, extra_terms=expansion_terms(query)
                )
                if lexical_ids:
                    fetched = collection.get(
                        ids=lexical_ids, include=["documents", "metadatas", "embeddings"], where=where
                    )
                    fetched_ids = fetched.get("ids") or []
                    german_channel = self._chunks_from_raw_query(
                        {
                            "ids": [fetched_ids],
                            "documents": [fetched.get("documents") or []],
                            "metadatas": [fetched.get("metadatas") or []],
                            "distances": [_cosine_distances(embedding, fetched.get("embeddings"), len(fetched_ids))],
                        }
                    )
                    # Restore the store's ranking: `collection.get` does not preserve it,
                    # and RRF consumes rank position.
                    rank = {chunk_id: index for index, chunk_id in enumerate(lexical_ids)}
                    german_channel.sort(key=lambda chunk: rank.get(chunk.chunk_id, len(rank)))
                    channels.append(german_channel)
            except Exception as lexical_error:
                logger.warning("German sparse channel unavailable: %s", lexical_error)

            # Only the vector channel: nothing to fuse. This replaces the old early
            # return on `not terms`, which would have made the sparse channel dead for
            # the 71.7% of German questions that produce no exact term -- precisely the
            # population it exists to serve.
            if len(channels) == 1:
                return chunks

            fused = reciprocal_rank_fusion(channels, top_n=top_k)
            if fused:
                logger.info(
                    f"Hybrid retrieval fused {len(chunks)} vector + {len(terms)} lexical channel(s) "
                    f"into {len(fused)} chunks for collection {collection_name}"
                )
                return fused
            return chunks
        except Exception as e:
            logger.warning(f"Hybrid lexical boost failed, falling back to vector-only retrieval: {e}")
            return chunks

    def _chunks_from_raw_query(self, raw: dict[str, Any]) -> list[Chunk]:
        """Convert a raw Chroma ``collection.query`` result dict into normalized Chunks.

        The raw query returns per-query-embedding lists; we always send exactly one
        embedding, so each key's first list is the one we want. Cosine distances map to
        the store's own ``exp(-distance)`` scale, mirroring what the vector channel
        receives from ``ChromaVectorStore`` so the two channels stay comparable.

        Node reconstruction goes through ``metadata_dict_to_node`` -- the same helper
        the vector path uses -- rather than a hand-built ``TextNode``. That is not a
        tidiness preference: ``node_id`` is a read-only *property* over the ``id_``
        field, so ``TextNode(node_id=...)`` was silently discarded by pydantic and every
        lexical chunk was born with a fresh ``uuid4``. Since reciprocal rank fusion keys
        on ``chunk_id``, no chunk could ever match across the two channels: fusion
        degenerated into channel-major concatenation, the same passage was emitted twice
        under two different ids, and the duplicates displaced genuine vector hits. The
        helper also restores the clean node metadata instead of Chroma's raw row, which
        carries a full JSON copy of the chunk's own text in ``_node_content``.
        """
        from llama_index.core.schema import NodeWithScore
        from llama_index.core.schema import TextNode
        from llama_index.core.vector_stores.utils import metadata_dict_to_node

        ids = raw.get("ids", [[]])[0]
        documents = raw.get("documents", [[]])[0]
        metadatas = raw.get("metadatas", [[]])[0]
        distances = raw.get("distances", [[]])[0]

        nodes: list[NodeWithScore] = []
        for index, chunk_id in enumerate(ids):
            distance = distances[index] if index < len(distances) else 1.0
            metadata = metadatas[index] if index < len(metadatas) and metadatas[index] else {}
            text = documents[index] if index < len(documents) else ""
            try:
                node = metadata_dict_to_node(metadata, text=text)
            except Exception:
                # Rows written before `_node_content` existed, or by a non-llama-index
                # writer. `id_`, not `node_id` -- see the docstring.
                node = TextNode(text=text or "", id_=chunk_id, metadata=metadata)
            nodes.append(NodeWithScore(node=node, score=math.exp(-float(distance))))
        return [self.normalize(node) for node in nodes]

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
            elif content_type_str == "drawing":
                content_type = ContentType.DRAWING
            else:
                content_type = ContentType.TEXT

            # Create display citation based on content type
            if content_type == ContentType.TABLE:
                table_idx = metadata.get("table_index", 0)
                display_citation = f"{file_name}, p.{page_number}, Table {table_idx + 1}"
            elif content_type == ContentType.IMAGE:
                img_idx = metadata.get("image_index", 0)
                display_citation = f"{file_name}, p.{page_number}, Image {img_idx + 1}"
            elif content_type == ContentType.DRAWING:
                drawing_type = metadata.get("drawing_type", "Zeichnung")
                display_citation = f"{file_name}, p.{page_number}, {drawing_type}"
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
                score=cosine_similarity_from_store_score(score),
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
        # Shared server when AIQ_CHROMA_URL/HOST is set, else embedded.
        client = _make_chroma_client(persist_dir)
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
