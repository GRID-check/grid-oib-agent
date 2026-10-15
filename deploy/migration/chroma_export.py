#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["chromadb==1.5.9"]
# ///
"""Export every Chroma collection, vectors included, to the neutral format ``piloti-vectors/1``.

The one place Chroma code still runs (ADR-0113). The product no longer
depends on ``chromadb``: this script carries its own pin (the inline metadata
above, which must match the Chroma server that wrote the data) and runs in a
throwaway environment, never in the backend image. The importer
(``scripts/import_vectors.py``) reads what it writes and knows nothing about
Chroma. The format is specified in ``deploy/migration/README.md``.

    # Against a persist directory (mounted read-only is fine: it is copied first)
    uv run --script deploy/migration/chroma_export.py --persist-dir /chroma --out /exchange/export
    # Against a running Chroma server
    uv run --script deploy/migration/chroma_export.py --url http://chroma:8000 --out /exchange/export

Stop every writer first (ingest workers, uploads): the export is a snapshot,
and a collection whose count changes while it is read fails the run.

Re-running overwrites the export. ``manifest.json`` is written last and only
on success, so an export without one is incomplete and the importer refuses it.

Standard library plus ``chromadb`` only: it must run with nothing of this
repository installed.

EXIT CODES: ``0`` exported; ``1`` a collection failed or changed while it was
read; ``2`` Chroma could not be opened or the arguments are invalid.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import gzip
import hashlib
import json
import logging
import os
import re
import shutil
import sys
import tempfile
from array import array
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import chromadb

FORMAT = "piloti-vectors/1"
DEFAULT_BATCH = 1000
INCLUDE = ["embeddings", "documents", "metadatas"]
#: Chroma's own rule for a collection name; anything else would not be a safe directory name.
COLLECTION_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{1,510}[A-Za-z0-9]$")

logger = logging.getLogger("chroma_export")


class ExportError(RuntimeError):
    """One collection could not be exported as a consistent snapshot."""


def encode_embedding(values: Any) -> str:
    """A vector as base64 of little-endian float32, whatever Chroma returned it as (ndarray or list)."""
    if hasattr(values, "astype"):
        raw = values.astype("<f4").tobytes()
    else:
        floats = array("f", [float(value) for value in values])
        if sys.byteorder == "big":
            floats.byteswap()
        raw = floats.tobytes()
    return base64.b64encode(raw).decode("ascii")


def add_to_digest(digest: int, chunk_id: str) -> int:
    """Fold one id into the order-independent digest: the sum of every id's SHA-256, mod 2**256."""
    return (digest + int.from_bytes(hashlib.sha256(chunk_id.encode("utf-8")).digest(), "big")) % (1 << 256)


def format_digest(digest: int) -> str:
    return f"sha256-sum:{digest:064x}"


def _json_value(value: Any) -> Any:
    """``json.dumps`` fallback for numpy scalars and arrays in metadata; anything else is an error."""
    if hasattr(value, "tolist"):
        return value.tolist()
    if hasattr(value, "item"):
        return value.item()
    raise TypeError(f"metadata value {value!r} of type {type(value).__name__} is not JSON")


def _pages(collection: Any, batch: int) -> Iterator[dict[str, Any]]:
    """The collection in pages of ``batch``, by offset: stable while nothing writes."""
    offset = 0
    while True:
        page = collection.get(include=INCLUDE, limit=batch, offset=offset)
        ids = list(page.get("ids") or [])
        if not ids:
            return
        yield page
        offset += len(ids)
        if len(ids) < batch:
            return


def _column(page: dict[str, Any], key: str, size: int) -> list[Any]:
    values = page.get(key)
    values = list(values) if values is not None else []
    return values + [None] * (size - len(values))


def _write_batch(path: Path, lines: list[str]) -> None:
    """One gzip file, written beside its final name and renamed, with mtime 0 so equal data gives equal bytes."""
    partial = path.with_name(path.name + ".partial")
    with partial.open("wb") as raw, gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as out:
        out.write("".join(lines).encode("utf-8"))
    os.replace(partial, path)


def export_collection(collection: Any, target: Path, batch: int) -> dict[str, Any]:
    """Write one collection's batches under ``target``; returns its manifest entry."""
    expected = int(collection.count())
    target.mkdir(parents=True)
    digest, written, files, dimension = 0, 0, 0, None
    for page in _pages(collection, batch):
        ids = [str(chunk_id) for chunk_id in page["ids"]]
        embeddings = _column(page, "embeddings", len(ids))
        documents = _column(page, "documents", len(ids))
        metadatas = _column(page, "metadatas", len(ids))
        lines = []
        for chunk_id, embedding, document, metadata in zip(ids, embeddings, documents, metadatas, strict=True):
            if embedding is None:
                raise ExportError(f"chunk {chunk_id} has no embedding")
            if dimension is None:
                dimension = len(embedding)
            elif len(embedding) != dimension:
                raise ExportError(f"chunk {chunk_id} has {len(embedding)} dimensions, the collection {dimension}")
            record = {
                "id": chunk_id,
                "embedding": encode_embedding(embedding),
                "document": document or "",
                "metadata": dict(metadata or {}),
            }
            lines.append(json.dumps(record, ensure_ascii=False, default=_json_value) + "\n")
            digest = add_to_digest(digest, chunk_id)
        _write_batch(target / f"{files:06d}.jsonl.gz", lines)
        files += 1
        written += len(ids)
    now = int(collection.count())
    if written != expected or now != expected:
        raise ExportError(
            f"read {written} chunks of {expected} (now {now}): the collection changed while it was read; "
            "stop every writer and run the export again"
        )
    return {
        "count": written,
        "dimension": dimension,
        "batches": files,
        "metadata": dict(collection.metadata or {}),
        "id_digest": format_digest(digest),
    }


def _collection_names(client: Any) -> list[str]:
    names = [entry if isinstance(entry, str) else getattr(entry, "name", None) for entry in client.list_collections()]
    return sorted(name for name in names if name)


def _http_client(url: str):
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError(f"--url must be http(s)://host[:port], not {url!r}")
    ssl = parsed.scheme == "https"
    return chromadb.HttpClient(host=parsed.hostname, port=parsed.port or (443 if ssl else 8000), ssl=ssl)


def _persistent_client(persist_dir: Path, scratch: Path):
    """A client on a COPY of ``persist_dir``: Chroma cannot open a read-only directory and must not alter the source."""
    if not (persist_dir / "chroma.sqlite3").is_file():
        raise ValueError(f"{persist_dir} holds no chroma.sqlite3: not a Chroma persist directory")
    copy = scratch / "chroma"
    logger.info("Copying %s to %s (Chroma opens a database read-write)", persist_dir, copy)
    shutil.copytree(persist_dir, copy)
    return chromadb.PersistentClient(path=str(copy))


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--persist-dir", type=Path, help="A Chroma persist directory (copied before it is opened).")
    source.add_argument("--url", help="A running Chroma server, http(s)://host[:port].")
    parser.add_argument("--out", type=Path, required=True, help="The export directory; its contents are replaced.")
    parser.add_argument("--collection", action="append", help="Only this collection (repeatable).")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH, help="Records per page and per file.")
    parser.add_argument(
        "--scratch", type=Path, help="Where the persist directory is copied (default: beside --out). Needs its size."
    )
    args = parser.parse_args(argv)
    if args.batch_size < 1:
        parser.error("--batch-size must be at least 1")
    return args


def _open(args: argparse.Namespace, scratch: Path) -> tuple[Any, dict[str, str]]:
    if args.url:
        client = _http_client(args.url)
        # What the server reports, which is not its release: the 1.5.9 image answers "1.0.0".
        return client, {"mode": "http", "location": args.url, "server_version": str(client.get_version())}
    client = _persistent_client(args.persist_dir, scratch)
    return client, {"mode": "persist", "location": str(args.persist_dir)}


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(message)s", stream=sys.stdout)
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one line per page otherwise
    args = _parse_args(argv)
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    manifest_path = out / "manifest.json"
    # Gone before anything else, so an interrupted re-run is never mistaken for a complete export.
    manifest_path.unlink(missing_ok=True)
    shutil.rmtree(out / "collections", ignore_errors=True)
    scratch_parent = args.scratch or out.resolve().parent
    scratch_parent.mkdir(parents=True, exist_ok=True)
    scratch = Path(tempfile.mkdtemp(prefix=".chroma-export-", dir=scratch_parent))
    try:
        return _export(args, out, manifest_path, scratch)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def _export(args: argparse.Namespace, out: Path, manifest_path: Path, scratch: Path) -> int:
    try:
        client, source = _open(args, scratch)
        names = sorted(set(args.collection)) if args.collection else _collection_names(client)
    except Exception as exc:  # noqa: BLE001 - any failure to open Chroma is the same hard stop
        logger.error("Could not open Chroma: %s", exc)
        return 2
    invalid = [name for name in names if not COLLECTION_NAME.match(name)]
    if invalid:
        logger.error("Not a Chroma collection name: %s", ", ".join(invalid))
        return 2

    collections: dict[str, Any] = {}
    failed = 0
    for name in names:
        try:
            entry = export_collection(client.get_collection(name=name), out / "collections" / name, args.batch_size)
        except Exception as exc:  # noqa: BLE001 - one collection failing never stops the rest
            failed += 1
            logger.error("[fail] %s: %s", name, exc)
            continue
        collections[name] = entry
        logger.info("[ok] %s: %d chunks in %d file(s), %s", name, entry["count"], entry["batches"], entry["id_digest"])
    if failed:
        logger.error("Done: %d collection(s) failed; no manifest written, the export is incomplete", failed)
        return 1
    write_manifest(out, collections, source)
    total = sum(int(entry["count"]) for entry in collections.values())
    logger.info("Done: %d collection(s), %d chunk(s) -> %s", len(collections), total, manifest_path)
    return 0


def write_manifest(out: Path, collections: dict[str, Any], source: dict[str, str]) -> Path:
    """Write ``manifest.json`` atomically: the last step, and the mark of a complete export."""
    manifest = {
        "format": FORMAT,
        "chroma_version": chromadb.__version__,
        "source": source,
        "created_at": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "collections": collections,
    }
    path = out / "manifest.json"
    partial = path.with_name("manifest.json.partial")
    partial.write_text(json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(partial, path)
    return path


if __name__ == "__main__":
    sys.exit(main())
