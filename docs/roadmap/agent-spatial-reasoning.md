# Giving the agent a building instead of a table

**Status:** research / design proposal — nothing here is built
**Date:** 2026-08-12
**Scope:** the agent's **spatial** understanding of an IFC model. Not the
viewer, not the OIB corpus, not retrieval — those work. The agent reasons
correctly about regulations; it has never been shown a building.
**Touches:** [ADR-0045](../adr/0045-ifc-models-as-a-queryable-building-not-a-document.md)
— revisits one decision, preserves its invariant.

---

## 0. The turn that prompted this

An architect asked two questions about `Ifc4_SampleHouse.ifc`. The first —
*what is wall `3cUkl32yn9qRSPvBJVyWy4`* — was answered perfectly: type,
function, layer build-up, U-value, area, storey. All correct, all from the
model.

The second was *"ist das Fenster mit dem Dach in Kombo ok für den
Sonneneinfallswinkel"*. The agent retrieved the right clause, understood it
correctly, explained the 45° light prism and the lateral 30° swivel, knew that
an overhang **enlarges the required Lichteintrittsfläche** rather than banning
the window — and then could not answer:

> Das Modell liefert keine zuverlässig auslesbare Überstandstiefe und keine
> Raumbodenflächen je Aufenthaltsraum in einer Form, mit der man Öffnungsfläche
> vs. %-Satz hier zahlenfest „OK/nicht OK" abhaken könnte.

Its own confidence note compressed that into five words: **"Überstand/Raum-% im
IFC nicht messbar."**

That sentence is true of the index we hand the agent and false of the file the
architect uploaded. The overhang is in `Ifc4_SampleHouse.ifc` — it is the roof's
extrusion, placed relative to the wall. The room area is in it — every
`IfcSpace` carries a boundary. The window's real opening is in it — the
`IfcOpeningElement` that the window fills. Three numbers, all present in the
bytes, none of them anywhere the agent can reach.

**The reasoning is not the bottleneck. The representation is.** This document
surveys what the field has already built for exactly this problem, states what
of it we can take, and designs the thing to build.

---

## 1. What the agent can see today

`ifc_query` is a good tool: deterministic, strict about invented filter keys,
careful to distinguish "could not look" from "looked and found nothing",
honest about truncation. None of that is the problem. The shape of what sits
behind it is.

One `bim_elements` row, in full:

| column | example |
|---|---|
| `global_id` | `3cUkl32yn9qRSPvBJVyWy4` |
| `ifc_type` | `IfcWall` |
| `name`, `type_name`, `tag`, `predefined_type` | `Basic Wall:Wall-Ext_102Bwk-…` |
| `storey_name`, `storey_global_id`, `container_*` | `Ground Floor` |
| `materials`, `classifications` | `["Brick, Common", …]` |
| `properties`, `quantities` | `{Pset_WallCommon: {IsExternal: true, ThermalTransmittance: 0.236}}` |

Read that list again asking *which column says where the wall is*. None does.
`storey_name` is the closest and it is a **string** — it says which drawing the
wall was filed under, not where it stands, which way it faces, what it touches,
or what is above it.

The index is a **flat table of isolated elements**: every fact in it is an
attribute of one element considered alone. Not one column relates two elements.

Three consequences, which between them explain every model question Piloti
cannot answer:

| missing | what becomes unaskable |
|---|---|
| **no relations** | what is next to / hosted in / bounded by / connected to / above what; which window sits in which wall; which walls enclose which room; whether a door leads outside |
| **no coordinates** | distance, direction, height above ground, clear width, overlap, which way a facade faces, how far a roof projects past a wall |
| **no surfaces** | the plane of a facade, the aspect of a room, the real (not nominal) glazed area, what a sightline hits |

On real questions:

| question | needs | today |
|---|---|---|
| Wie viele Außenwände im EG? | attribute | ✅ |
| U-Wert der Fenster? | attribute | ✅ |
| Welches Fenster sitzt in dieser Wand? | relation | ✗ |
| Welche Räume grenzen an das Stiegenhaus? | relation | ✗ |
| Wie tief kragt das Dach über der Südfassade aus? | metric | ✗ |
| Fluchtweg vom hintersten Raum ≤ 40 m? | relation + metric | ✗ |
| Liegt die Brüstung unter 100 cm? | metric | ✗ unless declared |
| Lichteintrittsfläche dieses Raumes? | relation + surface | ✗ |
| Ist der 45°-Lichteinfall frei? | relation + metric + surface | ✗ |
| Raumhöhe unter dem Unterzug noch 2,10 m? | metric | ✗ |

The pattern is not "hard questions fail". It is that **every question about an
arrangement of two or more things fails** — which is most of what a
Prüfingenieur asks.

The rule catalogue shows the same ceiling from the other side. Six rules, and
each is a lookup of a value the modeller typed: `RiserHeight`, `ClearWidth`,
`FinishCeilingHeight`, `FireRating`, `ThermalTransmittance`, `AcousticRating`.
Not one measures anything. That is not a gap in the catalogue — it is the limit
of what any catalogue over this index could contain, and `rules.ts` says so
itself.

---

## 2. What "spatial understanding" has to mean, operationally

"Understands the building" is not testable. Three things are:

1. **Topological competence** — the agent can name a relation between two
   elements *nobody wrote down for it*: this window is in that wall, which
   encloses that room, which opens onto that corridor.
2. **Metric competence** — it can produce a number about an arrangement (a
   distance, an angle, a projected depth, a real surface area) **with a
   derivation**: which elements, which operation, which tolerance.
3. **Calibrated ignorance** — when the file genuinely cannot support a number
   it says which fact is missing and what would supply it, and it does *not*
   say that when the number is derivable.

The third is the one to optimise. Today's failure is a false "undecidable"
about two perfectly measurable numbers. An agent that answers 60 % of spatial
questions and is right about which 40 % it cannot answer is a review tool. One
that answers 90 % and is wrong about which 10 % is a liability, because in this
domain a confident wrong number gets signed.

---

## 3. What has already been done

Nothing in this problem is unexplored. Five distinct research and tooling
lineages have attacked it, and one of them — LLM agents over BIM — has produced
enough measurement in the last eighteen months to settle an architectural
argument we would otherwise have to have by intuition.

### 3.1 Geometry and topology engines

| engine | language | what it gives | notes |
|---|---|---|---|
| **IfcOpenShell** (`ifcopenshell.geom.tree`) | Python/C++ | `select_box`, `select` (exact shape, with `extend` buffer), `select_ray(origin, direction, length)` returning hit position, distance, normal and dot product; `clash_intersection_many(tolerance=0.002)`, `clash_collision_many`, `clash_clearance_many(clearance)` | UB-tree from native OCCT shapes, BVH from triangulation. This is, essentially, the operator layer of §7 already implemented and battle-tested ([docs](https://docs.ifcopenshell.org/ifcopenshell-python/geometry_tree.html)) |
| **TopologicPy** | Python/C++ (OCCT) | non-manifold `CellComplex` of a building; adjacent cells share faces; **dual graph** connecting adjacent cells' centroids | the canonical "building as graph" library ([topologicpy](https://topologicpy.readthedocs.io/), [Topologic](https://github.com/wassimj/Topologic)) |
| **`@ifc-lite/geometry`** (ours) | TS + WASM | streamed tessellation, per-element `expressId`, local-frame origins, RTC/unit metadata, building rotation from `IfcSite` | already a dependency; see §4 |
| **web-ifc / ThatOpen** | TS + WASM | parses and queries in browser **and Node**; `IfcRelationsIndexer` builds a relation index | the JS ecosystem's answer to the same need |
| **xbim** | .NET | geometry engine + model checking | outside our stack |

**Take-away:** the primitives are commodity. Ray casting, clearance, exact
selection, clash and adjacency have production implementations in at least
three ecosystems. Nobody needs to invent them, and we should not.

### 3.2 The space-boundary problem — the known hard part

Rooms are where geometric compliance lives, and IFC's own answer is
`IfcRelSpaceBoundary`. The **2nd-level** variant exists precisely to give
analysis packages a surface view of the building, and the standard names its
three intended consumers: energy analysis, **lighting analysis**, and CFD
([IFC4.3 docs](https://ifc43-docs.standards.buildingsmart.org/IFC/RELEASE/IFC4x3/HTML/lexical/IfcRelSpaceBoundary2ndLevel.htm)).
That is our question, named in the schema.

The catch is universally reported: **2nd-level boundaries are usually absent or
wrong** in exported models. A decade of work exists on generating them:

- the **Space Boundary Tool (SBT)** — IFC2x3 only, drops curtain walls and some
  properties;
- **CBIP** (Common Boundary Intersection Projection), the UCL algorithm that
  generates 2nd-level topology from IFC geometry using IfcOpenShell
  ([Automation in Construction](https://www.sciencedirect.com/science/article/abs/pii/S0926580516301984),
  [preprint](http://discovery.ucl.ac.uk/1546334/1/CBIP_revised.pdf));
- later IBPSA work on generating 2nd-level boundary **geometry**, which reports
  the failure modes to design around: non-closed shells, inner/overlapping/
  wrongly-oriented faces, and gap healing that works "as long as gaps don't
  exceed a few centimetres"
  ([BS2021](https://publications.ibpsa.org/proceedings/bs/2021/papers/bs2021_30156.pdf)).

**Take-away:** use declared boundaries when present, compute a fallback when
not, and treat the fallback as `computed` with a tolerance — never silently mix
the two. The gap-healing threshold is a real number we will have to pick and
publish.

### 3.3 Graph representations of buildings

- **BOT — Building Topology Ontology** (W3C Linked Building Data,
  [Semantic Web Journal](https://www.semantic-web-journal.net/system/files/swj2279.pdf)).
  Four `bot:Zone` subclasses — `Site`, `Building`, `Storey`, `Space` — and three
  `bot:hasElement` sub-properties: `containsElement`, `adjacentElement`,
  `intersectingElement`, plus `bot:interfaceOf` for the boundary between a zone
  and an element. An `IFCtoLBD` converter exists. **This is a published, minimal,
  battle-argued vocabulary for exactly the graph in §6 — we should align our
  edge names to it rather than invent a private ontology.**
- **IFC-Graph / Cypher4BIM** (*Automation in Construction* 2025,
  [arXiv:2405.16345](https://arxiv.org/abs/2405.16345)) — converts IFC to a
  property graph and defines functional query patterns over five information
  categories: **spatial structure, space boundary, space accessibility,
  individual instances, complex relations**. Validated on five models. That
  category list is a good checklist for our operator coverage.
- **ifcOWL** — the full schema as OWL. Complete, and unusable at reasoning time:
  it reproduces IFC's objectified-relationship indirection rather than removing
  it. BOT exists because ifcOWL was too heavy; that lesson transfers directly.
- **`IfcRelationsIndexer`** (ThatOpen) — the same idea shipped as a viewer
  feature: index the relations once, query them fast.

### 3.4 Semantic enrichment — the `inferred` layer, already studied

Whether a space is an *Aufenthaltsraum* is not in the file. This is a known
research problem with a name: **semantic enrichment**.

- **SeeBIM** (Sacks et al.) encapsulates expert knowledge as inference rules
  and — importantly — uses **a BIM query language with spatial and topological
  operators** as its substrate. The prior art for §7 is not just geometric
  kernels; it is the idea that enrichment rules should be written against a
  closed operator vocabulary.
- **Bloch & Sacks** compared rule-based against machine-learned room-type
  classification: rigorous rule sets reached **100 % accuracy** but were tedious
  to author and scaled badly across many classes
  ([Automation in Construction](https://www.sciencedirect.com/science/article/abs/pii/S0926580521004908),
  [ITcon review](https://www.itcon.org/papers/2022_20-ITcon-Bloch.pdf)).
- Later work uses **graph neural networks** over the room adjacency graph for
  space-function classification.

**Take-away:** rules first (they are auditable and they hit 100 % when the
lexicon fits), learned models later and only as a *proposal*. Either way the
result is `inferred` and must be offered for confirmation — which is what the
existing `project_profile_patch` card already does for Gebäudeklasse.

### 3.5 Rule and compliance machinery

- **Solibri** is the incumbent and the benchmark for what "checked" means
  commercially: free-area checks around objects, **clearances around doors,
  windows and stairs**, and **escape-route length calculation**. The escape-route
  analysis approach was published and validated on real models
  ([Automation in Construction 2023](https://www.sciencedirect.com/science/article/pii/S0926580523003527)).
  Everything in that list is geometry; none of it is a property lookup.
- **IDS** (Information Delivery Specification, buildingSMART, v1.0 June 2024) is
  the standard for "which information must this model carry", with
  **IfcTester** in IfcOpenShell implementing all six facets and reporting to
  **BCF**. Implemented by Solibri Office, BIMcollab Zoom, Plannerly, BIMQ.
  **Our `missingPropertyShoppingList` is a private dialect of IDS.** Emitting
  real IDS would let an architect run our requirements inside the tools they
  already own.
- **EU digital-building-permit projects** — **CHEK** ([chekdbp.eu](https://chekdbp.eu/))
  and **ACCORD** ([accordproject.eu](https://accordproject.eu/)) — are building
  exactly this pipeline for European permit authorities, on IFC + CityGML +
  IDS, covering setbacks, heights and shadow studies, with a rule-formalisation
  tool and a published building-compliance ontology. This is the closest thing
  to an institutional standard for what Piloti does, and it is where OIB-style
  checks are heading.
- The generic ACC literature converges on a four-stage pipeline — rule
  interpretation → model preparation → rule execution → reporting — and reports
  the daylight case in the same words we need it in: the window-to-floor ratio
  "cannot be directly extracted; it must be indirectly derived by calculating
  the ratio of the spatial area to the window opening area".

### 3.6 LLM agents over BIM — where the numbers are

This is the most decision-relevant literature, because it measures the two
architectures we must choose between.

**Structured tools + precomputed geometry:**

- **IfcLLM** ([arXiv:2605.13236](https://arxiv.org/html/2605.13236v2)) pairs a
  relational store — 15 element types with attributes **and simplified
  geometry: centroids and bounding boxes** — with a property graph for
  connectivity between navigable elements. Over 30 scenarios on three models:
  SQL 91.3–100 %, **graph queries 100 % on all three**. It states the design
  constraint plainly: distance queries need geometry **precomputed into the
  database**, not derived at inference; full mesh reasoning at inference time is
  not viable.
- **SGR-BIM** ([arXiv:2606.12065](https://arxiv.org/abs/2606.12065)) builds a
  cross-modal graph aligning user intent, regulatory semantics and BIM geometry:
  **84.3 % over 679 expert-verified fire-code queries, +8.6 points over a strong
  single-agent tool baseline.** The gain comes from the graph and the
  decomposition, not from a bigger model.
- **A modular MCP reference architecture for agentic BIM**
  ([arXiv:2601.00809](https://arxiv.org/pdf/2601.00809)) separates a geometry
  layer from a semantic layer behind a tool interface, and concludes for
  **coarse-grained, domain-shaped tools** over raw IFC access — reporting that
  exposing raw IFC to an LLM "causes hallucination and confusion".
- **LLM-based adaptive exploration**
  ([arXiv:2605.01698](https://arxiv.org/pdf/2605.01698)) has the agent explore a
  model progressively under an explicit token budget (200 k), rather than
  ingesting it. Failure modes: deep nested hierarchies, keeping a coherent
  picture of relations across steps, and loss when truncation bites.

**Code generation into a sandbox** — the honest counter-argument, and it has
just been measured:

- **BIM-Edit** ([arXiv:2606.20146](https://arxiv.org/html/2606.20146)) gives an
  agent one tool, `execute_ifc_code`, with IfcOpenShell pre-loaded, a 20-call
  budget and a 120 s timeout, over **324 IFC editing tasks** spanning
  create/update/delete × direct/spatial/topological instructions × simple
  (~21 elements) and complex (~615 elements, ~2 089 relations) scenes.
  Frontier models score **43.9–49.5 out of 100** overall; **strict solve rates
  are under 4 %**. Geometry scores (~54 %) run well ahead of semantic and
  topological ones (~39 %) — models approximate the shape and lose the
  relations. Spatial and topological instructions cost 50–80 % more tokens and
  **do not score better**. One frontier model exhausted its call budget on 46 %
  of tasks.

That last bullet is the single most useful measurement in this document.
BIM-Edit is an *editing* benchmark, so it is harder than our read-only case —
but the direction is unambiguous: **an LLM writing geometry code against an IFC
is not, in 2026, a reliable way to obtain a number that an architect will
sign.** Relations are precisely where it degrades, and relations are precisely
what our questions need.

### 3.7 What the evidence says, in five sentences

1. The geometric primitives are solved and commoditised — take them, do not
   build them.
2. Every serious system precomputes simplified geometry (centroids, boxes,
   surfaces) into a queryable store; nobody reasons over meshes at inference.
3. A relation graph is what makes multi-hop spatial questions reliable — the
   graph half of IfcLLM scored 100 % where its SQL half did not.
4. Coarse, domain-shaped tools beat raw access; raw IFC in context produces
   hallucination.
5. Letting the model author geometry code is expressive and unreliable, and
   fails hardest on exactly the relational structure our domain runs on.

---

## 4. The substrate we already have — and throw away

Two findings from reading our own dependencies rather than their READMEs. Both
mean this is far less new machinery than it looks.

### 4.1 The relationship graph already exists, and we discard it

`@ifc-lite/parser` builds a **bidirectional CSR relationship graph** over the
whole file. `@ifc-lite/data` exports its type. The edge types it already
carries:

```
ContainsElements = 1      Aggregates = 2           DefinesByProperties = 10
DefinesByType = 11        AssociatesMaterial = 20  AssociatesClassification = 30
ConnectsPathElements = 40 FillsElement = 41        VoidsElement = 42
ConnectsElements = 43     SpaceBoundary = 50       AssignsToGroup = 60
AssignsToProduct = 61     ReferencedInSpatialStructure = 70
```

Look at 40–50. `FillsElement` is *this window fills that opening*.
`VoidsElement` is *that opening is a hole in that wall*. `SpaceBoundary` is
*that wall bounds this room*. `ConnectsPathElements` is *this wall meets that
wall, at this end*. The window→wall→room chain the failed answer needed is
**already built, in memory, on every extraction we run** — and there is an
`EntityFlags.HAS_OPENINGS` / `IS_FILLING` bit per entity that we never read
either.

`extract.ts` reads `ContainsElements`, `DefinesByProperties`, `DefinesByType`,
`AssociatesMaterial` and `AssociatesClassification`, and drops the rest when the
parse ends.

**So Phase 0 is not "add geometry". It is "stop discarding the graph".** No new
dependency, no kernel, no ADR to revisit.

And one step smaller still: `bim_elements.container_name` / `container_kind`
already exist as columns and are already written — `BimContainerKind` includes
`'space'`, so on an export whose elements are contained in rooms, *the
room-to-element relation is in Postgres today*. It reaches nobody:
`bimFilterSchema` has no container key and `BimElementListRow` does not select
the column. "Welche Bauteile stehen in Raum WZ 03" is currently a stored fact
with no way to ask for it.

### 4.2 The geometry kernel runs wherever Node runs

`GeometryProcessor` is a WASM pipeline behind a platform bridge (browser WASM /
native Rust under Tauri). Its `MeshData` carries `expressId`, positions, a
per-element local-frame `origin`; its `CoordinateInfo` carries unit scale, the
RTC shift, the building rotation from `IfcSite` and the original bounds. None of
it needs a GPU — WebGPU lives in `@ifc-lite/renderer`, a package we would not
import.

ADR-0045 says *"Geometry is never processed server-side."* That decision was
about **rendering**, and it was right: no mesh cache, no conversion worker, no
derived copy of the picture to keep in step. This proposal touches none of that.
It says geometry is *also the reasoning substrate*, and proposes a
**derived-facts pass** — placements, boxes, footprints, surfaces; a few thousand
numbers per model, not a mesh cache.

The ADR's real invariant is in its rejection of IfcOpenShell: *"One parser, one
interpretation."* Running ifc-lite's own kernel in the same Node process
**preserves** that invariant. Adding a Python IfcOpenShell service would break
it (§14).

---

## 5. What we could give the agent — the inventory

Ranked by value per unit of risk. "Evidence" points at the prior art that shows
it works.

| # | capability | effort | unlocks | evidence |
|---|---|---|---|---|
| 1 | **Persist the relation graph** (fills/voids/bounds/connects/aggregates) | S — stop discarding | window↔wall↔room, doors↔spaces, openings per wall, connected walls | §4.1; IfcLLM graph 100 % |
| 2 | **Per-element placement + AABB/OBB + azimuth** | M — geometry pass | where, how big, which way it faces, above/below, sill/head heights, real opening areas | IfcLLM stores exactly this |
| 3 | **Space footprints + computed floor areas + depth** | M | room %, room depth surcharges, Raumbuch that does not depend on the exporter writing Qto | ACC daylight literature |
| 4 | **Model dialect map + building briefing in context** | S — agent-side | stops the "filtered on a property this exporter never wrote" class of wrong empty answers | MCP arch: coarse tools; adaptive exploration |
| 5 | **Derivation objects (every number carries its method)** | S — agent-side | auditability; the reviewer can check the chain, not just the number | our own citation system |
| 6 | **Triangulation (declared vs computed vs derived)** | S once #2/#3 exist | catches wrong quantity sets; becomes a saleable export-quality finding | new — but cheap |
| 7 | **Space boundaries: declared, with computed fallback** | L | aspect, envelope by orientation, adjacency, daylight | SBT / CBIP / IBPSA |
| 8 | **Constructive operators: prism, obstructions, ray, projection** | M given #2 | the 45° Lichteinfall, overhangs, clear widths, headroom | `geom.tree.select_ray`, Solibri free-area |
| 9 | **Door/space traversal graph + path lengths** | M | Fluchtweglängen, accessibility, "which rooms are behind this door" | Solibri escape routes; Cypher4BIM accessibility |
| 10 | **Room-use inference (rules first, GNN later)** | M | *which* rooms are Aufenthaltsräume — the precondition for most OIB 3 checks | SeeBIM; Bloch & Sacks |
| 11 | **IDS export of the shopping list** | S | our "what to author in your CAD" runs inside Solibri/BIMcollab | IDS 1.0 + IfcTester |
| 12 | **Geometric rules in the catalogue, authored as skills** | M | catalogue stops being six property lookups | ACCORD rule formalisation |
| 13 | **Georeference-aware sun path** | S when present, impossible when not | real Besonnung, not just the geometric prism | `IfcMapConversion` often absent |
| 14 | **Cross-model / site context (CityGML neighbours)** | XL | the "frei" in freier Lichteinfall | CHEK (BIM + CityGML) |

Items 1–6 are the ones that change the agent's character rather than its
feature list, and five of the six are small.

---

## 5b. How far does a *skill* alone get us?

Worth asking before any of §5 is built, because a skill is instructions — no
migration, no extraction change, no deploy risk — and this repo already has the
machinery (`SKILL.md`, `use_skill`, the org toolbox). The honest answer has
three parts.

### What a skill genuinely fixes

Everything in the loop that is *discipline* rather than *data*:

1. **Grounding before filtering.** Call `overview` and `properties` first,
   copy storey and property names verbatim, never guess. This is the single
   largest source of wrong answers today, and the tool description currently has
   to *beg* for it in prose the model reads once. A skill makes it a procedure.
2. **A hand-built dialect map.** The first three calls of a model conversation
   can produce §8.1's `DIALEKT` block by hand: which psets exist, how well
   filled, what this exporter calls the U-value. That is the briefing,
   assembled in-context instead of precomputed.
3. **Storey arithmetic that is already available and unused.** `overview`
   returns storey elevations. Differences are storey heights; the sign of the
   lowest tells you Kellergeschoß; the span is the building height. All present
   today, rarely derived.
4. **Coarse ratios via `aggregate`, computed deterministically.** For the OIB 3
   daylight question, per *storey*: `aggregate(sum, quantity: Area,
   ifcTypes: [IfcWindow], groupBy: storey)` against `schedule`'s per-storey room
   area. Two calls, no arithmetic by the model, and `aggregate` already reports
   "über X von Y Bauteilen" so the coverage gap is stated rather than hidden.
   *"Im Erdgeschoß stehen 18,2 m² Fensterfläche 210 m² Raumfläche gegenüber —
   8,7 % auf Geschoßebene. Raumweise ist das aus diesem Modell nicht
   auflösbar."* That is a vastly better answer than "nicht messbar", and it is
   available today.
5. **Checking the declared value before declaring it absent.** Sill heights,
   clear widths and glazing areas *are* sometimes authored
   (`Pset_WindowCommon.SillHeight`, `Qto_WindowBaseQuantities.Area`). A skill
   that always calls `properties` before concluding "not in the model" converts a
   share of today's false "undecidable" into answers.
6. **The decidability vocabulary.** Three states, always name the property or
   the entity that would settle it, never let a stand-down read as a verdict.
7. **Fast, correct refusal.** Tell the agent which question shapes are
   *structurally* unanswerable from this index — overhang depth, prism freedom,
   clear widths between two elements, escape-route lengths — so it says so in
   the first paragraph instead of after a long turn.

### What a skill cannot do, at any length

No instruction creates a fact. A skill cannot:

- relate a window to its wall, a wall to its room, or a room to its neighbour —
  those relations are not in the index (§4.1);
- measure anything: no distance, no overhang, no angle, no clear width, no
  projected area;
- turn a nominal `1810 × 1210` into a real opening area;
- decide which rooms are Aufenthaltsräume beyond a name lexicon;
- and it must be written to *forbid* the plausible substitutes — a model told
  to be helpful about an overhang will estimate one.

### The score, honestly

Against §1's table, a skill moves **three of ten** questions from ✗ to *"useful
coarse answer with a precisely named gap"*, and **zero** to ✅:

| question | with a skill alone |
|---|---|
| Lichteintrittsfläche eines Raumes | per storey ✓, per room ✗ |
| Brüstungshöhe | ✓ when declared, ✗ otherwise |
| Raumhöhe | ✓ storey-to-storey (structural), ✗ clear height under a beam |
| the other seven | unchanged |

Call it 20–30 % of the perceived quality improvement for ~1 % of the effort —
concentrated in *never being confidently wrong* and *failing fast and
specifically*, which is exactly the axis §2 says matters most.

### The part that makes it worth doing first

**The skill is the experiment for Phase 4.** §16's open question 3 asks whether
the briefing and the disclosure ladder actually change agent behaviour — argued
here from two papers and our own defect history, measured on our agent never. A
skill implements both by hand, at zero infrastructure cost, and can be A/B'd on
the §13 question set. If the skill moves decidability calibration, the briefing
is worth building; if it does not, we learn that before writing a geometry pass.

That is also the honest ordering argument: **Phase 0 (persist the relation
graph) and the skill should ship together.** The skill teaches the loop, Phase 0
gives it the window↔wall↔room chain, and neither requires the geometry decision
to be made yet.

### Draft

```markdown
---
name: ifc-spatial-discipline
description: Wie eine Frage zum BIM-Modell beantwortet wird - erst das
  Vokabular des Modells feststellen, dann filtern, Zahlen nur aus aggregate,
  und raeumliche Fragen sofort und praezise als nicht entscheidbar kennzeichnen.
metadata:
  grid-agents: shallow_researcher,deep_researcher
  grid-cards: ifc_viewer,ifc_schedule,ifc_element
---

# Modellfragen: Reihenfolge, Zahlen, Grenzen

## 1. Immer zuerst: das Modell sprechen lassen
Vor JEDEM Filter:
1. `overview` — Geschoßnamen und Elevationen wörtlich übernehmen.
2. `properties` — welche Psets existieren und wie gut befüllt.
Ein Filter auf einen Namen, der dort nicht steht, liefert 0 Treffer und liest
sich wie „das Gebäude hat keine". Das ist der häufigste Fehler.

## 2. Was ohne Geometrie ableitbar ist
- Geschoßhöhen = Differenz der Elevationen (strukturell, ohne Deckenabzug —
  sag das dazu).
- Untergeschoß = negative Elevation.
- Flächenverhältnisse je GESCHOSS: `aggregate(sum, quantity, groupBy: storey)`
  gegen `schedule`. Nie je Raum — die Zuordnung Fenster→Raum existiert im
  Index nicht.

## 3. Zahlen kommen aus dem Werkzeug
Niemals Elementlisten selbst summieren. `aggregate` nennt „über X von Y
Bauteilen" — beide Zahlen berichten.

## 4. Drei Zustände, nie zwei
erfüllt / nicht erfüllt / **nicht entscheidbar**. Bei „nicht entscheidbar"
immer benennen, WAS es entscheiden würde (genaue Property oder Entität).
Eine fehlende Property ist eine Aussage über den EXPORT, nicht über das Haus.

## 5. Sofort und präzise ablehnen
Aus diesem Index NICHT ableitbar — sag es im ersten Absatz, schätze nicht:
Auskragung / Überstand · freier Lichteinfallswinkel · lichte Breiten zwischen
zwei Bauteilen · Fluchtweglängen · Abstände · Himmelsrichtung einer Fassade ·
welches Fenster in welcher Wand sitzt · welche Räume aneinandergrenzen.
Erst prüfen, ob der Wert DEKLARIERT ist (`properties`), dann ablehnen.
```

---

## 5c. The division of labour: tools give capability, skills give judgment

The skill above is not a stopgap that the operators later replace — the two are
different halves of one thing, and each is nearly useless alone.

| | tools (§7) | skills |
|---|---|---|
| supply | **capability** — what can be computed at all | **procedure** — when to reach for it, in what order, what to say |
| authored by | us, in code, reviewed, versioned, tested | domain experts, in Markdown, without a deploy |
| failure when absent | the agent cannot know the number | the agent has the number and uses it inconsistently |
| changes with | the geometry we can extract | the Richtlinie, the Bundesland, the reviewer's practice |

A tool without a skill is a capability the agent reaches for on some turns and
not others — which is the current `properties`-before-filtering situation
exactly: the capability exists, the tool description asks for it in prose, and
compliance is a coin flip. A skill without a tool is discipline with nothing to
be disciplined about: it can make the agent *fail well*, and nothing more.

Two consequences for how this gets built:

**Every operator ships with the skill text that teaches it.** A new primitive is
not done when it returns a correct number; it is done when there is a paragraph
saying which question shape reaches for it, which arguments to bind, and what
its `decidable: false` means. Otherwise we add capability and measure no change
— which is a real risk given §13's metrics, and a very expensive way to learn
nothing.

**The normative layer becomes authorable.** Once the operator set exists, an OIB
check is a skill that names a clause, binds its thresholds, calls three
operators and renders three states. That is what lets the catalogue stop being
six hardcoded property lookups and start being something a Ziviltechniker can
extend for a Landesbauordnung without a pull request — the same move ACCORD
makes with its rule-formalisation tool, and the same architecture SeeBIM used
twenty years earlier (expert rules over a closed spatial-operator vocabulary).

The boundary has to be policed in one direction: **a skill may compose
operators, never substitute for one.** A skill that says "estimate the overhang
from the roof's Length property" is worse than no skill, because it launders a
guess through a procedure. That is the rule the draft's §5 encodes, and it stays
the rule after the operators land — only the list of forbidden substitutes
shrinks.

---

## 6. The design: a Building Graph the agent reasons over

One typed, directed, attributed graph per model, computed once at extraction,
versioned like `rule_inputs` is. Edge names align to **BOT** where BOT has a
name, because a published vocabulary beats a private one and because it makes
an RDF export later a rename rather than a redesign.

### 6.1 Nodes

| node | from | key attributes |
|---|---|---|
| `Site` / `Building` / `Storey` (`bot:Zone`) | spatial tree (already extracted) | elevation band, true north, georeference if any |
| `Space` (`bot:Space`) | `IfcSpace` | footprint polygon, floor area **computed and declared**, height, volume, depth, inferred use |
| `Element` (`bot:Element`) | as today | + placement, AABB, OBB, principal axis, azimuth |
| `Opening` | `IfcOpeningElement` | host, filler, real opening area, sill/head above storey |
| `Surface` (`bot:Interface`) | 2nd-level boundaries, else computed | plane (normal + origin), area, side, what is on the other side |
| `Zone` | `IfcZone`, groups, fire compartments | membership |

The `Space` node is what changes the most questions. A room today is a row with
a name and maybe a `Qto_SpaceBaseQuantities.NetFloorArea`. A room in the graph
is a polygon with walls around it, windows in those walls, a depth, an aspect,
and a floor it sits on.

### 6.2 Edges

| edge | source | kind |
|---|---|---|
| `containsElement` | `IfcRelContainedInSpatialStructure` | declared |
| `hasSubElement` | `IfcRelAggregates` | declared |
| `voids` / `fills` | `IfcRelVoidsElement` / `IfcRelFillsElement` | declared |
| `interfaceOf` (bounds) | `IfcRelSpaceBoundary` 1st/2nd level | declared |
| `connects` | `IfcRelConnectsPathElements`, `IfcRelConnectsElements` | declared |
| `hostedIn` | window/door → wall, via fills+voids, else containment test | declared → computed |
| `adjacentElement` | OBB proximity within tolerance, shared surface > ε | **computed** |
| `above` / `below` | XY footprint overlap + elevation order | **computed** |
| `interfaceOf` (fallback) | space polygon ↔ wall surface intersection (CBIP-style) | **computed** |
| `faces` | surface normal → compass octant, after true north | **computed** |
| `opensTo` | door/window → the spaces (or space + exterior) either side | **computed** |
| `reachableFrom` | door traversal graph between spaces | **computed** |
| `isAufenthaltsraum`, `isFluchtweg`, … | lexicon + area + aspect + connectivity | **inferred** |

### 6.3 The provenance trichotomy — the part that matters most

Every edge and every derived number carries one of three kinds, and the agent is
told which:

- **declared** — the file says so. Wrong only if the export is wrong.
- **computed** — we measured it, with a stated tolerance. *"These two walls are
  adjacent: shared surface 4.2 m², gap ≤ 2 mm."*
- **inferred** — a heuristic with a confidence and a reason. *"Probably an
  Aufenthaltsraum: name 'Wohnen', 24 m², external window."*

This is not decoration. It is the mechanism that produces the three different
sentences a reviewer must be able to tell apart:

> Das Modell **deklariert** die Wand als raumbegrenzend für WZ 03.
> Die Auskragung **beträgt gemessen** 1,32 m (± 5 mm, aus der Dachgeometrie
> gegen die Fassadenebene der Wand `3cUkl…`).
> Der Raum ist **vermutlich** ein Aufenthaltsraum (Name „Wohnen", 24,3 m²,
> Fenster an der Südfassade) — bitte bestätigen.

The codebase already refuses to present a subset as a total or a stand-down as a
verdict. This is that same discipline applied to the difference between what a
model says and what we worked out.

### 6.4 Where it lives

Follow the pattern already established; do not invent one.

- **Scalars that get filtered on** → narrow columns on `bim_elements`
  (`elevation_min/max`, `bbox_*`, `azimuth`, `host_global_id`,
  `space_global_id`). Indexable, cheap, no jsonb — and note that the one jsonb
  GIN index this subsystem tried was measured at `idx_scan = 0` and dropped.
- **Graph and polygons** → one compact artefact beside the existing index
  (`_bim/graph.json.gz`), loaded on demand and cached per model. Same lifecycle,
  same prefix delete, same best-effort rule as `source.ifc.gz`.
- **`graph_version` column** → a model extracted by an older image is a *miss*
  that recomputes, never a wrong answer. Exactly what `rule_inputs` does.
- Tenancy unchanged: everything hangs off `bim_models`, whose RLS predicate
  already covers it.

---

## 7. The operator vocabulary

The agent must not write geometry code and must not write SQL — ADR-0045's
argument, now backed by BIM-Edit's numbers. So: a **closed set of composable
spatial operators**, each with a schema, each returning a value *plus its
derivation*. The right-hand column shows that almost every one has a
production implementation to copy semantics from.

```
── topological ─────────────────────────────  prior art
hosts(element) / hostedIn(element)            IFC fills/voids
bounds(space) / enclosedBy(element)           IfcRelSpaceBoundary, bot:interfaceOf
adjacentTo(element, tol)                      geom.tree.clash_collision_many
above(element) / below(element)               bbox overlap + elevation
connects(element)                             IfcRelConnectsPathElements
opensTo(opening)                              Cypher4BIM "space accessibility"
pathBetween(space, target)                    Solibri escape-route analysis

── metric ──────────────────────────────────
placement(element) → origin, axes, azimuth    ifc placement resolution
extent(element) → AABB, OBB, footprint        IfcLLM's stored primitives
area(space|surface, kind)                     computed + declared + delta
distance(a, b, min|centroid|horiz|vert)       geom.tree.clash_clearance_many
clearWidth(a, b) / clearHeight(volume)        Solibri clearance checks
sill(opening) / head(opening)
depth(space, facade)

── constructive ────────────────────────────
prism(surface, angle, swivel)                 the 45°/30° light prism
obstructions(volume, exclude)                 geom.tree.select(…, extend)
projection(element, plane) / overhang(…)
ray(from, direction, length)                  geom.tree.select_ray
sunPath(date, lat, lon, north)                only when georeferenced

── model-wide ──────────────────────────────
briefing() · envelope() · inventory(kind)     §8
```

Every operator returns the same envelope:

```json
{
  "value": 1.32, "unit": "m", "tolerance": 0.005,
  "provenance": "computed",
  "from": ["1Ab2…roof", "3cUkl32yn9qRSPvBJVyWy4"],
  "method": "overhang(roof, facadePlaneOf(wall))",
  "decidable": true,
  "caveat": null
}
```

`decidable: false` is a first-class result carrying **what would settle it** —
the same shape as today's `missingPropertyShoppingList`, extended from "author
this property" to "this model contains no `IfcSpace`, so no room area can be
derived; export rooms and re-upload". Expressed as IDS (§5, item 11) it becomes
a file the architect can run in their own checker.

**Composability is the difference from today's vocabulary.** Today's twelve ops
are twelve answers. These are primitives the agent chains — `bounds(space)` →
`hosts(wall)` → `opensTo(opening)` → `prism(...)` → `obstructions(...)` — while
still never authoring a predicate: it picks operators and binds arguments to ids
it obtained from earlier calls.

---

## 8. What the agent gets in context

A tool behind a wall is not understanding. This is the half the literature
under-weights — it measures a *tool's* accuracy on a benchmark, while what
decides whether an architect gets a right answer is whether the agent,
mid-conversation, under a budget, makes the right three calls.

### 8.1 The building briefing

A deterministic ~1 200-token spatial précis, computed once per model, injected
when a conversation first touches it — the spatial counterpart of the Markdown
digest that already serves retrieval. Not prose from an LLM: a rendered fact
sheet.

```
GEBÄUDE  Ifc4_SampleHouse.ifc · IFC4 · Revit 2024 · 2 Gebäude, 4 Geschoße
GESCHOSSE  Basement −2.60 | Ground Floor ±0.00 | First Floor +2.85 | Roof +5.70
HÜLLE      Außenwandfläche 412 m²; Fassaden N 88 · O 61 · S 96 · W 61 m²
           Nordabweichung +12.4° (IfcGeometricRepresentationContext)
           Georeferenzierung: KEINE (kein IfcMapConversion, keine RefLatitude)
DACH       Flachdach, Auskragung über Fassadenflucht: N 0.00 · O 0.35 · S 1.32 · W 0.35 m
RÄUME      12 IfcSpace · 9 mit deklarierter Fläche · 12 mit berechneter
           größte Abweichung deklariert↔berechnet: 0.4 %
           vermutliche Aufenthaltsräume: 7 (Lexikon + Fläche + Fenster)
ÖFFNUNGEN  14 Fenster / 8 Türen · 14 mit IfcRelFillsElement (100 %)
           reale Öffnungsflächen verfügbar: 14/14
DIALEKT    Feuerwiderstand → Pset_WallCommon.FireRating (0 % befüllt)
           U-Wert → Pset_WallCommon.ThermalTransmittance (94 % befüllt)
           Raumfläche → Qto_SpaceBaseQuantities.NetFloorArea (75 % befüllt)
BLIND      keine 2nd-level space boundaries (Fallback berechnet, ±3 cm)
           Brüstungshöhen nicht deklariert (aus Öffnungsgeometrie berechenbar)
```

`DIALEKT` removes the most common cause of a wrong empty answer today — a filter
on a property name this exporter never used — by *telling* the agent the mapping
instead of warning it to go looking. `BLIND` is the honesty budget: the agent
knows up front which questions this file cannot answer, so "nicht entscheidbar"
becomes a considered statement rather than a surrender at the end of a long turn.

### 8.2 Progressive disclosure

Building → storey → space → element, each level bounded, each naming what is one
level down. A person answering the Lichteinfall question does not read the
model; they find the room, look at its window, look up at the roof edge, and
measure one thing. This is the [adaptive-exploration](https://arxiv.org/pdf/2605.01698)
result, and its reported failure mode — losing coherence across steps — is
exactly what the briefing is there to prevent.

Concretely: `briefing()` is free, storey facts are cheap, space facts are one
call, element geometry is one call, and heavy constructive operators (`prism`,
`obstructions`, `pathBetween`) are explicit, metered and traced — as
`compliance` already is.

### 8.3 Derivations as citable objects

Every number carries a derivation id. Prose renders the claim; the derivation
renders as an expandable line:

> Auskragung Süd **1,32 m** — `overhang(Flachdach 1Ab2…, Fassadenebene der Wand
> 3cUkl…)`, normal zur Fassadenflucht, Toleranz ±5 mm.

The same discipline the citation system applies to text. A number whose
provenance is invisible is a screenshot, not a check — the viewer's measurement
module already argues this about snapping, and it holds with more force for a
number produced without a human watching. It also gives a wrong answer something
to be corrected *against*: today, nothing in the transcript says how the agent
got its number.

---

## 9. The reasoning loop

```
      question
         │
   ┌─────▼──────┐  attribute? relation? metric? normative?
   │  1 TYPE    │  → only metric/normative need geometry
   └─────┬──────┘
   ┌─────▼──────┐  briefing + dialect map; resolve names to ids
   │  2 GROUND  │  ✗ today: the agent guesses property and storey names
   └─────┬──────┘
   ┌─────▼──────┐  an explicit operator chain with bound arguments
   │  3 PLAN    │  ✗ today: no primitives to plan over
   └─────┬──────┘
   ┌─────▼──────┐  server computes; the agent never does arithmetic
   │  4 DERIVE  │  ✗ today: nothing to derive from
   └─────┬──────┘
   ┌─────▼──────┐  independent second route to the same number
   │  5 TRIANG. │  ✗ today: impossible — one source per fact
   └─────┬──────┘
   ┌─────▼──────┐  erfüllt / nicht erfüllt / nicht entscheidbar + what's missing
   │  6 DECIDE  │  ~ today: exists, but "undecidable" is over-reported
   └─────┬──────┘
   ┌─────▼──────┐  prose + derivations + card + highlight set
   │  7 REPORT  │  ✅ today: this half is good
   └────────────┘
```

Step 5 is nearly free once geometry exists, and it is what makes the numbers
trustworthy. Most quantities are knowable two or three independent ways:

| fact | declared | computed | third route |
|---|---|---|---|
| window area | `Qto_WindowBaseQuantities.Area` | opening geometry via `voids` | `OverallWidth × OverallHeight` |
| room area | `Qto_SpaceBaseQuantities.NetFloorArea` | footprint polygon | sum of bounding surfaces |
| storey height | next elevation − this one | slab top to soffit | `Qto_*.Height` on the space |
| wall length | `Qto_WallBaseQuantities.Length` | OBB principal axis | axis from `connects` |

Agreement is a fact. **Disagreement is a finding about the export** — and one an
architect wants before submission, because it means their schedule and their
geometry disagree. Today only the declared route exists, so a wrong quantity is
undetectable and is reported with full confidence.

---

## 10. The failed question, walked through

OIB 3 §9. The retrieval half already produces the clause and its parameters
correctly; that is not in scope. What changes is that every input becomes
bindable.

| the clause needs | today | with the Building Graph |
|---|---|---|
| which rooms are Aufenthaltsräume | ✗ | `inventory('aufenthaltsraum')` → **inferred**, per-room confidence and reasons, offered via the existing profile-patch card |
| the room's floor area | declared only, 75 % filled | `area(space)` computed, **cross-checked** against declared |
| the room's depth | ✗ | `depth(space, facade)` — the run normal to the glazed facade, which is what the depth surcharge is measured on |
| the light-entry area | nominal `1810 × 1210` | `area(opening)` from the real opening; nominal vs real is the whole answer at the margin |
| the facade plane | ✗ | `placement(wall)` → plane + azimuth |
| the 45° prism, ≤ 30° swivel | ✗ | `prism(openingSurface, 45, 30)` — a real volume in model space |
| what obstructs it | ✗ | `obstructions(prism, exclude: [host wall])` → the roof, with its intrusion depth |
| the overhang depth | **"nicht messbar"** | `overhang(roof, facadePlane)` → 1.32 m, ±5 mm |
| τ<sub>v</sub> of the glazing | ✗ | still ✗ — **decidable: false**, "kein Pset_WindowCommon-Wert; τv aus dem Datenblatt nachreichen" |
| neighbours, Raumordnung | ✗ | still ✗ — outside the file. The original answer said so and was right |

The answer this produces is not a shrug:

> Für **WZ 03 (Wohnen, 24,3 m² berechnet; 24,2 m² deklariert — Abweichung
> 0,4 %)** an der **Südfassade**: Lichteintrittsfläche 2,04 m² real (nominal
> 2,19 m²) = **8,4 %** der Bodenfläche. Das Flachdach kragt an dieser Fassade
> **1,32 m** aus und schneidet das 45°-Prisma; es gilt daher der erhöhte Satz
> für Auskragungen ≤ 1,50 m. Raumtiefe 5,8 m → zusätzlicher Zuschlag für die
> angefangenen 0,8 m über 5,00 m.
> **Nicht entscheidbar:** τv der Verglasung (nicht im Modell).
> **Nicht Gegenstand des Modells:** die Freiheit des Lichteinfalls gegenüber
> Nachbarbebauung.

Every number carries a derivation. The two honest gaps are named, and neither of
them is the overhang.

---

## 11. What this costs, and what stays impossible

**Extraction time and memory.** A geometry pass is the expensive half of reading
an IFC; the current parse is fast precisely because it never tessellates. Expect
single-digit seconds for a house and minutes for a large federated model, with
peak memory several times the file size. This forces the move ADR-0045 already
flags: **extraction must leave the request process and become a worker.** Treat
that as a precondition of Phase 2, not a consequence.

**A second derived thing to keep in step.** Mitigated the way the codebase
already does it: `graph_version`, a miss rather than a stale hit, no backfill.

**Precision claims.** A computed number carries tolerance from tessellation and
from the modeller's own sloppiness. Every geometric result states one, and
"gemessen am Modell" must never be presented as "geplant".

**What stays out of reach and must be said rather than approximated:**

- **Sun position over the year** needs `IfcSite.RefLatitude/RefLongitude` and a
  true-north angle. Exports frequently carry neither — `IfcMapConversion` is
  widely unpopulated and Revit does not interpret it. The 45° prism remains
  computable (it is a geometric construction, not a solar one), but a
  *Besonnungsstudie* is not.
- **Anything outside the file** — neighbours, terrain beyond the site solid,
  Raumordnung. CHEK's answer is to federate with CityGML; that is a product
  decision, not a parser one.
- **Room use** is a legal classification, not a geometric one. It stays
  `inferred` and gets confirmed.
- **Models without rooms.** No `IfcSpace` means no room area. Reconstructing
  polygons from wall loops is possible in simple cases and is exactly the kind
  of thing that must be labelled `inferred` — or deferred.

---

## 12. Phasing

Each phase pairs a **capability** with the **skill** that teaches it (§5c); a
phase is not done until both exist.

| phase | capability (tools) | skill shipped with it | unlocks |
|---|---|---|---|
| **0** | persist the relation graph the parser already builds; expose the `container` (room) column the DB already stores | grounding discipline, storey arithmetic, coarse per-storey ratios, fast precise refusal (§5b draft) | window↔wall↔room, doors↔spaces, openings per wall, elements per room |
| **1** | placements, AABB/OBB, footprints, azimuth, storey bands | "where and how big" — when to ask for extents instead of quantities; nominal vs real areas | where, which way it faces, above/below, real opening areas, sill/head |
| **2** | surfaces, space polygons, adjacency, boundary fallback, **extraction → worker** | reading a computed area against a declared one; what a tolerance means in a verdict | computed room areas, aspect, envelope by orientation, adjacency |
| **3** | constructive operators: prism, obstructions, ray, projection, path | one skill per check family (Belichtung, Fluchtwege, lichte Maße) | 45° Lichteinfall, overhangs, clear widths, headroom, Fluchtweglängen |
| **4** | briefing, disclosure ladder, derivation objects, triangulation | the skill's procedure moves *into* the platform; the skill shrinks to judgment | a tool that *can* answer becomes an agent that reliably *does* |
| **5** | check schema + IDS export | OIB checks authored as skills by domain experts, no PR | the catalogue stops being six property lookups |

### 12b. Amendment (2026-08-12): where the phases actually stand

Written against shipped code and green tests, not against intent. `ifc_measure`
is live in `configs/config_oib_openrouter.yml`, backed by
`packages/ifc-spatial-py`, with the skill in
`src/aiq_agent/skills/builtin/bim/ifc-spatial-reasoning/`.

| phase | state | evidence |
|---|---|---|
| **0** relation graph | **done** | IfcOpenShell holds every inverse attribute; `relations` exposes eleven of them |
| **1** placements, AABB, azimuth, footprints | **done except OBB** | `measure/extent` is AXIS-ALIGNED — on a skewed wall `width`/`depth` are systematically too large and are not its length and thickness |
| **2** space polygons, adjacency, boundary fallback | **done** | `bounds`/`adjacentSpaces`/`opensTo` fall back to a geometric contact map with a budget; the sample house declares no `IfcRelSpaceBoundary` at all |
| **2** extraction → worker | **not done** | still in-request, bounded instead by a memory-derived admission gate (`BIM_SPATIAL_MAX_MODEL_BYTES`) |
| **3** prism, obstructions, ray, overhang | **done** | `light_incidence`, `overhang`; the original failing turn is a standing regression |
| **3** Lichteinfall **ratio** | **done** | `measure/lightEntryArea` — the „Raum-%" half of the failing answer, external openings only |
| **3** clear widths | **missing** | `distance` measures centroids and boxes; a *lichte Breite* needs face-to-face |
| **3** Fluchtweglängen | **missing** | adjacency is not walkability: two rooms sharing a wall with no door are adjacent and unreachable |
| **3** room depth | **missing** | `depth(space, facade)` — daylight falls off with depth and OIB 3 turns on it |
| **4** briefing, disclosure, derivations, triangulation | **done** | every answer carries `provenance`/`tolerance`/`method`/`from`; `decidable:false` carries `missing.remedy` |
| **4** the agent can SEE | **done** | `operation: "view"` returns a raster image block with `highlight`/`only`; `draw` returns a path the agent cannot read |
| **5** IDS export | **missing** | the shopping list is German prose in a chat turn, not a file an architect can run in Solibri |
| **13** sun path | **missing** | georeferencing makes it possible and does not make it built; the sample house declares 51°30′N |

Two entries above are corrections rather than progress, and both were found by
reading rendered answers rather than by reading code:

- `DISTANCE_MODES["horizontal"]` was documented as „what a lichte Breite check
  needs". It is an Achsabstand — on a 1.00 m opening between two 30 cm walls,
  1.30 m, in the direction that turns a failed escape-route width into a passing
  one.
- `light_entry_area` first summed every opening bounding a room and put the
  sample bedroom at 25.3 %; the door to the hallway is 1.71 m². Split by
  external/internal it is 14.21 %. Two opposite answers to one daylight check.

---

Phase 0 is days and reverses no decision. Phase 4 is the one most often skipped
and most responsible for the gap between "the data is there" and "the agent used
it" — it is also the phase the literature measures least and we can measure
directly.

---

## 13. How this gets measured

"1000× more powerful" has to become a number. The repo's audit practice applies:
a fixed question set, ground truth by hand, run per change.

**The corpus.** 6–10 models spanning exporters (Revit, ArchiCAD, Allplan,
Vectorworks) and schemas (IFC2X3 and IFC4), including one with no `IfcSpace`,
one with no quantity sets, one federated, one with non-zero true north, one
100 MB+, and one carrying real 2nd-level space boundaries. Exporter dialect
variance is the dominant real-world failure and a benchmark on one sample house
hides it completely — this is also why BIM-Edit's finding that scene complexity
barely mattered should not be over-read: their scenes came from one generator.

**The question set.** ~150 questions with hand-verified answers, tagged
attribute / relation / metric / multi-hop / normative / **unanswerable**. The
last tag is the control group, not padding.

**Metrics, in order of importance:**

1. **Decidability calibration** — of the questions called undecidable, how many
   were? Of those answered, how many should not have been? Today's failure is a
   false "undecidable"; this design's risk is a false "decidable". Only this
   metric sees both.
2. **Numeric accuracy** within stated tolerance.
3. **Derivation correctness** — right answer for the right reason. A right
   number from the wrong chain is a coin flip that landed well.
4. **Triangulation disagreement rate** per model — a property of the *export*,
   and a saleable output in its own right.
5. Cost and latency per question class.

---

## 13b. Amendment (2026-08-12): the engine is IfcOpenShell

§14 below rejects IfcOpenShell and states the condition under which that
rejection stops holding. The condition was met, so the decision is reversed
here rather than quietly contradicted by the code.

### What changed the answer

**The two engines agree.** The TS implementation (ifc-lite, triangles) and
IfcOpenShell (OCCT, exact BREP) were run independently over the same sample
house:

| | IfcOpenShell | ours |
|---|---|---|
| Bedroom floor area | 15.41678125 m² | 15.416782274 m² |
| Living room | 51.994825 m² | 51.994827271 m² |
| Entrance hall | 8.69350625 m² | 8.693506722 m² |
| window sill / head | 0.900 / 2.110 m | 0.900 / 2.110 m |
| roof overhang past the north wall | 0.647 m | 0.647 m |

Areas to seven significant figures, everything else to the millimetre. The
rejection's premise — "the day they disagree, the agent and the viewer disagree
in front of the user" — is not borne out where it was tested, and the agreement
is itself the evidence that a swap is safe.

**It is not only geometry.** The rejection weighed IfcOpenShell as a geometry
kernel against another geometry kernel. That undersold it by a wide margin:
`geom.tree` is the ray/clash/clearance layer §7 already models its constructive
operators on; `util.shape` is the metric operators; `util.selector` is a query
language; `ifctester` is IDS validation, which §5 item 11 wanted anyway;
`ifc5d` is quantity take-off; `ifcdiff` is revision comparison; and `draw`
produces real architectural plans — wall poché, room cells, openings as gaps —
in 5.2 s, against which our own projector is a diagram.

**The measurement that nearly decided it wrongly.** A first benchmark put
`draw` at over ten minutes and was used to argue for keeping ours. It was
wrong: two runaway processes of the same script were saturating both CPUs, and
an expensive flag combination was layered on the defaults. Cleanly measured it
is **0.2 s to open and 5.3 s to draw**. A wrong number stated confidently, in a
document about not stating wrong numbers confidently.

### How the invariant survives

ADR-0045's real concern is not which library reads the file; it is that the
agent and the viewer must never state different facts about the same building.
That is preserved better than before, by drawing the line somewhere else:

> **The server knows; the browser draws.**

The viewport keeps ifc-lite because it must run in a browser, and it stops
being an authority on anything. It renders pixels and reports a GlobalId when
someone clicks. Every name, count, quantity and verdict comes from the server.
Two readers can only contradict each other about facts they both assert, and
after this the browser asserts none.

### What is bought, and what still has to be built

Adopted: geometry, spatial queries, ray/clash/clearance, quantities, IDS
validation, revision diffing, and drawings.

**Not bought, and still the whole point of this library:**

- the **answer contract** — declared / computed / inferred, `decidable`,
  tolerance, `method`, and triangulating a declared value against a measured
  one. No BIM library carries epistemics, because no BIM library is talking to
  something that will otherwise state a guess in a sentence;
- the **briefing**, the **dialect map** and the **blind spots** — §8, the half
  the literature under-weights;
- **space boundaries derived when the file omits them**, which most exports do;
- **room-use inference**, which is a legal classification and stays a proposal;
- the **agent tool surface** and its German wording.

That split is what §12 of this document already argued: the differentiator was
never the representation, it was making the epistemics the product. Adopting a
mature engine for the parts that are solved is what makes room to be good at
the part that is not.

---

## 14. Alternatives considered

**Let the agent write geometry code in a sandbox** (IfcOpenShell + shapely per
turn). The strongest alternative and the one most recent papers take. Rejected
as the primary path on evidence, not taste: **BIM-Edit** measures frontier
models at 43.9–49.5/100 with strict solve rates under 4 %, degrading worst on
exactly the topological structure our questions run on, with one model
exhausting its call budget on 46 % of tasks. Add three product-specific
objections: an answer produced by unreviewed code cannot be audited by the
person who signs it; a per-turn sandbox parsing a 150 MB IFC is a latency and
cost profile no chat turn survives; and it reintroduces the second
interpretation of the file that ADR-0045 exists to prevent. **Worth keeping as
an internal, offline tool for *authoring* operators** — the sandbox writes one,
a human reviews it, it enters the closed set.

**IfcOpenShell in the Python backend.** Mature, and the whole BIM world uses it
— `geom.tree` alone would give us §7's metric layer in an afternoon. Same
rejection as ADR-0045's, unchanged: two readers means two interpretations, and
the day they disagree the agent and the viewer disagree in front of the user.
The kernel we already ship runs in Node. *Revisit if* the geometry pass proves
materially harder in WASM than the OCCT-based stack — in which case the honest
move is to make IfcOpenShell the **only** reader, not a second one.

**A graph database (Neo4j).** What IfcLLM and Cypher4BIM use, and multi-hop
traversal is what it is for. Rejected for now: a new stateful service with its
own tenancy story, for a graph that is per-model, bounded, and read far more
than written. A serialized graph in object storage plus narrow Postgres columns
gets the same traversals at a fraction of the operational surface. Revisit if
cross-model federated queries become a product.

**ifcOWL / full RDF.** Complete and unusable at reasoning time; BOT exists
because of that. We take BOT's *vocabulary* and not its stack.

**Long context: put the IFC in the prompt.** Rejected on the ADR's grounds and
now on measured ones — the MCP reference architecture reports raw IFC in context
producing hallucination and confusion.

**A vision model over rendered views.** Useful as a *check*, not a source: a VLM
looking at a section can notice a computed answer is absurd; it cannot produce
1.32 m. Complement, later, never load-bearing.

**IDS as the decidability contract.** Not an alternative — an adoption. Emitting
IDS instead of a private shopping-list format is item 11 of §5 and should happen
regardless of the rest.

---

## 15. Open questions this document does not settle

Written down because a design that hides its unknowns is a design that will be
surprised by them.

1. **How good is the computed space-boundary fallback on real Austrian
   exports?** The literature's gap-healing thresholds are a few centimetres.
   Nobody has measured this on the exporters our customers use, and the answer
   decides whether Phase 2 is a feature or a research project.
2. **What tolerance may a compliance verdict be issued at?** A 1.32 m overhang
   measured ±5 mm is fine. A clear width of 1.198 m against a 1.20 m threshold is
   not a fail — it is a "measure this on the drawing". Where that band sits is a
   domain decision we have not made.
3. **Does the briefing actually change behaviour?** §8 is argued from two papers
   and from our own defect history, not from measurement on our agent. It is
   cheap to build and cheap to A/B, and it should be A/B'd rather than assumed.
4. **Rules or GNN for room-use inference?** Bloch & Sacks report 100 % for
   rigorous rules and tedium at scale. German-language name lexicons for
   Austrian practice may make rules cheaper here than in their study.
5. **How much of the graph belongs in Postgres?** The `jsonb_path_ops` index
   this subsystem already tried was measured at `idx_scan = 0`. Storage shape
   should be decided by measurement on a seeded model, the way `search_keys`
   was.
6. **Does the closed operator set stay closed?** Every new normative check will
   want one more primitive. The set must have an owner and an admission rule, or
   it becomes an API surface by accretion.

---

## 16. The one-sentence version

The agent already reasons well about buildings and has never been given one — so
give it the relation graph our parser already builds and discards, the handful
of geometric primitives our own kernel can compute, a closed set of composable
spatial operators modelled on tools that already exist, and a briefing that
tells it up front what this particular file can and cannot answer.

---

## Sources

**Prior art — agents over BIM**
[IfcLLM](https://arxiv.org/html/2605.13236v2) ·
[SGR-BIM / geometry-intensive ACC](https://arxiv.org/abs/2606.12065) ·
[BIM-Edit](https://arxiv.org/html/2606.20146) ·
[MCP reference architecture for agentic BIM](https://arxiv.org/pdf/2601.00809) ·
[LLM-based adaptive exploration](https://arxiv.org/pdf/2605.01698) ·
[hierarchical 3D scene graphs with LLMs](https://arxiv.org/pdf/2503.15091) ·
[schema-guided scene-graph reasoning](https://arxiv.org/pdf/2502.03450)

**Graph representations**
[BOT (W3C LBD)](https://www.semantic-web-journal.net/system/files/swj2279.pdf) ·
[Cypher4BIM](https://arxiv.org/abs/2405.16345)

**Geometry / topology engines**
[IfcOpenShell geometry tree](https://docs.ifcopenshell.org/ifcopenshell-python/geometry_tree.html) ·
[TopologicPy](https://topologicpy.readthedocs.io/) ·
[Topologic](https://github.com/wassimj/Topologic)

**Space boundaries**
[IfcRelSpaceBoundary2ndLevel (IFC4.3)](https://ifc43-docs.standards.buildingsmart.org/IFC/RELEASE/IFC4x3/HTML/lexical/IfcRelSpaceBoundary2ndLevel.htm) ·
[CBIP](https://www.sciencedirect.com/science/article/abs/pii/S0926580516301984) ·
[2nd-level boundary geometry generation (BS2021)](https://publications.ibpsa.org/proceedings/bs/2021/papers/bs2021_30156.pdf)

**Semantic enrichment**
[Room-type classification, rules vs ML](https://www.sciencedirect.com/science/article/abs/pii/S0926580521004908) ·
[semantic enrichment review](https://www.itcon.org/papers/2022_20-ITcon-Bloch.pdf)

**Compliance machinery**
[IDS (buildingSMART)](https://technical.buildingsmart.org/projects/information-delivery-specification-ids/) ·
[Solibri model checking](https://www.solibri.com/intelligent-model-checking) ·
[escape-route analysis for BIM code checking](https://www.sciencedirect.com/science/article/pii/S0926580523003527) ·
[CHEK](https://chekdbp.eu/) ·
[ACCORD](https://accordproject.eu/)
