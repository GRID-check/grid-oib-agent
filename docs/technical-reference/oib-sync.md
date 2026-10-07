# OIB Richtlinien Sync

How the base corpus (the OIB, Österreichisches Institut für Bautechnik, Richtlinien and the other documents the platform owner uploads) is stored and ingested into the `oib_knowledge` ChromaDB collection. ADR-0082 step A2.

There is one design and no switch: the corpus lives in object storage, one table says what is in it, and a scheduled sync cycle ingests what is not indexed yet. The code is `src/aiq_agent/corpus_store.py` (storage, table, cache), `src/aiq_agent/oib_sync.py` (ingestion), `src/aiq_agent/oib_status.py` (the status view) and `frontends/aiq_api/src/aiq_api/routes/oib.py` (the routes).

---

## Where things live

| Piece | Where |
|-------|-------|
| A PDF | The object `base-corpus/<file name>` in `SEAWEED_BUCKET`. Written through the BFF (`POST /api/internal/base-corpus/upload-url`, then a presigned `PUT` as `application/pdf`; `DELETE /api/internal/base-corpus/<name>`, header `x-grid-internal-token`), because the backend's S3 credential is read-only. Read with that credential (`aiq_agent.common.seaweed_s3`, shared with `view_knowledge_image`) |
| The list of PDFs and what ingestion knows about each | One table in the knowledge database (`AIQ_SUMMARY_DB`), `oib_corpus_files`, created on first use |
| A copy on a replica's disk | A cache in `GRID_BASE_CORPUS_CACHE_DIR` (default `/tmp/base-corpus`), filled one file at a time |

```
oib_corpus_files
  file_name              text pk
  storage_key            text not null      -- base-corpus/<file name>
  sha256                 text not null      -- of the stored bytes
  size_bytes             bigint not null
  uploaded_at            timestamptz not null default now()
  ingested_sha256        text null          -- the bytes the index was last built from
  chunk_format_version   int null           -- the chunking pipeline's version at that ingestion
```

Without `AIQ_SUMMARY_DB` the store fails with an error. It does not fall back to a local SQLite file, which would recreate the per-replica state it exists to remove.

There are no files on the backend that matter. A replica that loses its cache downloads again what it needs; nothing is pulled speculatively. The backend image ships no PDFs and reads no bind mount.

---

## The one rule: when a file needs ingestion

A file needs ingestion when

```
ingested_sha256 IS DISTINCT FROM sha256
OR chunk_format_version IS DISTINCT FROM CHUNK_FORMAT_VERSION
```

(`FileRow.needs_ingestion`). That single rule is the whole change detector:

| Case | Why the rule fires |
|------|--------------------|
| A new upload | `ingested_sha256` is `NULL` |
| An upload that replaces a file | `sha256` changed, `ingested_sha256` is still the old one |
| A failed or timed-out ingestion | Nothing was recorded, so the next cycle tries again |
| A change to chunking or to what a chunk carries | Bump `CHUNK_FORMAT_VERSION` in `oib_sync.py`; every file's recorded version differs, so the next cycle re-ingests the corpus. The ingestor replaces a document's chunks by name once the new version is indexed, so the re-ingest is not additive |
| A Chroma server that was wiped or repointed | The cycle sees rows claiming ingestion while the collection is empty, forgets every `ingested_sha256` and re-ingests |
| An admin's "re-index" | `POST /v1/admin/oib/reingest` clears `ingested_sha256` for the named files and queues them |

The hash and version are written only when the file reaches `FileStatus.SUCCESS`, and only if the row still holds the bytes that were ingested (`mark_ingested` is a conditional update), so a file replaced while it was being ingested still needs ingestion afterwards.

---

## Who runs ingestion

**An upload** (`POST /v1/admin/oib/documents`, one PDF or a ZIP of PDFs) stores the object, writes the row and the cache file, answers, and queues `ingest_single(name)` for that file at once. An upload is not a ten-minute wait. A store that refuses the object fails the request with an error, and no job is started for a file that was never kept.

**A sync cycle** (`oib_sync.sync()`) is housekeeping. It runs

- every ten minutes, as the base-corpus housekeeping route `POST /v1/maintenance/housekeeping/base-corpus` (internal token). On Kubernetes that is the `housekeeping-base-corpus` CronJob (`deploy/pulumi/src/app/workers.ts`, `*/10 * * * *`, `concurrencyPolicy: Forbid`); in Compose it is the housekeeping clock (`frontends/ui/workers/housekeeping-clock.js`);
- on demand, as `POST /v1/admin/oib/sync`, the admin's "run it now". It calls the same function.

There is no sync at boot and no boot thread. A cycle:

```
sync()
  keyed_lock("oib-sync")                       one cycle at a time, across replicas
  ├─ read every row
  ├─ if rows claim ingestion but the collection is empty: forget all ingested hashes
  ├─ pending = rows where needs_ingestion
  └─ ingest each pending file, OIB_SYNC_MAX_WORKERS at a time (default 4):
        ingest_single(name)
          keyed_lock("oib-file:<name>")          one operation per document, across replicas
          ├─ re-read the row; if the file is current → done (an upload and a cycle can meet here)
          ├─ ensure_local(name)                  download, sha-verified, atomic rename
          ├─ ingestor.upload_file(path, collection)
          ├─ poll the file status every 2 s, up to 600 s
          └─ on SUCCESS: record ingested_sha256 and chunk_format_version
  returns {ingested, failed, total}
```

A second cycle (the next tick, an admin's click) waits for the running one and then finds nothing to do. A failure is one file's: the others go on, and the failed one is retried by the next cycle.

---

## The cache

`ensure_local(name)` is the one way to get a path: it looks the name up in the table, downloads the object if this process lacks the current bytes (to a temp file beside the target, verified against the row's sha256, then renamed into place), and returns the path. A file counts as present when its sha256 equals the row's; hashes are memoised by size and mtime, so the check is a `stat`.

- A name the table does not list returns `None`, and any copy this process still holds is deleted: the table says what exists.
- A listed file that cannot be fetched (the object is gone, the hash does not match) raises `CorpusStoreError`; a table that cannot be read raises too. Neither is "not in the corpus", and nothing is deleted on a guess.

What calls it: ingestion, `GET /v1/oib/documents/{file_name}` (the PDF viewer; 404 for a name the table does not list, 503 for a listed one the store cannot serve), the corpus export (`GET /v1/admin/oib/corpus.tar.gz`, which fails rather than ship half a corpus) and the chat tool `view_knowledge_image`.

---

## Deleting

`DELETE /v1/admin/oib/documents/{file_name}` deletes. There is no exclusion list and no second kind of removal. It takes the document's lock, then removes, in this order, the chunks, the summary registration, the row, the object (through the BFF) and this replica's cached file. The row goes after the chunks, so a failure in between leaves the document listed and a retry finds it; the object goes after the row, so a failure there leaves an unreachable object that a later upload of the same name overwrites. A name only the index knows (chunks a half-finished delete left behind, a restored vector store) is cleared the same way; the status shows it as `removed`. Uploading the same file again adds it back.

---

## The status view

`GET /v1/oib/status` merges the table with the Chroma file listing, one entry per file:

| State | Meaning |
|-------|---------|
| `ingested` | The index was built from the file's current bytes by the current pipeline, and chunks exist |
| `stale` | The file changed (or the pipeline did) since it was ingested; the index still reflects the old version |
| `pending` | Never ingested |
| `inconsistent` | The table says ingested, the collection holds no chunks for it |
| `removed` | The collection holds chunks for it, the table does not list it. Delete the document to clear them |

The fields per file are `file_name`, `state`, `size_bytes`, `chunk_count`, `ingested_sha256`, `current_sha256`, `ingested_at`, `summary`, `doc_class`, `doc_class_suggestion` and `display_title`; the summary carries a count per state and `total_chunks`.

---

## Concurrency

| Lock | Protects |
|------|----------|
| `keyed_lock("oib-sync")` | One sync cycle at a time, across replicas |
| `keyed_lock("oib-file:<name>")` | All corpus mutations for **one** document: `ingest_single` (so an upload's queued ingestion and a cycle never both ingest it) and `remove_document`. Different documents stay fully concurrent |

`keyed_lock` waits, in this process and, on Postgres, across replicas (a Postgres advisory lock); without Postgres only the process lock holds. The ingestor also serialises the replacement of one document's previous version, under its own key.

---

## Collection management

`_ensure_collection(ingestor)` creates `OIB_COLLECTION_NAME` (default `oib_knowledge`) with the description `"Persistent OIB Richtlinien knowledge base."` if it is missing, and is safe to call repeatedly. Base and project collections like `oib_knowledge` are **never** subject to TTL auto-deletion (only `s_`-prefixed session collections are reaped).

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GRID_BASE_CORPUS_CACHE_DIR` | `/tmp/base-corpus` | This process's cache of corpus files. May be lost at any restart |
| `AIQ_SUMMARY_DB` | none | The knowledge database; holds `oib_corpus_files`. Required |
| `FRONTEND_INTERNAL_URL`, `GRID_INTERNAL_API_TOKEN` | none | How the backend reaches the BFF to write and delete objects |
| `SEAWEED_ENDPOINT`, `SEAWEED_ACCESS_KEY`, `SEAWEED_SECRET_KEY`, `SEAWEED_BUCKET` | none, none, none, `grid-documents` | The read-only credential and bucket the backend downloads with |
| `OIB_SYNC_MAX_WORKERS` | `4` | Files ingested at once in a sync cycle |
| `OIB_COLLECTION_NAME` | `oib_knowledge` | Target ChromaDB collection |
| `AIQ_CHROMA_URL` / `AIQ_CHROMA_DIR` | none / `/tmp/chroma_data` | The shared Chroma server, or the embedded store's directory (Compose and local development only) |

---

## Getting PDFs in

Upload them in the platform-admin UI. A developer with a directory of PDFs runs

```bash
GRID_ADMIN_TOKEN=... uv run python scripts/upload_oib_corpus.py data/oib --url http://localhost:8000
```

which sends each PDF through `POST /v1/admin/oib/documents` (header `X-Admin-Token`). The upload queues ingestion; watch `/v1/oib/status`.

---

## Ingestor initialization

The sync imports `knowledge_layer.llamaindex.adapter` eagerly to register the ingestor backend with the factory, then obtains an ingestor via:

```python
from aiq_agent.knowledge.factory import get_ingestor
ingestor = get_ingestor("llamaindex", {"persist_dir": CHROMA_DIR})
```

With `AIQ_CHROMA_URL` set (every Kubernetes and Coolify deployment) the adapter talks to the shared Chroma server and `persist_dir` is unused.

---

## Dependency graph

```
frontends/aiq_api routes/oib.py  ·  routes/jobs.py (housekeeping/base-corpus)
       │
       ▼
src/aiq_agent/oib_sync.py ──────────► src/aiq_agent/corpus_store.py
       │                                  │ table: oib_corpus_files (AIQ_SUMMARY_DB)
       ├── knowledge_layer.llamaindex.adapter   │ writes: BFF presigned URLs / delete
       ├── aiq_agent.knowledge.factory          │ reads:  aiq_agent.common.seaweed_s3
       ├── aiq_agent.knowledge.leader_lock      └ cache:  GRID_BASE_CORPUS_CACHE_DIR
       └── ChromaDB (oib_knowledge collection)
```

The OIB collection is included as the default `base_collection` in every query's scope (see [Collection Scoping](collection-scoping.md)).
