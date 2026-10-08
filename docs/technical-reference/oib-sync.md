# OIB Richtlinien Sync

How the base corpus (the OIB, Österreichisches Institut für Bautechnik, Richtlinien and the other documents the platform owner uploads) is stored and ingested into the `oib_knowledge` ChromaDB collection. ADR-0082 step A2.

There is one design and no switch: the corpus lives in object storage, one table says what is in it, and every file that is not indexed yet becomes one job on the durable ingest queue (ADR-0076), run by the ingest workers. Nothing is ingested in the web process. The code is `src/aiq_agent/corpus_store.py` (storage, table, cache), `src/aiq_agent/oib_sync.py` (ingestion), `src/aiq_agent/oib_status.py` (the status view) and `frontends/aiq_api/src/aiq_api/routes/oib.py` (the routes).

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
  failed_job_id          text null          -- the ingest job that ran for these bytes and gave up
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
| A failed ingestion | Nothing was recorded as ingested, so the rule keeps firing, but no new job is queued: the file reads `failed` (see below) until its bytes change or an admin re-indexes it |
| A change to chunking or to what a chunk carries | Bump `CHUNK_FORMAT_VERSION` in `oib_sync.py`; every file's recorded version differs (and its job id changes), so the next cycle queues the whole corpus again. The ingestor replaces a document's chunks by name once the new version is indexed, so the re-ingest is not additive |
| A Chroma server that was wiped or repointed | The cycle sees rows claiming ingestion while the collection is empty, forgets every `ingested_sha256` and re-ingests |
| An admin's "re-index" | `POST /v1/admin/oib/reingest` clears `ingested_sha256` and `failed_job_id` for the named files, drops their finished or failed job and queues a new one |

The hash and version are written only after the file's job reached `FileStatus.SUCCESS`, and only if the row still holds the bytes that were ingested (`mark_ingested` is a conditional update), so a file replaced while it was being ingested still needs ingestion afterwards. The worker never writes the table; whoever reads the job's status next does (`oib_sync.settle`, called by the sync cycle and by the status view).

---

## Who runs ingestion

**The ingest workers do.** A file that needs ingestion becomes exactly one job on the `ingest_job_queue` table, the queue `POST /v1/ingest` uses (`aiq_agent.knowledge.ingest_queue`), in the platform lane (no organisation) at `bulk` priority. It is claimed by the ingest-worker tier, and by nothing else: the `chat` and `api` roles only enqueue (ADR-0082 step B). Kubernetes runs it as the `ingest-worker` Deployment and both Compose files as the `ingest-worker` service, with the queue's heartbeat, stale-claim reclaim, attempt limit, dead rows and drain behaviour. The queue is on whenever `AIQ_SUMMARY_DB` is set, which the corpus needs anyway.

**There is no in-process path.** `oib_sync` never calls `upload_file`, `submit_job` or `run_prepared`, and has no thread pool (a test greps for it). If the queue is off or cannot take the job (`GRID_INGEST_QUEUE=off`, no database, a write error), `ingest_dispatch.enqueue_only` (reached through the agent tier's one seam into the API tier, `aiq_agent.turn.api_seam.enqueue_ingest_job`) raises `QueueUnavailable`: the upload route answers 500, the sync cycle fails loudly, and the next cycle queues the file once the queue is back.

**The job** is built like `POST /v1/ingest` builds one: `ingestor.prepare_job(...)` records a `PENDING` status and `ingest_dispatch.enqueue_only(prepared)` stores it. Its pieces:

| Piece | Value |
|-------|-------|
| Job id | `oib-` plus the first 32 hex characters of `sha256(name \0 sha256 \0 CHUNK_FORMAT_VERSION)` (`oib_sync.job_id_for`). The queue's primary key is what keeps one job per (name, bytes, pipeline version): `ClaimQueue.enqueue` is `INSERT ... ON CONFLICT (job_id) DO NOTHING` and returns whether it stored the row |
| File | `corpus_store.CorpusObjectDownload(storage_key, sha256)`: a deferred download in the job payload. The worker downloads the object with its own read-only S3 credential, into a temp file, and checks the hash (a mismatch fails the job). No presigned URL goes into the payload, so a job that waits in the queue longer than a URL would live is not a problem. The key must start with `base-corpus/`; a payload naming anything else is refused when it is decoded |
| Config | `cleanup_files`, `original_filenames=[name]`, `priority=bulk`, and `doc_class` when an admin chose one |
| What the ingestor does with it | The same as for any file: summary, the Dokumentart (the admin's choice, else the one a person set on the replaced version, else the file-name guess), the display title seeded from the file name, and the replacement of the previous version's chunks |

**An upload** (`POST /v1/admin/oib/documents`, one PDF or a ZIP of PDFs) calls `oib_sync.store_and_request(name, bytes, doc_class)`: under the document's lock it stores the object, writes the row and the cache file, and queues the job, then answers. A cycle cannot queue the file between the row and the job. A store that refuses the object fails the request, and no job is made for a file that was never kept; a queue that refuses the job fails it too, and the file stays, to be queued by the next cycle. Uploading the same bytes twice is one job.

**A sync cycle** (`oib_sync.sync()`) is housekeeping. It runs

- every ten minutes, as the base-corpus housekeeping route `POST /v1/maintenance/housekeeping/base-corpus` (internal token). On Kubernetes that is the `housekeeping-base-corpus` CronJob (`deploy/pulumi/src/app/workers.ts`, `*/10 * * * *`, `concurrencyPolicy: Forbid`); in Compose it is the housekeeping clock (`frontends/ui/workers/housekeeping-clock.js`);
- on demand, as `POST /v1/admin/oib/sync`, the admin's "run it now". It calls the same function.

There is no sync at boot and no boot thread. A cycle does bookkeeping and queues; it ingests nothing:

```
sync()
  keyed_lock("oib-sync")                       one cycle at a time, across replicas
  ├─ read every row
  ├─ if rows claim ingestion but the collection is empty: drop their jobs, forget all ingested hashes
  ├─ settle(rows)                              read each unfinished file's job in the ingest status store
  │     job finished, file SUCCESS  → mark_ingested(name, sha256, version)
  │     job ran and gave up / died  → mark_failed(name, sha256, job id)
  └─ for each file with no job for its current bytes:
        request_ingestion(name)
          keyed_lock("oib-file:<name>")
          ├─ re-read the row; if current, or a job exists → nothing
          └─ prepare_job(..., job_id=job_id_for(row)) + enqueue_only
  returns {enqueued, ingested_recorded, failed, total}
```

Run twice, the second cycle queues nothing: the job exists, waiting or running. A job that dies (every claim lost, so the queue row is `dead`) or that ran and failed shows as `failed`; the cycle counts it in `failed`, records the job id in `failed_job_id` (the status row is pruned after an hour and a ran-and-failed job leaves no dead queue row, so the table is the memory), and does not queue the file again until the bytes change (a new job id) or an admin re-indexes it.

---

## The cache

`ensure_local(name)` is the one way to get a path: it looks the name up in the table, downloads the object if this process lacks the current bytes (to a temp file beside the target, verified against the row's sha256, then renamed into place), and returns the path. A file counts as present when its sha256 equals the row's; hashes are memoised by size and mtime, so the check is a `stat`.

- A name the table does not list returns `None`, and any copy this process still holds is deleted: the table says what exists.
- A listed file that cannot be fetched (the object is gone, the hash does not match) raises `CorpusStoreError`; a table that cannot be read raises too. Neither is "not in the corpus", and nothing is deleted on a guess.

What calls it: ingestion, `GET /v1/oib/documents/{file_name}` (the PDF viewer; 404 for a name the table does not list, 503 for a listed one the store cannot serve), the corpus export (`GET /v1/admin/oib/corpus.tar.gz`, which fails rather than ship half a corpus) and the chat tool `view_knowledge_image`.

---

## Deleting

`DELETE /v1/admin/oib/documents/{file_name}` deletes. There is no exclusion list and no second kind of removal. It takes the document's lock, then removes, in this order, the file's ingest job (status and queue row, so a queued job never runs and a running one stops before it writes), the chunks, the summary registration, the row, the object (through the BFF) and this replica's cached file. The row goes after the chunks, so a failure in between leaves the document listed and a retry finds it; the object goes after the row, so a failure there leaves an unreachable object that a later upload of the same name overwrites. A name only the index knows (chunks a half-finished delete left behind, a restored vector store) is cleared the same way; the status shows it as `removed`. Uploading the same file again adds it back.

---

## The status view

`GET /v1/oib/status` merges the table with the Chroma file listing and with the file's job in the ingest status store, one entry per file. It calls `oib_sync.settle` first, so a file whose job has just finished reads `ingested` at once instead of at the next cycle:

| State | Meaning |
|-------|---------|
| `ingested` | The index was built from the file's current bytes by the current pipeline, and chunks exist |
| `stale` | The file changed (or the pipeline did) since it was ingested; the index still reflects the old version |
| `pending` | Never ingested, or its job is queued or running |
| `failed` | Its ingest job ran and gave up, or every worker that claimed it died. It is not queued again until the file changes or an admin re-indexes it |
| `inconsistent` | The table says ingested, the collection holds no chunks for it |
| `removed` | The collection holds chunks for it, the table does not list it. Delete the document to clear them |

The fields per file are `file_name`, `state`, `size_bytes`, `chunk_count`, `ingested_sha256`, `current_sha256`, `ingested_at`, `summary`, `doc_class`, `doc_class_suggestion` and `display_title`; the summary carries a count per state (`ingested`, `stale`, `pending`, `failed`, `removed`, `inconsistent`) and `total_chunks`.

---

## Concurrency

| Lock | Protects |
|------|----------|
| `keyed_lock("oib-sync")` | One sync cycle at a time, across replicas |
| `keyed_lock("oib-file:<name>")` | The decision to queue a job for **one** document, an upload's store plus its enqueue, and `remove_document`. Held for milliseconds, never for an ingestion. Different documents stay fully concurrent |

`keyed_lock` waits, in this process and, on Postgres, across replicas (a Postgres advisory lock); without Postgres only the process lock holds. The ingestor also serialises the replacement of one document's previous version, under its own key. Two workers cannot run one job: the queue claim is exclusive and the job id is unique.

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
| `GRID_INGEST_QUEUE` | on when a database is set | `off` turns the durable ingest queue off. The base corpus then cannot be ingested: uploads and sync cycles fail loudly |
| `OIB_COLLECTION_NAME` | `oib_knowledge` | Target ChromaDB collection |
| `AIQ_CHROMA_URL` / `AIQ_CHROMA_DIR` | none / `/tmp/chroma_data` | The shared Chroma server, or the embedded store's directory (Compose and local development only) |

---

## Getting PDFs in

Upload them in the platform-admin UI. A developer with a directory of PDFs runs

```bash
GRID_ADMIN_TOKEN=... uv run python scripts/upload_oib_corpus.py data/oib --url http://localhost:8000
```

which sends each PDF through `POST /v1/admin/oib/documents` (header `X-Admin-Token`). The upload queues one ingest job per file; watch `/v1/oib/status`.

---

## Ingestor initialization

`oib_sync` imports `knowledge_layer.llamaindex.adapter` lazily to register the ingestor backend with the factory, then obtains an ingestor, which it uses only to prepare jobs and to read and clean the collection, via:

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
       │   │                              │ table: oib_corpus_files (AIQ_SUMMARY_DB)
       │   │                              │ writes: BFF presigned URLs / delete
       │   │                              │ reads:  aiq_agent.common.seaweed_s3
       │   │                              └ cache:  GRID_BASE_CORPUS_CACHE_DIR
       │   └── turn/api_seam.enqueue_ingest_job ─► aiq_api.jobs.ingest_dispatch.enqueue_only ─► ingest_job_queue
       │                                                          │ claimed by
       │                                                          ▼
       │                                         ingest workers (QueueSource) ─► CorpusObjectDownload
       ├── knowledge_layer.llamaindex.adapter   (prepare_job; the worker runs the job)
       ├── aiq_agent.knowledge.ingest_status_store (job outcomes, read by settle)
       ├── aiq_agent.knowledge.leader_lock
       └── ChromaDB (oib_knowledge collection)
```

The OIB collection is included as the default `base_collection` in every query's scope (see [Collection Scoping](collection-scoping.md)).
