# @grid/ifc-spatial

Spatial reasoning over IFC, for language agents: a building graph, a closed set
of operators over it, and an answer contract that states how every value was
obtained.

> ## Status: reference implementation and cross-check oracle — NOT the serving path
>
> **What Piloti actually runs is [`packages/ifc-spatial-py`](../ifc-spatial-py),**
> reached through the `ifc_measure` tool. Nothing in this repository imports this
> package, and nothing should start: wiring it in would put two engines with
> different answers behind one tool.
>
> It is kept, rather than deleted, for one reason that has already paid for
> itself. It is a **second, independent engine** — a WASM triangulator against
> IfcOpenShell's OCCT BREP kernel — and running the same operators on both is a
> differential test that no amount of self-consistent unit testing replaces. On
> the first full comparison, 40 of 41 numbers agreed to micrometres. The 41st
> was `clearHeight`, where this engine returned the space solid's height —
> 2.500 m for a living room whose ceiling hangs at 2.200 m. Thirty centimetres,
> on precisely the figure a Mindestraumhöhe is checked against, in the direction
> that turns a fail into a pass. Nothing but a second kernel was going to find
> that.
>
> The port also runs in the opposite direction: the geometric operators here are
> where the frame conversion, the area-weighted normals and the poché renderer
> were worked out, and `test/the-question.spec.ts` is the standing regression for
> the turn the whole effort started from.
>
> **If you change an operator in `ifc-spatial-py`, changing it here too and
> comparing is the cheapest bug-finding available.** If the two ever disagree,
> that disagreement is the finding — do not pick the convenient one.

## The problem

An element table answers questions about elements considered one at a time,
while almost every question an architect actually has is about an
**arrangement** — which window sits in which wall, which rooms that wall
separates, what opens into what. Those relations are already in the IFC file, as
`IfcRelFillsElement`, `IfcRelVoidsElement`, `IfcRelSpaceBoundary` and their
siblings, and every pipeline that flattens IFC into rows reads the containment
edge, writes a `storey_name` column, and discards the rest. This package keeps
them, and gives an agent a vocabulary to walk them with.

## Quickstart

```ts
import { readFile } from 'node:fs/promises'
import { buildGraph, renderBriefing, hostedIn } from '@grid/ifc-spatial'

const graph = await buildGraph(new Uint8Array(await readFile('haus.ifc')))

// A deterministic fact sheet — storeys, counts, the file's property dialect,
// and what this file CANNOT answer. Rendered, not generated: put it in the
// agent's context once, before the first question.
console.log(renderBriefing(graph))

// Ask an arrangement question: which wall is this window sitting in?
const windowId = graph.byType.get('IfcWindow')?.[0]
const answer = hostedIn(graph, windowId!)
console.log(JSON.stringify(answer, null, 2))
```

```json
{
  "value": [
    {
      "globalId": "3cUkl32yn9qRSPvBJVyWy4",
      "ifcType": "IfcWall",
      "name": "Außenwand 30 tragend",
      "kind": "element",
      "via": "voids+fills"
    }
  ],
  "unit": null,
  "tolerance": null,
  "provenance": "computed",
  "from": ["1Ab2qHnUv7EO$8mZ4XcRt9", "3cUkl32yn9qRSPvBJVyWy4"],
  "method": "hostedIn(1Ab2qHnUv7EO$8mZ4XcRt9)",
  "decidable": true
}
```

`provenance: "computed"` and `via: "voids+fills"` are the honest reading: the
file does not state "this window is in that wall", it states that an opening
voids the wall and that the window fills the opening. Two declared edges, one
derived conclusion, and the answer says so.

## The answer contract

Every operator returns an `Answer<T>`. The value is never the whole result,
because the consumer is a model writing a sentence a human being will sign.

| field | what it carries |
|---|---|
| `value` | the result, or `null` when `decidable` is false |
| `unit` | SI or the file's declared unit, spelled the way it should be printed |
| `tolerance` | absolute, in `unit`, for computed numbers; `null` for declared ones |
| `provenance` | `declared` \| `computed` \| `inferred` — see below |
| `from` | the GlobalIds the value was derived from, in the order used |
| `method` | the operator expression, as text a reviewer can read back |
| `decidable` | whether this file can answer at all |
| `missing` | present exactly when `decidable` is false: what would settle it |
| `confidence`, `because` | present for `inferred` answers |
| `caveat` | a qualification the answer is not valid without |

### Three provenances, three different sentences

The distinction is the reason this library exists in this shape. A reviewer must
be able to tell these apart at a glance, and a bare number makes that impossible.

| provenance | means | wrong when | the sentence it licenses |
|---|---|---|---|
| `declared` | the file states it | the export is wrong | „Das Modell **deklariert** die Wand als raumbegrenzend für WZ 03." |
| `computed` | we derived it, within a stated tolerance | our derivation is wrong | „Die Auskragung **beträgt gemessen** 1,32 m (± 5 mm)." |
| `inferred` | a heuristic, with a confidence and reasons | the heuristic does not hold here | „Der Raum ist **vermutlich** ein Aufenthaltsraum — bitte bestätigen." |

Collapse the three into one number and a guess acquires a stamp. So `inferred`
answers carry `because` as a required field, not an optional one: an inference
whose reasons are invisible cannot be argued with.

### Undecidable is a result, not an error

`decidable: false` means the question was well-formed and **this file** cannot
answer it. It is not a thrown error, because "the model publishes no fire
rating" is a finding about the export that the architect can act on, whereas an
exception is a finding about us.

```json
{
  "value": null,
  "unit": null,
  "tolerance": null,
  "decidable": false,
  "provenance": "declared",
  "method": "bounds(2Kt9$dLmz4NPr8QfWvB1cE)",
  "from": ["2Kt9$dLmz4NPr8QfWvB1cE"],
  "missing": {
    "what": "IfcRelSpaceBoundary",
    "remedy": "Space Boundaries (2nd level) mitexportieren — in Revit/ArchiCAD eine Exporteinstellung"
  }
}
```

Three outcomes, never two: an empty `value` with `decidable: true` means the
element takes part in none of a relation the export DOES carry, which is a fact
about the building. One case does throw — a GlobalId that names nothing in this
model raises `UnknownElementError`, because an invented id supports no claim
about the export at all, and reporting it as "das Modell sagt dazu nichts" is
precisely the failure this package exists to prevent.

The same information arrives before anyone asks, too: `graph.blindSpots` lists
what this file cannot answer, computed at build time, so an agent does not spend
six tool calls discovering it — and does not report "the building has no rooms"
when the truth is "this export omitted a relation".

## What is actually in here

Three layers, each usable without the one above it:

1. **The relation graph** — `buildGraph(bytes)`, pure topology, no geometry
   read. This is the layer that answers arrangement questions, and it is the
   only one that works on a file the geometry kernel cannot open.
2. **The geometry pass** — `runGeometryPass` tessellates the model through
   `@ifc-lite/geometry` and indexes every element's box, centroid, surface
   areas and retained triangles. On top of it sit the metric operators, the
   constructive ones, and the renderer.
3. **`openModel(bytes)`**, which composes both and folds the geometry-derived
   space boundaries back into the graph. This is the entry point to use unless
   you specifically want topology alone.

Layer 2 degrades rather than fails. The kernel is WASM and can refuse to
initialise on an old runtime or a locked-down container; when it does,
`openModel` returns `geometry: null` with a stated reason, every topological
answer stays correct, and the metric operators return `decidable: false`
instead of throwing. A library that refuses to open a building because it could
not tessellate it has turned a partial answer into no answer.

### The graph

| edge | source | provenance |
|---|---|---|
| `containsElement` | `IfcRelContainedInSpatialStructure` | declared |
| `hasSubElement` | `IfcRelAggregates` + the spatial tree | declared |
| `voids` / `fills` | `IfcRelVoidsElement` / `IfcRelFillsElement` | declared |
| `interfaceOf` | `IfcRelSpaceBoundary` (space → bounding element) | declared |
| `connects` | `IfcRelConnectsPathElements`, `IfcRelConnectsElements` | declared |
| `inGroup` | `IfcRelAssignsToGroup` (`IfcZone`, systems) | declared |
| `hostedIn` | window/door → wall, through `voids` + `fills` | computed |
| `adjacentZone` | two spaces sharing a bounding element | computed |
| `opensTo` | opening or its filler → the spaces it opens into | computed |

Edge names follow the W3C **Building Topology Ontology** where BOT has a name
for the thing; where IFC has a relation BOT does not model, the IFC name is kept
verbatim rather than paraphrased.

Beyond the edges, a built graph carries `dialect` — which property sets and
properties this exporter actually wrote, and how many elements carry a value —
because a filter on a property name this file never used returns zero rows, and
zero rows reads as "the building has none". That is the most common way a model
question gets a confidently wrong answer, and publishing the vocabulary is the
cure.

### The topological operators

Every one takes a GlobalId and returns `Answer<ElementRef[]>`, and every
`ElementRef` is a valid subject for the next call — that closure is what lets an
agent chain calls without a lookup table in between.

| operator | question |
|---|---|
| `hosts(wall)` | which openings are cut out of this element |
| `fillerOf(opening)` | what fills this opening — and empty means an unfilled hole |
| `hostedIn(window)` | which wall or slab this window or door sits in |
| `bounds(space)` | which elements bound this room |
| `enclosedBy(wall)` | which rooms this element bounds — two means it separates them |
| `opensTo(door)` | which rooms this door or window opens into |
| `connects(element)` | which elements this one is connected to |
| `contains(storey \| space)` | what this container holds |
| `containerOf(element)` | the storey or room this element is in |
| `adjacentSpaces(space)` | which rooms are this room's neighbours |
| `elementsOfStorey(storey)` | everything resolving to this storey, through aggregation |

Alongside them: what the file declares (names, types, predefined types), the
property dialect it was exported with, and its blind spots.

### The metric operators

Numbers off the geometry, each with a tolerance attached, because the consumer
is a model that will print the value to two decimals in a document a human
signs. One coordinate is good to about 5 mm; a dimension is the difference of
two of them and is reported at 10 mm, areas at 1 %.

| operator | question |
|---|---|
| `extent(id)` | width, depth, height and centre |
| `floorArea(id)` | floor area from the shape — available where the export declares no quantity |
| `elevation(id)` | underside and top, absolute and above the element's own storey |
| `sillAndHead(window)` | Brüstungs- and Sturzhöhe over that window's storey |
| `clearHeight(space)` | height of the room solid |
| `azimuth(id)` | compass direction of the facade plane |
| `distance(a, b, mode)` | `min`, `centroid`, `horizontal` or `vertical` |

### The constructive operators

These build geometry rather than only reading it, which is what the Lichteinfall
family of questions needs.

| operator | question |
|---|---|
| `facadePlaneOf(id)` | the outward-oriented facade plane of an element |
| `overhang(id, plane)` | how far something projects past a plane |
| `ray(from, direction)` | what a ray hits, against real triangles |
| `prism(window, angleDeg, swivelDeg)` | the light-incidence volume in front of an opening |
| `obstructions(volume)` | which elements intrude into a volume, and how deep |
| `freeLightIncidence(window, …)` | whether the 45° prism is free, and what blocks it |

The angles are parameters. `prism` knows how to build a volume at `angleDeg`
with `swivelDeg` of flare; it does not know that OIB 3 says 45 and 30, and must
not — the next clause with different numbers would otherwise need a different
geometry engine.

### Drawing

`project(graph, geometry, { view })` returns a plan, section or elevation as
SVG, from exactly the triangles the measurements come from. One rule travels
with it: **numbers never come from the picture.** A value read off a drawing is
guessed even when it happens to be right, so the drawing shows arrangement and
`measure`/`distance` supply the figures.

### What is still out of reach, and will not be approximated

Shorter than it was, and none of it is a matter of loading geometry — an
operator that would need what is missing returns `decidable: false` rather than
an estimate.

| not available | why |
|---|---|
| sun position, Besonnung | needs `RefLatitude`/`RefLongitude` and a true-north angle that many exports simply do not carry |
| escape-route lengths through the building | needs path operators over the graph; not written |
| clear height under downstands and beams | `clearHeight` measures the room solid, which is the storey-to-storey figure, not the lichte Höhe under a Unterzug |
| room USE (Aufenthaltsraum or not) | a legal classification, not a geometric one — stays `inferred` and wants confirming |
| which clause applies, and whether the building complies | this package supplies the numbers a check is written against; the judgment is the host's |

The first is worth restating because it is the one people expect to work: a
`decidable: false` on azimuth or Besonnung is a finding about the **export**,
not about the building, and `missing` names the setting that would fix it.

## Caching: the same bytes are never parsed twice

`GraphCache` is keyed on the sha256 of the source bytes — the same hash the
builder stamps on `graph.contentHash` — so a re-upload of an unchanged file is a
hit and an edited file is a guaranteed miss. Concurrent `load()` calls for the
same bytes collapse into **one** parse; two identical requests a hundred
milliseconds apart would otherwise peak at twice the memory at exactly the
moment memory is tightest.

```ts
const cache = new GraphCache({ maxEntries: 8, maxBytes: 512 * 1024 * 1024 })
const graph = await cache.load(bytes)   // parses once, then never again
cache.stats                             // { hits, misses, entries, bytes }
```

`stats.bytes` is an **estimate** derived from node and edge counts, not a
measurement of retained memory. It exists to order evictions and bound growth;
do not put it in front of a user as a memory figure.

The cache is process-local, holds no lock, and has **no tenancy**. A hash is not
a permission: decide who may see a building before its bytes reach `load()`.

`SpatialCache` is the same idea one layer up, holding whole `openModel` results
— graph plus geometry — and bounded by an entry count rather than a byte
estimate, because the dominant term is the retained triangle array.

## The MCP server

The package ships an MCP surface over the same operators: a `./mcp` export and
an `ifc-spatial-mcp` binary.

```bash
npx ifc-spatial-mcp          # stdio MCP server
```

```ts
import { createSpatialServer } from '@grid/ifc-spatial/mcp'
```

The tool definitions live in `src/mcp/tools.ts` and carry no MCP import at all.
That is deliberate: MCP is how these tools are *delivered*, not what they are,
so the same handlers serve an MCP server, an HTTP route inside a host, or a
direct in-process call from a test, and none of the three reimplements the
argument checking.

| tool | what it does |
|---|---|
| `open_model` | reads an IFC from `path`, `url` or `base64`; returns a handle and the briefing. Always first |
| `briefing` | the briefing again, for a model already open |
| `find_elements` | GlobalIds by type, name, storey or kind — the input to everything else |
| `element` | one element, plus which relations are worth asking about it |
| `relations` | the eleven topological operators, under one enum |
| `measure` | the metric operators, under one enum |
| `distance` | distance between two elements, in a named mode |
| `draw` | a plan, section or elevation, written to a file rather than into the reply |
| `storey_heights` | storey elevations and their differences |
| `room_inventory` | rooms by inferred use, explicitly as a proposal |

One tool per *shape* rather than per operator: eleven relations share one
signature, so eleven tools would be eleven copies of one schema and a model
choosing between them would be choosing a name. What is not collapsed is the
meaning — the enum documents each relation, and the answer says which one ran.

Two things a host must decide before exposing this:

- **`open_model`'s `path` source is for trusted local callers only.** There is
  no root to resolve against. A host mounting these handlers on an HTTP route
  must drop that source or resolve the path against a directory it owns.
- **`url` is fetched by the server, to an address the agent chose.** Only
  http/https are allowed, literal loopback, private, link-local and metadata
  addresses are refused on every redirect hop, and the read is bounded by a
  timeout and a size limit. That check reads the literal in the URL: a hostname
  that *resolves* to an internal address still passes, so run this where it
  cannot reach anything worth reaching.

## It runs on `@ifc-lite/parser`

The parser is the one this package's host already uses to render models in the
browser. That is deliberate: a host that renders with ifc-lite and reasons with
this library gets **one interpretation of the file**, not two. Schema quirks,
entity naming, unit handling and the relationship index are resolved once, in a
place both halves share — so the wall the agent talks about is the wall the user
clicked, and a parser bug shows up as one wrong answer rather than as two
subsystems quietly disagreeing about the same building.

## Licence

MPL-2.0.
