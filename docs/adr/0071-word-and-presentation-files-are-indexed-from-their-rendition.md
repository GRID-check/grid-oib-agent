---
status: accepted
date: 2026-09-29
decision-makers: Grid engineering, product owner
consulted:
informed: everyone working in this repo
---

# Word and presentation files are indexed from their PDF rendition

## Context and Problem Statement

[ADR-0070](0070-office-files-are-viewed-through-a-pdf-rendition.md) gave every
office file a PDF rendition, `<dir>/_render.pdf`, and used it for viewing and
the thumbnail only. Retrieval kept reading the original through
`office_extractors`, and that left three gaps the rendition could close:

* **Pictures were invisible.** `docx2txt` and `python-pptx` read text frames and
  tables. A photo of a detail, a plan pasted into a report, a site picture on a
  slide: none of it reached the index. A PDF goes through the image path
  (`pypdfium2` extraction and VLM captions), so the same picture inside a PDF was
  searchable and inside a deck it was not.
* **A Word citation could not point into the file.** `_extract_docx` emits one
  unit per document labelled `"1"`, because a `.docx` has no pages until
  something lays it out. ADR-0070 therefore opened every Word citation at
  page 1 and named page-accurate Word citations as a follow-up.
* **Legacy and ODF formats had no extractor.** `.doc`, `.odt`, `.rtf`, `.ppt`,
  `.odp`, `.xls` and `.ods` fell through to the generic reader, which reads
  unknown bytes as text, so they indexed as garbage or failed.

## Decision Drivers

* A cited passage must open at its page. The viewer shows the rendition, so the
  page has to be a rendition page.
* Visual content in a document must be retrievable the same way whatever
  container it arrived in.
* A chunk's `file_name` is the join key every purge and every citation uses.
  Changing where the bytes come from must not change what a chunk is attributed
  to.
* One component owns format policy. Two lists of "which formats" drift, as the
  preview lists already did twice.
* A converter outage must not cost a document its index.

## Considered Options

1. **Keep extracting from the originals.** The ADR-0070 state.
2. **Word only from the rendition.** Fixes Word page numbers, leaves decks
   without their pictures.
3. **Word and presentations from the rendition**, with their legacy and ODF
   siblings and the two spreadsheets that have no extractor (`.xls`, `.ods`).
4. **Every office format from the rendition**, `.xlsx` and `.xlsm` included.

## Decision Outcome

Chosen option: 3, **Word and presentation files are indexed from their
rendition**, by the product owner's decision. It closes all three gaps for the
formats where the PDF is the better source and leaves spreadsheets on the
extractor that keeps their structure.

What that means in practice:

* **The BFF decides, by extension.** `isIndexedFromRendition` in
  `frontends/ui/src/lib/documents/preview-types.ts` holds the list: `.docx`
  `.docm` `.doc` `.odt` `.rtf` `.pptx` `.pptm` `.ppt` `.odp` `.xls` `.ods`.
  `rendition.ts` re-exports it as `extractsFromRendition` for the dispatch, and
  the citation resolver imports it directly. The module is browser-safe so both
  tiers read one list.
* **The backend has no format policy.** `IngestRequest.extraction_ref` is a
  presigned GET of `_render.pdf`. It passes the same two SSRF gates as
  `file_ref`, is downloaded to a temp file, and reaches the job as a local path
  (`extraction_paths`), never as the URL. It is never logged. A request that
  carries it is extracted from the PDF, whatever the original's extension.
* **Identity stays the original.** Every chunk's `file_name` is the row's
  filename, `Bericht.docx`, as `request.file_name` already states it. Only the
  bytes read come from the PDF. The document's summary, page count and content
  types are what the PDF pipeline produces.
* **Speaker notes come from the original.** A PDF export drops them. For a
  `.pptx` or `.pptm`, a companion extractor reads the notes from the original
  with `python-pptx` and adds one unit per slide that has them, labelled with
  the slide's page in the rendition. LibreOffice leaves hidden slides out of the
  PDF, so the label counts visible slides only.
* **Convert, then ingest, detached.** An office upload no longer races the
  conversion against a 20-second wait. `beginRenditionIngest` in
  `lib/documents/service.ts` marks the row `processing`, returns, and in the
  background runs `ensureRendition` with its full 120-second timeout, then
  `dispatchIngest` with `preview_ref` (thumbnail) and, for the listed formats,
  `extraction_ref`. The upload response says `processing`. Re-ingest takes the
  same path. Background conversions are bounded per BFF process
  (`GOTENBERG_MAX_CONCURRENCY`, default 2) behind any reader waiting for a
  preview, and time spent queued for a slot does not count against the 120
  seconds. A folder upload of hundreds of office files used to start them all
  at once and time most of them out in Gotenberg's own queue.
* **The rendition is the only source; there is no fallback reader.** The
  docx2txt Word reader and the python-pptx slide-text reader are deleted, and
  docx2txt leaves the dependencies. When `ensureRendition` throws, or no
  converter is configured, a Word or presentation file is marked failed
  (`RENDITION_REQUIRED_MESSAGE` in the BFF, `office_rendition_required` in the
  knowledge layer) and the existing retry converts again. A spreadsheet only
  loses its thumbnail. Keeping the old readers as a fallback was considered and
  turned down: it is a second path that quietly produces a worse index (no
  pictures, every Word citation on page 1) exactly when nobody is looking.
  Every outcome writes the row, as the IFC path does.
* **Citations use the page.** `renditionPage` in
  `features/chat/lib/citations/target.ts` takes a whole locus page of 1 or more
  as the rendition page for the listed formats. `.xlsx` and `.xlsm` open at
  page 1.

### Consequences

* Good, because pictures in Word files and decks are captioned by the VLM and
  indexed like pictures in a PDF: a question about a photo on slide 12 can find
  it and cite it.
* Good, because a Word citation opens at its page and highlights the passage.
  A slide citation still opens at its slide.
* Good, because `.doc`, `.odt`, `.rtf`, `.ppt`, `.odp`, `.xls` and `.ods` are
  indexed from a real PDF instead of the raw-bytes fallback.
* Bad, because captions cost a VLM call per picture. Every embedded raster of at
  least 100 x 100 px is captioned, with duplicates removed by content hash, when
  `extract_images` is on (`AIQ_EXTRACT_IMAGES`, on in the deployed stacks). The
  BFF keeps at most 64 of the rasters per document
  (`MAX_STORED_IMAGES_PER_DOCUMENT`); that bounds storage, not captioning. A
  picture-heavy deck costs more to ingest than it did.
* Bad, because only rasters are pictures to `pypdfium2`. A chart drawn as
  vectors, SmartArt and shapes arrive as PDF paths and are read only by the
  visual-page detector, if the page is sparse enough in text to trigger it.
* Bad, because documents indexed before this change keep their old chunks until
  they are ingested again. There is no backfill job. "Erneut lesen" on the
  file reads it again through this path and keeps its identity. Uploading the
  same bytes again does not: an identical upload is skipped as „Unverändert“.
  A Word citation from the old chunks carries `"1"` and opens at page 1, which
  is where it opened before.
* Bad, because a process restart during a conversion leaves the row at
  `processing` with no job. This is the tradeoff the IFC path already makes: the
  re-ingest action reads the backend state as `absent` and retries it.
* Bad, because Gotenberg is now required, not optional. Without it, or while
  it restarts mid-conversion, a Word or presentation upload fails retryably.
  Its rollout drains a conversion in flight for up to 120 s, and its flags
  refuse every URL LibreOffice would fetch.
* Bad, because the rollout order matters once. A new backend next to an old
  BFF refuses office files as `office_rendition_required`; the reverse is
  harmless. The runbooks are in
  [`cd.md`](../deployment/cd.md#rolling-out-adr-0071) and
  [`coolify.md`](../deployment/coolify.md#rolling-out-adr-0071).
* Bad, because LibreOffice's layout is not Word's. A page number is the
  rendition's page, correct in the viewer and possibly different from the page a
  person sees in Word.
* Neutral, because this changes ingestion, which shapes answers, so the root
  obligation applies: `task be:eval:answer-suite` before and after, with the
  report in the PR. The suite's corpus is the OIB PDFs, which this change does
  not touch, and it skips questions about an office's own files, which is where
  this change lands. A clean suite run is therefore weak evidence here. The PR
  that introduced this ADR states whether the suite was run.

### Confirmation

* `frontends/ui/src/lib/documents/preview-types.spec.ts`: which extensions are
  indexed from the rendition, that `.xlsx` and `.xlsm` are not, and that the list
  is a subset of the formats that have a rendition.
* `frontends/ui/src/lib/documents/dispatch.spec.ts`: an office upload is
  detached and marked `processing`; `extraction_ref` is sent for a listed
  format and not for a spreadsheet; a failed or unconfigured conversion fails a
  Word file and still ingests a workbook.
* `frontends/ui/src/features/chat/lib/citations/open-at.spec.ts`: a Word,
  presentation, `.xls` or `.ods` locus page is the rendition page, and `.xlsx`
  and `.xlsm` open at page 1.
* `frontends/aiq_api/tests/test_ingest.py`: `extraction_ref` passes the SSRF
  gates, is downloaded by the job rather than the request, and is never logged.
* `tests/knowledge_layer_tests/test_rendition_extraction.py`: a rendition is
  extracted under the original's `file_name`; `.pptx` speaker notes become units
  labelled by rendition page, hidden slides skipped; a listed format without a
  readable rendition fails as `office_rendition_required`.
* `tests/knowledge_layer_tests/test_rendition_extensions_parity.py`: the BFF's
  `RENDITION_INDEXED_EXTENSIONS` and the knowledge layer's copy are the same set.
  The backend does keep a list, to refuse a listed format that arrives without
  its rendition; the parity test is what keeps the two from drifting.

## Pros and Cons of the Options

### Keep extracting from the originals

* Good, because nothing changes and no answer moves.
* Bad, because every picture in a Word file or a deck stays out of the index,
  and Word citations stay at page 1.

### Word only

* Good, because it fixes Word page numbers with the smallest change to answers.
* Bad, because decks are where pictures matter most in a planning office: site
  photos, renderings, pasted plans. They would stay invisible.

### Word and presentations (chosen)

* Good, because it closes the three gaps for the formats where the PDF carries
  more than the extractor did.
* Bad, because speaker notes need a second reader on the original, the one
  place the rendition is not enough.

### Every office format, spreadsheets included

* Good, because it is one rule with no exceptions.
* Bad, because `openpyxl` emits each sheet as a table with its rows and columns
  intact, labelled by sheet name. LibreOffice prints a wide sheet across as many
  pages as its width needs, so a row lands on one page and its column headers on
  another. The index would lose the structure a cost plan or a room schedule is
  read by.

## More Information

Revisit if a spreadsheet format needs its pictures indexed (a combined reader
that keeps `openpyxl` tables and adds the rendition's rasters), or if VLM cost on
decks becomes material enough to cap captions per document.

How office files are viewed: [ADR-0070](0070-office-files-are-viewed-through-a-pdf-rendition.md).
The pipeline stages: [`visual-ingestion.md`](../architecture/visual-ingestion.md).
The ingest request and the detached dispatch:
[`document-ingestion.md`](../technical-reference/document-ingestion.md).
