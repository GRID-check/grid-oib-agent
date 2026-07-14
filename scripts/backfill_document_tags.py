"""Classify-only tag backfill for already-ingested documents.

Documents ingested BEFORE the tag-classification feature (FB-8, cycle 7) have a
persisted one-sentence summary but ``tags=NULL``. OIB sync is hash-gated (a
document already ingested is never re-processed), so those rows would never pick
up tags on their own. This script regenerates ONLY the tags for such rows — it
never re-ingests, re-embeds, or touches the summary.

Run it once after deploying the tagging feature, then never again (idempotent:
rows that already have tags are skipped unless ``--force``).

    python scripts/backfill_document_tags.py --dry-run          # preview
    python scripts/backfill_document_tags.py                    # all collections
    python scripts/backfill_document_tags.py --collection oib_knowledge
    python scripts/backfill_document_tags.py --force            # re-tag everything

TEXT SOURCE
-----------
Tags are classified from the best available text for each document:

1. Preferred — the document's already-indexed chunk text. The LlamaIndex/Chroma
   backend exposes a cheap per-file fetch
   (``collection.get(where={"file_name": ...}, include=["documents"])``), so the
   first few chunks are concatenated up to
   :data:`document_classification.CLASSIFY_MAX_INPUT_CHARS`. This is the same
   text ingestion classifies from, so a backfilled tag set matches what a fresh
   ingest would have produced.
2. Fallback — the stored SUMMARY text, always present on every row (the
   ``summary`` column is NOT NULL). Used whenever the chunk fetch is
   unavailable: a non-LlamaIndex/Chroma deployment, a missing/empty chroma dir,
   a collection or file not found in Chroma, or any fetch error. Classifying
   from the one-sentence summary is a lower-fidelity but ACCEPTABLE source per
   FB-8.

LLM ACCESS
----------
The summary/tagging LLM is only constructible inside the NAT runtime (resolved
from the ``llms:`` config section during function registration). Scripts run
outside NAT, so this builds an OpenAI-compatible client directly from env vars
that MUST match the config's ``summary_llm`` settings (see the ``summary_llm``
block in ``configs/config_*.yml`` — ``_type: nim`` is OpenAI-compatible):

* ``BACKFILL_SUMMARY_API_KEY`` — required (falls back to ``NVIDIA_API_KEY``,
  which is what the ``summary_llm`` block references).
* ``BACKFILL_SUMMARY_BASE_URL`` — default ``https://integrate.api.nvidia.com/v1``.
* ``BACKFILL_SUMMARY_MODEL`` — default ``nvidia/nemotron-mini-4b-instruct``.

STORE ACCESS
------------
The summaries DB is taken from ``AIQ_SUMMARY_DB`` (same env var the deployment
sets, default ``sqlite+aiosqlite:///./summaries.db``), overridable with
``--summary-db``. The Chroma directory is ``AIQ_CHROMA_DIR`` (default
``/tmp/chroma_data``), overridable with ``--chroma-dir``.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass

from aiq_agent.knowledge.document_classification import CLASSIFY_MAX_INPUT_CHARS
from aiq_agent.knowledge.document_classification import classify_document_tags
from aiq_agent.knowledge.schema import AvailableDocument

logger = logging.getLogger(__name__)

DEFAULT_SUMMARY_DB = os.environ.get("AIQ_SUMMARY_DB", "sqlite+aiosqlite:///./summaries.db")
DEFAULT_CHROMA_DIR = os.environ.get("AIQ_CHROMA_DIR", "/tmp/chroma_data")

# Type alias: fetch representative chunk text for a document, or None if the
# indexed text is unavailable (caller then falls back to the summary).
ChunkTextFetcher = Callable[[str, str], "str | None"]


# =============================================================================
# LLM access (OpenAI-compatible client from env — see module docstring)
# =============================================================================


class _LLMResponse:
    """Minimal ``.content`` carrier so the shared classifier stays LLM-agnostic."""

    def __init__(self, content: str) -> None:
        self.content = content


class _OpenAICompatLLM:
    """Adapts an OpenAI-compatible chat client to the ``.invoke``/``.content``
    shape the shared ``classify_document_tags`` helper expects."""

    def __init__(self, client, model: str) -> None:
        self._client = client
        self._model = model

    def invoke(self, prompt: str) -> _LLMResponse:
        response = self._client.chat.completions.create(
            model=self._model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.3,
            max_tokens=200,
        )
        return _LLMResponse(response.choices[0].message.content or "")


def build_summary_llm() -> _OpenAICompatLLM:
    """Construct the OpenAI-compatible tagging LLM from env (see module docstring)."""
    from openai import OpenAI

    api_key = os.environ.get("BACKFILL_SUMMARY_API_KEY") or os.environ.get("NVIDIA_API_KEY")
    if not api_key:
        raise RuntimeError(
            "No API key: set BACKFILL_SUMMARY_API_KEY (or NVIDIA_API_KEY) to the "
            "key for the summary model configured in configs/config_*.yml."
        )
    base_url = os.environ.get("BACKFILL_SUMMARY_BASE_URL", "https://integrate.api.nvidia.com/v1")
    model = os.environ.get("BACKFILL_SUMMARY_MODEL", "nvidia/nemotron-mini-4b-instruct")
    logger.info("Tagging LLM: model=%s base_url=%s", model, base_url)
    return _OpenAICompatLLM(OpenAI(base_url=base_url, api_key=api_key), model)


# =============================================================================
# Chunk-text fetch (preferred text source; Chroma per-file get)
# =============================================================================


def make_chunk_text_fetcher(chroma_dir: str) -> ChunkTextFetcher | None:
    """Build a best-effort per-file chunk-text fetcher over the Chroma store.

    Returns ``None`` (so callers fall back to summaries throughout) when Chroma
    is unavailable — the package is not installed, or the directory cannot be
    opened. The returned callable is itself fail-soft per document.
    """
    try:
        import chromadb
    except ImportError:
        logger.info("chromadb not installed; classifying from stored summaries only.")
        return None

    if not os.path.isdir(chroma_dir):
        logger.info("Chroma dir %s not found; classifying from stored summaries only.", chroma_dir)
        return None

    try:
        client = chromadb.PersistentClient(path=chroma_dir)
    except Exception as e:  # noqa: BLE001 - fail soft to summary source
        logger.warning("Could not open Chroma at %s (%s); using stored summaries.", chroma_dir, e)
        return None

    def fetch(collection: str, file_name: str) -> str | None:
        try:
            col = client.get_collection(name=collection)
        except Exception:
            return None
        try:
            result = col.get(where={"file_name": file_name}, include=["documents"])
        except Exception:
            return None
        documents = (result or {}).get("documents") or []
        if not documents:
            return None
        parts: list[str] = []
        total = 0
        for chunk in documents:
            if not chunk:
                continue
            parts.append(chunk)
            total += len(chunk)
            if total >= CLASSIFY_MAX_INPUT_CHARS:
                break
        text = "\n\n".join(parts).strip()
        return text[:CLASSIFY_MAX_INPUT_CHARS] or None

    return fetch


# =============================================================================
# Per-row logic (testable core)
# =============================================================================

# Outcome labels for a single row.
TAGGED = "tagged"
SKIPPED = "skipped"
FAILED = "failed"


@dataclass
class BackfillStats:
    processed: int = 0
    tagged: int = 0
    skipped: int = 0
    failed: int = 0

    def record(self, outcome: str) -> None:
        self.processed += 1
        if outcome == TAGGED:
            self.tagged += 1
        elif outcome == SKIPPED:
            self.skipped += 1
        elif outcome == FAILED:
            self.failed += 1


def process_row(
    collection: str,
    doc: AvailableDocument,
    *,
    llm,
    update_fn: Callable[[str, str, list[str]], bool],
    text_fetcher: ChunkTextFetcher | None = None,
    force: bool = False,
    dry_run: bool = False,
) -> str:
    """Backfill tags for one summary row. Returns one of TAGGED/SKIPPED/FAILED.

    Fail-soft: any per-row problem (no text, classification failure, store
    write returning no rows) is logged and counted as FAILED — it never aborts
    the batch. Rows with existing tags are SKIPPED unless ``force`` is set. In
    ``dry_run`` mode the classification still runs (to preview the result) but
    nothing is written.
    """
    file_name = doc.file_name

    if doc.tags and not force:
        logger.debug("[skip] %s/%s already tagged: %s", collection, file_name, doc.tags)
        return SKIPPED

    # Preferred: indexed chunk text; fallback: the always-present summary.
    text = None
    if text_fetcher is not None:
        text = text_fetcher(collection, file_name)
    source = "chunks"
    if not text:
        text = doc.summary
        source = "summary"
    if not text:
        # summary is NOT NULL, so this is unexpected — guard anyway.
        logger.warning("[fail] %s/%s has no text to classify", collection, file_name)
        return FAILED

    try:
        tags = classify_document_tags(text, file_name, llm)
    except Exception as e:  # noqa: BLE001 - classify_document_tags is fail-open, but guard the batch
        logger.warning("[fail] %s/%s classification error: %s", collection, file_name, e)
        return FAILED

    if not tags:
        logger.warning("[fail] %s/%s produced no tags (source=%s)", collection, file_name, source)
        return FAILED

    if dry_run:
        logger.info("[dry-run] %s/%s -> %s (source=%s)", collection, file_name, tags, source)
        return TAGGED

    if not update_fn(collection, file_name, tags):
        logger.warning("[fail] %s/%s store update matched no row", collection, file_name)
        return FAILED

    logger.info("[tagged] %s/%s -> %s (source=%s)", collection, file_name, tags, source)
    return TAGGED


# =============================================================================
# Batch driver
# =============================================================================


def run_backfill(
    *,
    collections: list[str],
    get_documents: Callable[[str], list[AvailableDocument]],
    update_fn: Callable[[str, str, list[str]], bool],
    llm,
    text_fetcher: ChunkTextFetcher | None = None,
    force: bool = False,
    dry_run: bool = False,
) -> BackfillStats:
    """Backfill tags across the given collections, batch-friendly logging."""
    stats = BackfillStats()
    for collection in collections:
        docs = get_documents(collection)
        logger.info("Collection %s: %d document(s)", collection, len(docs))
        for doc in docs:
            outcome = process_row(
                collection,
                doc,
                llm=llm,
                update_fn=update_fn,
                text_fetcher=text_fetcher,
                force=force,
                dry_run=dry_run,
            )
            stats.record(outcome)
        logger.info(
            "Collection %s done: processed=%d tagged=%d skipped=%d failed=%d",
            collection,
            stats.processed,
            stats.tagged,
            stats.skipped,
            stats.failed,
        )
    return stats


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument(
        "--collection",
        default=None,
        help="Only backfill this collection (default: every collection with summaries).",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-classify and overwrite tags even for rows that already have them.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Classify and print what would change, but write nothing.",
    )
    parser.add_argument(
        "--summary-db",
        default=DEFAULT_SUMMARY_DB,
        help="Summaries DB URL (default: $AIQ_SUMMARY_DB or sqlite+aiosqlite:///./summaries.db).",
    )
    parser.add_argument(
        "--chroma-dir",
        default=DEFAULT_CHROMA_DIR,
        help="Chroma persistence dir for the preferred chunk-text source (default: $AIQ_CHROMA_DIR).",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)-8s - %(name)s - %(message)s",
        stream=sys.stdout,
    )
    args = _parse_args(argv)

    from aiq_agent.knowledge import configure_summary_db
    from aiq_agent.knowledge import get_available_documents
    from aiq_agent.knowledge import list_summary_collections
    from aiq_agent.knowledge import update_document_tags

    configure_summary_db(args.summary_db)

    if args.collection:
        collections = [args.collection]
    else:
        collections = list_summary_collections()
    if not collections:
        logger.info("No collections with summaries found. Nothing to do.")
        return 0
    logger.info("Backfilling tags for %d collection(s): %s", len(collections), ", ".join(collections))

    try:
        llm = build_summary_llm()
    except RuntimeError as e:
        logger.error("%s", e)
        return 2

    text_fetcher = make_chunk_text_fetcher(args.chroma_dir)

    stats = run_backfill(
        collections=collections,
        get_documents=get_available_documents,
        update_fn=update_document_tags,
        llm=llm,
        text_fetcher=text_fetcher,
        force=args.force,
        dry_run=args.dry_run,
    )

    verb = "would tag" if args.dry_run else "tagged"
    logger.info(
        "Backfill complete: processed=%d %s=%d skipped=%d failed=%d",
        stats.processed,
        verb,
        stats.tagged,
        stats.skipped,
        stats.failed,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
