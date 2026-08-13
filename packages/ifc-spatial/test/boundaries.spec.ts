/**
 * `deriveBoundaries` / `withDerivedBoundaries` over both fixtures.
 *
 * The two fixtures are the two halves of the problem, and the module has to be
 * right about both:
 *
 *   - `Ifc4_SampleHouse.ifc` (Revit/Xbim) declares NO `IfcRelSpaceBoundary`.
 *     Every assertion about it checks that the geometry recovers what the export
 *     dropped — and, just as important, that it does not recover more than that.
 *     The numbers below were measured, not chosen: they are what the module
 *     produces at the default tolerance, and each one is small enough to check
 *     by hand against the plan (three external walls, two partitions, two
 *     curtain walls, a ground slab, a ceiling slab, four windows, three doors).
 *
 *   - `haus-mit-raeumen.ifc` declares six of them, and carries no geometric
 *     representation at all. It is the fixture for honesty rule 2: a declared
 *     relation is never duplicated by a measured one. Because the file has no
 *     shapes, the duplication test needs boxes — so it gets a hand-built
 *     {@link GeometryIndex} laid out to reproduce exactly the boundaries the
 *     file already states. That is the only way to put the deduplication under
 *     real load rather than watching it pass vacuously on an empty derivation.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildGraph } from '../src/graph/build.js'
import { runGeometryPass, type Box, type ElementGeometry, type GeometryIndex, type Vec3 } from '../src/geometry/pass.js'
import { deriveBoundaries, withDerivedBoundaries } from '../src/geometry/boundaries.js'
import { adjacentSpaces, bounds, opensTo } from '../src/operators/topology.js'
import type { BuildingGraph, GraphEdge } from '../src/graph/types.js'

function bytesOf(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))
}

/** GlobalIds read off the sample house, so a failure names a real element. */
const HOUSE = {
  living: '3w0zWKm7n8SB1qbfwUzt0U',
  bedroom: '3w0zWKm7n8SB1qbfwUzt0J',
  hall: '3w0zWKm7n8SB1qbfwUzt0G',
  roofSpace: '09J5N7xMHBfQZeQGAEMota',
  /** The 14 m external wall along the north side; bounds living room AND bedroom. */
  wallNorth: '3cUkl32yn9qRSPvBJVyWw5',
  /** Partition between living room and the two eastern rooms. */
  partitionNS: '3cUkl32yn9qRSPvBJVyWXt',
  /** Partition between bedroom and hall — meets the living room end-on. */
  partitionEW: '3cUkl32yn9qRSPvBJVyWY1',
  groundSlab: '3cUkl32yn9qRSPvBJVyWgQ',
  ceilingSlab: '3ntFzSulnDNeQ4nJrMgcOt',
  roof: '3cUkl32yn9qRSPvBJVyWh4',
  /** In `wallNorth`, at the bedroom's end of it. */
  windowBedroom: '3cUkl32yn9qRSPvBJVyWcE',
} as const

const targets = (edges: GraphEdge[], kind: string, from: string): string[] =>
  edges.filter((e) => e.kind === kind && e.from === from).map((e) => e.to)

describe('Ifc4_SampleHouse — an export with no space boundaries at all', () => {
  let graph: BuildingGraph
  let geometry: GeometryIndex
  let merged: BuildingGraph

  beforeAll(async () => {
    const bytes = bytesOf('Ifc4_SampleHouse.ifc')
    graph = await buildGraph(bytes)
    geometry = await runGeometryPass(bytes, graph)
    merged = withDerivedBoundaries(graph, geometry)
  }, 300000)

  it('is the problem case: the file states nothing about what bounds a room', () => {
    expect(graph.stats.edgesByKind['interfaceOf'] ?? 0).toBe(0)
    const before = bounds(graph, HOUSE.living)
    expect(before.decidable).toBe(false)
    expect(before.missing?.what).toBe('IfcRelSpaceBoundary')
  })

  it('bounds every space, from geometry alone', () => {
    const derived = deriveBoundaries(graph, geometry)
    expect(derived.stats.spaces).toBe(4)
    expect(derived.stats.spacesBounded).toBe(4)
    expect(derived.stats.tolerance).toBe(0.3)
  })

  it('gives each room a small, checkable set of bounding elements', () => {
    // Measured: 12 / 8 / 8 / 6. The upper guard is the assertion that matters —
    // a room bounded by dozens of elements means the tolerance has reached into
    // the neighbouring room, which is a defect and not a better number.
    const counts = [HOUSE.living, HOUSE.bedroom, HOUSE.hall, HOUSE.roofSpace].map(
      (id) => bounds(merged, id).value!.length
    )
    expect(counts).toEqual([12, 8, 8, 6])
    for (const count of counts) expect(count).toBeLessThan(15)
  })

  it('finds the walls, the floor and the ceiling a person would point at', () => {
    const living = bounds(merged, HOUSE.living).value!.map((r) => r.globalId)
    expect(living).toContain(HOUSE.wallNorth)
    expect(living).toContain(HOUSE.partitionNS)
    expect(living).toContain(HOUSE.groundSlab)
    expect(living).toContain(HOUSE.ceilingSlab)

    // Both glazed walls, which Revit exports as an IfcCurtainWall with no
    // geometry of its own — the aggregated panels carry it. Without the
    // parts-union fallback the room would silently lose two of its four sides.
    const curtainWalls = bounds(merged, HOUSE.living)
      .value!.filter((r) => r.ifcType === 'IfcCurtainWall')
    expect(curtainWalls).toHaveLength(2)
  })

  it('refuses the two boundaries a plain overlap test would invent', () => {
    const living = bounds(merged, HOUSE.living).value!.map((r) => r.globalId)
    // The pitched roof's bounding box overlaps the living room in all three
    // axes. It is not a boundary of it; the ceiling slab is.
    expect(living).not.toContain(HOUSE.roof)
    // The bedroom/hall partition touches the living room across its 0.10 m end,
    // which is 0.23 m² of shared face — under `minSharedArea`.
    expect(living).not.toContain(HOUSE.partitionEW)
  })

  it('resolves a window to the one room it lights', () => {
    const answer = opensTo(merged, HOUSE.windowBedroom)
    expect(answer.decidable).toBe(true)
    expect(answer.provenance).toBe('computed')
    expect(answer.value!.map((r) => r.globalId)).toEqual([HOUSE.bedroom])
    // Not by way of the host wall: that wall runs the width of the building and
    // bounds the living room too, so the host route would have answered "both".
    expect(bounds(merged, HOUSE.living).value!.map((r) => r.globalId)).toContain(HOUSE.wallNorth)
  })

  it('makes neighbours of the rooms that share a wall, and of no others', () => {
    const derived = deriveBoundaries(graph, geometry)
    expect(derived.stats.adjacencies).toBe(3)

    const neighbours = (id: string) => adjacentSpaces(merged, id).value!.map((r) => r.globalId).sort()
    expect(neighbours(HOUSE.living)).toEqual([HOUSE.bedroom, HOUSE.hall].sort())
    expect(neighbours(HOUSE.bedroom)).toEqual([HOUSE.hall, HOUSE.living].sort())
    // The roof space sits ON the three rooms and shares walls and the slab with
    // them. Stacked zones are not neighbours, and the shared floor slab must
    // never make every room on a storey adjacent to every other.
    expect(neighbours(HOUSE.roofSpace)).toEqual([])
  })

  it('stamps every derived edge as measured, with the tolerance it used', () => {
    const derived = deriveBoundaries(graph, geometry)
    expect(derived.edges.length).toBeGreaterThan(0)
    for (const edge of derived.edges) {
      expect(edge.provenance).toBe('computed')
      expect(edge.via).toBeTruthy()
      expect(edge.via).toMatch(/0\.30 m/)
    }
  })

  it('leaves the source graph untouched and cannot double-count', () => {
    const edgesBefore = graph.edges.length
    const merged2 = withDerivedBoundaries(graph, geometry)

    expect(graph.edges).toHaveLength(edgesBefore)
    expect(graph.stats.edgesByKind['interfaceOf'] ?? 0).toBe(0)
    expect(graph.out.has('interfaceOf')).toBe(false)
    expect(merged2).not.toBe(graph)

    const derived = deriveBoundaries(graph, geometry)
    expect(merged2.edges).toHaveLength(edgesBefore + derived.edges.length)
    expect(merged2.stats.edges).toBe(merged2.edges.length)
    expect(merged2.stats.edgesByKind['interfaceOf']).toBe(derived.stats.boundaryEdges)
    expect(merged2.out.get('interfaceOf')!.get(HOUSE.living)).toHaveLength(12)

    // Folding twice must add nothing: the second pass sees its own edges in the
    // graph and suppresses every one of them.
    const again = deriveBoundaries(merged2, geometry)
    expect(again.edges).toHaveLength(0)
    expect(withDerivedBoundaries(merged2, geometry).edges).toHaveLength(merged2.edges.length)
  })

  it('keeps the blind spot: we compensated, the export is still missing the relation', () => {
    expect(merged.blindSpots.map((s) => s.what)).toContain('keine IfcRelSpaceBoundary')
  })

  it('exposes the tolerance as a knob, and the default sits on a plateau', () => {
    // Measured sweep: 25 edges at 0.05 m, 29 at 0.15, then 34 flat from 0.20 to
    // 0.75 m, and 38 at 1.00 m where the roof starts counting as a ceiling. The
    // default is the middle of the flat stretch — tight enough not to reach past
    // a wall, loose enough for the 0.17 m Revit leaves under a slab.
    const tight = deriveBoundaries(graph, geometry, { tolerance: 0.05 })
    const dflt = deriveBoundaries(graph, geometry)
    const loose = deriveBoundaries(graph, geometry, { tolerance: 1.0 })
    expect(tight.stats.boundaryEdges).toBeLessThan(dflt.stats.boundaryEdges)
    expect(loose.stats.boundaryEdges).toBeGreaterThan(dflt.stats.boundaryEdges)
    expect(deriveBoundaries(graph, geometry, { tolerance: 0.2 }).stats.boundaryEdges).toBe(dflt.stats.boundaryEdges)
    expect(deriveBoundaries(graph, geometry, { tolerance: 0.75 }).stats.boundaryEdges).toBe(dflt.stats.boundaryEdges)

    // And the minimum shared face is a knob too: drop it and the partition met
    // end-on comes back.
    const permissive = deriveBoundaries(graph, geometry, { minSharedArea: 0 })
    expect(targets(permissive.edges, 'interfaceOf', HOUSE.living)).toContain(HOUSE.partitionEW)
  })
})

describe('haus-mit-raeumen — an export that states its boundaries', () => {
  let graph: BuildingGraph

  beforeAll(async () => {
    graph = await buildGraph(bytesOf('haus-mit-raeumen.ifc'))
  }, 120000)

  it('derives nothing from a file with no shapes, and says which spaces it skipped', async () => {
    const geometry = await runGeometryPass(bytesOf('haus-mit-raeumen.ifc'), graph)
    const derived = deriveBoundaries(graph, geometry)

    expect(derived.edges).toHaveLength(0)
    // Both rooms are counted and both are unbounded: the gap is visible rather
    // than guessed at from "Wohnzimmer" standing next to "Trennwand Wohnen-Kueche".
    expect(derived.stats.spaces).toBe(2)
    expect(derived.stats.spacesBounded).toBe(0)

    const merged = withDerivedBoundaries(graph, geometry)
    expect(merged.stats.edgesByKind['interfaceOf']).toBe(6)
    expect(bounds(merged, IDS.wohnzimmer).provenance).toBe('declared')
  })

  it('never re-emits a relation the file already declares', () => {
    const derived = deriveBoundaries(graph, synthetic())

    // The derivation really ran on this layout — otherwise the rest of this test
    // proves nothing.
    expect(derived.edges.length).toBeGreaterThan(0)

    const declared = new Set(graph.edges.map((e) => `${e.kind} ${e.from} ${e.to}`))
    for (const edge of derived.edges) {
      expect(declared.has(`${edge.kind} ${edge.from} ${edge.to}`)).toBe(false)
      // Symmetric kinds are stored once per pair, in whichever order the file's
      // own derivation happened to visit them.
      if (edge.kind === 'adjacentZone') expect(declared.has(`${edge.kind} ${edge.to} ${edge.from}`)).toBe(false)
    }

    // Specifically: the four declared boundaries of the Wohnzimmer are absent
    // from the derived set even though the boxes reproduce every one of them.
    const derivedForRoom = targets(derived.edges, 'interfaceOf', IDS.wohnzimmer)
    expect(derivedForRoom).not.toContain(IDS.wandSued)
    expect(derivedForRoom).not.toContain(IDS.trennwand)
    expect(derivedForRoom).not.toContain(IDS.fenster)
    // What it adds is what the file left out — nobody declared the floor.
    expect(derivedForRoom).toContain(IDS.bodenplatte)

    // The rooms are already neighbours by the file's own account, so no second
    // adjacency in either direction.
    expect(derived.edges.filter((e) => e.kind === 'adjacentZone')).toHaveLength(0)
  })

  it('merges without disturbing the declared edges', () => {
    const merged = withDerivedBoundaries(graph, synthetic())
    const declaredBoundaries = merged.edges.filter(
      (e) => e.kind === 'interfaceOf' && e.provenance === 'declared'
    )
    expect(declaredBoundaries).toHaveLength(6)
    // Each declared boundary appears exactly once — `bounds()` must not list the
    // same wall twice, once read and once measured.
    expect(new Set(declaredBoundaries.map((e) => `${e.from} ${e.to}`)).size).toBe(6)
    expect(merged.out.get('interfaceOf')!.get(IDS.wohnzimmer)!).toContain(IDS.wandSued)
  })
})

/** GlobalIds, verbatim from `haus-mit-raeumen.ifc`. */
const IDS = {
  wandSued: '2Haus0Raeume00Wall0001',
  wandNord: '2Haus0Raeume00Wall0002',
  trennwand: '2Haus0Raeume00Wall0003',
  wandWest: '2Haus0Raeume00Wall0004',
  bodenplatte: '2Haus0Raeume00Slab0001',
  fenster: '2Haus0Raeume00Window01',
  tuer: '2Haus0Raeume00Door0001',
  wohnzimmer: '2Haus0Raeume00Space001',
  kueche: '2Haus0Raeume00Space002',
} as const

/**
 * A hand-laid GeometryIndex for `haus-mit-raeumen.ifc`, in metres.
 *
 * Two rooms side by side with a party wall between them, an external wall on
 * each free side, a floor slab under both, a window in the south wall and a door
 * in the party wall. Every boundary the file declares is reproduced by these
 * boxes — which is the point: the derivation must find them all and emit none of
 * them.
 */
function synthetic(): GeometryIndex {
  const boxes: Record<string, Box> = {
    [IDS.wohnzimmer]: box([0, 0, 0], [5, 4, 2.5]),
    [IDS.kueche]: box([5.2, 0, 0], [8, 4, 2.5]),
    [IDS.trennwand]: box([5.0, 0, 0], [5.2, 4, 2.5]),
    [IDS.wandSued]: box([0, -0.2, 0], [5, 0, 2.5]),
    [IDS.wandNord]: box([0, 4, 0], [5, 4.2, 2.5]),
    [IDS.wandWest]: box([8, 0, 0], [8.2, 4, 2.5]),
    [IDS.bodenplatte]: box([-0.5, -0.5, -0.2], [8.5, 4.5, 0]),
    [IDS.fenster]: box([1, -0.15, 0.9], [2.4, 0.05, 2.1]),
    [IDS.tuer]: box([5.0, 1, 0], [5.2, 1.9, 2.1]),
  }

  const elements = new Map<string, ElementGeometry>()
  for (const [globalId, b] of Object.entries(boxes)) {
    elements.set(globalId, {
      globalId,
      expressId: 0,
      box: b,
      centroid: [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2],
      floorArea: 0,
      surfaceArea: 0,
      facade: null,
      dominant: null,
      triangleCount: 0,
      // `true`: these boxes ARE the whole truth about these elements, so
      // nothing was withheld by a retention cap. `deriveBoundaries` reads only
      // `box` today, but the flag is what tells a future reader that a
      // zero `surfaceArea` here means "a box has none" and not "we dropped it".
      complete: true,
      triangles: null,
    })
  }

  return {
    elements,
    bounds: box([-0.5, -0.5, -0.2], [8.5, 4.5, 2.5]),
    planCentre: [4, 2],
    // Nothing was re-based: the boxes above are already the file's own frame.
    frameOffset: null,
    stats: {
      elementsWithGeometry: elements.size,
      unmatched: 0,
      triangles: 0,
      retainedTriangles: 0,
      ms: 0,
      trianglesTruncated: false,
    },
  }
}

function box(min: Vec3, max: Vec3): Box {
  return { min: [...min] as Vec3, max: [...max] as Vec3 }
}
