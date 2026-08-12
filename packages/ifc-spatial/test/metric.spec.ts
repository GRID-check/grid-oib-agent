/**
 * The metric operators, against two real files.
 *
 * Every number asserted here was read off `Ifc4_SampleHouse.ifc` and then
 * checked against something the file says about itself in a DIFFERENT place —
 * the window height against the window type's own name (`1810x1210mm`), the
 * storey datum against the declared elevations. A geometry test that only
 * asserts what the code produced today locks in whatever the code got wrong.
 *
 * Tolerances here are the operators' own (5 mm on a coordinate, 10 mm on a
 * dimension, 1 % on an area). Asserting tighter than the answer claims would be
 * asserting precision the answer explicitly disclaims.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildGraph } from '../src/graph/build.js'
import { runGeometryPass, type GeometryIndex } from '../src/geometry/pass.js'
import type { BuildingGraph } from '../src/graph/types.js'
import { azimuth, clearHeight, distance, elevation, extent, floorArea, sillAndHead } from '../src/operators/metric.js'
import { UnknownElementError } from '../src/operators/topology.js'

/** IfcSpace "1 - Living room". */
const LIVING = '3w0zWKm7n8SB1qbfwUzt0U'
/** IfcSpace "2 - Bedroom". */
const BEDROOM = '3w0zWKm7n8SB1qbfwUzt0J'
/** IfcSpace "3 - Entrance hall". */
const HALL = '3w0zWKm7n8SB1qbfwUzt0G'
/** IfcWindow of type `Windows_Sgl_Plain:1810x1210mm` in the north wall. */
const WINDOW = '3cUkl32yn9qRSPvBJVyWcE'
/** IfcWindowLiningProperties — a real node that never had a body. */
const LINING = '2YIwE60BLCBQZbE8slzVOB'
/** IfcBuildingStorey "Ground Floor", elevation 0. */
const GROUND_FLOOR = '1o0c33arXF9AEePDYchjCY'

async function load(fixture: string): Promise<{ graph: BuildingGraph; geometry: GeometryIndex }> {
  const bytes = new Uint8Array(readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url)))
  const graph = await buildGraph(bytes)
  const geometry = await runGeometryPass(bytes, graph)
  return { graph, geometry }
}

describe('metric operators on Ifc4_SampleHouse.ifc', () => {
  let graph: BuildingGraph
  let geometry: GeometryIndex

  beforeAll(async () => {
    ;({ graph, geometry } = await load('Ifc4_SampleHouse.ifc'))
  }, 300_000)

  it('measures the three room floor areas', () => {
    // 1 % is the operator's own stated area tolerance.
    for (const [id, expected] of [
      [LIVING, 51.99],
      [BEDROOM, 15.42],
      [HALL, 8.69],
    ] as const) {
      const answer = floorArea(graph, geometry, id)
      expect(answer.decidable).toBe(true)
      expect(answer.provenance).toBe('computed')
      expect(answer.unit).toBe('m²')
      expect(answer.value!).toBeCloseTo(expected, 1)
      expect(answer.tolerance!).toBeCloseTo(expected * 0.01, 2)
      expect(answer.method).toBe(`floorArea(${id})`)
    }
  })

  it('returns nothing rounded — the value carries full precision', () => {
    const answer = floorArea(graph, geometry, LIVING)
    // 51.99482727127054: an operator that rounded would make the triangulation
    // below unable to tell 0.4 % from 0 %.
    expect(answer.value).not.toBe(Number(answer.value!.toFixed(2)))
  })

  it('triangulates a declared area against the measured one', () => {
    const agreeing = floorArea(graph, geometry, LIVING, 51.8)
    expect(agreeing.decidable).toBe(true)
    expect(agreeing.caveat).toBeUndefined()

    const disagreeing = floorArea(graph, geometry, LIVING, 45)
    // The measured value wins: the schedule is what is under suspicion.
    expect(disagreeing.value!).toBeCloseTo(51.99, 1)
    expect(disagreeing.caveat).toMatch(/widersprechen sich/)
    expect(disagreeing.caveat).toMatch(/Befund über den Export/)
  })

  it('measures sill and head above the window own storey', () => {
    const answer = sillAndHead(graph, geometry, WINDOW)
    expect(answer.decidable).toBe(true)
    expect(answer.unit).toBe('m')
    expect(answer.tolerance).toBe(0.01)
    // 5 mm on a coordinate; 2 decimal places is 5 mm.
    expect(answer.value!.sill).toBeCloseTo(0.9, 2)
    expect(answer.value!.head).toBeCloseTo(2.11, 2)
    // The type is named `1810x1210mm`, so the file states this height in a
    // completely different place — the naming, not the geometry.
    expect(answer.value!.height).toBeCloseTo(1.21, 2)
    // The datum is the storey, not the project zero.
    expect(answer.from).toContain(GROUND_FLOOR)
  })

  it('measures the window extent, and 1810 mm is in the type name too', () => {
    const answer = extent(graph, geometry, WINDOW)
    expect(answer.decidable).toBe(true)
    expect(answer.value!.width).toBeCloseTo(1.86, 2)
    expect(answer.value!.height).toBeCloseTo(1.21, 2)
    // 1.86 rather than the type's 1.81: the box is the window ASSEMBLY (frame
    // and reveal trim), not the nominal opening. The opening element measures
    // 1.81 — a difference worth not papering over.
    expect(answer.value!.box.min[2]).toBeCloseTo(0.9, 2)
  })

  it('gives absolute and storey-relative elevation', () => {
    const answer = elevation(graph, geometry, WINDOW)
    expect(answer.decidable).toBe(true)
    expect(answer.tolerance).toBe(0.005)
    expect(answer.value!.bottom).toBeCloseTo(0.9, 2)
    expect(answer.value!.top).toBeCloseTo(2.11, 2)
    // Ground floor sits at 0.00, so the two coincide here — on the Roof storey
    // (2.50) they would not.
    expect(answer.value!.heightAboveStorey).toBeCloseTo(0.9, 2)
  })

  it('orients the north window, because THIS file does declare TrueNorth', () => {
    // The task brief expected this file to have no TrueNorth. It has one:
    // `#93=IFCDIRECTION((6.12303176911189E-17,1.))`, i.e. north = +Y. So the
    // honest test here is that the bearing is right, and the refusal is tested
    // on the file that genuinely lacks the entity (below).
    expect(graph.trueNorth).not.toBeNull()
    const answer = azimuth(graph, geometry, WINDOW)
    expect(answer.decidable).toBe(true)
    expect(answer.unit).toBe('°')
    expect(answer.tolerance).toBe(3)
    expect(answer.value!.degrees).toBeCloseTo(0, 1)
    expect(answer.value!.compass).toBe('N')
  })

  it('orients the three exterior walls to N, O and S', () => {
    const bearings = (graph.byType.get('IfcWall') ?? []).map((id) => azimuth(graph, geometry, id).value?.compass)
    expect(bearings).toEqual(['N', 'O', 'S'])
  })

  it('measures a space height and says it is not the clear height', () => {
    const answer = clearHeight(graph, geometry, LIVING)
    expect(answer.decidable).toBe(true)
    expect(answer.value!).toBeCloseTo(2.5, 2)
    expect(answer.caveat).toMatch(/NICHT die lichte Höhe/)
  })

  it('refuses clearHeight on a window with a pointer to the right operator', () => {
    const answer = clearHeight(graph, geometry, WINDOW)
    expect(answer.decidable).toBe(false)
    expect(answer.missing!.what).toMatch(/erwartet einen Raum/)
    expect(answer.missing!.remedy).toMatch(/extent\(\)/)
  })

  it('measures the four senses of distance differently', () => {
    // Living room and bedroom are separated by one 100 mm partition.
    const min = distance(graph, geometry, LIVING, BEDROOM, 'min')
    expect(min.value!).toBeCloseTo(0.095, 2)
    expect(min.caveat).toMatch(/Hüllboxen/)

    const centroid = distance(graph, geometry, LIVING, BEDROOM, 'centroid')
    // 7.08 m, cross-checked against the distance between the two rooms' BOX
    // centres (7.06 m) — 2 cm apart, which is what agreement looks like for two
    // near-prismatic solids. This asserted 6.73 while `pass.ts` derived the
    // centroid from the mean of mesh VERTICES: duplicated vertices pulled the
    // centre 33 cm toward whichever faces were densely tessellated. The
    // centroid is area-weighted now, and the box-centre figure is the reason to
    // believe the new number rather than the old one.
    expect(centroid.value!).toBeCloseTo(7.08, 1)

    // Both rooms are on the same storey and equally tall, so the vertical
    // distance is zero while the horizontal one is the full 6.73.
    expect(distance(graph, geometry, LIVING, BEDROOM, 'horizontal').value!).toBeCloseTo(6.73, 1)
    expect(distance(graph, geometry, LIVING, BEDROOM, 'vertical').value!).toBeCloseTo(0, 2)
  })

  it('reports 0 with a caveat when the boxes overlap', () => {
    // The window's box reaches into the bedroom's band.
    const answer = distance(graph, geometry, WINDOW, BEDROOM, 'min')
    expect(answer.value).toBe(0)
    expect(answer.caveat).toMatch(/überschneiden sich/)
    expect(answer.caveat).toMatch(/NICHT/)
  })

  it('is undecidable — not an exception — for a node without geometry', () => {
    const answer = extent(graph, geometry, LINING)
    expect(answer.decidable).toBe(false)
    expect(answer.provenance).toBe('computed')
    expect(answer.missing!.what).toMatch(/keine geometrische Repräsentation/)
    expect(answer.missing!.elements).toEqual([LINING])
  })

  it('throws for a GlobalId this model does not contain', () => {
    for (const call of [
      () => extent(graph, geometry, 'nichtvorhanden'),
      () => floorArea(graph, geometry, 'nichtvorhanden'),
      () => sillAndHead(graph, geometry, 'nichtvorhanden'),
      () => azimuth(graph, geometry, 'nichtvorhanden'),
      () => clearHeight(graph, geometry, 'nichtvorhanden'),
      () => distance(graph, geometry, LIVING, 'nichtvorhanden', 'min'),
    ]) {
      expect(call).toThrow(UnknownElementError)
    }
  })
})

describe('metric operators on a file without a declared north', () => {
  let graph: BuildingGraph
  let geometry: GeometryIndex

  beforeAll(async () => {
    ;({ graph, geometry } = await load('haus-mit-raeumen.ifc'))
  }, 300_000)

  it('refuses every compass bearing rather than defaulting north to +Y', () => {
    expect(graph.trueNorth).toBeNull()
    const wall = (graph.byType.get('IfcWall') ?? [])[0]!
    expect(wall).toBeTruthy()

    const answer = azimuth(graph, geometry, wall)
    expect(answer.decidable).toBe(false)
    expect(answer.value).toBeNull()
    expect(answer.missing!.what).toBe('IfcGeometricRepresentationContext.TrueNorth')
    expect(answer.missing!.remedy).toMatch(/Nordrichtung/)
  })
})
