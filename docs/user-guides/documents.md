# Document Management

Upload your files to make them searchable by the AI. Documents are ingested into a vector knowledge base, allowing the AI to reference their content when answering your questions.

---

## Uploading Documents

There are two upload zones in the UI:

- **Project upload zone** — appears in the Data Sources panel when a project is active. Files uploaded here are scoped to the project (`proj_{projectId}` collection) and shared with everyone who has access to that project.
- **Chat upload zone** — appears within a conversation. Files uploaded here are scoped to that session (`s_{conversationId}` collection) and visible only within that conversation.

To upload, drag and drop files onto the upload zone or click to browse. Multiple files can be uploaded at once.

The project Files workspace shows folders, the file grid, and the preview side by side on desktop. On small screens the panes stack — folders above the file grid — and selecting a file opens the preview as a full-screen overlay with a close button.

### The file card grid

Files render as cards in a responsive grid. Each card shows:

- a **content-aware skeleton thumbnail** — the sketch is picked from the document's ingestion tags (or, absent tags, filename heuristics / content type): floor plan (Grundriss), section/elevation (Schnitt/Ansicht), site plan (Lageplan), official notice (Bescheid), photo, or a generic document
- the file name and, when ingestion generated one, a one-line **AI description**
- a tinted **extension chip** (PDF, DOCX, …), the file size and a relative upload time
- the **ingestion status badge** (Ready / Processing / Failed) — failed cards show the failure reason inline

The last tile of the grid is a dashed **upload card** listing the actually accepted file types and the size limit; drag-and-drop anywhere on the workspace also works.

A **search field** above the grid filters the current listing client-side by file name, ingestion tags, and the AI description. Top-level folders additionally appear as a quick-filter **chip row** above the grid (the same selection the sidebar folder tree drives — no separate navigation model).

### Supported File Types

The accepted file types are configured via `FILE_UPLOAD_ACCEPTED_TYPES` (default: `.pdf,.docx,.txt,.md`).

| Extension | MIME Type |
|-----------|-----------|
| `.pdf` | `application/pdf` |
| `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| `.pptx` | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| `.txt` | `text/plain` |
| `.md` | `text/markdown` |
| `.html` | `text/html` |
| `.csv` | `text/csv` |
| `.json` | `application/json` |

### File Size Limits

The maximum upload size is configured via `FILE_UPLOAD_MAX_SIZE_MB` (default: **100 MB**). This limit applies per **batch** (total of all files in a single upload operation), not per individual file.

Additional limits:
- **Chat-session attachments**: `FILE_UPLOAD_MAX_FILE_COUNT` (default: **10 files**) caps how many files one chat session can hold. Project Dateiablage and the Büroarchiv are **not** under this cap — they are bounded by the organization's storage quota.
- **Duplicate filenames** within a session are rejected
- Files already tracked in the current session are skipped on re-upload

---

## Upload Progress

When you select files, the UI shows each file's status in real time:

1. **uploading** — File is being uploaded to the server (POST to `/api/documents/upload`)
2. **ingesting** — File has been received and sent to the ingestion pipeline
3. **completed** — Ingestion finished successfully; the document is searchable
4. **failed** — Ingestion encountered an error (hover the row for details)

After upload, the `UploadOrchestrator` polls the job status every 5 seconds via `/api/documents/{id}/status` until the job reaches a terminal state or times out (max 420 attempts / ~35 minutes).

On **page refresh**, the orchestrator resumes polling from persisted job state in localStorage, so in-progress uploads are not lost.

---

## Document Processing Lifecycle

```
User uploads file
       │
       ▼
   ┌──────────┐
   │ uploaded  │  File saved to SeaweedFS, DB row inserted
   └─────┬────┘
         │ BFF calls POST /v1/ingest with presigned URL
         ▼
   ┌──────────┐
   │ pending   │  Ingestion job created (status: 'pending')
   └─────┬────┘
         │ Background thread processes file
         ▼
   ┌──────────┐
   │ ingesting │  Text extracted, chunked, embedded, stored in ChromaDB
   └─────┬────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌────────┐
│completed│ │ failed │
└────────┘ └────────┘
```

### Step-by-step

1. **Upload** — `FileUploadZone` captures the file, the `useFileUpload` hook validates it against configured limits, then POSTs it as `multipart/form-data` to `/api/documents/upload` with `projectId` and `file`.
2. **BFF upload route** — The Next.js API route generates a UUID `documentId`, stores the file in SeaweedFS at `org/{orgId}/project/{projId}/doc/{docId}/{filename}`, inserts a `documents` row in Drizzle (status: `uploaded`), generates a presigned GET URL, and calls the Python backend's `POST /v1/ingest` with that URL.
3. **Python ingest route** — Downloads the file from the presigned URL via `httpx`, saves it to a tempfile, and submits it to the active ingestor via `submit_job()`.
4. **Background ingestion** — `LlamaIndex` extracts text via `SimpleDirectoryReader`, optionally extracts tables (`pdfplumber`), images (`pypdfium2`) with VLM captioning, chunks the content, generates embeddings via NVIDIA models, and stores the vectors in ChromaDB.
5. **Status polling** — The frontend `UploadOrchestrator` polls `/api/documents/{id}/status` which reads the Drizzle `documents.status` column.
6. **Searchable** — Once `status = 'completed'`, the document's chunks are queryable via the knowledge search function.

---

## The "Indexed by Piloti" Panel (files-metadata-panel flag)

With the `files-metadata-panel` feature flag on (the default while flag
enforcement is off), the preview pane leads with an **Indexed by Piloti** panel
showing what ingestion extracted from the document:

- the one-sentence **AI summary** that grounds the agent's answers
- key-value rows from real metadata only: detected **document type** (first
  document-type tag), **project**, **pages**, **passages** (retrieval chunks),
  **contents** (when the document holds more than plain text), and the
  **updated** timestamp
- **editable tags**: remove a tag via its ×, add one through the inline input
  (Enter commits, Escape clears, clicking a suggestion adds it). Tags come from
  a controlled vocabulary (document types + OIB disciplines), so the input
  suggests the allowed labels and free-form values are rejected. Each change
  saves immediately.
- the caption "Automatically detected on upload — your corrections improve
  future answers": tag corrections feed back into retrieval quality.

With the flag off, the preview pane shows only the ungated status/type/size
rows, the raw preview, and download — unchanged behavior.

## Viewing and Downloading Documents

The **Document List** component (`document-list.tsx`) renders all tracked files for the current session, showing:

- **Filename** (truncated if long)
- **File size** (formatted as B/KB/MB)
- **Content type**
- **Status badge** (color-coded: yellow for pending/uploaded, green for success/ingested, red for failed)
- **Error message** (if ingestion failed)
- **Download button** — fetches a presigned S3 URL from `/api/documents/{id}/download` and triggers a browser download

---

## Project-Scoped vs Session-Scoped Documents

| Scope | Collection Pattern | Visibility | TTL Cleanup |
|-------|--------------------|------------|-------------|
| **Archiv (org-wide)** | `archiv_{orgId}` | Every project in the organization | Never (persistent) |
| **Project** | `proj_{projectId}` | All project members | Never (persistent) |
| **Session** | `s_{conversationId}` | Only within that conversation | Deleted after 24 hours (configurable via `AIQ_COLLECTION_TTL_HOURS`) |

Session-scoped collections are prefixed with `s_` and are automatically reaped by the `TTLCleanupMixin` background thread that runs periodically (every `AIQ_TTL_CLEANUP_INTERVAL_SECONDS`, default 3600s).

### The org-wide Archiv (ADR-0024)

The **Archiv** is a top-level document store that lives above projects, reachable
from the user menu (Archiv). Anything uploaded there is shared with **every
project in your organization** — every project's chat automatically searches the
Archiv alongside its own documents and the base corpus, with no per-project
re-upload. Any member can browse, preview, and download Archiv documents;
uploading and deleting require the **`org:archiv:manage`** permission (org admins
have it). It reuses the exact same upload/ingestion/preview experience as the
project Files tab. The feature is gated by the `organization-archiv` feature flag
(available to all orgs while flag enforcement is off; targeted per-org once on).

The Archiv presents itself as the office's **knowledge library** (gold archive
mark = the Büroarchiv provenance signal used across the app):

- **Card grid** — the same content-aware skeleton thumbnails, extension chips,
  one-line AI descriptions, and ingestion-status badges as the project file
  grid; failed cards show the failure reason inline.
- **Category chips** — a filter row derived from the controlled ingestion tags
  actually present on the archive's documents (document type + OIB discipline),
  plus an "All" chip. Categories come from the documents themselves; creating
  custom categories is not (yet) supported.
- **Provenance footer** — cards whose documents carry ingestion tags show them
  as an "Aus: …"/"From: …" line with the gold archive mark. Documents without
  tags simply show none, and there is no "verified" marker — the Archiv has no
  review workflow.
- **Search** — filters the listing client-side by file name, ingestion tags,
  and the AI description, combinable with the category chips.

---

## How Documents Become Searchable

Ingestion turns raw files into a searchable knowledge base:

1. **Text extraction** — `SimpleDirectoryReader` reads the file content
2. **Optional multimodal extraction** — PDFs can have tables extracted (pdfplumber) and images/charts extracted (pypdfium2) with VLM-generated captions (NVIDIA nemotron-nano-12b)
3. **Chunking** — Text is split into overlapping segments (default: 1024 tokens, 128 overlap)
4. **Embedding** — Each chunk is vectorized using NVIDIA's `llama-nemotron-embed-vl-1b-v2` model
5. **Storage** — Vectors are stored in ChromaDB under the target collection
6. **Summarization** — Optionally, a one-sentence summary is generated for each document (configured via `generate_summary` + `summary_model`)

At query time, the AI searches across all collections in scope (see [Knowledge Search](knowledge-search.md) and [Collection Scoping](../technical-reference/collection-scoping.md)).
