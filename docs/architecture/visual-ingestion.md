# Visual ingestion: requirements and direction

How drawing/plan pages become retrievable knowledge, what the pipeline is
required to look like structurally, and where it goes next. Written 2026-08
alongside the schema-v2 change; the survey findings below are from that
research pass.

## The backend requirement: modularity

**Visual ingestion MUST stay decomposed into independently swappable stages.**
This is a standing requirement, not a description of the current code: every
change to this pipeline is measured against it in review.

The stages, and the module seam that owns each:

| Stage | Owner | Swappable without touching |
|---|---|---|
| Detect visual pages | `processing.render_visual_pages_no_vlm` (text/path heuristic) | everything downstream |
| Render | same module (pypdfium2 raster) | detection, analysis, indexing |
| Analyse (VLM call) | `adapter._analyze_drawing_page_with_vlm` + `resolve_vlm_credential` (BYOK, per-org model override) | schema, prompt, indexing |
| Extraction schema + prompt + parsing | `drawing_analysis` (versioned: `SCHEMA_VERSION`) | VLM backend, indexing |
| Map to chunks | `drawing_analysis.segment_payloads` → adapter builds `Document`s | schema internals, VLM |
| Office-format text extraction | `office_extractors` (one handler per extension) | everything else |

Concretely, the rules that keep it modular:

1. **The schema is versioned and the version is part of every cache and
   storage identity.** `drawing_analysis.SCHEMA_VERSION` feeds the VLM cache
   key (`CACHE_PROMPT_TYPE`) and is stamped into every `drawing_data`
   payload. A schema bump therefore never serves last generation's cached
   captions, and stored chunks are self-describing for later re-mapping.
   This mirrors what every serious pipeline does (nv-ingest, Docling,
   Unstructured all tag records with parser/schema/model versions).
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
5. **Degradation is defined.** A VLM reply that does not parse as the current
   schema falls back to the v1 line format; a v1 reply falls back to prose.
   A weaker configured model produces coarser chunks, never failed files.
6. **New capability = new module behind the same seam.** A layout/view
   detector (below) slots between render and analyse; a visual-embedding
   channel slots beside the text channel at indexing. Neither may require
   rewriting an existing stage.

## What the schema captures (v2)

`drawing_analysis` (module docstring holds the full schema): multiple
**segments per sheet** — a plan sheet carrying Grundriss + Schnitt + Detail
indexes as separate chunks, each with its **own scale** — plus per segment:
rooms (name/use/area), circulation, structure, envelope, building services,
building physics, materials, structural system, **assemblies as ordered
layers** (material/thickness/function), existing-vs-new status per element
(`bestand|neu|rueckgebaut|weiterverwendet|transformiert`), **quantities as
object+property+value+unit** (never a bare `71 %`), **spatial relations as
subject→relation→object triples**, and verbatim annotations. Sheet-level:
project title / subtitle / slogans kept apart, author/institution/
supervision/location, design strategies, process steps, watermark, and a
free-text summary that is deliberately kept alongside the structured data.
Segments and quantities carry **provenance** (`text|visual|inferred`) and
**confidence** (`high|medium|low`).

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
  room labelling are the systematic successes. This is why v2 records
  provenance + confidence and why quantities from the VLM are estimates,
  never takeoff numbers.
- **Multi-view sheets need a layout stage.** Commercial tools (Bluebeam,
  Togal.AI, Kreo) and the published pipelines first segment a sheet into
  views/title block/notes (YOLO-class detectors), then analyse each view at
  native resolution. v2 asks the VLM to segment logically (one JSON segment
  per drawing) — the right schema, with the detector as the known upgrade.
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
| Microsoft MarkItDown | evaluated, rejected (2026-08) | `markitdown[docx,xlsx,pptx]` pulls 30 packages incl. **onnxruntime** (native ML runtime via magika) + pandas — a toolchain in the ingest image for format conversion. Emits one Markdown blob per file: no per-sheet/per-slide `page_label`, which citations need. Its per-format converters could still back an `office_extractors` handler later. |
| mammoth (docx→markdown) | noted as upgrade path | Preserves heading structure where docx2txt flattens; two small pure-Python deps. Worth taking when heading-aware chunking of Word uploads matters. |

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
