# Document Management

Upload your files to make them searchable by the AI. Documents are ingested into a vector knowledge base, allowing the AI to reference their content when answering your questions.

---

## Uploading Documents

There are two upload zones in the UI:

- **Project upload zone** — appears in the Data Sources panel when a project is active. Files uploaded here are scoped to the project (`proj_{projectId}` collection) and shared with everyone who has access to that project.
- **Chat upload zone** — appears within a conversation. Files uploaded here are scoped to that session (`s_{conversationId}` collection) and visible only within that conversation.

To upload, drag and drop files onto the upload zone or click to browse. Multiple files can be uploaded at once.

The project Files workspace shows folders, the file grid, and the preview side by side on desktop. On small screens the panes stack — folders above the file grid — and selecting a file opens the preview as a full-screen overlay with a close button.

### Folders

The folder tree in the left pane is the project's filing system, and it supports the full set of operations — not just creating folders.

- **Create** — `New folder` at the bottom of the tree adds a top-level folder; hovering a row reveals a `+` (`Add subfolder in {name}`) that nests one inside it. Both open an inline name field; Enter commits, Escape cancels.
- **Rename** — the row's `⋯` menu → `Rename…` turns the row itself into an input, pre-filled with the current name. Enter commits, Escape cancels, and a name that did not change makes no request at all. If the rename fails the row stays in edit mode with your text intact, so nothing is retyped.
- **Move** — `PATCH …/folders/{folderId}` accepts a new `parentId`; moving a folder into itself or into one of its own subfolders is refused rather than silently producing a loop.
- **Delete** — the same menu's `Delete…`. The folder goes to the project's **Papierkorb** with its subfolders and documents: *"Move the folder 'Brandschutz' to the bin? Its subfolders and documents go with it. From the bin it can be restored with its access until it is permanently deleted."* The toast says until when: *"'Brandschutz' is in the bin. Restorable until 20 Oct 2026."* It is gone from every listing, search and answer at once, and restorable for 14 days from the bin icon in Files; then it is deleted for good. A folder holding a folder you may not edit is refused. The whole story: [Deleting folders: the Papierkorb](sensitive-data-and-access.md#deleting-folders-the-papierkorb).

Each of these is a write in the folder. In a folder whose access list gives you only **Lesen**, the tree and the file grid mark it **Nur lesen** and offer none of them, nor upload or moving a document in or out; the route refuses them too (403, `reason: folder-read-only`). Who may read and edit a folder: [sensitive data and access](sensitive-data-and-access.md#who-may-read-and-edit-a-folder).

Renaming or moving a folder rewrites the stored path of everything beneath it in the same transaction, so a deeply nested document is never left pointing at a path that no longer exists.

**Moving a document between folders** is in the document's own `⋯` menu, under `Move to folder`. Until now a file was filed once, at upload, and stayed there: a document dropped in the wrong folder — or uploaded before the folder existed — could not be re-filed at all. Each destination is listed by its full path (`Brandschutz / Fluchtwege`), because two branches of a tree can both hold a *Fluchtwege*; the folder the document is in now carries a check and cannot be picked; and **All Files** is a real destination, so a document can be taken back out of every folder. The move also re-files the document on the assistant's side, so what Piloti says about where a document lives follows it immediately (see ADR-0049).

**The assistant knows your folders.** When you file a document, the folder travels
with it into the knowledge base, so the agent can answer "welche Unterlagen habe
ich in Brandschutz" from the actual filing rather than guessing from file names,
and it can search inside one folder — including everything nested under it, so
asking about `Brandschutz` also reads `Brandschutz/Fluchtwege`. Renaming or
moving a folder updates what the assistant sees too; it may take one more
question before a very recent rename shows up in its answers. Documents that were
never filed simply have no folder, and the assistant says nothing about one.

### The file card grid

Files render as cards in a responsive grid. Each card shows:

- a **content-aware skeleton thumbnail** — the sketch is picked from the document's ingestion tags (or, absent tags, filename heuristics / content type): floor plan (Grundriss), section/elevation (Schnitt/Ansicht), site plan (Lageplan), official notice (Bescheid), photo, or a generic document
- the file name and, when ingestion generated one, a one-line **AI description**
- a tinted **extension chip** (PDF, DOCX, …), the file size and a relative upload time
- the **ingestion status badge** (Ready / Processing / Failed) — failed cards show the failure reason inline

The last tile of the grid is a dashed **upload card** listing the actually accepted file types and the size limit; drag-and-drop anywhere on the workspace also works. A file dropped on another project page, such as Settings or Members, opens Files and is uploaded there; the chat, the research page and the intake keep their own drop targets.

Right-click a file, a folder, or the empty listing — the same operations as the ⋯ menu, laid out the way Finder and Explorer are: Open, Ask about this, Download, Rename, Move, Copy origin path, Delete on a file; Open, New folder inside, Rename, Move, Delete on a folder; New folder, Upload, View and Sort on empty canvas. The ⋯ stays, top-right on both file and folder tiles, so the menu is still there if you never right-click.

The **detail view** (the list toggle) is a dense sortable table for a corpus past what a card grid can hold. It is fully keyboard-navigable: one tab stop into the list, then arrows to walk it and Home/End to jump to either end — and the tab stop stays on the row you walked to, so tabbing away and back does not return you to the top. Enter opens the row.

A **search field** above the grid filters the current listing client-side by file name, ingestion tags, and the AI description. Folders are the drill-down inside the listing itself (breadcrumb, tiles, `?folder=` in the URL); a search escapes the current folder and runs over everything.

Semantic results arrive in whichever view you are in. In the detail view the ranking is preserved rather than being re-sorted by upload date: **Relevance** is the column the list opens sorted by (and can be sorted the other way), and each row carries the passage that matched with its page number in place of the document's summary.

### When an upload is refused

Files are validated before anything leaves the browser: type, individual size, the batch's total size, and duplicates (both within one selection and against what is already there). A rejection names the reason in the language the interface is in — the validator itself is a pure module and keeps an English fallback for callers with no dictionary, but nothing user-facing renders it any more.

A partially rejected batch still uploads: the valid files go, and the panel says how many were skipped and why.

Your office's sensitive-data list can also hold files back, by name before they are sent or by content before any model reads them: see [Sensitive data, quarantine and folder access](sensitive-data-and-access.md).

### Supported File Types

The accepted file types are configured via `FILE_UPLOAD_ACCEPTED_TYPES` (default: `.pdf,.docx,.txt,.md,.csv,.xlsx,.pptx`).

| Extension | MIME Type |
|-----------|-----------|
| `.pdf` | `application/pdf` |
| `.docx` | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |
| `.xlsx` | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` |
| `.pptx` | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| `.txt` | `text/plain` |
| `.md` | `text/markdown` |
| `.html` | `text/html` |
| `.csv` | `text/csv` |
| `.json` | `application/json` |

Spreadsheets index one chunk per worksheet (labelled by sheet name), so a citation points at the sheet. Word files and presentations are indexed from their PDF preview, page by page and with their pictures, so a citation points at the page or slide (see [Word, Excel and PowerPoint files](#word-excel-and-powerpoint-files)). Image uploads (`.png`, `.jpg`, `.jpeg`, `.webp`) are governed by the image-upload flag plus VLM availability, not by this list (see below).

### File Size Limits

The maximum upload size applies to **each file**, not to a batch: a folder of fifty 80 MB plans uploads into the Dateiablage under a 100 MB limit. It is your organization's own limit when Piloti has set one, otherwise the deployment default from `FILE_UPLOAD_MAX_SIZE_MB` (default: **100 MB**, decimal). The upload area shows the limit in force ("max. 100 MB per file"), and Organization → Storage lists it beside the storage quota. Only Piloti's platform staff can change it, between 1 MB and the largest request the deployment accepts. A file over the limit is refused with a message naming it. IFC models (`.ifc`, `.ifczip`) have their own, larger limit (`BIM_MAX_IFC_BYTES`, default 250 MB) that the organization limit does not change.

The total stored per organization is bounded separately by the storage quota.

Additional limits:
- **Chat-session attachments** also have a total: all files on one chat together may not exceed the deployment default (100 MB), or the organization's per-file limit when that is higher, so one admissible file always fits.
- **Chat-session attachments**: `FILE_UPLOAD_MAX_FILE_COUNT` (default: **10 files**) caps how many files one chat session can hold. Project Dateiablage and the Büroablage are **not** under this cap — they are bounded by the organization's storage quota.
- **Duplicate filenames** within a session are rejected
- Files already tracked in the current session are skipped on re-upload
- **A question asked while an attachment is still being read waits for it.**
  Indexing a file takes a few seconds after the upload finishes. If you send a
  question in that window, the turn holds for up to twenty seconds (the status
  line says so) and answers once the file is searchable. A file that takes
  longer is named in the answer as still being processed, so the answer never
  silently omits it.

## Moving a file into a folder

Drag it onto the folder — a card, a row, or „Alle Dateien" in the breadcrumb to
move it back to the top level. The folder lights up as the target while you are
over it. „Verschieben" in a file's overflow menu does the same thing and remains
the way to move a file into a folder you are not currently looking at.

Dragging a file inside Piloti never starts an upload: a drag carrying files from
your desktop and a drag carrying a document already here are different things to
the browser, and only the first raises the upload overlay.

## Uploading a whole folder

A büro onboarding a project moves a directory tree, not a hand-picked list. Two
ways to give Piloti one:

- **„Ordner hochladen"**, beside the upload button in a project's Dateiablage.
- **Dragging the folder** onto the file area. A dropped folder used to do
  nothing at all — the browser reports directories through a different API than
  loose files, and the old handler read only the loose ones — so the overlay
  appeared, the finger let go, and nothing happened.

Everything under the folder is uploaded, at any depth. What Piloti will not read
is refused per file, in the usual upload report; the folder as a whole is never
rejected for containing one file of the wrong kind.

**The original path is recorded, and shown.** A file that arrives this way keeps
where it came from — `Wohnbau Nord/03_Einreichung/Grundrisse/EG.pdf` — visible
under „Herkunft" in the file's detail panel and copyable with a click. That is
deliberately not the same thing as the folder you file it into here: Piloti's
folders are yours to rename and rearrange, while the origin is a fact about the
file and is never rewritten. The point of it is that you can go back and work on
the ORIGINAL on the office server, instead of downloading a copy that diverges
from the moment you save it.

Very large drops are bounded (files, depth, and a time limit). When a bound is
reached you are told the upload is incomplete rather than left with a silently
partial one — a bulk upload that quietly took the first half is worse than one
that refuses, because the missing files look exactly like files nobody chose.

Project and Büroablage uploads are bounded by the organization's **storage
quota** and by the **per-file** size limit. The batch total-size limit applies
only to chat-session attachments: it exists for a conversation, which has no
quota behind it.

## Uploading a ZIP

A `.zip` can be dropped on the file area, or picked with the upload button, in a
project's Dateiablage and in the Büroarchiv alike. Piloti treats it as the
folder it contains: the ZIP is unpacked in your browser and then goes through
exactly what a dropped folder goes through — the „Wollen Sie aktualisieren?"
plan, the folders it names created in one step, a file that is already here
offered as a new version, an unchanged one left alone.

- **Where the files land.** If the ZIP has one top-level folder (what „Komprimieren"
  makes), that folder is recreated where you are standing. If it holds loose
  files, they go into a folder named after the ZIP.
- **What is left out without a word:** the files macOS and Office put inside
  archives (`__MACOSX`, `.DS_Store`, `~$…`, `Thumbs.db`). Nobody meant to upload
  them.
- **What is refused, with a message:** a ZIP that cannot be read (damaged, or
  protected by a password), an empty one, one with more than 2,000 files, or one
  that unpacks to more than 1 GB. The whole ZIP is refused, never its first
  half — the missing files would look exactly like files nobody chose. Other ZIPs
  dropped with it are unaffected.
- **Types Piloti does not read** inside a ZIP are refused per file in the usual
  upload report, like any other file. A ZIP inside a ZIP is not unpacked.
- **An `.ifczip` is not a ZIP of documents.** It is a building model and is
  uploaded as one, as before.

File names in ZIPs made by very old Windows versions, which did not mark their
names as UTF-8, can show garbled umlauts; renaming the folder in Piloti fixes it.

**Re-uploading a file that is already there replaces it.** Dropping a corrected
plan under the same name into the same project, the Büroablage, or the same chat
points the existing document at the new bytes and re-indexes it: the document
keeps its identity, so citations, chat subjects and folder placement all
survive, and the organization is charged for one copy rather than two. The
previous version's thumbnail and parsed model are discarded with it, so nothing
rendered from the old bytes is shown as if it were the new ones. The old
passages are removed only once the new file has been indexed: if it cannot be
(a password-protected PDF, a file with no readable text), the upload is marked
as failed and search keeps finding the previous version until a working file
replaces it, while the download already returns the new file. The preview says
so under the failure reason, for a document with more than one version. A file
that fails partway through indexing leaves none of its passages behind, and two
people re-uploading one name at once end with the version indexed last. The database
enforces one live document per name and collection, so two uploads racing each
other cannot recreate the duplicate either. This is the behaviour the
ingestion pipeline already had — it replaces a document's passages by filename —
and the file list now agrees with it. Before, a re-upload left the first entry
listed and downloadable but findable by nothing, because its passages had been
replaced by the second one's.

The browser-side duplicate warning above is a convenience and is per-browser: it
is remembered locally, so it does not appear in a different browser or a private
window. The replacement rule is enforced on the server and does not depend on it.

---

## Upload Progress

When you select files, the UI shows each file's status in real time:

1. **uploading** — File is being uploaded to the server (POST to `/api/documents/upload`)
2. **ingesting** — File has been received and sent to the ingestion pipeline
3. **completed** — Ingestion finished successfully; the document is searchable
4. **failed** — Ingestion encountered an error (hover the row for details)

After upload, the `UploadOrchestrator` polls the ingestion job every 5 seconds via `/api/v1/documents/{jobId}/status` until the job reaches a terminal state, for at most 420 attempts (~35 minutes). Running out of that budget, or a job the backend no longer knows, is not a failure: the rows keep reading „Wird gelesen“, a notice says reading continues in the background, and the workspace listing settles them when the documents finish. A file that is open in the preview asks `/api/documents/{id}/status` on its own and shows the summary, page count and tags as soon as indexing finishes.

On **page refresh**, the orchestrator resumes polling from persisted job state in localStorage, so in-progress uploads are not lost.

A batch in which **everything succeeded** retires its panel a few seconds after it settles — success gets confirmed and then out of the way. A batch containing anything failed or canceled never retires on its own, because those rows carry an action. The countdown **holds** while the pointer is over the panel or keyboard focus is inside it, and starts again when you leave: an unattended panel gets out of the way, one being read does not.

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
4. **Background ingestion** — the LlamaIndex backend extracts text (pdfplumber for PDFs and for the PDF rendition of a Word or presentation file; dedicated office extractors for spreadsheets, one chunk per sheet), optionally extracts tables (`pdfplumber`) and images (`pypdfium2`) with VLM captioning, chunks the content, generates embeddings via NVIDIA models, and stores the vectors in ChromaDB.
5. **Status polling** — The `UploadOrchestrator` polls the backend job through `/api/v1/documents/{jobId}/status`. Document lists and the open preview read `/api/documents/{id}/status`, which reconciles the `documents` row with the backend and returns its status together with the summary, page count, chunk count, content types and tags. Details: [Document ingestion, step 5](../technical-reference/document-ingestion.md#step-5-status-polling).
6. **Searchable** — Once `status = 'completed'`, the document's chunks are queryable via the knowledge search function.

---

## The "Read by Piloti" Panel (files-metadata-panel flag)

With the `files-metadata-panel` feature flag on (the default while flag
enforcement is off), the preview pane leads with a **Read by Piloti** panel
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

### Word, Excel and PowerPoint files

Office files (`.docx`, `.xlsx`, `.pptx`, their older and OpenDocument
counterparts, and `.rtf`) open in the preview as a **PDF preview**. Piloti
converts the file to a PDF and shows that in the same viewer as any other PDF,
so a citation to an office file opens the document instead of only offering a
download. The pane says that it is showing a PDF preview of the original.

**Download always gives the original file**, unchanged. The PDF is a copy for
reading; nothing is edited or replaced.

What to expect:

- The first time an older file is opened, the preview shows „PDF-Vorschau wird
  erstellt…" while it is converted. Files uploaded since the change are
  converted during upload.
- The PDF is LibreOffice's rendering, not Word's or Excel's. Layout can shift a
  little, and a font the server does not have is replaced by a similar one.
- A citation to a Word document or a PowerPoint slide opens at the page it
  came from. A citation to an Excel sheet opens at page 1, because one sheet can
  print across several pages.
- If conversion is not set up for your installation, or fails for a file, the
  pane shows the placeholder and the Download button as before.

**Pictures in Word and PowerPoint files are read.** Piloti indexes these files
from the PDF, the same way it reads a PDF you upload: a photo, a pasted plan or
a rendering on a slide gets a description, and a question about it can find it
and cite it. PowerPoint speaker notes are still read from the original file,
because the PDF leaves them out. Excel files keep being read sheet by sheet, as
tables.

- While the PDF is being made, the upload shows „Wird gelesen“. It turns into
  Ready once the file is indexed, which for a large deck can take a few minutes.
  The conversion is a background job that survives a server restart; a folder of
  hundreds of files is worked through in turn and does not delay other offices.
- Files uploaded before this change keep their old index: their text is
  searchable, their pictures are not, and a Word citation opens at page 1.
  Choose „Erneut lesen“ in the file's ⋯ menu to have it read the new way.
  Uploading the same file again does not: identical bytes are skipped as
  „Unverändert“. Until the new reading finishes, answers use the old one.
- A diagram drawn with Office shapes or SmartArt is not a picture to Piloti.
  Its labels are text and are found; its layout is not described.
- If the PDF cannot be made, the file shows „Lesen fehlgeschlagen“ with the
  reason, and „Erneut lesen“ tries again. It stays stored and downloadable.
  Excel files are the exception: they are still read, only without a thumbnail.

Why it works this way: [ADR-0070](../adr/0070-office-files-are-viewed-through-a-pdf-rendition.md)
for viewing, [ADR-0071](../adr/0071-word-and-presentation-files-are-indexed-from-their-rendition.md)
for indexing.

---

## Project-Scoped vs Session-Scoped Documents

| Scope | Collection Pattern | Visibility | TTL Cleanup |
|-------|--------------------|------------|-------------|
| **Büroablage (org-wide)** | `archiv_{orgId}` | Every project in the organization | Never (persistent) |
| **Project** | `proj_{projectId}` | All project members | Never (persistent) |
| **Session** | `s_{conversationId}` | Only within that conversation | Deleted after 24 hours (configurable via `AIQ_COLLECTION_TTL_HOURS`) |

Session-scoped collections are prefixed with `s_` and are automatically reaped by the `TTLCleanupMixin` background thread that runs periodically (every `AIQ_TTL_CLEANUP_INTERVAL_SECONDS`, default 3600s).

### The Büroablage (ADR-0024)

The **Büroablage** (English UI: *Office filing*) is a top-level document store
that lives above projects, reachable from the navigation (Büroablage). Until
October 2026 it was called „Archiv“; the URL `/app/archiv`, the permission
`org:archiv:manage` and the collection `archiv_{orgId}` keep that name. It is a
different thing from the „Stilllegen“ action on a project document. Anything uploaded there is shared with **every
project in your organization** — every project's chat automatically searches the
Büroablage alongside its own documents and the base corpus, with no per-project
re-upload. Any member can browse, preview, and download Büroablage documents;
uploading and deleting require the **`org:archiv:manage`** permission (org admins
have it). It is the same workspace as the project Files tab — upload, ingestion, preview and folders. The feature is gated by the `organization-archiv` feature flag
(available to all orgs while flag enforcement is off; targeted per-org once on).

The Büroablage is the project Files workspace over the office's shelf: **one
component, two shelves** (`FileWorkspace`; see
[`docs/ux/file-upload-and-explorer.md`](../ux/file-upload-and-explorer.md#one-workspace-two-shelves)).
Everything described for a project's Dateien above — folders, moving files by
menu or drag, uploading a whole folder, the cards/list toggle, filters and sort,
search, the preview and its `?doc=` link — works the same here, with the same
words. It keeps the gold office mark (the Büroablage provenance signal used
across the app) and what is specific to the office:

- **Folders** — the office's own tree, separate from every project's. Members
  with `org:archiv:manage` create, rename, move and delete folders and re-file
  documents; deleting a folder never deletes documents, it re-files them into the
  parent. Everyone else can open folders, search, filter, preview and download
  but sees no upload, drag, create, rename, move or delete.
- **Gold kind chip and provenance footer** — a card shows the document's kind
  (floor plan, notice, …) on a gold chip, and cards whose documents carry
  ingestion tags show them as an "Aus: …"/"From: …" line. Documents without
  tags show none, and there is no "verified" marker — the Büroablage has no review
  workflow.
- **Category filter** — the filter menu offers „Kategorie", derived from the
  controlled ingestion tags actually present on the loaded documents (document
  type + OIB discipline). Categories come from the documents themselves;
  creating custom categories is not (yet) supported. This filter is on every
  shelf, not only the Büroablage.
- **Search** — as in a project: typing filters the listing by file name, ingestion
  tags and the AI description, across every folder; Enter runs the semantic
  search over the whole Büroablage. A semantic search that cannot RUN says so and
  offers to run the same query again — it is never reported as "no matches".
- **No assignments and no „Frage zur Datei"** — collaboration is project-scoped
  and the Büroablage has no project chat to ask in.
- **A document that failed to index** carries the reason on its card, and the
  card's ⋯ menu offers „Erneut lesen“ for it, the same retry the preview
  has, where the failure is actually read. An indexed document gets the same
  action behind a confirmation, to read it again. A document with no known
  state gets neither, and only someone who may manage the document sees it.

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
