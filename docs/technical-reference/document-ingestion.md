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
      │                            │ ◄────────────────────────────────────────────── │                    │
      │  {documentId, jobId,       │  202 {job_id} at once:   │                      │                    │
      │   status: "pending"}       │  submit_job(), no GET    │                      │                    │
      │ ◄──────────────────────────┤                          │                      │                    │
      │                            │                          │  job: GET presigned  │                    │
      │                            │                          │  URL (deferred)      │                    │
      │                            │                          │ ◄────────────────── │                    │
      │                            │                          │ ──────────────────► │                    │
      │                            │                          │     file bytes       │                    │
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
3. **Store in SeaweedFS** — `PutObjectCommand` with key `org/{orgId}/project/{projId}/doc/{docId}/{filename}` (built by `buildStorageKey()` in `s3.ts`). The filename segment goes through `storageKeySegment`: separators are flattened, and a name the pipelines write beside the original (`_render.pdf`, `_thumb.jpg`, `_img`, `_bim`, compared without case) or a dot-only name gets a `_` prefix, so a user file named `_render.pdf` is stored as `__render.pdf` and cannot be mistaken for a derived object. The row keeps the user's filename
4. **Insert DB row** — Drizzle `documents` table with `status: 'uploaded'`, storing `documentId`, `organizationId`, `projectId`, `createdBy`, `filename`, `storageKey`, `collectionName`, `fileSize`, `contentType`
5. **Generate presigned GET URL** — `getSignedUrl(s3Client, GetObjectCommand, { expiresIn: INGEST_JOB_REF_TTL_SECONDS })`. 24 hours, not the 600 s `SEAWEED_PRESIGNED_URL_TTL_SECONDS` default the other signed reads use: the ingest job downloads the file when the bounded ingest pool reaches it, which can be well after dispatch (Step 3)
6. **Trigger ingestion** — POST to `{BACKEND_URL}/v1/ingest` with `{ file_ref: presignedUrl, collection: collectionName, document_id: documentId, file_name: filename, folder_path }`. `file_name` is the row's own `documents.filename`, stated rather than derived from the presigned URL's last path segment, because it is the join key every chunk purge addresses
7. **Record the job** — on success the row is updated to `status: 'pending'` with `metadata: { ingestJobId }` so status reads can later reconcile the row against the backend job (see Step 5)
8. **Return response** — `{ documentId, jobId, status: 'pending' | 'uploaded' | 'processing' }`

Two kinds of file skip steps 6 and 7 and return `processing` with no ingest
job id: an IFC model (`beginModelExtraction`) and, when `GOTENBERG_URL` is set,
an office file. Each is queued as a `bim_extract` or `office_rendition` job on
`bff_job_queue` (ADR-0079, [`kubernetes.md`](../deployment/kubernetes.md) §6.3c)
and the row remembers the queue job as `metadata.bffJobId`. Without a converter,
a Word, presentation, `.xls` or `.ods` file returns `failed` at once.

### Office files: convert, then ingest

**File**: `frontends/ui/src/lib/documents/service.ts` (`beginRenditionIngest`)

An office file (`isOfficeRenditionSource` on the row's filename and stored type)
is converted to its PDF rendition before it is ingested, by a background job
rather than in the request ([ADR-0071](../adr/0071-word-and-presentation-files-are-indexed-from-their-rendition.md)):

1. The row is set to `processing`, an `office_rendition` job is queued
   (`interactive` for an upload, `bulk` inside a reindex) and the upload
   returns.
2. A `bff-jobs` pod claims the job (fairly across organisations) and runs
   `ensureRendition` (`lib/documents/rendition.ts`), which writes
   `<dir>/_render.pdf` through Gotenberg, with a 120-second timeout. Each BFF
   process runs at most `GOTENBERG_MAX_CONCURRENCY` conversions at once
   (default 2; a pool pod gets `bffJobsRenditionConcurrency`, 1), readers ahead
   of background work, and the 120 seconds start when a slot is held, not while
   the conversion waits for one. The pool's replicas times that number is the
   fleet-wide ceiling, held to Gotenberg's capacity by `gotenberg.spec.ts`.
3. `dispatchIngest` posts to `/v1/ingest` with `preview_ref`, a presigned GET of
   the rendition for the thumbnail, and, when `isIndexedFromRendition(filename)`
   (`lib/documents/preview-types.ts`: Word, presentations, `.xls`, `.ods`),
   `extraction_ref`, the same URL for text extraction. `.xlsx` and `.xlsm` get
   `preview_ref` only.
4. The dispatch sets the row to `pending` with the job id, or to `failed`. A
   throw anywhere around it is retried by the queue, and the last attempt marks
   the row `failed` first, so a row never stays at `processing` because of an
   error nobody saw.

There is no fallback reader. A failed or timed-out conversion of a Word,
presentation, `.xls` or `.ods` file marks the row `failed` with
`RENDITION_REQUIRED_MESSAGE` and dispatches nothing. Without `GOTENBERG_URL` the
dispatch marks such a file failed the same way, before any background work. A
`.xlsx` or `.xlsm` goes out without `preview_ref` and is indexed from the
original, only without a thumbnail. The re-ingest action („Erneut lesen“,
`POST /api/documents/{id}/reingest`) takes the same path and converts again. A
process restart during a conversion gives the claim back and another pod runs
it. A row left at `processing` without a live job (from before the jobs, or one
whose job died) is found by the sweep `POST /api/internal/maintenance/
reconcile-background-work`, which the scheduler worker calls every tick: a row
with no job gets a new one, a row whose job is dead is failed with its reason.

**SeaweedFS config** (`frontends/ui/src/lib/s3.ts`):
- Endpoint: `process.env.SEAWEED_ENDPOINT`
- Bucket: `process.env.SEAWEED_BUCKET || 'grid-documents'`
- Region: `us-east-1`, `forcePathStyle: true`

---

## Step 3: Python Ingest Route

**File**: `frontends/aiq_api/src/aiq_api/routes/ingest.py` (moved from the deleted `src/aiq_agent/fastapi_extensions/` package on 2026-07-03)

```python
POST /v1/ingest
Body: {
  file_ref: str, collection: str, document_id: str,
  file_name: str | None, folder_path: str | None, thumbnail_upload_url: str | None,
  # office renditions (ADR-0070, ADR-0071): presigned GETs of _render.pdf
  preview_ref: str | None, extraction_ref: str | None,
  # provenance, all four together or none (ADR-0054)
  authored_by: str | None, approved_by: str | None, approved_at: str | None, producer: str | None,
}
Status: 202 Accepted
```

The request downloads nothing. The BFF aborts it after ten seconds and sends it
once more, so every second spent before the job id is returned is a false
„failed" waiting to happen: a download here failed any file slower than that,
and a retry landing on another replica while the first attempt was still
downloading.

1. Validates `file_ref` and `collection` are present, and passes `file_ref`, `extraction_ref`, `preview_ref` and `thumbnail_upload_url` through the object-store SSRF gates. It is the only gate those URLs meet: the job fetches them later without asking again
2. With a `document_id`, looks for a live job under the dispatch key (sha256 of `document_id` and the object path of `file_ref`), under a per-key lock on this replica, and answers with that job's id when one exists
3. Otherwise submits to the active ingestor: `ingestor.submit_job([DeferredObjectDownload(file_ref)], collection, config={cleanup_files: True, original_filenames: [...], ...})`. `original_filenames` is `file_name` when the BFF stated one and the URL basename otherwise; it becomes each chunk's `file_name` metadata. A rendition goes in as `extraction_paths: [DeferredObjectDownload(extraction_ref, suffix=".pdf")]`, positional like `original_filenames`, so the chunks are read from the PDF and still carry the original's name (`Bericht.docx`). `DeferredObjectDownload`'s `repr` is `<deferred object download>`: no presigned URL is logged or visible in the job config
4. Returns `{ job_id, status: 'pending', document_id }` (202) and fetches nothing itself. An office original with `preview_ref` and no `extraction_ref` (a spreadsheet) gets the rendition as the job's second deferred download (`preview_paths`), drawn into its thumbnail only after the screen passes (ADR-0086)

A failed submit is a 500 with a fixed message. A missing object, an expired
signature or an unreachable store is no longer a status of this request: it is a
failed file on the job (Step 4).

### Provenance (ADR-0054)

A **published** document Piloti wrote and a person released carries four extra
fields: `authored_by: "agent"`, `approved_by` (the approver's display name),
`approved_at` and `producer`. The route drops all four unless `authored_by` is
the token `agent` — a human document must reach the pipeline byte-for-byte as it
always did — and otherwise puts them on the job config, from which the ingestor
stamps them onto **every chunk's metadata** and onto the `document_metadata`
row's `provenance` column. They are excluded from the embedded text and the LLM
header (a release date carries no retrieval signal, and embedding an approver's
name would shift every chunk of the document toward whoever signed it) and
stored regardless, because retrieval reads them off `Chunk.metadata`.

The names are spelled once, in `src/aiq_agent/common/provenance.py`, which is
also what reads them back. Nothing is inferred: a document with no provenance is
a human document, which is what every unmarked chunk already means. Only a
published version is ever dispatched, so a draft has no chunks at all — see
[`../architecture/agent-document-provenance.md`](../architecture/agent-document-provenance.md)
for the lane and the label, and ADR-0054 for the door.

The ingestion route delegates to the active ingestor singleton, which is set up during NAT function registration.

---

## Step 4: Background Ingestion (`LlamaIndex`)

**File**: `sources/knowledge_layer/src/llamaindex/adapter.py`

The `LlamaIndexIngestor.submit_job()` creates a job with `JobState.PENDING` and hands `_run_ingestion()` to the bounded ingest pool. An entry of `file_paths` is a local path (the multipart upload, the OIB sync) or a deferred download (`/v1/ingest`); the latter is kept unchecked, since nothing is on disk yet.

### `_run_ingestion(job_id, file_paths, collection_name, config)`

For each file:

0. **Download and thumbnail** — a deferred original is downloaded first (`knowledge_layer.deferred_files.resolve_original`): one GET without redirects, into a temp file whose suffix comes from the response's `Content-Type` (the object path as fallback, scrubbed), owned and deleted by the job whether or not `cleanup_files` is set. A failed download fails the file with the stable error `original_download_failed: …` and nothing else is fetched for it, the rendition included; the log names the error class and HTTP status, never the URL. Then the rendition, when there is one. The 400px card thumbnail is drawn later, once the file's upload screen has passed (ADR-0086): from the rendition or a PDF original after its text screen, from an image once it passes on its name, from a spreadsheet's `preview_paths` rendition after its extracted text is screened. A quarantined file has none
1. **Text extraction** — a PDF is read per page with pdfplumber, recording each line's font size and weight (`line_styles`). `.xlsx`/`.xlsm` go through `office_extractors`; `.md`, `.txt`, `.csv` and `.tsv` through `text_formats`, which decodes without dropping a byte (BOM, else strict UTF-8, else cp1252, else Latin-1; the encoding is stored as `source_encoding`). Any other extension falls to `SimpleDirectoryReader`. When the job carries an extraction path for the file, the PDF rendition is read instead and every later step treats it as a PDF: pages, tables, images and visual pages. For a `.pptx` or `.pptm` a companion reads the speaker notes from the original, one unit per slide labelled with its rendition page, because a PDF export drops them. On a job whose config carries `screening`, the [upload screen](#upload-screening-before-the-first-model-call) runs on this extracted text before anything below
   **Chunking.** Every text chunk carries a locator a citation and `read_passage(punkt=…)` can use:

   | Source | Unit | Locator (`punkt_id`) | `page_label` |
   |---|---|---|---|
   | OIB Richtlinie (`oib_doc_class` set) | a Punkt (`punkt_chunking`) | `3.5.2`, `Tabelle 3` | first page |
   | Any other PDF with a heading structure | chunks of ~640 tokens inside a section that may span pages, 96 tokens of overlap inside the section, heading breadcrumb as the first line (`section_chunking`) | the heading's number (`3.2`, `§ 4`, `Artikel 2`), else its title path (`Brandschutz › Allgemeines`) | page the chunk's own text starts on; `page_end` where it ends |
   | A PDF without one | one Document per page, split by `SentenceSplitter` | none | the page |
   | `.md` (the IFC digest too) | one section per ATX heading, packed to the same budget, breadcrumb first | the heading path under the document title (`Geschoße › EG`) | none |
   | `.txt` | paragraph blocks packed to the budget | `Zeilen 12-30` | none |
   | `.csv`/`.tsv` | row groups that each repeat the header | `Zeilen 2-41` (file lines) | none |
   | `.xlsx`/`.xlsm` sheet | row groups that each repeat the header, at most 10,000 rows a sheet; the rest are stated in the last group and counted as `rows_over_cap` on the file's job status | `Raumliste: Zeilen 2-41` | the sheet name |

   A PDF counts as structured when it has at least three headings, at least half its text sits under one, and at most 30% of its lines are headings (`section_chunking.structure_is_usable`). A heading is a short line in a larger type than the body, in bold, or opened by a German numbering; lines that repeat at the top or bottom of most pages are running headers and are dropped. A transcribed page's Markdown ATX headings (`## 1 Befund`) are section headings. A numbered line in body type counts only when its title reads as one: at most 8 words, no finite verb, not ending mid-sentence. A line that runs on in lowercase into a line of another style is not a heading. Locators are normalised, so `§3` and `Art.3` become `§ 3` and `Art. 3`. `read_passage(page=N)` returns the chunks whose `[page_label, page_end]` range covers N, so a section chunk that starts on page 2 and ends on page 3 is found for page 3.
2. **Table extraction** (PDF only, optional) — Uses `pdfplumber` to extract the tables the text pass did not already index as captioned tables; each becomes row groups that repeat the header row (`content_type: "table"`, `table_part` orders them), so the splitter never cuts a table into header-less rows. The tables are read right after the text, before the upload screen, and screened with it: the table pass opens the PDF on its own and also reads a page the text pass lost
3. **Image extraction** (PDF only, optional) — Uses `pypdfium2` to extract images (min 100×100px to filter icons); each image is sent to the VLM API (default: `openai/gpt-6-luna` via OpenRouter — image input verified, caption quality on OIB drawings still open, see the Configuration table) for classification (chart vs image) and captioning; captions become `Document` objects with `content_type: "chart"` or `"image"` metadata

   Every PDFium call in the process (page triage, page renders, image extraction, thumbnails, `view_knowledge_image`) is serialized through `pdfium_lock` in `knowledge_layer/llamaindex/pdfium_lock.py`, because PDFium is not thread-safe; the lock is held per page and image encoding happens after it is released.

4. **Summarization** (optional) — If `generate_summary` is enabled, the first and last chunks are combined and sent, as two **concurrent** calls to the same `summary_model` LLM, for a one-sentence summary and a tag classification (document type + OIB discipline; see "Backfilling tags" below). Both calls independently swallow exceptions/timeouts and return nothing on failure. A deterministic, text-derived fallback summary now fires whenever the LLM summary is missing — for any reason, independent of whether tag classification succeeded — so a document that finishes ingestion always gets a `document_metadata` row (see "Silent summary-row loss" below for the fix and the reconciliation backstop).
5. **Indexing** — All `Document` objects are inserted into a `VectorStoreIndex` backed by ChromaDB with OpenRouter embeddings (`openai/text-embedding-3-large` by default; see "Embedding-model changes" below — stored vectors only match query vectors from the same model)
6. **Job completion** — Status updated to `JobState.COMPLETED` with metadata about chunks, tables, charts, and images created

### Upload screening, before the first model call

A job whose config carries `screening` (the organization's policy, sent by the BFF on `POST /v1/ingest`; see the [endpoint contract](../api/python-endpoints.md)) checks each file's locally extracted text against the office's terms and detectors (`sources/knowledge_layer/src/llamaindex/screening.py`) before any of it is sent to a model. A match fails the file with `error_message` `quarantined:{…}` and the loop moves to the next file; nothing of a quarantined file is transcribed, captioned, summarised or embedded. The job without a policy (the OIB corpus sync) runs exactly as before.

Where it sits, per file, against the five places ingestion sends content out:

| Order | Step | Local or external |
|---|---|---|
| 1 | download | local |
| 2 | text extraction: pdfplumber per page (a rendition for Word and presentation files, plus pptx speaker notes) and the PDF's uncaptioned tables; `office_extractors`, `text_formats` or `SimpleDirectoryReader` otherwise | local |
| 3 | page triage (`page_triage.triage_pdf`, PDFium) | local |
| **4** | **upload screen**: PDF text pages, speaker notes and table row groups, or the extracted documents of any other format | **local** |
| 4a | thumbnail, only when the screen passed (to the office's own object store, ADR-0086) | local |
| 5 | OCR of scanned and garbled pages (`transcription.route_pdf_pages`) | external |
| 6 | image captioning of a standalone image (`_build_image_documents`) | external |
| 7 | VLM enrichment of embedded rasters and drawing pages (`processing.enrich_vlm_batch`) | external |
| 8 | summary and tag classification (`summary_llm`) | external |
| 9 | embeddings (`VectorStoreIndex`) | external |

Each file of a screened job gets `file_details[].screening` on its job status: `quarantined`; `clean` when everything that goes on was screened; `partial` when the text layer was clean but something of the file reaches a model unscreened: pages the triage sends to transcription or drawing analysis (or a PDF it could not measure), or embedded rasters the VLM will caption (pdfplumber's per-page image count, read before any model call; the enrichment step also marks the file `partial` when it sends rasters the count missed); `partial` also when some of the file's text was never read, so never screened: a PDF page the text pass could not read (`pages_failed`; its tables, when the table pass reads them, are screened), or spreadsheet rows past the 10,000-row cap (`rows_over_cap`, not indexed either), or cells the extractors drop or shorten: spreadsheet columns past the 60th and the tail of a spreadsheet or CSV cell longer than 500 characters (`content_cut` on the documents, not indexed either); `unchecked` for a standalone image or a file with no local text. The triage the screen measured is handed to `route_pdf_pages`, so a screened PDF is measured once. Known gaps, accepted for content that cannot be read locally: scanned and drawing pages, standalone images and embedded rasters reach the VLM without being screened; the outcome says so (`partial` or `unchecked`), never `clean`. The thumbnail is drawn after the screen, and only when it passed. The log line for a quarantine names reason kinds and counts only, not the term, the value or the file name.

### A re-upload replaces the previous version once it has indexed

Chunks are keyed by file name within a collection, so a file uploaded under a
name the collection already holds is a new version of that document, not a
second document. The replacement runs in two steps inside `_run_ingestion`,
per file, under a lock on (collection, normalized name):

1. Before the file is read, `_find_previous_versions` reads which chunk ids
   answer to its name and what a person set on their metadata row:
   `doc_class`, `display_title`, `folder_path`. It deletes nothing. The read is
   a Chroma `where={"file_name": {"$in": [...]}}` over the spellings a stored
   version can carry: the name, its percent-encoded forms, and the
   `tmp[8]_`-prefixed names the metadata rows know
   (`find_tmp_upload_names`; Chroma cannot filter by pattern and the prefix is
   random). Its cost is the chunks of the file being replaced; it used to read
   every chunk of the collection, once per OIB PDF. A legacy tmp-prefixed
   version with no metadata row is not found and stays beside its re-upload.
2. After a file reaches `SUCCESS`, `_retire_previous_version` deletes exactly
   those collected ids from Chroma and from the lexical mirror
   (`ChunkTextStore.delete_chunks`), and bumps the collection version. The
   metadata row under the new name is the new version's row and keeps the
   fields people set; a row under another spelling of the name is dropped, and
   its fields were carried onto the new row.

A file that fails (an encrypted PDF, nothing extracted, no VLM key for an
image, any exception) retires nothing: the previous version stays the one
retrieval serves, and the job logs `Kept the previous version of …`. Deleting
first, as this step once did, left such a document with no chunks at all.
The cost is that both versions are retrievable for the length of the job.

A file the upload screen quarantines is the exception. A quarantine holds the
whole document, its earlier screened version included, from everyone but its
uploader and its reviewers until a reviewer releases or deletes it (ADR-0086),
so `_retire_held_predecessor` takes the previous version's chunks out of Chroma
and the lexical mirror as the verdict lands, still under the replacement lock.
It drops no metadata row: the Dokumentart and title a person set wait there for
the release's reading.

A file that fails after some of its chunks were inserted (an embedding batch
timing out halfway through a long PDF) takes those chunks back out:
`_discard_partial_version` deletes, from Chroma and the lexical mirror, the ids
under the name that were not there when the attempt started. Left in, they sat
beside the kept version as part of a version nobody published.

The lock (`keyed_lock` in `aiq_agent/knowledge/leader_lock.py`) is held from
the find until the file is retired or discarded. Without it two jobs uploading
one name at once both collected the same predecessor, both retired it, and both
new versions stayed. With it the second job waits, finds the first job's new
version as its predecessor, and replaces it: the version that finishes last is
the one left. On Postgres it is a session advisory lock on a connection of its
own, taken on `AIQ_LOCK_DB_URL`, the direct DSN and never the pooled one
(ADR-0083), so it holds across replicas and is released when a replica dies;
with SQLite or no database only the in-process lock holds. With Postgres it
fails closed: an unreachable lock database raises, logged, and the file
is marked failed (it does not replace its predecessor unguarded across replicas),
so the failed-ingestion rescan picks it up. An ingest worker on Postgres with no
`AIQ_LOCK_DB_URL` refuses to start.

The base corpus (`src/aiq_agent/oib_sync.py`) relies on the same step: its ingest
jobs run on the queue like any other and nothing deletes a file before it is ingested again.

### A document deleted while it indexed takes its chunks back out

A delete does not wait for the lock. `delete_file` removes the chunks under the
name it is given, and an ingest of that name still running goes on inserting
afterwards. A delete can also land after the upload has recorded its version
and before the dispatch runs (ADR-0054, correction 17), and the dispatch then
indexes a document that no longer exists. Either way a deleted document used to
stay retrievable, with no row behind it.

So once a file is in the vector store, and before its predecessor is retired,
the ingestor asks the BFF whether the document it was dispatched for still
exists: `GET /api/internal/document-exists?documentId=&collection=[&organizationId=]`
with the service token (`knowledge_layer/llamaindex/document_presence.py`,
`_deleted_while_indexing` in the adapter). The job config carries the
`document_id` and `organization_id` that `/v1/ingest` received. On
`{ "exists": false }` the file:

- discards what this attempt inserted, by the same `_discard_partial_version`
  difference a failure uses, from Chroma and from the lexical mirror;
- retires nothing. Under the same name the predecessor may already be a new
  document's first version: a delete, then a new upload of the name that
  indexed while this attempt waited for the lock;
- writes no metadata row, and ends `FAILED` with
  `document_deleted: the document was deleted while it was being ingested`, so
  the end-of-job summary reconciliation, which backfills a row for every
  successful file, does not write one either.

Only a definite "gone" discards. No BFF configured (`FRONTEND_INTERNAL_URL`,
`GRID_INTERNAL_API_TOKEN`), a timeout, a non-200 (including the 404 of a BFF
that predates the route) or a body without a boolean `exists` all read as
"present", and the file indexes as it did before: an unreachable BFF must never
cost a live document its chunks. A job without a `document_id` (the OIB sync,
`/v1/documents`) is never asked about.

`delete_file` does not take the lock instead. The ingestor holds it for the
whole of a file, extraction and embedding included, so a delete behind it would
wait minutes and outlast the BFF's request timeout.

The BFF's delete purges the chunks first and deletes the row last, after the
objects, so an ingest whose check lands between the two still sees the row and
keeps the chunks it inserted after that purge. Every immediate delete therefore
purges once more after the row is gone: the project and Archiv deletes
(`deleteDocument` in `lib/documents/service.ts`, `deleteArchivDocument` in
`lib/archiv/service.ts`), the chat-attachment delete (`deleteSessionDocument`
in `lib/session-documents/service.ts`) and a whole chat's attachment purge
(`purgeSessionDocuments` in `lib/session-documents/cleanup.ts`, for the rows
that pass erased). An ingest that asked before the row went has indexed by
then, and one that asks afterwards reads "gone". That second purge is logged,
never surfaced; the row is already gone, and the weekly orphaned-vector sweep
(`lib/platform/vector-reconcile.ts`) is the net when it fails.

One window remains, narrow and named:

- A delete that runs completely between the check and the metadata writes
  leaves a summary row with no chunks. The `reconcile-summaries` maintenance
  pass forgets such rows ([deletion pipeline](../architecture/deletion-pipeline.md)).

### Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `persist_dir` | `AIQ_CHROMA_DIR` or `/tmp/chroma_data` | ChromaDB persistence directory |
| `embed_model` | `openai/text-embedding-3-large` (via OpenRouter) | Embedding model id; keep it stable, stored vectors only match query vectors from the same model — see "Embedding-model changes" below |
| `chunk_size` | 1024 | Text chunk size (model supports up to 2048 tokens) |
| `chunk_overlap` | 128 | Overlap between chunks |
| `extract_tables` | true (`AIQ_EXTRACT_TABLES`) | PDF table extraction |
| `extract_images` | true (`AIQ_EXTRACT_IMAGES`) | PDF image extraction + VLM captioning, at most `AIQ_MAX_IMAGES_PER_DOCUMENT` (64) per PDF |
| `extract_charts` | true (`AIQ_EXTRACT_CHARTS`) | Index VLM-typed charts as `chart` chunks with structured data; off, as images |
| `vlm_model` | `openai/gpt-6-luna` (via OpenRouter) | VLM for image captioning. TODO: evaluate caption quality on OIB drawings; neither this default nor its predecessor has been measured there |
| `generate_summary` | false | Enable document summarization |
| `summary_model` | null | LLM reference for summarization |

### Embedding-model changes invalidate stored vectors

Stored vectors are only comparable to query vectors from the same model, so
changing the embedding model invalidates every stored vector. The code default
moved from the NVIDIA embedder to `openai/text-embedding-3-large` on OpenRouter:
collections that carry an embedding fingerprint refuse a mismatched model with
an `embedding mismatch` error, while collections written before the fingerprint
existed are adopted silently and just retrieve garbage (see the gotchas
register, `docs/contributing/gotchas.md`).

After any embedding-model change:

1. Delete the Chroma directory (`AIQ_CHROMA_DIR`, `/app/data/chroma_data` in compose).
2. Re-ingest the base corpus (OIB sync) and every project collection.
3. Pin `AIQ_EMBED_MODEL` explicitly wherever the deployment must survive the
   next default change (production does this and is unaffected).

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
   runs at the end of every ingestion job (this ingestor, the base-corpus
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
- **LLM access**: it runs outside the NAT runtime, so it builds an OpenAI-compatible client from env vars that must match the `summary_llm` block in `configs/config_oib_openrouter.yml`: `BACKFILL_SUMMARY_API_KEY` (falls back to the provider key inferred from the base URL, `OPENROUTER_API_KEY` by default), `BACKFILL_SUMMARY_BASE_URL` (default `https://openrouter.ai/api/v1`), `BACKFILL_SUMMARY_MODEL` (default `GRID_DEFAULT_MODEL`, then `openai/gpt-6-luna`).
- **Store**: `AIQ_SUMMARY_DB` (or `--summary-db`); chunk source dir `AIQ_CHROMA_DIR` (or `--chroma-dir`).
- **Exit codes** (for CI): `0` = success (nothing to do, or a completed run with no failures; `--dry-run` always exits `0`), `1` = a real run finished but at least one document failed to classify (`stats.failed > 0`, so a partial backfill can be flagged), `2` = the tagging LLM could not be constructed (no `BACKFILL_SUMMARY_API_KEY` and no provider key for the base URL).

---

## Step 5: Status Polling

Two pollers read two different things.

**Upload progress**: `UploadOrchestrator` (`frontends/ui/src/features/documents/orchestrator.ts`, a singleton outside the React lifecycle)
- Polls the backend JOB every 5 seconds through the BFF proxy: `GET /api/v1/documents/{jobId}/status` (`documentsClient.getJobStatus`), which reaches `GET /v1/documents/{job_id}/status` in `documents.py` and returns `IngestionJobStatus` with per-file progress
- Maximum 420 poll attempts (~35 minutes)
- Persists job state to localStorage for recovery on page refresh
- Updates `TrackedFile` entries in the Zustand store from the job status

**Document status**: `GET /api/documents/{id}/status` (`frontends/ui/src/app/api/documents/[id]/status/route.ts` → `getDocumentStatus` in `lib/documents/service.ts`)
- Reads the `documents` row, reconciling an in-flight row first (see below)
- Returns `{ id, status, filename, displayName, scope, fileSize, contentType, collectionName, errorMessage, createdAt, updatedAt, summary, pageCount, chunkCount, contentTypes, tags, authoredBy, openVersion, versionCount }`. `summary` through `tags` are read-only metadata merged from the backend's collection listing
- Read by the open file preview, the composer's subject bar and the chat's document peek

**The open file follows ingestion live.** `file-preview-host.tsx` polls
`/api/documents/{id}/status` while the open document's status can still change
(`useSettlingRefresh`) and patches every field the payload carries into the
open file: status, error, summary, page count, chunk count, content types, tags
and version count. The summary and tags appear in the pane the moment indexing
finishes, without closing and reopening the file. If a terminal answer still
arrives without a summary, the host polls up to three more times
(`METADATA_GRACE_POLLS`) and then stops, because some documents never get one.

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

A job the backend lost to a restart is not an in-flight job forever: its status
row stops being vouched for by a heartbeat, and the status endpoint answers
`failed` with `error_message` starting `interrupted:` once the heartbeat is two
minutes old, which step 2 records like any other failure and re-ingest can
retry ([python endpoints](../api/python-endpoints.md#ingestion)).

Dispatch (`dispatchIngest` in `service.ts`) sends `POST /v1/ingest` with a
ten-second budget. A timeout is sent once more: the backend is idempotent per
document and object, so the second request joins the job the first one started.
Only a second timeout, a non-2xx answer or a connection that never reached the
backend records `failed` with „Ingestion could not be started".

The collection file list is fetched at most once per collection per request.

Metadata enrichment reads the listing through a 15-second cache
(`loadCollectionFilesCached`), except in two cases that read it fresh and
replace the cache entry:

- the read that moves a row to a terminal status. That read tells every client
  to stop polling, and a cached listing from before the file was indexed would
  have handed them a `completed` with no summary, counts or tags;
- a row whose `updatedAt` is newer than the cached listing, which covers a
  transition written by another read or by re-ingest.

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
