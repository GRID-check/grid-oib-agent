# Moving the vectors from Chroma to Qdrant

Qdrant replaced Chroma (ADR-0113), and the product no longer contains any
Chroma code. A deployment that still has its vectors in Chroma moves them in
two steps that share a file format and nothing else:

1. **Export**: `chroma_export.py`, in this directory, reads Chroma and writes
   every collection in the neutral format below. It is the only Chroma code
   left in the repository. It runs in a throwaway Python environment holding
   `chromadb` at the server's version, never in the backend image.
2. **Import**: `scripts/import_vectors.py`, in the backend image, reads that
   format into Qdrant (`sources/knowledge_layer/src/qdrant/import_vectors.py`).
   It knows nothing about Chroma.

Nothing is re-parsed and nothing is re-embedded: the vectors Chroma holds are
the vectors Qdrant gets, and Qdrant computes the BM25 vector from the text.
The step-by-step procedure, with the order of stopping writers, exporting,
upgrading and importing, is in the runbook:
[Migrating from Chroma](../../docs/deployment/qdrant-runbook.md#migrating-from-chroma).

## The exporter

`chromadb/chroma:1.5.9`, the server image, has no Python (its entrypoint is the
Rust `chroma` binary), so the exporter cannot run in Chroma's own image. It
runs in `ghcr.io/astral-sh/uv:0.11.32-python3.12-trixie-slim` beside it, Compose
and the Kubernetes Job alike. The script pins its own `chromadb` in its inline
metadata (PEP 723), and `uv run --script` installs exactly that, so the image
needs nothing else. The pin must equal the server version that wrote the data,
1.5.9, which `deploy/pulumi/src/constants.ts` records (`CHROMA_MIGRATION`).

```bash
# From the persist directory (the Chroma volume; read-only is fine)
docker run --rm \
  -v <chroma volume>:/chroma:ro \
  -v "$PWD/deploy/migration:/migration:ro" \
  -v "$PWD/vector-export:/exchange" \
  ghcr.io/astral-sh/uv:0.11.32-python3.12-trixie-slim \
  uv run --script /migration/chroma_export.py --persist-dir /chroma --out /exchange/export

# From a running Chroma server, on its network
docker run --rm --network <network> \
  -v "$PWD/deploy/migration:/migration:ro" \
  -v "$PWD/vector-export:/exchange" \
  ghcr.io/astral-sh/uv:0.11.32-python3.12-trixie-slim \
  uv run --script /migration/chroma_export.py --url http://chroma:8000 --out /exchange/export
```

Without Docker: `uv run --script deploy/migration/chroma_export.py --persist-dir <dir> --out <dir>`.

| Flag | Meaning |
|---|---|
| `--persist-dir DIR` or `--url URL` | The source: a Chroma persist directory, or a server (`http(s)://host[:port]`) |
| `--out DIR` | The export directory. Its `manifest.json` and `collections/` are replaced |
| `--collection NAME` | Only this collection (repeatable); default every one |
| `--batch-size N` | Records per page read and per file written (default 1,000) |
| `--scratch DIR` | Where a persist directory is copied (default: beside `--out`) |

Exit codes: `0` exported; `1` a collection failed or changed while it was
read (no manifest is written); `2` Chroma could not be opened or an argument
is invalid.

What it does, and why:

- **A persist directory is copied before it is opened.** Chroma cannot open a
  read-only directory (`attempt to write a readonly database`), and opening the
  original read-write could alter it. The copy needs as much free space as the
  volume holds, and is deleted at the end.
- **Stop every writer first.** The export reads each collection in pages by
  offset; a collection whose count changes while it is read fails the run, and
  the export must be repeated.
- **Idempotent.** A re-run deletes the manifest first, rewrites every batch, and
  writes the manifest last. An export without a manifest is incomplete, and
  the importer refuses it.
- **Constant memory.** One page in memory at a time; the id digest is a running sum.
- **Both modes give the same records**, ids, texts, metadata and digests alike.
  The vectors can differ in the last float32 bit: Chroma 1.5.9's two read paths
  disagreed on 546 of 2,800 vectors (at most 1.2e-7) in the drill, and neither
  returned the nearest float32 of what had been written. Both are Chroma's own
  answers; a cosine does not see the difference.

## The importer

```bash
python scripts/import_vectors.py --in /exchange/export --dry-run      # read and check everything, write nothing
python scripts/import_vectors.py --in /exchange/export --verify       # import, then compare the id sets
python scripts/import_vectors.py --in /exchange/export --prune --verify
python scripts/import_vectors.py --in /exchange/export --verify-only  # compare only
python scripts/import_vectors.py --in /exchange/export --collection oib_knowledge
```

It reads the backend's environment (`AIQ_QDRANT_URL`, `AIQ_QDRANT_API_KEY`, the
metadata store for the person-set facts, `AIQ_EMBED_MODEL` and
`AIQ_EMBED_BASE_URL` for a collection whose export names no embedder), so run
it where the backend runs.

- **Insert-only.** Point ids are the chunk ids, so a re-run inserts only what
  is missing and finishes a run that stopped halfway. A point that already
  exists keeps its payload (the office, project and document ids ingestion
  wrote); only the fields the chunk alone decides are merged onto it.
- **The person-set facts** (tags, topics, Dokumentart, Fassung, folder) are read
  from the metadata store once a collection is written, and merged onto every
  file's points, never replacing a payload whole. Read at the end, not the
  start, so an edit a person made while the collection was copied wins.
- **A file ingested again after the export keeps what ingestion wrote.** When
  Qdrant already holds points of a file the export holds, with chunk ids the
  export lacks and an `indexed_at` later than the manifest's `created_at`,
  the file was re-uploaded or re-indexed since: its exported chunks are left
  out (a warning names it), and `--verify` and `--prune` expect the new ones
  instead. Inserted, the old Fassung would answer beside the new one under one
  file name, and a prune would then delete the new one.
- **The embedder must match.** Each collection's `aiq:embed_fingerprint` is
  checked against the Qdrant collection it lands in before anything is written;
  one mismatch refuses the whole run (exit 2). A collection without a
  fingerprint takes the configured embedder's.
- **`--verify`** compares the chunk ids per collection, not only the counts:
  the whole sets up to 200,000 chunks, a sample of 4,096 each way above.
  Without `--collection`, a scope Qdrant holds and the export does not counts
  as out of step. A point the export lacks fails it too, on purpose: it is
  either something uploaded since the export or a stale point an earlier
  dual-write left behind, and the second is deleted content still answering
  searches. So verify while nothing writes, and remove stale points with
  `--prune` before uploads restart.
- **`--prune`** deletes the points, and without `--collection` the whole scopes,
  the export does not hold. The export is a snapshot: prune only before the new
  release takes uploads, or **what was uploaded since is deleted**, a new file
  or a whole new project (the re-ingested file above is the one exception).
- **Once, unless forced.** A run with `--verify` over every collection that
  ends in step records it in the Qdrant collections' metadata
  (`aiq:vector_import`: which export, verified when). Every later run that
  would write is then refused with exit 2 and writes nothing, unless
  `--force`: an old export imported again brings back the chunks of every
  document deleted since. `--dry-run` and `--verify-only` are never refused.
  The mark lives and dies with the collections: `qdrant_rebuild.py` copies it
  into the next `_vN` with the rest of the metadata, and a Qdrant whose
  collections were deleted carries none.

Exit codes: `0` done and, with `--verify`, every collection in step; `1` a
collection failed or differs (run it again); `2` Qdrant unreachable, or the
export invalid, incomplete or refused (another embedder, or an import that
already verified).

## The format: `piloti-vectors/1`

```text
<export>/
  manifest.json
  collections/<name>/000000.jsonl.gz
  collections/<name>/000001.jsonl.gz
  ...
```

`manifest.json`, written last:

```json
{
  "format": "piloti-vectors/1",
  "chroma_version": "1.5.9",
  "created_at": "2026-10-13T10:17:54+00:00",
  "source": {"mode": "persist", "location": "/chroma"},
  "collections": {
    "proj_drill": {
      "count": 2500,
      "dimension": 3072,
      "batches": 3,
      "metadata": {"hnsw:space": "cosine", "aiq:embed_fingerprint": "…", "aiq:embed_model": "…"},
      "id_digest": "sha256-sum:b2154f2a…"
    }
  }
}
```

| Field | Meaning |
|---|---|
| `format` | `piloti-vectors/1`. The importer refuses any other value |
| `chroma_version` | The `chromadb` package that read the data. In `http` mode `source.server_version` is what the server reports (the 1.5.9 image says `1.0.0`) |
| `created_at` | When the export finished, UTC |
| `collections.<name>.count` | Records in the collection's batches |
| `.dimension` | Floats per vector, the same for every record (`null` for an empty collection) |
| `.batches` | Files in `collections/<name>/`, numbered from `000000` |
| `.metadata` | The collection's metadata as Chroma holds it, the embedder identity (`aiq:embed_fingerprint`, `aiq:embed_model`) included when the collection has one |
| `.id_digest` | `sha256-sum:` and 64 hex digits: the sum of the SHA-256 of every id (UTF-8, as a big-endian integer), mod 2^256. It does not depend on order, so the exporter keeps one number and the importer recomputes it while reading; a lost, truncated or edited batch does not match |

Each batch is gzip of UTF-8 JSON lines, one record per line:

```json
{"id": "6047aab3-…", "embedding": "EFgwP5kSBD9eqyK+…", "document": "Abschnitt 8 …", "metadata": {"file_name": "a.pdf", "page_label": "8"}}
```

| Field | Meaning |
|---|---|
| `id` | The chunk id, which becomes the Qdrant point id (a non-UUID id becomes a stable UUIDv5; the payload keeps the original) |
| `embedding` | Standard base64 of the vector as little-endian float32, `4 × dimension` bytes |
| `document` | The chunk text (`""` when Chroma has none) |
| `metadata` | The chunk's metadata object as Chroma holds it (`{}` when none) |

The records stand in the order `collection.get` returned them, batch after
batch, and the order is part of the format: it is Chroma's insertion order
(checked on 1.5.9 against `embeddings.id` for every collection of a real
store), and ingestion inserted a file's chunks as the chunker cut them. The
importer numbers each file's records in that order as their `chunk_ordinal`,
the only thing that orders the chunks of one page; `_node_content`'s
`start_char_idx` counts within one LlamaIndex Document and was 0 for most
chunks.

A collection name is Chroma's (`[A-Za-z0-9._-]`, starting and ending with a
letter or digit); the importer refuses any other before it becomes a path.

## Tests

The exporter needs `chromadb`, which is not a dependency of this repository, so
its tests run in an environment of their own and never in `task be:test*`:

```bash
AIQ_QDRANT_TEST_URL=http://localhost:6333 task be:test:migration
# which runs
uvx --python 3.12 --with-requirements deploy/migration/chroma_export.py --with pytest \
  pytest deploy/migration/tests -q -p no:cacheprovider
```

`--with-requirements` reads the exporter's own PEP 723 pin, so the tests run
against the `chromadb` the exporter will run with, and the pin lives in one place.

They build a real persist directory, export it in both modes (the HTTP mode
against `chroma run`), and check the manifest and every record. The last test
hands the export to `scripts/import_vectors.py` in the repository's venv
(`.venv/bin/python`, or `PILOTI_VENV_PYTHON`) and checks every point in Qdrant;
it skips without `AIQ_QDRANT_TEST_URL` locally and fails without it on CI. The
importer's own tests, on hand-written exports, are
`sources/knowledge_layer/tests/test_qdrant_import_vectors.py`.
