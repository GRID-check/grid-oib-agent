# @grid/ifc-spatial

Spatial reasoning over IFC, for language agents: a building graph, a closed set
of operators over it, and an answer contract that states how every value was
obtained.

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

## Phase 0: what is actually in here

This package implements phase 0 of the design: **the relation graph, and pure
topology over it.** No geometry is read. Nothing here tessellates, measures, or
projects.

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

### The operators

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

### What phase 0 does not answer, and will not approximate

**No geometry is loaded, so nothing here can measure anything.** These are not
missing features to be worked around; an operator that would need them returns
`decidable: false`.

| not available | needs | phase |
|---|---|---|
| distances, clearances, clear widths, clear heights | placements, extents, surfaces | 1–2 |
| positions, orientation, azimuth, above/below | placements, AABB/OBB | 1 |
| room areas computed from shape (declared quantities only) | space polygons | 2 |
| overhangs, projections, real opening areas | surfaces + projection | 1–3 |
| the 45° Lichteinfall prism, obstruction tests, ray casts | constructive operators | 3 |
| escape-route lengths through the building | path operators | 3 |
| sun position, Besonnung | georeferencing **and** geometry | 3+ |

Two of these stay out of reach even with geometry, and are worth saying plainly:
sun position needs `RefLatitude`/`RefLongitude` and a true-north angle that many
exports simply do not carry, and room USE is a legal classification rather than a
geometric one — it will stay `inferred` and want confirming.

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
