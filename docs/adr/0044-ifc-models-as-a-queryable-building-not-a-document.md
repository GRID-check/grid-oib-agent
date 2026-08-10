# ADR-0044 — IFC models are a queryable building, not another document

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

An uploaded `.ifc` becomes **two artefacts**, and neither is the raw file:

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
conversion, no cached mesh format, and no second copy of the geometry to keep in
step with the file.

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
