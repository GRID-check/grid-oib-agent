"""Carry the base corpus from a pre-ADR-0082-A2 data volume into the corpus store, once.

Before A2 the base corpus lived on the backend's own disk: operator PDFs in
``oib/`` (with deletions recorded in ``oib_excluded.json``) and admin uploads in
``oib_uploads/``, all under ``/app/data``. A2 moved it to object storage and the
``oib_corpus_files`` table, and the backend keeps no volume any more. This reads
an old data directory, mounted read-only, and stores every PDF the old corpus
held through :func:`corpus_store.put`, the path an admin upload takes. The
base-corpus housekeeping cycle then queues their ingestion.

It runs as a one-shot Job (Kubernetes) or service (Compose) on the first deploy
of A2 and is safe to run again: a file already stored with the same bytes is
skipped. Once every environment has run it, delete this module, its Job, its
Compose service and the ``legacyCorpusClaim`` stack key together.

    python -m aiq_agent.legacy_corpus_import /legacy               # Kubernetes: the old volume
    python -m aiq_agent.legacy_corpus_import /legacy/data /legacy/oib  # Compose: the volume and the host's data/oib

Compose bind-mounted the operator PDFs from the host over ``/app/data/oib``, so
there they live beside the volume rather than in it; the second argument names
that directory.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sys
from pathlib import Path

from aiq_agent import corpus_store

logger = logging.getLogger(__name__)


def legacy_pdfs(root: Path, operator_dir: Path | None = None) -> dict[str, Path]:
    """The old corpus by file name: the operator PDFs not excluded, then the uploads.

    The old ``discover_pdfs`` let an upload stand for a name the exclusions
    named, and listed the upload after the operator file of the same name, so
    an upload wins here too.
    """
    excluded_path = root / "oib_excluded.json"
    excluded = set(json.loads(excluded_path.read_text(encoding="utf-8"))) if excluded_path.is_file() else set()
    found: dict[str, Path] = {}
    for directory, honour_exclusions in ((operator_dir or root / "oib", True), (root / "oib_uploads", False)):
        if not directory.is_dir():
            continue
        for pdf in sorted(directory.glob("*.pdf")):
            if honour_exclusions and pdf.name in excluded:
                continue
            found[pdf.name] = pdf
    return found


def import_legacy_corpus(root: Path, operator_dir: Path | None = None) -> dict[str, int]:
    """Store every legacy PDF the corpus does not already hold with the same bytes."""
    counts = {"stored": 0, "unchanged": 0, "skipped": 0, "failed": 0}
    for name, pdf in legacy_pdfs(root, operator_dir).items():
        if not corpus_store.is_valid_name(name):
            logger.warning("Skipping %s: not a corpus file name", name)
            counts["skipped"] += 1
            continue
        data = pdf.read_bytes()
        existing = corpus_store.get_file(name)
        if existing is not None and existing.sha256 == hashlib.sha256(data).hexdigest():
            counts["unchanged"] += 1
            continue
        try:
            corpus_store.put(name, data)
        except corpus_store.CorpusStoreError as e:
            logger.error("Could not store %s: %s", name, e)
            counts["failed"] += 1
            continue
        counts["stored"] += 1
    return counts


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) not in (1, 2):
        print("usage: python -m aiq_agent.legacy_corpus_import <old /app/data> [operator oib dir]", file=sys.stderr)
        return 2
    logging.basicConfig(level=logging.INFO)
    counts = import_legacy_corpus(Path(args[0]), Path(args[1]) if len(args) == 2 else None)
    print(f"[legacy-corpus-import] {json.dumps(counts, sort_keys=True)}", flush=True)
    # A failed store is worth the Job's retry: everything stored is skipped next time.
    return 1 if counts["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
