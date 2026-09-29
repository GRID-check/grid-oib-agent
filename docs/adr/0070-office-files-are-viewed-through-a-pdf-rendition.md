---
status: accepted
date: 2026-09-29
decision-makers: Grid engineering, product owner
consulted:
informed: everyone working in this repo
---

# Office files are viewed through a PDF rendition that Gotenberg makes

## Context and Problem Statement

Upload accepts `.docx`, `.xlsx` and `.pptx` by default
(`FILE_UPLOAD_ACCEPTED_TYPES`), and ingestion indexes their text, so answers
cite them. Nothing could show them. The preview pane drew a placeholder with a
download button, and a citation to an office file could only download it: the
reader lands in Word or Excel with no page, no highlight, and a second copy on
disk. The pilot feedback listed it as „Office-Viewer"
([triage](../audit/pilot-feedback-triage-2026-09.md), backlog PF-11), and the
triage concluded that any honest fix adds a conversion dependency and needs an
ADR first.

The product already has one viewer that does what a citation needs: pdf.js with
a text layer, page navigation and passage highlight. The question is how an
office file reaches it.

## Decision Drivers

* A citation must open at a place and highlight the passage, which needs a PDF
  with a text layer, not an approximation of the layout.
* The original bytes are the record. Whatever is shown is derived from them and
  must never replace them.
* The BFF owns storage, authorization and the per-tenant buckets, and every
  file uploaded before this change needs a preview too.
* Buy, don't build: office layout is somebody else's domain.
* A deployment without the new service must behave exactly as today. This
  held for viewing alone. ADR-0071 made the service required for indexing
  Word, presentation, `.xls` and `.ods` files, so it no longer holds.

## Considered Options

1. **Gotenberg as a sidecar**: LibreOffice behind an HTTP API, one container.
2. **LibreOffice (`soffice`) installed in the Python or UI image**, run as a
   subprocess.
3. **Client-side renderers**: docx-preview or mammoth to HTML for Word, SheetJS
   for Excel, something else for PowerPoint.
4. **Conversion in the Python ingest**, beside text extraction.

## Decision Outcome

Chosen option: 1, **Gotenberg 8 as a sidecar, called by the BFF**, because it
gives LibreOffice's fidelity as a service we run and do not maintain, produces a
real PDF that the existing viewer, text layer and citation highlight work on
unchanged, and keeps the conversion inside the tier that already owns the
bytes.

What that means in practice:

* **The original is kept and is what Download returns.** `GET
  /api/documents/[id]/download` is unchanged. The PDF is a derived sibling
  object, like `_thumb.jpg`: `<dir>/_render.pdf` next to the original in its
  per-version directory, in the same bucket, built by
  `buildRenditionStorageKey` in `lib/s3.ts`.
* **No database column.** Whether the object exists is the state; the BFF HEADs
  it. There is nothing to migrate and nothing to fall out of step.
* **The BFF is the only converter.** `lib/documents/rendition.ts` GETs the
  original, POSTs it to `{GOTENBERG_URL}/forms/libreoffice/convert` with its
  original filename (LibreOffice picks the filter by extension), and PUTs the
  result. Concurrent requests for one key share one conversion.
* **Eager at dispatch, lazy at view.** The upload converts an office file
  before it posts to `/v1/ingest`. `/preview` and `/file` convert on first view
  when the object is missing, which covers every file uploaded before this
  change and every `.docx` Piloti generates. As decided here the dispatch
  failed open: a failed conversion was logged and ingestion continued.
  [ADR-0071](0071-word-and-presentation-files-are-indexed-from-their-rendition.md)
  ended that for Word, presentation, `.xls` and `.ods` files. They are indexed
  from the rendition, so a failed conversion now fails their ingest, retryably.
  A spreadsheet still ingests and only loses its thumbnail.
* **The thumbnail comes from the rendition.** The BFF sends a presigned GET of
  the PDF to the backend as `preview_ref`, which passes the same two SSRF gates
  as `file_ref`, is used only to render the thumbnail, and is never stored or
  logged. Under this decision text extraction still read the original; since
  ADR-0071 the same PDF is also sent as `extraction_ref` for the formats it
  lists, and those are read from it.
* **Which files** is `isOfficeRenditionSource` in
  `lib/documents/preview-types.ts`: Word, Excel, PowerPoint, their ODF
  counterparts and RTF, by content type or extension.
* **`GOTENBERG_URL` unset turns viewing off**: `/preview` answers 415, the
  pane shows the placeholder and Download. A failed conversion answers 502
  `RENDITION_FAILED` and the pane falls back the same way. For viewing that is
  the behaviour before this decision. Since ADR-0071 it also fails the ingest
  of every Word, presentation, `.xls` and `.ods` file.
* **Gotenberg has no egress.** It receives bytes and returns bytes, and needs
  nothing outside the cluster to do it. The network denies it a route where it
  can (an internal Compose network, a NetworkPolicy), and the
  `--libreoffice-deny-private-ips` and `--libreoffice-deny-public-ips` flags
  make LibreOffice refuse every URL a file links where it cannot (Coolify, a
  cluster without NetworkPolicies).

### Consequences

* Good, because an office file opens in the same viewer as a PDF, and a
  citation to it opens that viewer instead of a download.
* Good, because the original is untouched, and deleting a document deletes the
  rendition with the other derived objects (`deleteDerivedObjects`).
* Good, because, as decided here, a deployment without Gotenberg lost nothing
  it had. ADR-0071 gave that up: without it, Word and presentation files no
  longer index.
* Bad, because the first view of a file uploaded before this change waits for a
  conversion, seconds for a typical file. A reader waits at most 85 s
  (`RENDITION_READER_WAIT_MS`, below Cloudflare's roughly 100 s origin timeout)
  and then gets the handled 502 while the conversion runs on in the background
  and is stored for the next open. The preview says it is being made.
* Bad, because a failed conversion is remembered in-process for five minutes
  for readers, so a broken file is not converted again on every open. The
  retry and the ingest bypass that memory.
* Neutral, because conversions are bounded per BFF process
  (`GOTENBERG_MAX_CONCURRENCY`, default 2), readers queue ahead of background
  work, and the 120 s conversion budget counts from when a slot is held, not
  from the request.
* Bad, because LibreOffice is not Word. Layout can shift, and a document set in
  a font the container lacks is drawn in a substitute. Installing the office's
  fonts in the Gotenberg image may be needed; that is a deployment change, not a
  code change.
* Bad, because an `.xlsx` is paged by its print areas, not by sheet. A sheet has
  no page number the PDF knows, so a citation to a sheet opens page 1. A
  `.pptx` slide label is a page number, and that one opens at its slide.
* Neutral, because this decision left retrieval unchanged: a `.docx` stayed one
  text unit with no page label, so its citations opened at page 1 too.
  Page-accurate Word citations meant chunking by the rendition's pages, which
  changes answers and needs `task be:eval:answer-suite` before and after, so it
  was left as a follow-up.
* Extended by [ADR-0071](0071-word-and-presentation-files-are-indexed-from-their-rendition.md),
  which took that follow-up: Word and presentation files are indexed from the
  rendition, with no fallback reader, which gives their citations a page and
  makes Gotenberg a required service. This decision still holds for viewing.
* Bad, because it is one more container to run, patch and size. LibreOffice
  parses untrusted bytes, which is why it runs isolated and without egress
  rather than inside a service that holds credentials.

### Confirmation

* `frontends/ui/src/lib/documents/preview-types.spec.ts`: which types and
  extensions count as an office source, including a `.docx` stored without a
  content type.
* `frontends/ui/src/lib/documents/rendition.spec.ts`: an existing rendition is
  reused, a missing one is converted and stored at `_render.pdf`, concurrent
  calls convert once, disabled and failed conversions throw their typed errors.
* `frontends/ui/src/lib/s3.spec.ts`: `buildRenditionStorageKey` places the PDF
  beside the original and follows the thumbnail key's null rules.
* `frontends/ui/src/lib/documents/object-cleanup.spec.ts`: deleting a document
  deletes `_render.pdf`.
* `frontends/ui/src/app/api/documents/[id]/preview/route.spec.ts` and
  `.../file/route.spec.ts`: an office source is served as the rendition, 415
  when disabled, 502 `RENDITION_FAILED` when conversion fails, and non-office
  files unchanged.
* `frontends/aiq_api/tests/test_ingest.py`: `preview_ref` passes the SSRF gates,
  is used only for the thumbnail, and never reaches storage or the log.

Nothing checks that `/download` keeps returning the original; review is the only
gate for that.

## Pros and Cons of the Options

### Gotenberg sidecar

* Good, because LibreOffice's filters cover Word, Excel, PowerPoint, ODF and RTF
  with one call.
* Good, because the image is maintained upstream and the API is a multipart
  POST: plain `fetch` and `FormData`, no SDK.
* Bad, because it is a new service in every environment.

### LibreOffice in the Python or UI image

* Good, because there is no new service.
* Bad, because it adds several hundred MB and a native toolchain to an image
  that ships on every change, the thing "buy, don't build" warns against.
* Bad, because we would own process management: a hung `soffice`, its profile
  directory, concurrency, timeouts. Gotenberg already solves those.
* Bad, because an office parser would run inside a service that holds database
  and storage credentials.

### Client-side renderers

* Good, because nothing runs on the server.
* Bad, because it is three renderers of different fidelity, one per format, and
  none for PowerPoint that holds up.
* Bad, because HTML made from user-supplied bytes would render in our origin.
* Bad, because there is no pdf.js text layer, so citation highlight would not
  work and would need a second implementation per renderer.

### Conversion in the Python ingest

* Good, because ingest already reads the bytes once.
* Bad, because the BFF owns storage, authorization and the bucket, and the lazy
  path for files uploaded before this change runs where the viewer asks, in the
  BFF. Ingest-side conversion would need the BFF converter anyway, and two
  converters drift.

## More Information

Revisit if a customer's documents need Word-exact layout (a commercial
renderer, or conversion at the source), or if answers start citing office files
by page, which is the follow-up named under Consequences.

`GOTENBERG_URL` is listed in
[`environment-variables.md`](../deployment/environment-variables.md). How office
text is extracted for retrieval since ADR-0071:
[`visual-ingestion.md`](../architecture/visual-ingestion.md).
