# OIB Richtlinien Sync

Incremental ingestion pipeline for OIB (Österreichisches Institut für Bautechnik) PDFs into the `oib_knowledge` ChromaDB collection.

---

## CLI Entry Point

**File**: `scripts/ingest_oib.py`

```python
from aiq_agent.oib_sync import sync

if __name__ == "__main__":
    added, total = sync()
    print(f"OIB sync complete: {added} added/changed, {total} total tracked")
```

Run via Docker:

```bash
docker compose -f deploy/compose/docker-compose.yaml --env-file deploy/.env exec aiq-agent python scripts/ingest_oib.py
```

---

## Sync Algorithm

**File**: `src/aiq_agent/oib_sync.py`

```
sync()
  │
  ├─ 1. Scan data/oib/ and data/oib_uploads/ for *.pdf (recursive; may be empty)
  │
  ├─ 2. Load data/oib_registry.json (SHA-256 → filename mapping)
  │
  ├─ 3. Compute SHA-256 for each PDF
  │
  ├─ 4. Compare against registry → identify new/changed files
  │
  ├─ 5. If no changes → return (0, total)
  │
  ├─ 6. Initialize LlamaIndex ingestor
  │
  ├─ 7. Ensure oib_knowledge collection exists
  │
  └─ 8. For each new/changed PDF:
       │
       ├─ ingestor.upload_file(path, collection)
       ├─ _wait_for_file(ingestor, file_id) → poll every 2s, timeout 600s
       ├─ If SUCCESS → record SHA-256 in registry, save
       └─ If FAILED  → leave registry unchanged (retry on next run)
```

### Incremental Sync

The registry file (`data/oib_registry.json`) maps relative PDF paths to their SHA-256 hashes:

```json
{
  "data/oib/OIB-Richtlinie-1.pdf": "abc123def456...",
  "data/oib/OIB-Richtlinie-2.pdf": "789012ghi345..."
}
```

On each run:
- Files with a **changed hash** are re-ingested (content was modified)
- **New files** (not in registry) are ingested
- **Unchanged files** are skipped
- **Failed files** are retried on the next run (registry not updated on failure)

### Polling (`_wait_for_file`)

| Parameter | Value |
|-----------|-------|
| Poll interval | 2 seconds |
| Timeout | 600 seconds (10 minutes) |
| Terminal states | `SUCCESS`, `FAILED` |
| On timeout | Returns `FAILED` (retry next run) |

The function calls `ingestor.get_file_status(file_id, collection_name)` in a loop until a terminal status is reached or the deadline is exceeded.

---

## Registry Management

**Functions**:
- `_load_registry()` — Reads `REGISTRY_PATH` (default: `data/oib_registry.json`), returns `dict[str, str]`
- `_save_registry(registry)` — Writes sorted JSON to `REGISTRY_PATH`, creates parent directories if needed
- `_file_hash(path)` — Streams the file through SHA-256 (8KB chunks)

Only files that reach `FileStatus.SUCCESS` have their hash recorded. Failures and timeouts leave the registry unchanged, guaranteeing automatic retry.

---

## Concurrency

The admin route's executor runs more than one worker, so a corpus `sync()`, a
ZIP member's `ingest_single()` and a delete can be in flight at the same time.
Four locks keep that safe:

| Lock | Protects |
|------|----------|
| `_SYNC_LOCK` | Single-flight `sync()` — a second sync waits instead of ingesting the same work list twice |
| `_file_lock(basename)` | All corpus mutations for **one** document: `ingest_single`, `remove_uploaded_document`, `exclude_document`, and each file of a `sync()` (held from its delete/upload until its terminal status). Different documents stay fully concurrent |
| `_REGISTRY_LOCK` | Registry read-modify-write |
| `_EXCLUDED_LOCK` | Exclusion-set read-modify-write (`exclude`/`unexclude`/prune) |

Every registry and exclusion write **reloads the file inside its lock** and
merges. The lock alone would only serialize the saves: `sync()` loads the
registry once and then runs for minutes, so saving that snapshot would drop
hashes a concurrent ingestion recorded in the meantime (a lost hash means a
wasteful re-ingest next run; a lost exclusion means a removed document coming
back).

---

## Object mode (`GRID_BASE_CORPUS_STORE=object`)

`disk` (the default, Compose and local dev) is everything above. `object` is the
Kubernetes setting (ADR-0082 step A2): an admin upload used to land on one
replica's disk, with that replica's registry and exclusion files beside it. In
object mode the object store is the record and `OIB_UPLOADS_DIR` is a local
cache of it, so hashing, `ingestor.upload_file(path)`, `FileResponse` and
`rglob` still work on paths, and the registry keys (absolute paths under
`OIB_UPLOADS_DIR`) are the ones already recorded: nothing re-ingests because of
the move. The module is `src/aiq_agent/corpus_store.py`; `oib_sync` branches on
`corpus_store.object_mode()` in the four registry/exclusion functions and in a
few calls (`_refresh_cache`, `remove`, the locks), not throughout.

| Piece | Where it lives in object mode |
|-------|-------------------------------|
| The PDFs | SeaweedFS, key `base-corpus/<file name>` in `SEAWEED_BUCKET`. Written through the BFF (`POST /api/internal/base-corpus/upload-url`, then a presigned `PUT` as `application/pdf`; `DELETE /api/internal/base-corpus/<name>`, header `x-grid-internal-token`), because the backend's S3 credential is read-only. Read with that credential (`aiq_agent.common.seaweed_s3`, shared with `view_knowledge_image`) |
| The list of PDFs | `oib_corpus_files(file_name pk, storage_key, sha256, size_bytes, uploaded_at)` |
| The registry | `oib_corpus_registry(doc_key pk, value)`: the JSON registry key for key, including `__chunk_format_version__` |
| The exclusions | `oib_corpus_excluded(file_name pk)` |
| This replica's copy | `OIB_UPLOADS_DIR`, a cache |

The tables are in the knowledge database (`AIQ_SUMMARY_DB`) and created on first
use. Object mode without that database fails with an error instead of falling
back to a local SQLite file, which would recreate the per-replica state.

**The cache is checked, not trusted.** A cached PDF counts when its sha256
equals the table row's (memoised by size and mtime, so a check is a `stat`).
A download goes to a temp file beside its target, is verified against the row,
and only then renamed in; a mismatch is logged and the cached copy stays. `pull`
makes the cache match the table: it fetches what is missing or different and
removes top-level `*.pdf` files the table does not list. It reads the table
first, so a table that cannot be read raises before any file is touched.

**Who refreshes it.** `discover_pdfs()` (so `/v1/oib/status`, the corpus export
and `sync()`), `remove_document`/`remove_uploaded_document`, and the start of
`sync()` all run `_refresh_cache()`. `GET /v1/oib/documents/{file}` and the chat
tool `view_knowledge_image` fetch the one file they need (`ensure_local`). An
upload (`corpus_store.put`) stores the object, then writes the row and the cache
file together under a lock, so a concurrent pull cannot drop the file it just
wrote. A store that refuses the object fails the upload with an error (no
pending job for a file that was never kept).

**Locks across replicas.** The in-process locks above stay, and each registry
or exclusion read-modify-write also takes a Postgres advisory lock
(`oib-registry`, `oib-excluded`), and the whole `sync()` takes `oib-sync`, via
`corpus_store.shared_lock` (`keyed_lock`, which waits, and is a no-op without
Postgres). Every web replica runs `sync()` at boot, so the second one waits for
the first and then finds nothing new. `OIB_FORCE_REINGEST` also clears the
shared registry.

**One-time move of an existing volume** (`corpus_store.migrate_once`, run before
the first `pull` on a replica, until `OIB_UPLOADS_DIR/.object-store-migrated`
exists):

1. import the local JSON registry into `oib_corpus_registry`, when that table is empty;
2. add the local exclusion file to `oib_corpus_excluded` (union);
3. upload every top-level local PDF the table does not list;
4. write the marker.

It is idempotent, and every replica contributes the files only it holds, which
also repairs a corpus an upload had left on one replica of several. Files of a
replica that migrates after the registry was imported have no registry entry and
are ingested once more. The remaining edge: a document an admin deletes after the
first replica migrated, but before a second one that still holds its file has
booted, is uploaded again by that second replica; delete it again.

---

## Collection Management

`_ensure_collection(ingestor)`:
- Checks if `OIB_COLLECTION_NAME` (default: `oib_knowledge`) exists
- Creates it if missing, with description `"Persistent OIB Richtlinien knowledge base."`
- Idempotent — safe to call multiple times

Base/project collections like `oib_knowledge` are **never** subject to TTL auto-deletion (only `s_`-prefixed session collections are reaped).

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OIB_DOCUMENTS_DIR` | `data/oib` | Operator-provided OIB PDFs, bind-mounted read-only. Gitignored and empty in a fresh clone |
| `OIB_UPLOADS_DIR` | `data/oib_uploads` | PDFs uploaded through the platform-admin UI, on the persistent volume |
| `OIB_REGISTRY_PATH` | `data/oib_registry.json` | Path to SHA-256 registry file (object mode: read once, to move an existing volume into the store) |
| `GRID_BASE_CORPUS_STORE` | `disk` | `object` keeps the uploaded corpus, registry and exclusions in SeaweedFS and the knowledge database; see [Object mode](#object-mode-grid_base_corpus_storeobject) |
| `OIB_COLLECTION_NAME` | `oib_knowledge` | Target ChromaDB collection |
| `AIQ_CHROMA_DIR` | `/tmp/chroma_data` | ChromaDB persistence directory |

---

## Ingestor Initialization

The sync imports `knowledge_layer.llamaindex.adapter` eagerly to register the ingestor backend with the factory, then obtains an ingestor via:

```python
from aiq_agent.knowledge.factory import get_ingestor
ingestor = get_ingestor("llamaindex", {"persist_dir": CHROMA_DIR})
```

This creates a `LlamaIndexIngestor` with ChromaDB persistence at `AIQ_CHROMA_DIR`.

---

## Dependency Graph

```
scripts/ingest_oib.py
       │
       ▼
src/aiq_agent/oib_sync.py
       │
       ├── knowledge_layer.llamaindex.adapter  (registers backend)
       ├── aiq_agent.knowledge.factory          (get_ingestor)
       ├── aiq_agent.knowledge.schema           (FileStatus)
       │
       └── ChromaDB (@ AIQ_CHROMA_DIR / oib_knowledge collection)
```

The OIB collection is included as the default `base_collection` in every query's scope (see [Collection Scoping](collection-scoping.md)).
