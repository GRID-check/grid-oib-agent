/**
 * Regressions from the exporter corpus.
 *
 * Every case here was found by running the pipeline over thirteen third-party
 * IFC files — ArchiCAD 18/20, Revit 2011/2015/2024, SketchUp, SDS/2, IFC Java
 * Toolbox, across IFC2X3, IFC4, IFC4X2 and IFC4X3 — after the library had only
 * ever been measured on one hand-written fixture and one sample house. The
 * findings and the measured numbers are written up in
 * `docs/roadmap/ifc-spatial-corpus-report.md`.
 *
 * The corpus files themselves are third-party and are NOT in this repository.
 * Each defect is therefore reproduced against a fixture small enough to read,
 * or against a synthetic graph built here — and each test names the real file
 * and the real number it stands in for, so the connection survives.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildGraph } from '../src/graph/build.js'
import { openModel } from '../src/model.js'
import { opensTo, adjacentSpaces } from '../src/operators/topology.js'
import { sillAndHead, elevation } from '../src/operators/metric.js'
import { out } from '../src/graph/types.js'
import type { BuildingGraph, GraphNode } from '../src/graph/types.js'
import type { GeometryIndex, ElementGeometry } from '../src/geometry/pass.js'

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))))

// ── units ───────────────────────────────────────────────────────────────────

describe('length unit: the project assignment, not the first unit in the file', () => {
  let graph: BuildingGraph
  beforeAll(async () => {
    graph = await buildGraph(fixture('einheiten-fuss.ifc'))
  })

  /**
   * `Trapelo_Design_Intent.ifc` (Revit 2015) is drawn in feet and was reported
   * as metres, because the metre its foot is defined against appears first;
   * `AISC_Sculpture_param.ifc` (SDS/2) is drawn in inches and was reported as
   * millimetres for the same reason. Both then look like ordinary metric files
   * to anything downstream that prints the unit.
   */
  it('resolves a conversion-based unit to its real factor instead of its SI base', () => {
    expect(graph.units.length).toEqual({ symbol: 'ft', toMetres: 0.3048 })
  })

  /**
   * The decimetre at #6 is not in the unit assignment. `ifcbridge-model01.ifc`
   * has exactly this shape and was reported as a decimetre file — a factor of
   * ten on a 195 m bridge — while its IfcUnitAssignment names a plain metre.
   */
  it('ignores a length unit the project never assigned', () => {
    expect(graph.units.length?.symbol).not.toBe('dm')
  })

  it('is unchanged on the metric files it was already right about', async () => {
    const metric = await buildGraph(fixture('haus-mit-raeumen.ifc'))
    expect(metric.units.length).toEqual({ symbol: 'mm', toMetres: 0.001 })
  })
})

// ── adjacency and openings from declared boundaries ─────────────────────────

describe('declared space boundaries', () => {
  const ID = {
    wohnen: '4Decke00000Space00001',
    kueche: '4Decke00000Space00002',
    bad: '4Decke00000Space00003',
    langeWand: '4Decke00000Wall000001',
    trennwand: '4Decke00000Wall000002',
    decke: '4Decke00000Slab000001',
    fenster: '4Decke00000Window0001',
    oeffnung: '4Decke00000Openin0001',
  } as const

  let graph: BuildingGraph
  beforeAll(async () => {
    graph = await buildGraph(fixture('geschossdecke-und-fenster.ifc'))
  })

  /**
   * The unrestricted rule — any two spaces bounded by any one element are
   * neighbours — reported 6 876 neighbour pairs among the 139 spaces of
   * `Trapelo_Design_Intent.ifc`, 72 % of every possible pair, of which 4 014
   * joined rooms on different storeys. One IfcSlab accounted for 4 278 of them.
   * On `AC20-FZK-Haus.ifc` all 21 of 21 possible pairs came back adjacent.
   */
  it('does not make two rooms neighbours through the floor slab they stand on', () => {
    const neighbours = adjacentSpaces(graph, ID.wohnen)
    expect(neighbours.decidable).toBe(true)
    const ids = neighbours.value!.map((r) => r.globalId)
    expect(ids).toContain(ID.kueche) // shares the party wall
    expect(ids).not.toContain(ID.bad) // shares only the floor slab
  })

  it('the slab under all three rooms produces no adjacency at all', () => {
    const throughSlab = graph.edges.filter(
      (e) => e.kind === 'adjacentZone' && (e.via ?? '').includes('IfcSlab')
    )
    expect(throughSlab).toHaveLength(0)
  })

  /**
   * The party wall and the long south wall are genuine vertical separators, so
   * the adjacencies through them are real — the guard must not have thrown the
   * operator away along with the slab.
   */
  it('still finds the neighbours a wall really does create', () => {
    const throughWall = graph.edges.filter(
      (e) => e.kind === 'adjacentZone' && (e.via ?? '').includes('IfcWall')
    )
    expect(throughWall.length).toBeGreaterThan(0)
  })

  /**
   * The file states, at #41, that the window bounds the Kueche and nothing
   * else. Unioning that with its host wall's three rooms buried the statement:
   * on `C20-Institute-Var-2.ifc` all 283 openings carried such a statement and
   * the union answered with a mean of 5.7 rooms and up to 10 — the window of
   * `Labor K5` was reported as opening into `Labor K1`…`K4` and `WC Damen`.
   */
  it('a window opens into the room its own boundary names, not into every room on its wall', () => {
    const answer = opensTo(graph, ID.fenster)
    expect(answer.decidable).toBe(true)
    expect(answer.value!.map((r) => r.globalId)).toEqual([ID.kueche])
    expect(out(graph, 'interfaceOf', ID.wohnen)).toContain(ID.langeWand)
  })

  it('names the route it took, so a one-room answer is distinguishable from a whole-wall one', () => {
    const edge = graph.edges.find((e) => e.kind === 'opensTo' && e.from === ID.fenster)
    expect(edge?.via).toBe('interfaceOf (eigene Raumbegrenzung)')
  })

  /**
   * The opening itself carries no boundary of its own, so it must still fall
   * back to its host wall — the fallback is the only route there is for the
   * many exports that write no boundary for the filler (78 of 171 openings in
   * `Office_A_20110811.ifc`), and removing it would trade one wrong answer for
   * no answer.
   */
  it('falls back to the host wall for an opening the file does not bound', () => {
    const edges = graph.edges.filter((e) => e.kind === 'opensTo' && e.from === ID.oeffnung)
    expect(edges.length).toBe(2)
    for (const e of edges) expect(e.via).toBe('voids+interfaceOf (Gastbauteil)')
  })
})

// ── IFC4X3 spatial spine ────────────────────────────────────────────────────

describe('IFC4X3 facilities are spatial structure, not components', () => {
  let graph: BuildingGraph
  beforeAll(async () => {
    graph = await buildGraph(fixture('strasse-ifc4x3.ifc'))
  })

  it('classifies IfcRoad as a container and IfcRoadPart as a storey-level part', () => {
    expect(graph.nodes.get('3Strasse0000Road000001')?.kind).toBe('building')
    expect(graph.nodes.get('3Strasse0000RoadPart01')?.kind).toBe('storey')
    expect(graph.nodes.get('3Strasse0000RoadPart02')?.kind).toBe('storey')
  })

  it('leaves only the real components as elements', () => {
    const elements = [...graph.nodes.values()].filter((n) => n.kind === 'element')
    expect(elements.map((n) => n.ifcType).sort()).toEqual(['IfcKerb', 'IfcPavement'])
  })

  /**
   * The parser's own spatial hierarchy is built for the building spine, so an
   * IfcRoad reaches its parts only through IfcRelAggregates. Treating the new
   * container types as "already walked" would have deleted the containment
   * structure of every infrastructure model.
   */
  it('keeps the containment structure the aggregation states', () => {
    expect(out(graph, 'hasSubElement', '3Strasse0000Road000001')).toEqual(
      expect.arrayContaining(['3Strasse0000RoadPart01', '3Strasse0000RoadPart02'])
    )
    expect(out(graph, 'containsElement', '3Strasse0000RoadPart01')).toContain('3Strasse0000Pavement01')
  })
})

// ── the storey datum ────────────────────────────────────────────────────────

/**
 * A graph and a geometry index built by hand, because the defect is a
 * relationship between two numbers and needs no file to exist.
 *
 * `IfcBuildingStorey.Elevation` is DECLARED and the box is MEASURED, and
 * nothing in IFC makes them share a vertical reference. In
 * `Trapelo_Design_Intent.ifc` (Revit 2015, feet) the storeys are declared on the
 * survey datum at 55.68…70.68 m while the geometry spans −3.62…12.29 m, and
 * `sillAndHead` answered, for all 68 windows,
 *
 *     sill = −58.353 m   head = −56.556 m   height = 1.797 m
 *
 * with a 10 mm tolerance and a `computed` provenance. The height is right,
 * which is what made it look like a measurement.
 */
function syntheticModel(storeyElevation: number): { graph: BuildingGraph; geometry: GeometryIndex } {
  const storey: GraphNode = {
    globalId: 'STOREY',
    expressId: 1,
    kind: 'storey',
    ifcType: 'IfcBuildingStorey',
    name: 'FLOOR 1',
    longName: null,
    predefinedType: null,
    elevation: storeyElevation,
    storeyGlobalId: null,
    storeyName: null,
  }
  const window_: GraphNode = {
    globalId: 'WINDOW',
    expressId: 2,
    kind: 'element',
    ifcType: 'IfcWindow',
    name: 'Fenster',
    longName: null,
    predefinedType: null,
    elevation: null,
    storeyGlobalId: 'STOREY',
    storeyName: 'FLOOR 1',
  }
  const nodes = new Map([
    ['STOREY', storey],
    ['WINDOW', window_],
  ])
  const graph = {
    contentHash: 'synthetic',
    schema: 'IFC2X3',
    sourceName: null,
    originatingSystem: null,
    units: { length: { symbol: 'm', toMetres: 1 } },
    trueNorth: null,
    georeferenced: false,
    nodes,
    edges: [],
    out: new Map(),
    in: new Map(),
    byType: new Map([['IfcWindow', ['WINDOW']]]),
    storeys: [storey],
    dialect: [],
    dialectSampleSize: null,
    blindSpots: [],
    stats: {
      entities: 2,
      nodes: 2,
      edges: 0,
      edgesByKind: {},
      parseMs: 0,
      buildMs: 0,
      fileSizeBytes: 0,
    },
  } as unknown as BuildingGraph

  const geo: ElementGeometry = {
    globalId: 'WINDOW',
    expressId: 2,
    box: { min: [0, 0, 0.78], max: [1.4, 0.2, 2.57] },
    centroid: [0.7, 0.1, 1.675],
    floorArea: 0,
    surfaceArea: 1,
    facade: null,
    dominant: null,
    triangleCount: 2,
    complete: true,
    triangles: null,
  }
  const geometry: GeometryIndex = {
    elements: new Map([['WINDOW', geo]]),
    bounds: { min: [0, 0, -3.62], max: [20, 20, 12.29] },
    planCentre: [10, 10],
    frameOffset: null,
    stats: {
      elementsWithGeometry: 1,
      unmatched: 0,
      triangles: 2,
      retainedTriangles: 2,
      ms: 0,
      trianglesTruncated: false,
    },
  }
  return { graph, geometry }
}

describe('storey datum vs measured geometry', () => {
  it('refuses a sill height when the two are on different vertical references', () => {
    const { graph, geometry } = syntheticModel(59.1312)
    const answer = sillAndHead(graph, geometry, 'WINDOW')
    expect(answer.decidable).toBe(false)
    expect(answer.value).toBeNull()
    expect(answer.missing?.what).toMatch(/verschiedenen Höhenbezügen/)
    // The refusal has to carry both ranges, or nobody can act on it.
    expect(answer.missing?.remedy).toContain('59.13')
    expect(answer.missing?.remedy).toContain('12.29')
  })

  it('still answers when the storey sits inside the model it belongs to', () => {
    const { graph, geometry } = syntheticModel(0)
    const answer = sillAndHead(graph, geometry, 'WINDOW')
    expect(answer.decidable).toBe(true)
    expect(answer.value!.sill).toBeCloseTo(0.78, 6)
    expect(answer.value!.head).toBeCloseTo(2.57, 6)
  })

  /**
   * `elevation()` keeps its two measured coordinates and drops only the field
   * that depends on the bad datum — collapsing the whole answer would throw two
   * good numbers away for one missing one.
   */
  it('elevation keeps the absolute heights and nulls only the storey-relative one', () => {
    const { graph, geometry } = syntheticModel(59.1312)
    const answer = elevation(graph, geometry, 'WINDOW')
    expect(answer.decidable).toBe(true)
    expect(answer.value!.bottom).toBeCloseTo(0.78, 6)
    expect(answer.value!.top).toBeCloseTo(2.57, 6)
    expect(answer.value!.heightAboveStorey).toBeNull()
    expect(answer.caveat).toMatch(/Höhenbezügen/)
  })
})

// ── blind spots after the geometry pass ─────────────────────────────────────

describe('blind spots know whether geometry ran', () => {
  /**
   * The list is assembled in `buildGraph`, which runs before the geometry pass,
   * and it used to append "keine Geometrie in dieser Ausbaustufe → Abstände,
   * lichte Maße, Auskragungen, Flächen aus Geometrie und der freie Lichteinfall
   * sind noch nicht berechenbar" unconditionally. `renderBriefing` printed it
   * under BLIND on every model this library ever opened — including
   * `Snowdon_IFC2x3.ifc`, beside a pass that had just tessellated 6 436
   * elements into 2 452 915 triangles. A false "undecidable" is the failure the
   * whole library exists to end, and it was emitting one about itself.
   */
  it('drops the no-geometry spot once the pass has produced geometry', async () => {
    const model = await openModel(fixture('Ifc4_SampleHouse.ifc'))
    expect(model.geometry).not.toBeNull()
    expect(model.geometry!.stats.elementsWithGeometry).toBeGreaterThan(0)
    const what = model.graph.blindSpots.map((b) => b.what)
    expect(what).not.toContain('keine Geometrie in dieser Ausbaustufe')
    expect(what).not.toContain('kein Geometrie-Pass gelaufen (nur Topologie)')
  })

  it('says so plainly when the pass was skipped', async () => {
    const model = await openModel(fixture('Ifc4_SampleHouse.ifc'), { skipGeometry: true })
    expect(model.graph.blindSpots.map((b) => b.what)).toContain('keine Geometrie verfügbar')
  })

  /**
   * Rooms without a solid are the reason `floorArea` is undecidable for them,
   * and nothing else in the briefing would say so: `schependomlaan.ifc`
   * (ArchiCAD 18) declares 100 IfcSpaces and the kernel produced a body for 6.
   */
  it('counts the rooms the kernel produced no solid for', async () => {
    const model = await openModel(fixture('haus-mit-raeumen.ifc'))
    const spot = model.graph.blindSpots.find((b) => /Räumen ohne Volumenkörper/.test(b.what))
    expect(spot?.what).toBe('2 von 2 Räumen ohne Volumenkörper')
  })
})

// ── the geometry frame ──────────────────────────────────────────────────────

describe('the RTC frame', () => {
  /**
   * The kernel re-bases a far-from-origin model and reports what it subtracted.
   * `pass.ts` used to read `coordinateInfo.originShift`, which is `0` whenever
   * the WASM path did the re-basing, and to add it BEFORE the Y-up→Z-up swap
   * although both offset fields are documented as IFC Z-up. Neither error could
   * show on a model whose shift is zero, which is every model this library had
   * ever been run on. `Trapelo_Design_Intent.ifc` carries
   * (219 917.23, 907 157.92, 59.13) m and `Snowdon_IFC2x3.ifc`
   * (417 596.05, 78 709.95, 235.86) m; both were read as zero.
   *
   * The offset is now published rather than baked in — every measurement here
   * is a difference between two points in one frame, and `IfcBuildingStorey.
   * Elevation` is measured from the very datum the kernel re-bases onto.
   */
  it('publishes the offset, and reports none for a model at the origin', async () => {
    const model = await openModel(fixture('Ifc4_SampleHouse.ifc'))
    expect(model.geometry).not.toBeNull()
    expect('frameOffset' in model.geometry!).toBe(true)
    expect(model.geometry!.frameOffset).toBeNull()
  })

  /**
   * The axis swap itself, restated as an assertion rather than a comment: the
   * sample house declares its storeys at 0.00 and 2.50 m, and a frame error
   * would put the ground-floor walls somewhere plausible and wrong.
   */
  it('leaves the sample house on its own declared storey heights', async () => {
    const model = await openModel(fixture('Ifc4_SampleHouse.ifc'))
    const bounds = model.geometry!.bounds!
    expect(bounds.min[2]).toBeGreaterThan(-1)
    expect(bounds.max[2]).toBeLessThan(10)
  })
})
