# Document Ingestion Pipeline

End-to-end flow from file upload to vector search.

---

## Overview

```
User's Browser                 Next.js BFF                    SeaweedFS          Python Backend          ChromaDB
      │                            │                          │                      │                    │
      │   POST /api/documents/      │                          │                      │                    │
      │   upload (multipart)        │                          │                      │                    │
      ├───────────────────────────► │                          │                      │                    │
      │                            │                          │                      │                    │
      │                            │  PutObject               │                      │                    │
      │                            │ ──────────────────────► │                      │                    │
      │                            │                          │                      │                    │
      │                            │  INSERT documents (DB)   │                      │                    │
      │                            │                          │                      │                    │
      │                            │  Generate presigned URL  │                      │                    │
      │                            │ ◄────────────────────── │                      │                    │
      │                            │                          │                      │                    │
      │                            │  POST /v1/ingest         │                      │                    │
      │                            │  {file_ref, collection,  │                      │                    │
      │                            │   document_id}           │                      │                    │
      │                            │ ──────────────────────────────────────────────► │                    │
      │                            │                          │                      │                    │
      │  {documentId, jobId,       │                          │   GET presigned URL  │                    │
      │   status: "pending"}       │                          │ ──────────────────► │                    │
      │ ◄──────────────────────────┤                          │                      │                    │
      │                            │                          │ ◄────────────────── │                    │
      │                            │                          │     file bytes       │                    │
      │                            │                          │                      │                    │
      │                            │                          │   submit_job()       │                    │
      │                            │                          │   (background)       │                    │
      │                            │                          │ ────────────────►    │                    │
      │                            │                          │                      │                    │
      │  Poll /api/documents/      │                          │                      │                    │
      │  {id}/status (5s)          │                          │                      │  Extract → Chunk   │
      │ ├─────────────────────────►│                          │                      │  → Embed → Store   │
      │ ◄──────────────────────────┤                          │                      │ ────────────────►  │
      │  {status: "completed"}     │                          │                      │                    │
```

---

## Step 1: Upload (`FileUploadZone` + `useFileUpload`)

**Frontend files**:
- `frontends/ui/src/features/documents/components/FileUploadZone.tsx`
- `frontends/ui/src/features/documents/hooks/use-file-upload.ts`
- `frontends/ui/src/features/documents/orchestrator.ts`

The user selects files via the `FileUploadZone` (drag-and-drop or click-to-browse). The `useFileUpload` hook:

1. Validates files against configured limits (`FILE_UPLOAD_ACCEPTED_TYPES`, `FILE_UPLOAD_MAX_SIZE_MB`, `FILE_UPLOAD_MAX_FILE_COUNT`)
2. Checks for duplicate filenames in the current session
3. Creates `TrackedFile` entries in the Zustand store (status: `uploading`)
4. Ensures the target collection exists via `ensureCollectionExists()`
5. Extracts `projectId` from the collection name (`proj_{projectId}` → `{projectId}`)
6. POSTs each file as `multipart/form-data` to `/api/documents/upload` with `projectId` + `file`

---

## Step 2: BFF Upload Route

**File**: `frontends/ui/src/app/api/documents/upload/route.ts`

```typescript
POST /api/documents/upload
Content-Type: multipart/form-data
Body: { projectId: string, file: File }
```

1. **Auth check** — `requireAuthorizedSession()` + `requireProjectAccess(session, projectId, 'project:edit')`
2. **Generate documentId** — `uuidv4()`
3. **Store in SeaweedFS** — `PutObjectCommand` with key `org/{orgId}/project/{projId}/doc/{docId}/{filename}` (built by `buildStorageKey()` in `s3.ts`)
4. **Insert DB row** — Drizzle `documents` table with `status: 'uploaded'`, storing `documentId`, `organizationId`, `projectId`, `createdBy`, `filename`, `storageKey`, `collectionName`, `fileSize`, `contentType`
5. **Generate presigned GET URL** — `getSignedUrl(s3Client, GetObjectCommand, { expiresIn: SEAWEED_PRESIGNED_URL_TTL_SECONDS || 600 })`
6. **Trigger ingestion** — POST to `{BACKEND_URL}/v1/ingest` with `{ file_ref: presignedUrl, collection: collectionName, document_id: documentId }`
7. **Record the job** — on success the row is updated to `status: 'pending'` with `metadata: { ingestJobId }` so status reads can later reconcile the row against the backend job (see Step 5)
8. **Return response** — `{ documentId, jobId, status: 'pending' | 'uploaded' }`

**SeaweedFS config** (`frontends/ui/src/lib/s3.ts`):
- Endpoint: `process.env.SEAWEED_ENDPOINT`
- Bucket: `process.env.SEAWEED_BUCKET || 'grid-documents'`
- Region: `us-east-1`, `forcePathStyle: true`

---

## Step 3: Python Ingest Route

**File**: `frontends/aiq_api/src/aiq_api/routes/ingest.py` (moved from the deleted `src/aiq_agent/fastapi_extensions/` package on 2026-07-03)

```python
POST /v1/ingest
Body: { file_ref: str, collection: str, document_id: str }
Status: 202 Accepted
```

1. Validates `file_ref` and `collection` are present
2. Downloads the file from the presigned URL via `httpx.AsyncClient` (follows redirects)
3. Infers file suffix from `Content-Type` header or URL path
4. Saves to a `tempfile.NamedTemporaryFile`
5. Submits to the active ingestor via `ingestor.submit_job([temp_path], collection, config={cleanup_files: True, original_filenames: [...]})`
6. Returns `{ job_id, status: 'pending', document_id }`

On failure, the temp file is cleaned up in the `finally` block. The ingestion route delegates to the active ingestor singleton, which is set up during NAT function registration.

---

## Step 4: Background Ingestion (`LlamaIndex`)

**File**: `sources/knowledge_layer/src/llamaindex/adapter.py`

The `LlamaIndexIngestor.submit_job()` creates a job with `JobState.PENDING` and spawns a daemon thread running `_run_ingestion()`.

### `_run_ingestion(job_id, file_paths, collection_name, config)`

For each file:

1. **Text extraction** — `SimpleDirectoryReader(input_files=[file_path])` loads the file content into LlamaIndex `Document` objects
2. **Table extraction** (PDF only, optional) — Uses `pdfplumber` to extract tables as markdown; each table becomes a `Document` with `content_type: "table"` metadata
3. **Image extraction** (PDF only, optional) — Uses `pypdfium2` to extract images (min 100×100px to filter icons); each image is sent to NVIDIA's VLM API (default: `nvidia/nemotron-nano-12b-v2-vl`) for classification (chart vs image) and captioning; captions become `Document` objects with `content_type: "chart"` or `"image"` metadata
4. **Summarization** (optional) — If `generate_summary` is enabled, the first and last chunks are combined and sent, as two **concurrent** calls to the same `summary_model` LLM, for a one-sentence summary and a tag classification (document type + OIB discipline; see "Backfilling tags" below). Both calls independently swallow exceptions/timeouts and return nothing on failure. A deterministic, text-derived fallback summary now fires whenever the LLM summary is missing — for any reason, independent of whether tag classification succeeded — so a document that finishes ingestion always gets a `document_metadata` row (see "Silent summary-row loss" below for the fix and the reconciliation backstop).
5. **Indexing** — All `Document` objects are inserted into a `VectorStoreIndex` backed by ChromaDB with NVIDIA embeddings (`nvidia/llama-nemotron-embed-vl-1b-v2`)
6. **Job completion** — Status updated to `JobState.COMPLETED` with metadata about chunks, tables, charts, and images created

### Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `persist_dir` | `AIQ_CHROMA_DIR` or `/tmp/chroma_data` | ChromaDB persistence directory |
| `embed_model` | `nvidia/llama-nemotron-embed-vl-1b-v2` | NVIDIA embedding model |
| `chunk_size` | 1024 | Text chunk size (model supports up to 2048 tokens) |
| `chunk_overlap` | 128 | Overlap between chunks |
| `extract_tables` | false | Enable PDF table extraction |
| `extract_images` | false | Enable PDF image extraction + VLM captioning |
| `extract_charts` | false | Enable chart extraction with structured data |
| `vlm_model` | `nvidia/nemotron-nano-12b-v2-vl` | VLM for image captioning |
| `generate_summary` | false | Enable document summarization |
| `summary_model` | null | LLM reference for summarization |

### TTL Cleanup

Session-scoped collections (`s_*`) are automatically reaped by a background thread. Default TTL is 24 hours (`AIQ_COLLECTION_TTL_HOURS`), checked every 3600 seconds (`AIQ_TTL_CLEANUP_INTERVAL_SECONDS`). Base/project collections are never auto-deleted.

### Backfilling tags for documents ingested before tagging existed

Ingestion now also classifies each document into controlled tags (document type + OIB discipline), stored on the `document_metadata` table alongside the one-sentence summary. Documents ingested **before** this feature shipped have a summary but `tags = NULL`, and OIB sync is hash-gated (an already-ingested, unchanged document is never re-processed), so they will never pick tags up on their own.

Run the classify-only backfill **once** after deploying the tagging feature:

```bash
python scripts/backfill_document_tags.py --dry-run          # preview, writes nothing
python scripts/backfill_document_tags.py                    # every collection with summaries
python scripts/backfill_document_tags.py --collection oib_knowledge
python scripts/backfill_document_tags.py --force            # re-classify rows that already have tags
```

It never re-ingests or re-embeds and never touches the summary — it only fills the `tags` column. It is idempotent (rows with tags are skipped unless `--force`) and fail-soft per document.

### Fixed: silent summary-row loss on double LLM failure (2026-07-16)

The summary and tag-classification calls in Step 4 above run concurrently
against the same `summary_llm` (`sources/knowledge_layer/src/llamaindex/adapter.py`,
~lines 1795–1965) and both fail open (log a warning, return `None`) on
error/timeout. `register_summary()` — the only call that writes a row into
the `document_metadata` table — only runs when a summary value exists. Previously the
deterministic fallback summary (derived from already-extracted text) only
covered the case where *tagging* succeeded but *summarization* didn't, so a
**double** failure left the document indexed into ChromaDB and marked
`SUCCESS` (fully searchable via `knowledge_search`) but with no `document_metadata`
row at all — invisible in `available_documents` (agent prompts, Data Sources
panel summary list), and unrecoverable by the tag-backfill script above
(which only fills `tags` on rows that already exist).

Two fixes landed together, both described in
`docs/architecture/backend-deep-dive.md` §6:

1. **Fallback ungated** (`7bc5cc7`) — the fallback now fires whenever the LLM
   summary is missing, independent of tag-classification success, and reads a
   wider text sample (first + last chunk).
2. **Reconciliation backfill** (`42a4fa3`) — `reconcile_collection_summaries()`
   runs at the end of every ingestion job (this ingestor, `scripts/ingest_oib.py`'s
   `oib_sync`, and any future caller), diffing indexed-and-successful files
   against the `document_metadata` table and backfilling a fallback summary for any
   gap it finds (logged as a WARNING per backfilled document — a gap still
   means the primary path failed, this is a backstop not a silent fix). The
   per-job call is scoped to the job's own successful files (`file_names=…`),
   so it no longer pays the full-collection `list_files` metadata scan on every
   single-file upload.

Recovery no longer requires re-ingesting the file; the reconciliation pass
catches it on the next ingestion run for that collection.

- **Text source**: the document's already-indexed Chroma chunk text when available (the same text ingestion classified from), falling back to the stored summary otherwise.
- **LLM access**: it runs outside the NAT runtime, so it builds an OpenAI-compatible client from env vars that must match the `summary_llm` block in `configs/config_*.yml`: `BACKFILL_SUMMARY_API_KEY` (falls back to `NVIDIA_API_KEY`), `BACKFILL_SUMMARY_BASE_URL` (default `https://integrate.api.nvidia.com/v1`), `BACKFILL_SUMMARY_MODEL` (default `nvidia/nemotron-mini-4b-instruct`).
- **Store**: `AIQ_SUMMARY_DB` (or `--summary-db`); chunk source dir `AIQ_CHROMA_DIR` (or `--chroma-dir`).
- **Exit codes** (for CI): `0` = success (nothing to do, or a completed run with no failures; `--dry-run` always exits `0`), `1` = a real run finished but at least one document failed to classify (`stats.failed > 0`, so a partial backfill can be flagged), `2` = the tagging LLM could not be constructed (missing `BACKFILL_SUMMARY_API_KEY` / `NVIDIA_API_KEY`).

---

## Step 5: Status Polling

**Frontend**: `UploadOrchestrator` (singleton, lives outside React lifecycle)
- Polls every 5 seconds via `/api/documents/{id}/status`
- Maximum 420 poll attempts (~35 minutes)
- Persists job state to localStorage for recovery on page refresh
- Updates `TrackedFile` entries in Zustand store based on job status

**BFF status route**: `frontends/ui/src/app/api/documents/[id]/status/route.ts`
- Reads `documents.status` from Drizzle, reconciling pending rows first (see below)
- Returns `{ id, status, filename, fileSize, contentType, collectionName, errorMessage, createdAt, updatedAt }`

**Python job status**: `GET /v1/documents/{job_id}/status` (in `documents.py`)
- Returns `IngestionJobStatus` with per-file progress via `ingestor.get_job_status(job_id)`

### Status reconciliation (BFF)

**File**: `frontends/ui/src/lib/documents/reconcile-status.ts`

Backend ingestion is fire-and-forget from the BFF's perspective — there is no completion
callback, so the `documents` row would otherwise stay `pending` forever. Instead, the BFF
reconciles lazily on every read of document rows (`GET /api/documents` list and
`GET /api/documents/{id}/status`):

1. For each row with an in-flight status (`pending` / `processing` / `ingesting`), query
   `GET {BACKEND_URL}/v1/documents/{metadata.ingestJobId}/status`
2. Terminal job → update the row to `completed` or `failed` (+ `errorMessage`) in Postgres
3. Job unknown (404 — e.g. backend restart wiped the in-memory job registry) or no recorded
   job id (legacy rows) → fall back to `GET /v1/collections/{collection}/documents` and match
   by filename: `success` → `completed`, `failed` → `failed`
4. Backend unreachable → leave the row untouched; the next read retries

The collection file list is fetched at most once per collection per request.

---

## Step 6: Search (Knowledge Retrieval)

At query time, the `knowledge_retrieval` NAT function:

1. Resolves target collections via `_resolve_target_collections()` (see [Collection Scoping](collection-scoping.md))
2. For each collection, calls `retriever.retrieve(query, collection_name, top_k)` (config `top_k`, default 5; the working OpenRouter config uses 8)
3. The `LlamaIndexRetriever` queries ChromaDB for the `top_k` most similar chunks
4. Results from all collections are merged by relevance score (cosine similarity) with a per-document diversity cap (`max_chunks_per_document`, default 2): a first pass takes at most that many chunks per distinct document (keyed by collection + file_name), then remaining slots up to `top_k` are filled with the highest-scoring leftovers — so cross-cutting questions span multiple Richtlinien instead of all chunks coming from the 1-2 top-scoring PDFs
5. Formatted with citations (filename, page number) for LLM consumption (chunk content truncated at 2500 chars so OIB tables survive intact)

Note this search path reads **only** the ChromaDB vector index — it is
independent of the SQL `document_metadata` table that feeds `available_documents`
(the per-document summary list injected into agent prompts, described above
and in `docs/architecture/backend-deep-dive.md` §6). The two stores remain
architecturally distinct, so a document can in principle be returned here
without a `document_metadata` row (the reconciliation backstop above closes this for
every ingestion path in practice), and conversely `available_documents`
cannot show a document that failed to index into ChromaDB.

---

## File: Download

**File**: `frontends/ui/src/app/api/documents/[id]/download/route.ts`
- Auth check (`requireAuthorizedSession`)
- Reads `storageKey` from the `documents` table
- Generates a presigned GET URL with `ResponseContentDisposition: attachment`
- Returns `{ downloadUrl, filename, contentType, fileSize }`
