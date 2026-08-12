/**
 * The constructive operators, on the file the failed turn was about.
 *
 * Every expectation here is a number measured from `Ifc4_SampleHouse.ifc`, not a
 * number invented for a fixture: a flat-roofed house whose roof is in fact a
 * shallow barrel (z 1.74–3.48, sagging to the eaves), three exterior walls, four
 * windows at sill 0.90 / head 2.11. The point of testing against it rather than
 * against a synthetic box is that the two interesting failures — the geometry
 * pass' facade plane landing inside the masonry, and a 376-triangle roof whose
 * triangles span the whole prism — only exist in a real export.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildGraph } from '../src/graph/build.js'
import { runGeometryPass, type GeometryIndex } from '../src/geometry/pass.js'
import type { BuildingGraph } from '../src/graph/types.js'
import { UnknownElementError } from '../src/operators/topology.js'
import { facadePlaneOf, freeLightIncidence, obstructions, overhang, prism, ray } from '../src/operators/constructive.js'

const NORTH_WALL = '3cUkl32yn9qRSPvBJVyWw5'
const EAST_WALL = '3cUkl32yn9qRSPvBJVyWx4'
const SOUTH_WALL = '3cUkl32yn9qRSPvBJVyWy4'
const ROOF = '3cUkl32yn9qRSPvBJVyWh4'
/** The window of the failed question, in the north wall. */
const WINDOW = '3cUkl32yn9qRSPvBJVyWcE'
const OPENING = '3cUkl32yn9qRSPvAVVyWcE'
/** Exports geometry through its panels and mullions, never as a solid of its own. */
const CURTAIN_WALL = '3cUkl32yn9qRSPvBJVyW_P'

let graph: BuildingGraph
let geometry: GeometryIndex

beforeAll(async () => {
  const bytes = new Uint8Array(readFileSync(new URL('./fixtures/Ifc4_SampleHouse.ifc', import.meta.url)))
  graph = await buildGraph(bytes)
  geometry = await runGeometryPass(bytes, graph)
}, 300000)

describe('facadePlaneOf', () => {
  it('orients the normal outward and seats the plane on the outer leaf', () => {
    const north = facadePlaneOf(graph, geometry, NORTH_WALL)
    expect(north.decidable).toBe(true)
    const plane = north.value!
    expect(plane.outward).toBe(true)
    // Outward is +Y here; the geometry pass reports the same axis with the
    // normal of whichever face won a coin flip, which is the inner one.
    expect(plane.normal[1]).toBeCloseTo(1, 6)
    expect(plane.normal[2]).toBe(0)
    // The wall spans y 4.409 (inside) .. 4.699 (outside), and the plane sits on
    // the outer leaf — a real face, which is the invariant that matters.
    expect(plane.point[1]).toBeCloseTo(4.699, 2)
    expect(plane.point[1]).toBeCloseTo(geometry.elements.get(NORTH_WALL)!.box.max[1], 3)
    expect(north.provenance).toBe('computed')
    expect(north.tolerance).toBe(0.005)
  })

  it('handles all three exterior walls, each pointing away from the plan centre', () => {
    expect(facadePlaneOf(graph, geometry, EAST_WALL).value!.normal[0]).toBeCloseTo(1, 6)
    expect(facadePlaneOf(graph, geometry, EAST_WALL).value!.point[0]).toBeCloseTo(6.41, 2)
    expect(facadePlaneOf(graph, geometry, SOUTH_WALL).value!.normal[1]).toBeCloseTo(-1, 6)
    expect(facadePlaneOf(graph, geometry, SOUTH_WALL).value!.point[1]).toBeCloseTo(-1.391, 2)
  })

  it('is undecidable — not zero, not a throw — for an element without a solid', () => {
    const answer = facadePlaneOf(graph, geometry, CURTAIN_WALL)
    expect(answer.decidable).toBe(false)
    expect(answer.value).toBeNull()
    expect(answer.missing!.what).toContain('Körpergeometrie')
    expect(answer.missing!.remedy).toMatch(/exportiert|Unterbauteile/)
  })

  it('throws on an id this model does not contain', () => {
    expect(() => facadePlaneOf(graph, geometry, 'nichtImModell00000000x')).toThrow(UnknownElementError)
  })
})

describe('overhang', () => {
  it('measures the roof past each exterior facade — the number that was "nicht messbar"', () => {
    const north = overhang(graph, geometry, ROOF, NORTH_WALL)
    const east = overhang(graph, geometry, ROOF, EAST_WALL)
    const south = overhang(graph, geometry, ROOF, SOUTH_WALL)

    expect(north.value).toBeCloseTo(0.647, 2)
    expect(south.value).toBeCloseTo(0.548, 2)
    // Flush: the roof stops exactly on the east wall's outer face.
    expect(east.value).toBeCloseTo(0, 2)

    for (const answer of [north, east, south]) {
      expect(answer.provenance).toBe('computed')
      expect(answer.unit).toBe('m')
      expect(answer.tolerance).toBe(0.005)
      expect(answer.caveat).toBeUndefined()
    }
    expect(north.method).toBe(`overhang(${ROOF}, facadePlaneOf(${NORTH_WALL}))`)
    expect(north.from).toEqual([ROOF, NORTH_WALL])
  })

  it('measures from a real face, never from the binned plane inside the masonry', () => {
    const passPlane = geometry.elements.get(NORTH_WALL)!.facade!
    const seated = facadePlaneOf(graph, geometry, NORTH_WALL).value!
    // The geometry pass bins parallel faces by normal alone, so its plane can
    // land anywhere between the wall's leaves and never outside the outer one.
    // Today it reports y 4.4221 against the outer face's 4.6986: 0.28 m of
    // masonry, on a question whose answer is of the order of a metre. Asserted
    // as the inequality rather than as that difference, because a fix in
    // pass.ts must not read as a regression here.
    expect(passPlane.point[1]).toBeLessThanOrEqual(seated.point[1] + 1e-6)
    expect(seated.point[1]).toBeCloseTo(geometry.elements.get(NORTH_WALL)!.box.max[1], 3)
    expect(overhang(graph, geometry, ROOF, NORTH_WALL).value!).toBeCloseTo(
      geometry.elements.get(ROOF)!.box.max[1] - geometry.elements.get(NORTH_WALL)!.box.max[1],
      3
    )
  })

  it('reports 0 with a caveat, never a negative projection', () => {
    // The south wall does not reach the north wall's facade plane.
    const answer = overhang(graph, geometry, SOUTH_WALL, NORTH_WALL)
    expect(answer.value).toBe(0)
    expect(answer.caveat).toContain('erreicht die Fassadenebene nicht')
  })

  it('propagates undecidable when the reference element has no solid', () => {
    const answer = overhang(graph, geometry, ROOF, CURTAIN_WALL)
    expect(answer.decidable).toBe(false)
    expect(answer.missing!.what).toContain('Körpergeometrie')
  })
})

describe('ray', () => {
  it('reports the first surface with its position and distance', () => {
    // From inside the bedroom, straight north at window height. The wall is
    // voided here, so the first surface is the window's own glazing at y 4.61 —
    // which is also proof that the opening was really subtracted from the wall.
    const answer = ray(graph, geometry, [3.9, 2.0, 1.5], [0, 1, 0])
    expect(answer.decidable).toBe(true)
    const hit = answer.value!
    expect(hit.hit).toBe(WINDOW)
    expect(hit.point[1]).toBeCloseTo(4.613, 2)
    expect(hit.distance).toBeCloseTo(2.613, 2)
  })

  it('hits the wall where the wall is solid, and escapes through the hole where it is not', () => {
    const solid = ray(graph, geometry, [1.0, 2.0, 1.5], [0, 1, 0])
    expect(solid.value!.hit).toBe(NORTH_WALL)
    expect(solid.value!.point[1]).toBeCloseTo(4.409, 2)

    // Same aim as above but through the window opening, with the window
    // excluded: nothing is left in the way, and the answer is a decidable null.
    const throughTheHole = ray(graph, geometry, [3.9, 2.0, 1.5], [0, 1, 0], undefined, [WINDOW])
    expect(throughTheHole.decidable).toBe(true)
    expect(throughTheHole.value).toBeNull()
  })

  it('distinguishes "nothing in the way" from "could not look"', () => {
    const free = ray(graph, geometry, [3.9, 6.5, 1.5], [0, 1, 0], 50)
    expect(free.decidable).toBe(true)
    expect(free.value).toBeNull()
  })

  it('answers a zero direction rather than throwing', () => {
    const answer = ray(graph, geometry, [0, 0, 0], [0, 0, 0])
    expect(answer.decidable).toBe(false)
    expect(answer.missing!.what).toContain('Strahl')
  })
})

describe('prism', () => {
  it('anchors on the lower edge of the opening, in the facade plane', () => {
    const answer = prism(graph, geometry, OPENING, 45, 30)
    expect(answer.decidable).toBe(true)
    const volume = answer.value!
    expect(volume.facadeElementId).toBe(NORTH_WALL)
    expect(volume.sillZ).toBeCloseTo(0.9, 3)
    expect(volume.normal[1]).toBeCloseTo(1, 6)
    // Both ends of the lower edge sit on the wall's outer face, at sill height.
    for (const end of volume.lowerEdge) {
      expect(end[1]).toBeCloseTo(4.699, 2)
      expect(end[2]).toBeCloseTo(0.9, 3)
    }
    expect(Math.abs(volume.lowerEdge[1][0] - volume.lowerEdge[0][0])).toBeCloseTo(1.81, 2)
    expect(volume.halfSpaces.map((h) => h.role)).toEqual(['facade', 'incline', 'lateralLeft', 'lateralRight'])
    expect(volume.rays).toHaveLength(15)
    for (const r of volume.rays) expect(Math.asin(r.direction[2]) * (180 / Math.PI)).toBeCloseTo(45, 6)
  })

  it('takes the angles from the caller and refuses nonsense ones', () => {
    expect(prism(graph, geometry, OPENING, 30, 0).value!.angleDeg).toBe(30)
    expect(prism(graph, geometry, OPENING, 30, 0).value!.rays).toHaveLength(3)
    const bad = prism(graph, geometry, OPENING, 0, 30)
    expect(bad.decidable).toBe(false)
    expect(bad.missing!.what).toContain('angleDeg')
  })

  it('accepts the window as well as the opening it fills', () => {
    const fromWindow = prism(graph, geometry, WINDOW, 45, 30).value!
    expect(fromWindow.facadeElementId).toBe(NORTH_WALL)
    expect(fromWindow.sillZ).toBeCloseTo(0.9, 2)
  })
})

describe('obstructions', () => {
  it('finds the roof in the 45°/30° prism and says how deep it reaches', () => {
    const volume = prism(graph, geometry, OPENING, 45, 30).value!
    const answer = obstructions(graph, geometry, volume, [NORTH_WALL])
    expect(answer.decidable).toBe(true)
    const found = answer.value!
    expect(found.map((f) => f.globalId)).toContain(ROOF)
    const roof = found.find((f) => f.globalId === ROOF)!
    expect(roof.intrusionDepth).toBeGreaterThan(0.5)
    expect(roof.name).toMatch(/Roof/)
    expect(answer.unit).toBe('m')
  })

  it('never reports the opening or its own filler as blocking its light', () => {
    const volume = prism(graph, geometry, OPENING, 45, 30).value!
    const ids = obstructions(graph, geometry, volume, [NORTH_WALL]).value!.map((f) => f.globalId)
    // The window's frame projects 40 mm past the facade and would otherwise
    // stand in its own prism.
    expect(ids).not.toContain(WINDOW)
    expect(ids).not.toContain(OPENING)
  })

  it('excludes spaces and openings by construction — air does not block light', () => {
    const volume = prism(graph, geometry, OPENING, 45, 30).value!
    const ids = obstructions(graph, geometry, volume, [NORTH_WALL]).value!.map((f) => f.globalId)
    for (const id of ids) expect(graph.nodes.get(id)!.kind).toBe('element')
  })
})

describe('freeLightIncidence', () => {
  it('composes the check for the window of the failed question', () => {
    const answer = freeLightIncidence(graph, geometry, OPENING, { angleDeg: 45, swivelDeg: 30, exclude: [NORTH_WALL] })
    expect(answer.decidable).toBe(true)
    const result = answer.value!

    expect(result.free).toBe(false)
    expect(result.blockedBy.map((b) => b.globalId)).toContain(ROOF)
    // The roof meets the facade plane above the sill, so no elevation under 90°
    // frees the prism — and saying "89.7°" instead of null would be arithmetic
    // dressed as advice.
    expect(result.worstAngleDeg).toBeNull()
    expect(answer.caveat).toContain('Überstand')
  })

  it('returns geometry, not a verdict', () => {
    const answer = freeLightIncidence(graph, geometry, OPENING, { angleDeg: 45, swivelDeg: 30, exclude: [NORTH_WALL] })
    expect(Object.keys(answer.value!).sort()).toEqual(['blockedBy', 'free', 'worstAngleDeg'])
    expect(JSON.stringify(answer)).not.toMatch(/compliant|konform|zulässig/i)
    // §11: a cut prism enlarges the required light-entry area, it does not ban
    // the window — and the answer says so rather than implying the opposite.
    expect(answer.caveat).toContain('Lichteintrittsfläche')
  })

  it('blocks the south window too, and reports its own intrusion depth', () => {
    // 0.55 m of roof over the south facade rather than 0.65 m, and the prism it
    // cuts is a different one — the depth must not be copied between windows.
    const answer = freeLightIncidence(graph, geometry, '3cUkl32yn9qRSPvAVVyZTO', {
      angleDeg: 45,
      swivelDeg: 30,
      exclude: [SOUTH_WALL],
    })
    expect(answer.value!.free).toBe(false)
    expect(answer.value!.blockedBy[0].globalId).toBe(ROOF)
    expect(answer.value!.blockedBy[0].intrusionDepth).toBeCloseTo(1.347, 2)
  })

  it('reports a number, not null, once the obstruction is out of the way', () => {
    // Same window with the roof excluded: nothing stands in front of the facade
    // at all, so the prism is free and the shallowest achievable elevation is 0.
    const answer = freeLightIncidence(graph, geometry, OPENING, {
      angleDeg: 45,
      swivelDeg: 30,
      exclude: [NORTH_WALL, ROOF],
    })
    expect(answer.value!.free).toBe(true)
    expect(answer.value!.blockedBy).toEqual([])
    expect(answer.value!.worstAngleDeg).toBe(0)
  })

  it('shrinks the intrusion as the required angle steepens — monotone, as a prism must be', () => {
    const depth = (angleDeg: number) =>
      freeLightIncidence(graph, geometry, OPENING, { angleDeg, swivelDeg: 30, exclude: [NORTH_WALL] }).value!
        .blockedBy[0]!.intrusionDepth
    expect(depth(30)).toBeGreaterThan(depth(45))
    expect(depth(45)).toBeGreaterThan(depth(60))
    expect(depth(30)).toBeCloseTo(1.316, 2)
    expect(depth(45)).toBeCloseTo(1.075, 2)
    expect(depth(60)).toBeCloseTo(0.76, 2)
  })

  it('carries the tolerance and a method that reads like the call', () => {
    const answer = freeLightIncidence(graph, geometry, OPENING, { angleDeg: 45, swivelDeg: 30, exclude: [NORTH_WALL] })
    expect(answer.tolerance).toBe(0.5)
    expect(answer.unit).toBe('°')
    expect(answer.method).toContain('freeLightIncidence(')
    expect(answer.method).toContain('45°')
    expect(answer.method).toContain('±30°')
  })
})
