"""Permit-record backfill for documents ingested before the permitting memory.

The ingest extracts a permit record from every document it types ``Bescheid``
(``knowledge_layer/llamaindex/adapter.py``, ``_remember_permit``). Documents already
ingested never pass that hook again, and the OIB sync is hash-gated, so their notices
would stay out of the memory. This reads each ``Bescheid`` of one collection back out
of the vector store, extracts its record and hands it to the BFF. It never re-ingests,
re-embeds or touches the summary or the tags. Idempotent: the BFF replaces a document's
record, so a second run rewrites the same rows.

    python scripts/backfill_permit_records.py --organization-id org_1 --collection proj_x \\
        --document-ids document_ids.json --dry-run
    python scripts/backfill_permit_records.py --organization-id org_1 --collection proj_x \\
        --document-ids document_ids.json
    python scripts/backfill_permit_records.py --organization-id org_1 --collection proj_x

DOCUMENT IDS
------------
The BFF addresses a record by ``documentId``, and the BFF's ``documents`` table is not
readable from here (ADR-0055). Neither the summaries nor the vector store carry that id.
``--document-ids`` is optional. It is a JSON object from file name to document id for the
collection, exported from the BFF, for example
``select json_object_agg(filename, id) from documents where collection_name = '...'``.
With it, each record is stored under its document id, and a ``Bescheid`` with no entry is
counted as failed. Without it, each record is stored by collection and file name, and the
BFF finds the document from those (a live file name is unique per collection). A
``--dry-run`` writes nothing.

TEXT SOURCE
-----------
The document's indexed chunks, ordered by ``page_label`` and joined under ``[Seite N]``
markers: the same shape the ingest hook reads.

LLM ACCESS
----------
The extraction model is the ingest's summary model, which no organization chooses, so it
is pinned to zero-data-retention endpoints (``openrouter.PLATFORM_FIXED``). Scripts run
outside NAT, so the chat model is built from the same env as ``backfill_document_tags.py``:

* ``BACKFILL_SUMMARY_API_KEY`` — falls back to the provider key inferred from the base URL.
* ``BACKFILL_SUMMARY_BASE_URL`` — default ``https://openrouter.ai/api/v1``.
* ``BACKFILL_SUMMARY_MODEL`` — default ``GRID_DEFAULT_MODEL``, then ``openai/gpt-6-luna``.

The BFF is reached through ``FRONTEND_INTERNAL_URL`` and ``GRID_INTERNAL_API_TOKEN``.
The summaries DB is ``AIQ_SUMMARY_DB`` (``--summary-db``), the Chroma directory
``AIQ_CHROMA_DIR`` (``--chroma-dir``).

EXIT CODES
----------
* ``0`` — a completed run with no failures, or any ``--dry-run``.
* ``1`` — a real run finished but at least one record failed to extract or store.
* ``2`` — the model could not be constructed (missing API key), or ``--document-ids``
  could not be read.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass

from aiq_agent.knowledge.permit_extraction import extract_permit_record
from aiq_agent.knowledge.permit_extraction import is_bescheid
from aiq_agent.knowledge.permit_extraction import llm_model_name
from aiq_agent.knowledge.permit_extraction import pages_with_markers
from aiq_agent.knowledge.schema import AvailableDocument

logger = logging.getLogger(__name__)

DEFAULT_SUMMARY_DB = os.environ.get("AIQ_SUMMARY_DB", "sqlite+aiosqlite:///./summaries.db")
DEFAULT_CHROMA_DIR = os.environ.get("AIQ_CHROMA_DIR", "/tmp/chroma_data")

# A document's indexed chunks as (page_label, text), in reading order; None when unavailable.
PageFetcher = Callable[[str, str], "list[tuple[str | None, str]] | None"]
# (organization_id, document_id | None, collection, file_name, model, record) -> stored
StoreFn = Callable[..., bool]


def build_extraction_llm():
    """The platform-fixed chat model the ingest's summary step uses, built outside NAT.

    Wrapped in the request contract (``enforce_chat_request_contract``), the seam
    where every chat call takes its provider slot (ADR-0081), so a backfill queues
    behind chat like any other model call.
    """
    from langchain_openai import ChatOpenAI

    from aiq_agent.common.credential_resolution import resolve_llm_credential
    from aiq_agent.common.llm_factory import apply_openrouter_structured_defaults
    from aiq_agent.common.llm_factory import enforce_chat_request_contract
    from aiq_agent.common.openrouter import PLATFORM_FIXED
    from aiq_agent.common.openrouter import pin_chat_model

    cred = resolve_llm_credential(
        primary_env="BACKFILL_SUMMARY_API_KEY",
        default_base_url="https://openrouter.ai/api/v1",
        default_model=os.environ.get("GRID_DEFAULT_MODEL", "openai/gpt-6-luna"),
        base_url_env="BACKFILL_SUMMARY_BASE_URL",
        model_env="BACKFILL_SUMMARY_MODEL",
        organization_id=None,
        data_policy=PLATFORM_FIXED,
    )
    if not cred.api_key:
        raise RuntimeError(
            "No API key: set BACKFILL_SUMMARY_API_KEY (or the provider key for "
            "BACKFILL_SUMMARY_BASE_URL) to the key for the summary model configured in configs/config_*.yml."
        )
    logger.info("Extraction LLM: model=%s base_url=%s", cred.model, cred.base_url)
    llm = ChatOpenAI(model=cred.model, api_key=cred.api_key, base_url=cred.base_url, temperature=0, timeout=120)
    return pin_chat_model(enforce_chat_request_contract(apply_openrouter_structured_defaults(llm)), PLATFORM_FIXED)


def _page_sort_key(item: tuple[str | None, str]) -> int:
    """Numeric page order; a chunk without a readable page label sorts first (Python sorts stably)."""
    try:
        return int(item[0] or 0)
    except ValueError:
        return 0


def make_page_fetcher(chroma_dir: str) -> PageFetcher | None:
    """A per-file fetcher of ``(page_label, chunk text)`` over the Chroma store, or None without one."""
    try:
        import chromadb
    except ImportError:
        logger.error("chromadb is not installed; there is no document text to read.")
        return None
    if not os.path.isdir(chroma_dir):
        logger.error("Chroma dir %s not found; there is no document text to read.", chroma_dir)
        return None
    try:
        client = chromadb.PersistentClient(path=chroma_dir)
    except Exception as e:  # noqa: BLE001 - reported once, as no source
        logger.error("Could not open Chroma at %s (%s)", chroma_dir, e)
        return None

    def fetch(collection: str, file_name: str) -> list[tuple[str | None, str]] | None:
        try:
            result = client.get_collection(name=collection).get(
                where={"file_name": file_name}, include=["documents", "metadatas"]
            )
        except Exception:  # noqa: BLE001 - a missing collection or file is a per-document failure
            return None
        documents = (result or {}).get("documents") or []
        metadatas = (result or {}).get("metadatas") or [None] * len(documents)
        pages = [
            ((meta or {}).get("page_label"), text) for text, meta in zip(documents, metadatas, strict=False) if text
        ]
        return sorted(pages, key=_page_sort_key) or None

    return fetch


STORED = "stored"
NO_RECORD = "no_record"
SKIPPED = "skipped"
FAILED = "failed"


@dataclass
class BackfillStats:
    processed: int = 0
    stored: int = 0
    no_record: int = 0
    skipped: int = 0
    failed: int = 0

    def record(self, outcome: str) -> None:
        self.processed += 1
        setattr(self, outcome, getattr(self, outcome) + 1)


def process_row(
    organization_id: str,
    collection: str,
    doc: AvailableDocument,
    *,
    llm,
    store_fn: StoreFn,
    page_fetcher: PageFetcher,
    document_ids: dict[str, str],
    dry_run: bool = False,
) -> str:
    """Backfill one document's permit record. Returns STORED, NO_RECORD, SKIPPED or FAILED.

    A document the tags do not call a Bescheid is skipped. Everything else is fail-soft
    per document: it is logged and counted, and never aborts the batch. ``--dry-run``
    extracts, to preview, and writes nothing. An empty ``document_ids`` means no
    ``--document-ids`` was given: the record is stored by file name, with no id.
    """
    file_name = doc.file_name
    if not is_bescheid(doc.tags):
        return SKIPPED
    document_id = document_ids.get(file_name) or None
    if document_ids and document_id is None and not dry_run:
        logger.warning("[fail] %s/%s has no entry in --document-ids", collection, file_name)
        return FAILED
    pages = page_fetcher(collection, file_name)
    if not pages:
        logger.warning("[fail] %s/%s has no indexed text", collection, file_name)
        return FAILED
    try:
        record = extract_permit_record(pages_with_markers(pages), llm, file_name=file_name)
    except Exception as e:  # noqa: BLE001 - extract_permit_record is fail-open, but guard the batch
        logger.warning("[fail] %s/%s extraction error: %s", collection, file_name, e)
        return FAILED
    if record is None:
        logger.warning("[no record] %s/%s: the model found no notice, or its call failed", collection, file_name)
        return NO_RECORD
    if dry_run:
        logger.info(
            "[dry-run] %s/%s -> %s, %s, %d requirement(s)",
            collection,
            file_name,
            record.kind,
            record.authority,
            len(record.requirements),
        )
        return STORED
    if not store_fn(organization_id, document_id, collection, file_name, llm_model_name(llm), record):
        logger.warning("[fail] %s/%s the BFF did not store the record", collection, file_name)
        return FAILED
    logger.info("[stored] %s/%s -> %s, %d requirement(s)", collection, file_name, record.kind, len(record.requirements))
    return STORED


def run_backfill(
    *,
    organization_id: str,
    collection: str,
    documents: list[AvailableDocument],
    llm,
    store_fn: StoreFn,
    page_fetcher: PageFetcher,
    document_ids: dict[str, str],
    dry_run: bool = False,
) -> BackfillStats:
    """Backfill every document of one collection."""
    stats = BackfillStats()
    for doc in documents:
        stats.record(
            process_row(
                organization_id,
                collection,
                doc,
                llm=llm,
                store_fn=store_fn,
                page_fetcher=page_fetcher,
                document_ids=document_ids,
                dry_run=dry_run,
            )
        )
    return stats


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--organization-id", required=True, help="The organization the collection belongs to.")
    parser.add_argument("--collection", required=True, help="The collection (a project's, or a restricted folder's).")
    parser.add_argument(
        "--document-ids",
        default=None,
        help=(
            "Optional JSON object from file name to document id for the collection. Without it, records "
            "are stored by collection and file name (see the module docstring)."
        ),
    )
    parser.add_argument("--dry-run", action="store_true", help="Extract and print, but write nothing.")
    parser.add_argument("--summary-db", default=DEFAULT_SUMMARY_DB, help="Summaries DB URL (default: $AIQ_SUMMARY_DB).")
    parser.add_argument(
        "--chroma-dir", default=DEFAULT_CHROMA_DIR, help="Chroma persistence dir (default: $AIQ_CHROMA_DIR)."
    )
    return parser.parse_args(argv)


def _load_document_ids(path: str | None) -> dict[str, str] | None:
    """The file-name to document-id map, ``{}`` when none was given, None when unreadable."""
    if not path:
        return {}
    try:
        with open(path, encoding="utf-8") as handle:
            loaded = json.load(handle)
    except (OSError, ValueError) as e:
        logger.error("Could not read --document-ids %s: %s", path, e)
        return None
    if not isinstance(loaded, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in loaded.items()):
        logger.error("--document-ids %s must be a JSON object of file name to document id", path)
        return None
    return loaded


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s - %(levelname)-8s - %(name)s - %(message)s", stream=sys.stdout
    )
    args = _parse_args(argv)

    from aiq_agent.knowledge import configure_summary_db
    from aiq_agent.knowledge import get_available_documents
    from aiq_agent.knowledge.permit_records_client import store_permit_record

    document_ids = _load_document_ids(args.document_ids)
    if document_ids is None:
        return 2

    configure_summary_db(args.summary_db)
    documents = get_available_documents(args.collection)
    logger.info("Collection %s: %d document(s)", args.collection, len(documents))
    if not any(is_bescheid(doc.tags) for doc in documents):
        return 0

    page_fetcher = make_page_fetcher(args.chroma_dir)
    if page_fetcher is None:
        return 2
    try:
        llm = build_extraction_llm()
    except RuntimeError as e:
        logger.error("%s", e)
        return 2

    stats = run_backfill(
        organization_id=args.organization_id,
        collection=args.collection,
        documents=documents,
        llm=llm,
        store_fn=store_permit_record,
        page_fetcher=page_fetcher,
        document_ids=document_ids,
        dry_run=args.dry_run,
    )
    logger.info(
        "Backfill complete: processed=%d %s=%d no_record=%d skipped=%d failed=%d",
        stats.processed,
        "would_store" if args.dry_run else "stored",
        stats.stored,
        stats.no_record,
        stats.skipped,
        stats.failed,
    )
    return 1 if not args.dry_run and stats.failed > 0 else 0


if __name__ == "__main__":
    raise SystemExit(main())
