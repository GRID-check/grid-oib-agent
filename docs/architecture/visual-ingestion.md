# Visual ingestion: requirements and direction

How drawing/plan pages become retrievable knowledge, what the pipeline is
required to look like structurally, and where it goes next. Written 2026-08
alongside the first structured-schema change and revised for schema v4; the
survey findings below are from those research passes.

## The backend requirement: modularity

**Visual ingestion MUST stay decomposed into independently swappable stages.**
This is a standing requirement, not a description of the current code: every
change to this pipeline is measured against it in review.

The stages, and the module seam that owns each:

| Stage | Owner | Swappable without touching |
|---|---|---|
| Triage pages | `page_triage` (pure `classify_page` over signals read once per page): text, scan, garbled, drawing | everything downstream |
| Transcribe scans and garbled pages | `transcription` (same endpoint, key and cache as the analysis; its own prompt and cache namespace) | the drawing stages; its output is ordinary page text |
| Render | `processing` (pypdfium2 raster: `render_visual_pages_no_vlm` for drawings, `render_pdf_pages` for transcription) | triage, analysis, indexing |
| Analyse | `adapter.analyze_visual` — ONE entry point for every source — over `_analyze_drawing_page_with_vlm` + `resolve_vlm_credential` (BYOK, per-org model override) | schema, prompt, vocabulary, indexing |
| Extraction schema + JSON Schema + prompt + parsing | `visual_analysis` (versioned: `SCHEMA_VERSION`) | VLM backend, indexing, vocabulary |
| Domain vocabulary | `visual_domains` (data: segment types, entity categories, states) | the kernel, the parser, the UI |
| Map to chunks | `visual_analysis.segment_payloads` → `adapter.visual_documents` | schema internals, VLM |
| Office-format text extraction | `office_extractors`: `.xlsx`/`.xlsm` sheets through `openpyxl` as header-repeating row groups, and `.pptx`/`.pptm` speaker notes. `text_formats`: `.md`/`.txt`/`.csv`/`.tsv` with section, line and row locators. Word, presentation, `.xls` and `.ods` files are read only from their PDF rendition (`extraction_ref`) through the PDF stages above; without one they fail as `office_rendition_required` ([ADR-0071](../adr/0071-word-and-presentation-files-are-indexed-from-their-rendition.md)) | everything else |

Concretely, the rules that keep it modular:

1. **The schema AND the vocabulary are versioned, and both are part of every
   cache and storage identity.** `visual_analysis.cache_prompt_type()` keys on
   `visual:v{schema}:{domains}@{content_hash}`, where the hash digests what the
   enabled domains actually say. Both are stamped into every stored payload, so
   a schema bump never serves last generation's output and "which records were
   produced under the old vocabulary" is a query rather than a guess. This
   mirrors what every serious pipeline does (nv-ingest, Docling, Unstructured
   all tag records with parser/schema/model versions).
2. **Extract, then map.** The VLM is asked to collect exhaustively into a
   JSON structure; classification into index chunks happens afterwards in
   code (`segment_payloads`). Changing the index layout (e.g. one chunk per
   room instead of per segment) is a code change with no prompt change, and
   vice versa.
3. **Raw before derived.** The full structured analysis is persisted on the
   chunk (`drawing_data`, JSON) — chunks and rendered text are derived and
   disposable, the analysis is the artifact. A re-chunking never needs the
   VLM again.
4. **Every stage fails open per unit** (page, image, segment), never per
   document — one unreadable page costs that page.
5. **Degradation is defined, and layered cheapest-first.** A reply that parses
   as the current schema types itself; one that parses only as the legacy line
   format is a drawing by construction; one that parses as neither — prose from
   a weak model, or a provider failure — spends one more call on the legacy
   caption prompt. A weaker configured model produces coarser chunks, never
   failed files.
6. **New capability = new module behind the same seam.** A layout/view
   detector (below) slots between render and analyse; a visual-embedding
   channel slots beside the text channel at indexing. Neither may require
   rewriting an existing stage.
7. **One analysis for every source.** A rendered page, a raster embedded in a
   PDF and an uploaded image file all go through `analyze_visual` and
   `visual_documents`. They differ only in where the bytes came from and which
   metadata rides along. They used to differ in how the image was UNDERSTOOD —
   embedded rasters got a generic caption prompt — so a scanned plan inside a
   PDF was indexed as one paragraph while the identical sheet as a vector page
   was indexed per drawing.
8. **A new domain is data, not code.** Adding one must not require a change to
   the kernel schema, the parser or the UI. The schema, why the domain is
   chosen per segment, and where the vocabulary should eventually live:
   [`visual-extraction-schema.md`](visual-extraction-schema.md).
9. **Every capability is on in code; a flag only switches one off.**
   `AIQ_EXTRACT_TABLES`, `AIQ_EXTRACT_IMAGES` and `AIQ_EXTRACT_CHARTS` default
   to on and no deployment sets them, so none is off because a stack forgot
   it. Production once set only the images flag: uncaptioned tables stayed
   garbled page text, and every raster typed `chart` was analysed and then
   dropped. The switches now decide how an analysed visual is typed, never
   whether a paid-for chart is thrown away (`adapter.indexed_visual_type`):
   charts off indexes a chart as an image.
10. **Each page is analysed once, and the count is bounded.** A page rendered
   whole as a visual page contributes no embedded rasters: the render already
   shows them, and a scanned page's full-page raster was otherwise analysed
   twice. The remaining rasters are capped per PDF at
   `AIQ_MAX_IMAGES_PER_DOCUMENT` (64, the BFF's storage cap), largest first;
   the number left out is recorded on the file's job status
   (`file_details[].metadata.images_over_cap`). Rendered pages have their own
   cap, `AIQ_MAX_RENDERED_PAGES`.

## Scans and garbled text layers

A page reaches the index by one of four roads (`page_triage`):

| Kind | Test | Road |
|---|---|---|
| text | usable text layer | pdfplumber text, as always |
| scan | less than `AIQ_VISUAL_PAGE_MIN_TEXT_CHARS` of text and a raster covering at least half the page | rendered, **transcribed**, indexed as page text |
| garbled | the text layer is `(cid:n)` runs, replacement characters, mojibake (`GebÃ¤ude`) or glyph ids shifted into letters (vowel ratio below 0.22) | as a scan, and the transcription replaces the text layer. A page left untranscribed (no vision key, a failed call, past `AIQ_MAX_OCR_PAGES`, or that set to 0) keeps what of its text is not `(cid:n)` tokens (`salvage_text`), counted as `pages_garbled_text_kept`. The shares are measured per glyph, a `(cid:n)` token counting as the one glyph it stands for, and symbol-font bullets in the private use area are exempt, so a clean Word export with bullets is not garbled |
| drawing | text-low and not a scan, carrying any real graphic content: at least `MIN_SKETCH_PATHS` (20) vector paths or a picture. A garbled page with at least `AIQ_VISUAL_PAGE_MIN_PATHS` paths is a CAD sheet and lands here too | rendered, drawing schema |

Until 2026-09 a page with under 200 characters went through the drawing schema,
which describes a page ("Bescheid mit Auflagen") instead of saying what is
written on it, and only the first `AIQ_MAX_RENDERED_PAGES` (20) were rendered:
page 21 of a scan was lost with the file reporting success. The rule was also
"text-low OR path-heavy", so a table-ruled text page with 300 cell borders was
sent to the drawing analysis too. A drawing now needs both.

**Transcription is text, not a visual.** The reply replaces the page's text in
`text_pages` and goes through the normal chunker (`text_documents_for_pages`),
with `page_label` = the page. It never enters the drawing schema. The prompt
(`transcription.TRANSCRIPTION_PROMPT`, German) asks for the page verbatim, in
reading order, headings as Markdown headings, tables as Markdown tables,
illegible parts as `[unleserlich]`, and forbids summarising. Two markers route
a page elsewhere: `[ZEICHNUNG]` (a scanned plan) sends it to the drawing
analysis, `[KEIN TEXT]` (a blank page) indexes nothing.

**Same credential, same cache.** Transcription calls the endpoint the drawing
analysis calls, with `resolve_vlm_credential` (org BYOK, then
`AIQ_VLM_API_KEY`, then the provider key). The model is the org's `ingest_vlm`
override, else `AIQ_OCR_MODEL`, else the VLM model. A separate `ingest_ocr`
agent group was not added: it would be a new picker row, a bootstrap default
and a BFF config key for a choice no tenant has asked to make separately.
Replies are cached in the VLM cache (Dragonfly) as
`vlm:caption:{model}:ocr:v{PROMPT_VERSION}:{sha256(render)}`, a namespace no
visual analysis shares; failures are not cached.

**Nothing is dropped quietly.** Transcription has its own cap,
`AIQ_MAX_OCR_PAGES` (500). Every page the triage sent to transcription is
counted on the file's job status (`file_details[].metadata`):
`pages_transcribed`, `pages_transcription_failed`, `pages_over_ocr_cap`, and
`pages_not_transcribed_no_vlm` when no vision key resolves. A PDF whose only
content is scanned pages fails with `vlm_not_configured: …` instead of "no
content extracted". Drawing pages past `AIQ_MAX_RENDERED_PAGES` are counted as
`drawing_pages_over_cap`. A scanned page's full-page raster is not also sent
to the image analysis.

**Why per-page vision rather than OpenRouter's PDF parser.** Evaluated
2026-09-29 on the same German scan (a Bescheid with umlauts, ß, § and a
table), both through the deployment's OpenRouter key:

| Route | Cost per page | Result |
|---|---|---|
| Rendered page → `openai/gpt-6-luna` with the transcription prompt | $0.00067 (3 896 prompt + 357 completion tokens, 7 s) | Verbatim, table as Markdown, `EI2 30-C` correct; the en dash in the title came back as a hyphen |
| Whole PDF → `file-parser` plugin, engine `mistral-ocr` | $0.002 per page plus the model call ($0.0040 for 2 pages) | One text part per page, table as Markdown, but `EI2 30-C` read as `El2 30-C` — a fire-resistance class misread |

The parser is three times the price, got the one domain token wrong, and has
three structural costs: it bills OpenRouter's own Mistral key even for a BYOK
org, it does not exist on a BYOK endpoint that is not OpenRouter, and it takes
whole files, so one garbled page inside a 200-page text PDF would pay for 200
pages or need the PDF split first. Per-page transcription picks exactly the
pages triage selects, reuses the cache and the per-org model, and a better OCR
model is a setting (`AIQ_OCR_MODEL`), not a new route.

## What the schema captures (v4)

Multiple **segments per image** — a sheet carrying a floor plan + a section + a
chart + a photo indexes as four chunks, each with its **own scale and its own
domain**. Repeated depictions of the same kind side by side (two floor plans)
are separate segments too, with a per-type ordinal in the chunk header
("Floor plan 1 of 2") and a shared `segment_count` on every chunk of the
sheet, so the detail view can say which depiction a row is. Per segment: entities (each with a `category` from its domain),
compositions as ordered layers, states per element, **quantities as
object+property+value+unit** (never a bare `71 %`), **relations as
subject→relation→object triples**, verbatim annotations, an approximate bbox,
and **provenance** (`text|visual|inferred`) + **confidence**
(`high|medium|low`). Document-level: title / subtitle / slogans kept strictly
apart, author, institution, supervision, location, strategies, process steps,
watermark (quarantined), and a free-text summary kept alongside the structured
data.

The vocabulary is not in the schema. `space`, `circulation`, `envelope`,
`building_physics` are the *architecture domain's* entity categories; another
domain declares its own. Full schema and the reasoning:
[`visual-extraction-schema.md`](visual-extraction-schema.md).

## Survey: what others do (2026)

Ingestion frameworks (NVIDIA nv-ingest/NeMo Retriever, IBM Docling,
Unstructured, LlamaParse, Marker, MinerU) converge on one decomposition:
*render → detect/classify regions (layout model) → crop → per-type analysis →
normalize to a versioned typed-element JSON → chunk/embed → index*. The
requirement above is that decomposition, minus the region-detector stage we
don't have yet.

For architectural drawings specifically:

- **VLMs are reliable for semantics, unreliable for geometry.** Published
  evals put general VLMs at 33–38% on floor-plan CAD understanding
  (ArchPlanVQA 2026); counting doors/windows and applying scale are the
  systematic failures, while sheet classification, title-block reading and
  room labelling are the systematic successes. This is why the schema records
  provenance + confidence and why quantities from the VLM are estimates,
  never takeoff numbers.
- **Multi-view sheets need a layout stage.** Commercial tools (Bluebeam,
  Togal.AI, Kreo) and the published pipelines first segment a sheet into
  views/title block/notes (YOLO-class detectors), then analyse each view at
  native resolution. The schema asks the VLM to segment logically (one JSON
  segment per depiction) — the right shape, with the detector as the known
  upgrade.
- **Scale should eventually be computed, not asked**: dimension-line text vs.
  pixel distance. Until then a VLM-reported scale is `visual`/`inferred`
  provenance at best.
- **Visual retrieval (ColPali/ColQwen-style page-image embeddings) is the
  second channel** the field pairs with extracted text; it retrieves what any
  text rendering misses. Fits at the indexing seam as an additional channel.
- **Vector PDFs carry exploitable structure** (paths, layers, exact dimension
  strings — panoptic symbol spotting reaches ~90 PQ on vector CAD). Today we
  rasterise and discard it; a vector-aware analysis stage is a candidate
  behind the same analyse seam.

## Library evaluations (register)

| Library | Verdict | Why |
|---|---|---|
| `llama-index-readers-file` | not adopted | Optional distribution; wasn't installed, and `SimpleDirectoryReader`'s fallback read office files as raw bytes — every `.docx` upload failed ingestion. Replaced by `office_extractors`. |
| llama-index `MarkdownNodeParser` | evaluated, not adopted (2026-09) | Ships in `llama-index-core`, and splits on ATX headings with a `header_path` — but emits one node per section with no budget packing, no line numbers and a path that starts at the document title, so a section could be neither cited by line nor opened by `read_passage` under a stable address. `text_formats` does the split (about thirty lines) and reuses `section_chunking.pack`. |
| pymupdf4llm / unstructured / docling (PDF heading structure) | not adopted (2026-09) | Each reads headings from a PDF, and each brings a native toolchain (MuPDF, AGPL) or a model runtime (torch, onnxruntime) into the ingest image. pdfplumber, already the PDF reader, exposes every character's font size and name; `section_chunking` ranks those against the body size, which is the whole of what the heading test needs. |
| `charset_normalizer` (encoding detection) | installed, not used for this (2026-09) | A statistical guess over a short CSV can land on cp1250 or MacRoman. The files that reach this path are UTF-8 or Windows exports, so `text_formats.decode_text` is a fixed order — BOM, strict UTF-8, cp1252, Latin-1 — which never drops a byte and records the encoding it used. |
| Microsoft MarkItDown | evaluated, rejected (2026-08) | `markitdown[docx,xlsx,pptx]` pulls 30 packages incl. **onnxruntime** (native ML runtime via magika) + pandas — a toolchain in the ingest image for format conversion. Emits one Markdown blob per file: no per-sheet/per-slide `page_label`, which citations need. Its per-format converters could still back an `office_extractors` handler later. |
| mammoth (docx→markdown) | not needed (2026-09) | Was the upgrade path over docx2txt for Word heading structure. Word files are now read from their PDF rendition ([ADR-0071](../adr/0071-word-and-presentation-files-are-indexed-from-their-rendition.md)) and docx2txt is gone; headings come from the PDF's layout. |
| Gotenberg 8 (LibreOffice over HTTP) | adopted for viewing (2026-09, [ADR-0070](../adr/0070-office-files-are-viewed-through-a-pdf-rendition.md)) and for extracting Word and presentation files (2026-09, [ADR-0071](../adr/0071-word-and-presentation-files-are-indexed-from-their-rendition.md)) | The BFF converts an office file to a `_render.pdf` sibling so it opens in the PDF viewer, and the backend draws the thumbnail from that PDF (`preview_ref`). For Word, presentations, `.xls` and `.ods` the BFF also sends the PDF as `extraction_ref`, and the backend indexes it like any PDF: pictures get VLM captions and a citation carries the rendition's page. `.xlsx` and `.xlsm` stay on `office_extractors`, whose `openpyxl` tables keep rows and columns that a printed sheet splits across pages. |

## Direction (not yet built)

In rough order of value, each behind an existing seam:

1. **View/layout detector** between render and analyse: crop each view +
   title block, analyse per crop at native resolution, inherit a bbox per
   extraction. Fixes the resolution ceiling on dense sheets.
2. **Visual embedding channel** beside the text channel (page-image
   multi-vector retrieval), fused at query time.
3. **Grounding check**: cross-check VLM claims against the page's extracted
   text tokens; downgrade or drop unverifiable claims instead of indexing
   them.
4. **Computed scale** from dimension annotations.
5. **Re-processing/backfill path**: re-run analyse+map for chunks whose
   `drawing_data.schema_version` is behind, without re-uploading.
