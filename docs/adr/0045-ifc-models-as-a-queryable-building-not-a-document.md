# ADR-0045 — IFC models are a queryable building, not another document

**Status:** Accepted
**Date:** 2026-08-08
**Supersedes the plan in:** [`docs/roadmap/ifc-viewer-card-spec.md`](../roadmap/ifc-viewer-card-spec.md)

## Context

Architects author their buildings as **IFC** models (the openBIM exchange
format). Until now Grid could read what an architect *wrote about* a building —
PDFs, plans, notices — but not the building itself. Every question with an exact
answer ("how many external walls on the ground floor", "net floor area per
storey", "which doors are fire exits") had to be answered by a human reading a
drawing, or not at all.

The obvious move — accept `.ifc` in the uploader and let the existing pipeline
handle it — does not work, in two separate ways.

**It cannot be ingested.** An IFC file is a STEP physical file: tens of
megabytes of `#412=IFCCARTESIANPOINT((1.2,0.,3.));`. Embedding that produces
chunks that match no query and dilute every other document in the collection.
The backend already guards against exactly this shape of failure for raw PDF
bytes.

**It cannot be answered by retrieval.** Even given perfect text, "how many
external walls are on the ground floor" is a `COUNT(*)` with a `WHERE`. A
language model summing forty thousand elements out of retrieved prose turns a
fact into a guess, and the guess is confident.

The 2026-05 roadmap spec proposed `web-ifc` + ThatOpen with a server-side
conversion to Fragments. That plan is superseded here: the viewer library it
named is not the one adopted, and — more importantly — it treated the problem as
"render the model", when the larger half is "answer questions about it".

## Decision

An uploaded `.ifc` becomes **two artefacts**, and neither is the raw file
(a third, purely a transport optimisation, was added later — see
[*The viewer's compressed source*](#the-viewers-compressed-source)):

1. **A structured index** — `bim_models` + `bim_elements` — extracted once at
   ingestion by [`@ifc-lite/parser`](https://github.com/LTplus-AG/ifc-lite)
   running in the BFF's Node process. Elements carry their GlobalId, type,
   storey, property sets, quantities, materials and classifications. The agent
   queries this **deterministically** through a closed query vocabulary
   (`lib/bim/query.ts`) that compiles to SQL.

2. **A Markdown digest** — the model's facts written as prose, uploaded beside
   the source object and ingested **in the model's place**. This is what makes a
   model visible to ordinary retrieval, so "is there a model, and what is it of"
   is answerable in a chat that never mentions it.

The two divide by question shape: retrieval answers *what is this*, the query
layer answers *how many / how much / which ones*. Neither is asked to do the
other's job.

**Geometry is never processed server-side.** The 3D viewport parses and
triangulates in the browser (ifc-lite's WASM kernel, WebGPU renderer), streaming
the source through a short-lived presigned URL. There is no Fragments
conversion and no cached mesh format.

There is also no *derived* copy of the geometry to keep in step with the file.
The gzip added below is the same bytes under a `Content-Encoding` header — the
browser inflates it and the kernel receives exactly what was uploaded — so it
cannot drift from the source the way a converted mesh would, and it is written
once at extraction rather than maintained. It is best-effort: when it is absent
the viewer presigns the original, so a model extracted before the gzip existed
keeps working. It is swept by the same prefix delete as the other two artefacts,
so a deleted model leaves no compressed copy of itself behind.

### Consequences of that split

| | Extracted server-side, once | Computed client-side, per view |
|---|---|---|
| What | metadata: types, storeys, psets, quantities | geometry: meshes, camera, picking |
| Where it lives | Postgres + an index JSON in object storage | nowhere; recomputed on open |
| Who reads it | the agent, the API, the explorer UI | the viewport only |
| Cost of a browser without WebGPU | none | the viewport degrades to the explorer |

A browser with no WebGPU loses **only the picture**. The structure, the
elements, the properties, the quantities and every answer the agent gives are
unaffected — which is why the fallback names what is missing rather than
apologising.

## Alternatives considered

**Parse with IfcOpenShell in the Python backend.** Mature, and it is what most
BIM tooling uses. Rejected because it would put the *metadata* extractor in a
different language and library from the *geometry* one (which must be
ifc-lite/WASM, because it must run in a browser). Two IFC readers means two
interpretations of the same file, and the day they disagree about what an
element is called, the agent and the viewer disagree in front of the user. One
parser, one interpretation.

**Convert to a cached mesh format (Fragments/glTF) at ingestion.** The original
plan. Rejected: it needs a conversion worker, a second storage artefact, and a
cache-invalidation story — for a saving that ifc-lite's streaming parser
(~50 MB/s, first triangles during parse) largely removes. Revisit if models
routinely exceed what a laptop can parse in a few seconds.

**Let the agent write SQL.** Rejected outright. The query vocabulary is closed
and every value is a bound parameter; a model-authored `WHERE` clause is a
model-authored injection.

**Give the agent model UUIDs.** Rejected: a UUID carried through a conversation
is a reliable source of hallucinated identifiers. The tool addresses models by
project and by file name, and the endpoint resolves them.

## What this costs

- **Extraction runs in the request process**, detached from the request. A model
  is capped at 250 MB (`BIM_MAX_IFC_BYTES`) and 200 000 persisted elements
  (`BIM_ELEMENT_LIMIT`); the counts stay exact past the cap, the element rows
  stop. A process restart mid-parse leaves the document at `processing` and the
  model at `extracting` — visible in both places and recoverable through the
  ordinary re-ingest action. Moving extraction to a worker is the next step if
  model sizes grow.
- **The digest is a summary, not a serialization.** Per-element rows are in
  Postgres where they can be queried; dumping them into a vector index would
  bury the rest of the corpus.
- **`bim_elements` is a wide jsonb table.** Property-set keys are chosen by
  whichever application exported the model, so they cannot be columns. Indexed
  with `gin (properties jsonb_path_ops)`. *(Superseded — see the amendment
  below.)*

## Tenancy

`bim_models` carries `organization_id` and follows the `documents` predicate
exactly. `bim_elements` deliberately carries none: the parent model's column is
the truth and the RLS policy joins it, per the child-table rule in
[ADR-0041](0041-row-level-security-for-tenant-isolation.md). Both are inside the
boundary via migration `0034_bim_models.sql`, and the join is asserted against a
real Postgres in `src/lib/bim/query.integration.spec.ts`.

## Gating

One WorkOS flag, `ifc-models`, with **no paired capability**: extraction has no
infrastructure dependency to derive one from (unlike image upload, which needs a
VLM). WebGPU is a per-browser fact detected at render time, not a deployment
capability. The flag gates the `.ifc` entry in the upload accept-list on both
the client and the BFF allow-list, the model page, and every `/api/**/bim/*`
route. The gate is applied on the user-facing routes through
`assertIfcModelsEnabled`, and on the session-less `/api/internal/bim/query`
route — the agent's path — by evaluating the flag per-organization, so
revoking it stops the agent answering as well as hiding the pages.

## Observability (ADR-0044)

Everything else expensive in a research turn happens in the agent process,
where NAT traces it span by span and Langfuse renders the result. This feature
is the exception: the parse, the SQL and the rule catalogue all run in the BFF,
which exports OTel **logs** and is not a trace producer. `ifc_query` therefore
reaches Langfuse as one opaque span — a duration and a rendered German string.

Rather than make the BFF a second trace producer (a platform decision, not this
feature's to take), the tool states on the trace what it did. It uses the seam
ADR-0044 already established for app-side attribution — the same NAT processor,
ahead of the same redaction pass, under the same `langfuse.trace.metadata.`
prefix:

| | |
|---|---|
| `ifc_op` | which operation ran |
| `ifc_outcome` | `resolved`, `unresolved:<reason>`, or `service_unavailable` |
| `ifc_model` / `ifc_elements` | which model, and how big |
| `ifc_truncated`, `ifc_total_is_lower_bound`, `ifc_catalog_sampled` | whether the answer covered the WHOLE building |

The tag `feature:ifc` goes alongside `org:<id>`, because "which turns read a
building model" is a trace-list filter and metadata is the slower path.

The last row is the one that is not about performance. A truncated run, a
count that stopped early and a sampled property catalogue are all subsets
presented as totals unless something says otherwise; the UI and the agent are
told, and the trace is the third place — the one that lets an answer be
audited after the fact rather than only while it is on screen.

Deliberately absent: element names, property values and filter contents. Those
are already in `output.value` under the redaction policy that governs it, and
copying them into trace metadata would put the same tenant data in a second
place under a second policy. `ifc_outcome` distinguishes "could not look" from
"looked and found nothing" for the same reason the tool's own return value
does.

## Amendments

### The property index (migrations 0036, 0038, 0039, 0040)

`gin (properties jsonb_path_ops)`, as decided above, was never usable by any
query this layer emits, and was dropped in `0036` after being measured at
`idx_scan = 0`. Two things were wrong with it. `jsonb_path_ops` supports
containment (`@>`) only, while the property filters also need key-existence
(`?`); and no operator class can serve the predicate the filters actually
emit, which is a correlated `EXISTS (jsonb_each(properties) … lower(…) =
lower(…))` — set and property names come from whichever tool exported the
model, so the comparison has to be case-insensitive, and `lower()` over an
unnested key is not an indexable expression.

What replaced it keeps the decision above intact — the keys still cannot be
columns — and adds an indexable *shadow* of them:

- `bim_elements.search_keys` (`0038`), a flat lowercased map of exactly what
  those predicates look up, with `gin (search_keys jsonb_ops)` — `jsonb_ops`
  because it must serve `?` as well as `@>`. It is a **necessary pre-filter,
  never the answer**: the exact unnest still decides.
- `bim_models.search_keys_indexed` (`0038`), so a model an older image wrote is
  answered by the unnest alone rather than by an index that does not describe
  it.
- `(model_id, ifc_type, express_id)` (`0039`), so the element list's ordering
  comes from the index and a page stops at its last row.
- `(model_id, lower(storey_name))` (`0040`), for the same reason the original
  index failed: the predicate is on `lower()`, and the plain btree could not
  serve it either.

The two indexes are the fast plan for opposite regimes — one for a filter
matching few elements, one for a filter matching many — and `listBimElements`
chooses between them from measured counts, because jsonb containment has no
statistics and Postgres cannot. `docs/architecture/backend-deep-dive.md`
carries the measurements.

### The viewer's compressed source

The 3D viewport is the one surface that does not read the structured index: it
needs triangles, so it downloads the raw `.ifc` and triangulates it in the
browser with ifc-lite's WASM kernel. That download is the page's slowest phase
by a wide margin, and it is paid **in full on every visit** — a presigned URL is
unique per request, so the object is never cached.

Extraction therefore writes a third derived artefact beside the index and the
digest: `_bim/source.ifc.gz`, the same bytes with `Content-Encoding: gzip`.
STEP is repetitive ASCII and compresses roughly 5–10×, so a 149 MB model
crosses the wire as around 20 MB. The encoding header is what makes it
invisible: the browser inflates the body itself, and the geometry kernel
receives exactly what the architect uploaded.

Three things follow from that shape and are worth stating, because each was a
choice:

- **`getModelSource` probes rather than records.** A `HeadObject` against the
  derived key decides whether to presign the gzip or the original. Models
  extracted before this existed have no gzip and keep working, which a column
  would have required a migration and a backfill to achieve.
- **The write is best-effort.** A failed gzip must not cost an extraction; the
  viewer falls back to the original object, which is slower and correct.
- **The uncompressed length rides as user metadata.** On a gzipped response
  `Content-Length` describes the compressed body while a streaming reader counts
  decoded bytes, so a progress bar that divides one by the other reaches 100% at
  a seventh of the file. With no metadata to divide by, progress reports
  indeterminate rather than wrong.

It costs one extra object per model, swept by the same prefix delete as the
other two — a model cannot leave a compressed copy of itself behind.

### A model previews as a file

The decision above makes a model *queryable*; it left it *findable* only through
a `Modell` entry in the project navigation. So the richest file in the system
was the one file the file system could not show: an `.ifc` opened in **Dateien**
rendered the same decorative page mock as a `.dwg`, captioned "no inline
preview", while the building itself lived on a route beside the file list.

An IFC is now previewed as the building, in the same pane and the same modal
every other file opens in. Three constraints shaped how:

- **The documents pane learns nothing about BIM.** It gains one conditional —
  `inferDocumentKind(...) === 'model'`, a helper it already calls to pick card
  thumbnails — and one dynamic import. Everything else lives in
  `features/bim/components/ifc-file-preview.tsx`: which model belongs to this
  document, whether the browser can draw, what to say when it cannot.
- **The preview is not the workspace.** No tabs, no element table, no Prüfbuch.
  The pane's question is "show me this file"; the analytical surfaces stay one
  link away, and that link addresses the model **by file name** (`?model=`), so
  no UUID travels through a URL a user can see (see *Alternatives considered*).
- **Project scope only.** Models are listed per project, because that route is
  where the `ifc-models` flag and the project-access check live. The org-wide
  Archiv has no project in hand, so it keeps the ordinary preview rather than a
  viewport that could never resolve a model.

Four things can be true of an `.ifc` in that pane, and each gets its own
sentence: the model is ready, it is still being read, it could not be read, or
the model **list** did not load. The last is the one worth naming — collapsing
it into "there is no model" would tell an architect their upload vanished.

### The viewport fails after it starts, too

`supportsWebGpu()` can only ask whether `navigator.gpu` is *present*. Whether an
adapter can actually be acquired is a separate question the browser answers only
when asked — and headless Chromium, a blocklisted driver, a VM and a remote
desktop session all answer it with a refusal after passing the first check. An
interrupted download of a hundred-megabyte model lands in the same place.

Until this change, that path left an empty grey box with a caption in the
corner, which reads as a broken feature rather than a missing picture. The
viewport now renders the same shape of fallback as the unsupported-browser case
— what is missing, what is unaffected, and the raw reason underneath so a
support report does not need a browser console. This was found by capturing the
screenshot for the new preview: the harness's Chromium is exactly such a
browser.
