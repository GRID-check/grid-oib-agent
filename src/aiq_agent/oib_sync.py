# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Incremental ingestion of OIB Richtlinien PDFs into the oib_knowledge collection.

Uses the canonical, blocking knowledge-layer ingestion path: each new or changed
PDF is uploaded via the ingestor and its file status is polled until it reaches a
terminal state. Only files that ingest successfully have their SHA-256 hash recorded
in the registry, so failures (or timeouts) are automatically retried on the next run.
"""

import hashlib
import json
import logging
import os
import time
from pathlib import Path

# Import the LlamaIndex adapter eagerly so the ingestor backend is registered
# with the factory before we ask for it.
import knowledge_layer.llamaindex.adapter  # noqa: F401

from aiq_agent.knowledge.factory import get_ingestor
from aiq_agent.knowledge.schema import FileStatus

logger = logging.getLogger(__name__)

OIB_DIR = Path(os.environ.get("OIB_DOCUMENTS_DIR", "data/oib"))
REGISTRY_PATH = Path(os.environ.get("OIB_REGISTRY_PATH", "data/oib_registry.json"))
COLLECTION_NAME = os.environ.get("OIB_COLLECTION_NAME", "oib_knowledge")
CHROMA_DIR = os.environ.get("AIQ_CHROMA_DIR", "/tmp/chroma_data")

# Polling configuration for blocking file-status checks.
_POLL_INTERVAL_SECONDS = 2.0
_POLL_TIMEOUT_SECONDS = 600.0
_TERMINAL_STATUSES = (FileStatus.SUCCESS, FileStatus.FAILED)


def _file_hash(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def _load_registry() -> dict[str, str]:
    if REGISTRY_PATH.exists():
        return json.loads(REGISTRY_PATH.read_text(encoding="utf-8"))
    return {}


def _save_registry(registry: dict[str, str]) -> None:
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    REGISTRY_PATH.write_text(json.dumps(registry, indent=2, sort_keys=True), encoding="utf-8")


def _ensure_collection(ingestor) -> None:
    """Create the OIB collection if it does not already exist (idempotent)."""
    if ingestor.get_collection(COLLECTION_NAME) is not None:
        logger.info("Collection %s already exists", COLLECTION_NAME)
        return

    try:
        ingestor.create_collection(
            COLLECTION_NAME,
            description="Persistent OIB Richtlinien knowledge base.",
        )
        logger.info("Created collection %s", COLLECTION_NAME)
    except Exception as e:
        # The LlamaIndex adapter uses get_or_create_collection and will not raise on
        # an existing collection, but guard against backends that do. Only swallow the
        # error if the collection actually exists now.
        if ingestor.get_collection(COLLECTION_NAME) is None:
            raise
        logger.info("Collection %s already exists (create raised: %s)", COLLECTION_NAME, e)


def _wait_for_file(ingestor, file_id: str) -> FileStatus:
    """Poll get_file_status until it reaches a terminal state or times out.

    Returns the terminal FileStatus. On timeout, returns FileStatus.FAILED so the
    caller leaves the registry untouched and retries on the next run.
    """
    deadline = time.monotonic() + _POLL_TIMEOUT_SECONDS
    last_status: FileStatus | None = None

    while True:
        file_info = ingestor.get_file_status(file_id, COLLECTION_NAME)
        last_status = file_info.status if file_info else None

        if last_status in _TERMINAL_STATUSES:
            return last_status

        if time.monotonic() >= deadline:
            logger.error(
                "Timed out after %.0fs waiting for file %s (last status: %s)",
                _POLL_TIMEOUT_SECONDS,
                file_id,
                last_status,
            )
            return FileStatus.FAILED

        time.sleep(_POLL_INTERVAL_SECONDS)


def sync() -> tuple[int, int]:
    """Incrementally ingest new/changed OIB PDFs into the persistent collection.

    Returns:
        Tuple of (num_succeeded, num_total_tracked) where num_succeeded is the
        number of files that ingested successfully this run and num_total_tracked
        is the total number of OIB PDFs discovered on disk.
    """
    if not OIB_DIR.exists():
        raise FileNotFoundError(f"OIB directory not found: {OIB_DIR}")

    pdf_paths = sorted(p for p in OIB_DIR.rglob("*.pdf") if p.is_file())
    if not pdf_paths:
        logger.warning("No PDF files found in %s", OIB_DIR)
        return 0, 0

    registry = _load_registry()
    new_or_changed: list[tuple[Path, str]] = []

    for pdf in pdf_paths:
        current_hash = _file_hash(pdf)
        if registry.get(str(pdf)) != current_hash:
            new_or_changed.append((pdf, current_hash))

    if not new_or_changed:
        logger.info("No new or changed OIB PDFs. Skipping ingestion.")
        return 0, len(pdf_paths)

    ingestor = get_ingestor("llamaindex", {"persist_dir": CHROMA_DIR})
    _ensure_collection(ingestor)

    succeeded = 0
    for pdf, current_hash in new_or_changed:
        logger.info("Ingesting %s", pdf)
        file_info = ingestor.upload_file(str(pdf), COLLECTION_NAME)

        status = _wait_for_file(ingestor, file_info.file_id)
        if status == FileStatus.SUCCESS:
            registry[str(pdf)] = current_hash
            _save_registry(registry)
            succeeded += 1
            logger.info("Ingested %s (file_id=%s)", pdf.name, file_info.file_id)
        else:
            logger.error(
                "Ingestion failed for %s (status=%s); registry not updated, will retry next run",
                pdf.name,
                status,
            )

    logger.info(
        "OIB sync complete: %d/%d new-or-changed file(s) succeeded; %d total file(s) tracked",
        succeeded,
        len(new_or_changed),
        len(pdf_paths),
    )
    return succeeded, len(pdf_paths)
