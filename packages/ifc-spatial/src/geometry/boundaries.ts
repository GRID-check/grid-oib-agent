/**
 * Space boundaries recovered from geometry, for the files that state none.
 *
 * ## The problem this exists to solve
 *
 * `IfcRelSpaceBoundary` is an export OPTION in every major authoring tool, and
 * it is off by default in most of them. The consequence is not cosmetic: with no
 * boundary relation, `bounds()`, `adjacentSpaces()` and `opensTo()` are all
 * undecidable, and the chain every daylight rule walks —
 * *window → the room it lights → that room's floor area* — has no middle link.
 * The user's own `Ifc4_SampleHouse.ifc` (Revit, 4 rooms, 3 external walls, 2
 * partitions, 4 windows, 3 doors) contains exactly zero of them. So the most
 * common real model cannot answer the most common real question, and the reason
 * is a checkbox in someone's export dialog months ago.
 *
 * The geometry is right there. A wall standing against the face of a room is
 * measurably against the face of that room, whatever the file forgot to say. So
 * this module measures it — and says, on every single edge it produces, that it
 * measured rather than read.
 *
 * ## What it is, precisely, so nobody mistakes it for more
 *
 * A bounding-box adjacency test. Not a CAD kernel, not a 2nd-level boundary
 * generator, not a half-space classification of the wall's faces. An element
 * bounds a space when their boxes lie against each other on ONE axis (within
 * {@link BoundaryOptions.tolerance}) while genuinely overlapping on the other
 * two, and the overlapping face is at least
 * {@link BoundaryOptions.minSharedArea} in size.
 *
 * The single-contact-axis requirement is what makes this a *face* test rather
 * than a proximity test, and it is worth spelling out what it rejects:
 *
 *   - The pitched roof of the sample house has a box spanning z 1.74–3.48 while
 *     the living room spans 0.00–2.50. Their boxes overlap by 0.76 m in z and
 *     completely in x and y — no axis is thin, so the roof is NOT reported as a
 *     boundary of the living room. A plain `boxesOverlap` test would have
 *     reported it, and the room would have gained a ceiling it does not have.
 *   - The partition between bedroom and hall meets the living room end-on, with
 *     its 0.10 m thick end. It passes the contact test on x and fails on area
 *     (0.10 × 2.34 = 0.23 m² < 0.5), which is the correct answer: a wall you can
 *     see the end of is not a wall of your room.
 *
 * And what it costs. The same roof is missed for the roof space it genuinely
 * covers, because a pitched solid's bounding box swallows the space beneath it
 * and no box test can tell that from an enclosure. That miss is deliberate: a
 * missing boundary is visible to the caller as a short list, while a false one
 * is invisible and propagates into every area, adjacency and daylight answer
 * downstream. When one of the two has to happen, it should be the loud one.
 *
 * ## Honesty rules these edges live under
 *
 *   1. Every edge is `provenance: 'computed'` and names its tolerance in `via`.
 *      A consumer must be able to tell a measured boundary from a declared one,
 *      because a measured boundary can be wrong about a correct file while a
 *      declared one is wrong only if the export is.
 *   2. A declared edge always wins. We never emit a relation the graph already
 *      carries — the file's own statement outranks our measurement, and a
 *      duplicate would make `bounds()` list the same wall twice, i.e. turn our
 *      approximation into a visible defect in someone else's correct model.
 *   3. A space with no geometry contributes nothing. It is counted in
 *      {@link DerivedBoundaries.stats} so the gap is visible, and it is never
 *      guessed at from names — "Bad" next to "Bad Wand" is not a measurement.
 *   4. The numbers are not to be improved by loosening the tolerance. If a room
 *      comes back bounded by forty elements, the tolerance has swallowed the
 *      neighbouring room's walls and the derivation is wrong; the default stays
 *      tight and the knob stays visible.
 *
 * ## What it does NOT do
 *
 * It does not touch {@link BuildingGraph.blindSpots}. After folding these edges
 * in, `bounds()` answers — but the export still contains no
 * `IfcRelSpaceBoundary`, and the architect who wants a model that answers this
 * without our help still needs to hear so. Deleting the blind spot because we
 * papered over it would be the library telling a user their file is fine
 * because we compensated.
 */

import type { BuildingGraph, EdgeKind, GraphEdge } from '../graph/types.js'
import { boxGap, boxesOverlap, type Box, type GeometryIndex, type Vec3 } from './pass.js'

export interface BoundaryOptions {
  /** How close a surface must come to a space to count as bounding it. Default 0.30 m. */
  tolerance?: number
  /** Minimum shared vertical surface for a wall to count as bounding, m². Default 0.5. */
  minSharedArea?: number
}

export interface DerivedBoundaries {
  edges: GraphEdge[]
  stats: {
    spaces: number
    spacesBounded: number
    boundaryEdges: number
    adjacencies: number
    openings: number
    tolerance: number
  }
}

/**
 * 0.30 m, and the reasoning rather than the number is the point.
 *
 * It has to clear the largest honest disagreement between a room's box and the
 * wall against it: an IfcSpace is usually modelled to the finished surface while
 * the wall is modelled to its structural core, and the finish layers between
 * them run to ~50 mm. It also has to clear the gap Revit leaves between a room's
 * ceiling height and the underside of the slab above (0.17 m in the sample
 * house). It must stay well UNDER the thinnest wall in ordinary construction
 * (~0.10 m) plus a room's depth, or a tolerance-sized reach would step over a
 * partition and bound a room with its neighbour's walls.
 *
 * Measured on the sample house rather than argued: the derivation yields 25
 * boundary edges at 0.05 m, 29 at 0.15, then a flat 34 from 0.20 through 0.75,
 * and 38 at 1.00 where each room gains the roof as a phantom ceiling. 0.30 m is
 * the middle of that plateau — the value at which the answer is least sensitive
 * to the value, which is the only thing a tolerance can honestly be chosen for.
 *
 * Below the plateau real boundaries drop out and the loss is not graceful: at
 * 0.15 m the living room loses its ceiling slab (0.17 m gap) and its south
 * window (0.17 m reveal), and the window — having no space of its own left —
 * falls back on its host wall and reports three rooms instead of one.
 */
const DEFAULT_TOLERANCE = 0.3

/**
 * 0.5 m² of shared face.
 *
 * Small enough that no real wall, floor or window fails it, large enough to
 * reject the two ways a box test produces a phantom: a wall met end-on (its
 * 0.10 m end times a 2.3 m storey is 0.23 m²) and an element that merely clips a
 * corner of the room. Deliberately an area and not a length, because a wall
 * segment can be short or a storey low and neither alone should decide it.
 */
const DEFAULT_MIN_SHARED_AREA = 0.5

/**
 * The element types that can bound a room.
 *
 * A closed list rather than "everything that is not a space", because the
 * alternative reports a room as bounded by its own furniture. Coverings
 * (suspended ceilings, floor finishes) are excluded too even though they sit
 * exactly at a room's face: they are the FINISH on a boundary, and admitting
 * them would double every floor and ceiling in `bounds()` — the slab and the
 * screed on top of it are one boundary to every consumer of this list.
 *
 * `IfcPlate` and `IfcMember` are absent on purpose. They are what a curtain wall
 * is made of, and Revit exports twenty-six of them for the sample house's two
 * curtain walls; admitting them would bury the living room's real boundaries
 * under a list of mullions. The curtain wall itself stands in for them — see
 * {@link boxOf}, which is how it gets a box at all.
 */
const BOUNDING_TYPES = new Set([
  'IfcWall',
  'IfcWallStandardCase',
  'IfcWallElementedCase',
  'IfcCurtainWall',
  'IfcSlab',
  'IfcSlabStandardCase',
  'IfcSlabElementedCase',
  'IfcRoof',
  'IfcColumn',
  'IfcColumnStandardCase',
  'IfcWindow',
  'IfcWindowStandardCase',
  'IfcDoor',
  'IfcDoorStandardCase',
  // A virtual element IS a space boundary — it exists for nothing else. When an
  // export writes them but omits the relation, this is the only way they count.
  'IfcVirtualElement',
])

/** The subset that opens into a room rather than closing it off. */
const FILLER_TYPES = new Set(['IfcWindow', 'IfcWindowStandardCase', 'IfcDoor', 'IfcDoorStandardCase'])

/** Axis names, for the `via` strings a reviewer reads back. */
const AXIS = ['x', 'y', 'z'] as const

/**
 * One element lying against one face of one space.
 *
 * `axis` is the direction the contact is across — 0/1 for a wall-like (vertical)
 * face, 2 for a floor or ceiling. Adjacency between rooms needs that
 * distinction, and recovering it later from the boxes would mean measuring
 * twice.
 */
interface Contact {
  axis: 0 | 1 | 2
  /** Area of the overlapping face, m². */
  area: number
}

export function deriveBoundaries(
  graph: BuildingGraph,
  geometry: GeometryIndex,
  options: BoundaryOptions = {}
): DerivedBoundaries {
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE
  const minSharedArea = options.minSharedArea ?? DEFAULT_MIN_SHARED_AREA
  const via = `geometry: box adjacency ±${tolerance.toFixed(2)} m`

  const edges: GraphEdge[] = []
  const emitted = new Set<string>()
  const declaredOrKnown = knownEdgeKeys(graph)

  /**
   * Emit unless the graph — or this run — already carries the same relation.
   *
   * Both checks matter and for different reasons: the graph check is honesty
   * rule 2 (a declared boundary outranks a measured one), the local check keeps
   * a space that touches an element across two axes from being reported twice.
   */
  const emit = (kind: EdgeKind, from: string, to: string, viaText: string): boolean => {
    const key = edgeKey(kind, from, to)
    if (declaredOrKnown.has(key) || emitted.has(key)) return false
    emitted.add(key)
    if (kind === 'adjacentZone') emitted.add(edgeKey(kind, to, from))
    edges.push({ kind, from, to, provenance: 'computed', via: viaText })
    return true
  }

  // ── Candidates ────────────────────────────────────────────────────────────
  const candidates: Array<{ globalId: string; ifcType: string; box: Box }> = []
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'element' || !BOUNDING_TYPES.has(node.ifcType)) continue
    const box = boxOf(graph, geometry, node.globalId)
    if (box) candidates.push({ globalId: node.globalId, ifcType: node.ifcType, box })
  }

  // ── Boundaries, space by space ────────────────────────────────────────────
  /** space → element → the contact that put it there, for the two derivations below. */
  const contactsBySpace = new Map<string, Map<string, Contact>>()
  const spaceBoxes = new Map<string, Box>()
  let spaces = 0

  for (const node of graph.nodes.values()) {
    if (node.kind !== 'space') continue
    spaces++
    const spaceBox = geometry.elements.get(node.globalId)?.box
    // Honesty rule 3: no geometry, no contribution. A room whose shape the
    // kernel could not produce is a room we know nothing about, and the name
    // "Bad" is not evidence about which walls touch it.
    if (!spaceBox || !isFinite(spaceBox)) continue
    spaceBoxes.set(node.globalId, spaceBox)

    const contacts = new Map<string, Contact>()
    for (const candidate of candidates) {
      // Cheap reject first: everything that is not within tolerance on all three
      // axes cannot touch a face, and this skips the arithmetic for the ~90 % of
      // element/space pairs that are simply somewhere else in the building.
      if (!boxesOverlap(spaceBox, candidate.box, tolerance)) continue
      const contact = faceContact(spaceBox, candidate.box, tolerance, minSharedArea)
      if (contact) contacts.set(candidate.globalId, contact)
    }
    if (contacts.size > 0) contactsBySpace.set(node.globalId, contacts)
  }

  let boundaryEdges = 0
  for (const [spaceId, contacts] of contactsBySpace) {
    for (const [elementId, contact] of contacts) {
      if (emit('interfaceOf', spaceId, elementId, `${via} (${AXIS[contact.axis]}, ${contact.area.toFixed(2)} m²)`)) {
        boundaryEdges++
      }
    }
  }

  // ── Adjacency ─────────────────────────────────────────────────────────────
  //
  // Two spaces sharing a bounding element are neighbours — but only through a
  // VERTICAL separator, and only where they coexist in height. Both restrictions
  // are corrections to the purely topological rule build.ts applies to declared
  // boundaries, and both were forced by this fixture:
  //
  //   - Without the vertical-separator test, every room on a storey shares the
  //     one floor slab and every room becomes adjacent to every other. On the
  //     sample house that turns 3 real neighbours into 6 pairs, and on a real
  //     office floor it makes the operator useless.
  //   - Without the height-overlap test, the roof space above the house is
  //     "adjacent" to the rooms below it, because the same external wall runs
  //     past both. Rooms stacked on different storeys are not neighbours in the
  //     sense anyone asking the question means.
  const spaceIds = [...contactsBySpace.keys()]
  let adjacencies = 0
  for (let i = 0; i < spaceIds.length; i++) {
    for (let j = i + 1; j < spaceIds.length; j++) {
      const a = spaceIds[i]!
      const b = spaceIds[j]!
      if (a === b) continue
      const boxA = spaceBoxes.get(a)!
      const boxB = spaceBoxes.get(b)!
      if (overlapOn(boxA, boxB, 2) <= 0) continue

      const contactsA = contactsBySpace.get(a)!
      const contactsB = contactsBySpace.get(b)!
      let shared: string | null = null
      for (const [elementId, ca] of contactsA) {
        const cb = contactsB.get(elementId)
        if (!cb || ca.axis === 2 || cb.axis === 2) continue
        shared = elementId
        break
      }
      if (!shared) continue
      if (emit('adjacentZone', a, b, `shared bounding element (computed, ±${tolerance.toFixed(2)} m)`)) adjacencies++
    }
  }

  // ── Openings ──────────────────────────────────────────────────────────────
  //
  // A window's OWN box beats its host wall's boundaries, and that ordering is
  // the whole content of this block. The sample house's north wall runs the full
  // 14 m width of the building and bounds both the living room and the bedroom;
  // the window in it sits at x 2.96–4.82 and opens into the bedroom alone.
  // Deriving from the host would have said "both rooms" — a confident wrong
  // answer to the question the daylight rules are built on.
  //
  // The host route survives as a fallback for the case it is genuinely the only
  // route: a filler the geometry pass produced no mesh for. There the answer is
  // coarser and says so in `via`.
  let openings = 0
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'element' || !FILLER_TYPES.has(node.ifcType)) continue

    const direct: string[] = []
    for (const [spaceId, contacts] of contactsBySpace) {
      if (contacts.has(node.globalId)) direct.push(spaceId)
    }

    if (direct.length > 0) {
      for (const spaceId of direct) {
        if (emit('opensTo', node.globalId, spaceId, via)) openings++
      }
      continue
    }

    // Fallback: the spaces this filler's host wall bounds — by our measurement
    // or by the file's own statement, whichever exists.
    const hosts = graph.out.get('hostedIn')?.get(node.globalId) ?? []
    for (const host of hosts) {
      for (const [spaceId, contacts] of contactsBySpace) {
        if (!contacts.has(host)) continue
        if (emit('opensTo', node.globalId, spaceId, `${via}, via Gastbauteil`)) openings++
      }
      for (const spaceId of graph.in.get('interfaceOf')?.get(host) ?? []) {
        if (emit('opensTo', node.globalId, spaceId, 'deklarierte Raumbegrenzung des Gastbauteils')) openings++
      }
    }
  }

  return {
    edges,
    stats: {
      spaces,
      spacesBounded: contactsBySpace.size,
      boundaryEdges,
      adjacencies,
      openings,
      tolerance,
    },
  }
}

/**
 * The graph with the derived edges folded in, as a NEW object.
 *
 * The input graph is left exactly as it was, including its edge array: a caller
 * holding the declared-only graph — a cache, another request, a comparison — must
 * keep holding it. Mutating a cached graph in place is how one request's
 * tolerance ends up in another request's answer.
 *
 * `out`, `in` and `stats` are rebuilt from the merged edge list rather than
 * patched, because patching is where a double count hides: the derived edges are
 * already deduplicated against the graph's own, so a full rebuild and an
 * incremental update must agree, and only one of them is obviously correct.
 */
export function withDerivedBoundaries(
  graph: BuildingGraph,
  geometry: GeometryIndex,
  options: BoundaryOptions = {}
): BuildingGraph {
  const derived = deriveBoundaries(graph, geometry, options)
  if (derived.edges.length === 0) return { ...graph }

  const edges = [...graph.edges, ...derived.edges]
  const out = new Map<EdgeKind, Map<string, string[]>>()
  const inn = new Map<EdgeKind, Map<string, string[]>>()
  const edgesByKind: Record<string, number> = {}

  for (const edge of edges) {
    if (!out.has(edge.kind)) out.set(edge.kind, new Map())
    if (!inn.has(edge.kind)) inn.set(edge.kind, new Map())
    push(out.get(edge.kind)!, edge.from, edge.to)
    push(inn.get(edge.kind)!, edge.to, edge.from)
    edgesByKind[edge.kind] = (edgesByKind[edge.kind] ?? 0) + 1
  }

  return {
    ...graph,
    edges,
    out,
    in: inn,
    stats: { ...graph.stats, edges: edges.length, edgesByKind },
  }
}

// ── the measurement ─────────────────────────────────────────────────────────

/**
 * Whether these two boxes lie against each other on exactly one axis, and how
 * much face they share if so.
 *
 * `boxGap` returns, per axis, the distance between the nearest pair of opposite
 * faces — positive where the boxes are apart, negative where they interpenetrate.
 * A contact axis is one where that number is small in BOTH directions: wider
 * than the tolerance means they do not touch at all, and more negative than the
 * tolerance means the element runs through the space rather than standing
 * against it. It is exactly the right measure here, and notably NOT the same as
 * the overlap — for an element sitting well inside the space's span on some
 * axis, `boxGap` reports the large distance to the space's own faces and thereby
 * says "this is not the axis you are touching across", which is the truth.
 *
 * The other two axes must overlap outright, and there the true overlap — not
 * `boxGap` — is what multiplies out to the shared face. See below.
 *
 * When more than one axis qualifies — a wall meeting a room at a corner — the
 * largest face wins, because that is the one a person would point at.
 */
function faceContact(space: Box, element: Box, tolerance: number, minSharedArea: number): Contact | null {
  const gap = boxGap(space, element)
  let best: Contact | null = null

  for (let k = 0; k < 3; k++) {
    if (Math.abs(gap[k]!) > tolerance) continue

    let area = 1
    let overlapping = true
    for (let j = 0; j < 3; j++) {
      if (j === k) continue
      // NOT `-gap[j]`. `boxGap` returns the distance between the nearest pair of
      // opposite faces, which equals the overlap only while the boxes cross —
      // where one box CONTAINS the other on that axis it returns the far larger
      // distance to the enclosing box's faces instead. On the sample house that
      // difference reported the bedroom/hall partition, which meets the living
      // room end-on across its 0.10 m thickness, as sharing 5.15 m² of face with
      // it instead of 0.23 m², and the minimum-area guard passed it through.
      const overlap = overlapOn(space, element, j as 0 | 1 | 2)
      if (overlap <= 0) {
        overlapping = false
        break
      }
      area *= overlap
    }
    if (!overlapping || area < minSharedArea) continue
    if (!best || area > best.area) best = { axis: k as 0 | 1 | 2, area }
  }

  return best
}

/** Overlap of two boxes on one axis, metres; ≤ 0 when they do not overlap. */
function overlapOn(a: Box, b: Box, axis: 0 | 1 | 2): number {
  return Math.min(a.max[axis]!, b.max[axis]!) - Math.max(a.min[axis]!, b.min[axis]!)
}

/**
 * An element's box — its own, or the union of its parts'.
 *
 * The fallback exists for one shape of export that is far too common to treat as
 * an edge case: Revit writes an `IfcCurtainWall` with NO geometry of its own and
 * hangs every panel and mullion off it through `IfcRelAggregates`. Without this,
 * the sample house's living room loses both of its glazed walls and comes back
 * bounded on three sides — a wrong answer that looks exactly like a right one,
 * since nothing about "6 bounding elements" announces that two are missing.
 *
 * Recursive, because an assembly can nest, and depth-limited because a cyclic
 * `hasSubElement` in a damaged file must not become a hang.
 */
function boxOf(graph: BuildingGraph, geometry: GeometryIndex, globalId: string, depth = 0): Box | null {
  const own = geometry.elements.get(globalId)?.box
  if (own && isFinite(own)) return own
  if (depth >= 4) return null

  let union: Box | null = null
  for (const part of graph.out.get('hasSubElement')?.get(globalId) ?? []) {
    const box = boxOf(graph, geometry, part, depth + 1)
    if (!box) continue
    union = union ? merge(union, box) : { min: [...box.min] as Vec3, max: [...box.max] as Vec3 }
  }
  return union
}

function merge(into: Box, other: Box): Box {
  for (let k = 0; k < 3; k++) {
    if (other.min[k]! < into.min[k]!) into.min[k] = other.min[k]!
    if (other.max[k]! > into.max[k]!) into.max[k] = other.max[k]!
  }
  return into
}

/**
 * A box the kernel actually produced.
 *
 * The geometry pass initialises its accumulators to ±Infinity and only writes an
 * element out once it has vertices, so an infinite bound should not reach here —
 * but an element degenerate in one axis (a zero-thickness surface) is normal, and
 * a NaN from a malformed placement would silently pass every comparison below as
 * `false`, quietly bounding nothing. Checking once is cheaper than explaining a
 * room that lost its walls.
 */
function isFinite(box: Box): boolean {
  for (let k = 0; k < 3; k++) {
    if (!Number.isFinite(box.min[k]!) || !Number.isFinite(box.max[k]!)) return false
    if (box.max[k]! < box.min[k]!) return false
  }
  return true
}

// ── bookkeeping ─────────────────────────────────────────────────────────────

function edgeKey(kind: EdgeKind, from: string, to: string): string {
  return `${kind} ${from} ${to}`
}

/**
 * Every relation the graph already carries, in both orientations for the kinds
 * that read as symmetric.
 *
 * `adjacentZone` is stored once per pair, in whichever order the derivation that
 * wrote it happened to visit the two spaces. Checking only our own orientation
 * would let a pair the file already states as `A → B` be re-emitted as `B → A`,
 * and `adjacentSpaces()` — which reads both directions on purpose — would then
 * report the neighbour twice, once declared and once measured.
 */
function knownEdgeKeys(graph: BuildingGraph): Set<string> {
  const keys = new Set<string>()
  for (const edge of graph.edges) {
    keys.add(edgeKey(edge.kind, edge.from, edge.to))
    if (edge.kind === 'adjacentZone' || edge.kind === 'connects') {
      keys.add(edgeKey(edge.kind, edge.to, edge.from))
    }
  }
  return keys
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}
