/**
 * The turn this library was built because of.
 *
 * An architect uploaded `Ifc4_SampleHouse.ifc` and asked whether a window and
 * the roof above it work for the light-incidence angle. The agent retrieved the
 * right clause, explained the 45° prism and the 30° lateral swivel correctly,
 * and then could not answer. Its own confidence note gave the reason in five
 * words:
 *
 *     "Überstand/Raum-% im IFC nicht messbar."
 *
 * Every one of those numbers was in the file. This suite is the standing proof
 * that each is now reachable, on that exact file, and it asserts the PROVENANCE
 * of each as strictly as the value — because the difference between "the model
 * says" and "I measured, ±30 cm" is the whole product.
 *
 * If this file ever goes red, the thing that was fixed has come undone.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildGraph } from '../src/graph/build.js'
import { runGeometryPass, type GeometryIndex } from '../src/geometry/pass.js'
import { withDerivedBoundaries } from '../src/geometry/boundaries.js'
import { openModel } from '../src/model.js'
import { hostedIn, opensTo } from '../src/operators/topology.js'
import { azimuth, clearHeight, floorArea, sillAndHead } from '../src/operators/metric.js'
import { facadePlaneOf, freeLightIncidence, overhang } from '../src/operators/constructive.js'
import { inventory } from '../src/operators/model.js'
import type { BuildingGraph } from '../src/graph/types.js'

/** The window the architect asked about. */
const WINDOW = '3cUkl32yn9qRSPvBJVyWcE'

describe('the question that started this', () => {
  let graph: BuildingGraph
  let geometry: GeometryIndex
  let hostWall: string
  let roof: string

  beforeAll(async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/Ifc4_SampleHouse.ifc', import.meta.url)))
    const base = await buildGraph(bytes)
    geometry = await runGeometryPass(bytes, base)
    graph = withDerivedBoundaries(base, geometry)
    hostWall = hostedIn(graph, WINDOW).value![0]!.globalId
    roof = (graph.byType.get('IfcRoof') ?? [])[0]!
  }, 180_000)

  it('finds the wall the window sits in', () => {
    const answer = hostedIn(graph, WINDOW)
    expect(answer.decidable).toBe(true)
    expect(answer.value).toHaveLength(1)
    expect(answer.value![0]!.name).toContain('Wall-Ext_102Bwk')
    // Two hops through relations the file states outright, so this is a
    // reading of the file and not a measurement.
    expect(answer.provenance).toBe('computed')
    expect(answer.value![0]!.via).toBe('voids+fills')
  })

  it('finds the room the window serves, and says it measured rather than read', () => {
    const answer = opensTo(graph, WINDOW)
    expect(answer.decidable).toBe(true)
    expect(answer.value!.map((r) => r.name)).toEqual(['Bedroom'])
    // This export writes no IfcRelSpaceBoundary at all. The relation exists
    // only because geometry recovered it, and the answer has to say so —
    // presenting a 30 cm contact test as a declared fact is the failure this
    // library exists to prevent.
    expect(answer.provenance).toBe('computed')
    expect(answer.caveat).toMatch(/Geometrie abgeleitet/)
  })

  it('measures the room area the file never declares', () => {
    const bedroom = opensTo(graph, WINDOW).value![0]!.globalId
    const area = floorArea(graph, geometry, bedroom)
    expect(area.decidable).toBe(true)
    expect(area.value!).toBeCloseTo(15.42, 1)
    expect(area.unit).toBe('m²')
    expect(area.tolerance).toBeGreaterThan(0)
    expect(area.provenance).toBe('computed')
  })

  it('proposes the room use without asserting it', () => {
    const bedroom = opensTo(graph, WINDOW).value![0]!.globalId
    const habitable = inventory(graph, 'aufenthaltsraum')
    const match = habitable.value!.find((room) => room.globalId === bedroom)
    expect(match).toBeTruthy()
    // Aufenthaltsraum is a legal classification, not a geometric one. It stays
    // a proposal with reasons, at a confidence, for a human to confirm.
    expect(habitable.provenance).toBe('inferred')
    expect(match!.confidence).toBeGreaterThanOrEqual(0.8)
    expect(match!.because.length).toBeGreaterThan(0)
  })

  it('measures the sill and head the file never declares', () => {
    const answer = sillAndHead(graph, geometry, WINDOW)
    expect(answer.decidable).toBe(true)
    expect(answer.value!.sill).toBeCloseTo(0.9, 2)
    expect(answer.value!.head).toBeCloseTo(2.11, 2)
    // The type is named `Windows_Sgl_Plain:1810x1210mm`. The measured height
    // agreeing with the name to under a millimetre is an independent check
    // that the Y-up → Z-up frame conversion in pass.ts is right: two unrelated
    // statements in the file, one a string and one a swept solid, agree.
    expect(answer.value!.height).toBeCloseTo(1.21, 2)
  })

  it('names the facade bearing instead of inventing one', () => {
    const answer = azimuth(graph, geometry, hostWall)
    // The original answer described this as the Südfassade. It faces north,
    // and the file declares a TrueNorth, so this is checkable rather than
    // narrated. On a file WITHOUT one the operator refuses — see metric.spec.
    expect(answer.decidable).toBe(true)
    expect(answer.value!.compass).toBe('N')
  })

  it('measures the overhang the agent called unmeasurable', () => {
    const plane = facadePlaneOf(graph, geometry, hostWall)
    expect(plane.decidable).toBe(true)
    expect(plane.value!.outward).toBe(true)

    const answer = overhang(graph, geometry, roof, hostWall)
    expect(answer.decidable).toBe(true)
    // 0.647 m, normal to the facade plane, from the roof's own triangles.
    expect(answer.value!).toBeCloseTo(0.647, 2)
    expect(answer.unit).toBe('m')
    expect(answer.tolerance!).toBeLessThanOrEqual(0.01)
    expect(answer.provenance).toBe('computed')
  })

  it('reports the prism as geometry and refuses to turn it into a verdict', () => {
    const answer = freeLightIncidence(graph, geometry, WINDOW, {
      angleDeg: 45,
      swivelDeg: 30,
      exclude: [hostWall],
    })

    expect(answer.decidable).toBe(true)
    expect(answer.value!.free).toBe(false)
    expect(answer.value!.blockedBy.map((b) => b.name).join(' ')).toContain('Roof_Flat')

    // The angles are PARAMETERS the caller binds from the clause; this module
    // knows geometry, not law. A blocked prism enlarges the required
    // light-entry area under OIB 3 — it does not ban the window — and an
    // operator that returned `compliant: false` would be lying about its own
    // competence.
    expect(answer.caveat).toMatch(/kein Befund/)
    expect(answer.caveat).toMatch(/Regelwerk/)
    expect(JSON.stringify(answer)).not.toMatch(/compliant|erfüllt|verstoß/i)
  })

  it('does not claim a blind spot the file does not have', () => {
    // This assertion was written the other way round, on the assumption that a
    // sample house would carry no georeferencing. It does: IfcSite declares
    // 51°30'N 0°07'W, which is London — the file is the buildingSMART/Xbim
    // sample, not an Austrian project. So the "keine Georeferenzierung" blind
    // spot correctly does NOT fire, and the test that expected it was asserting
    // a defect.
    //
    // Worth keeping as a test rather than deleting: a false blind spot is the
    // same failure as a false answer. Telling an architect their model lacks
    // something it declares sends them to fix a file that is already right.
    expect(graph.georeferenced).toBe(true)
    const blind = graph.blindSpots.map((spot) => spot.what).join(' | ')
    expect(blind).not.toMatch(/Georeferenzierung/)
  })

  it('offers no sun position even though this file could support one', async () => {
    // Georeferencing makes a Besonnungsstudie POSSIBLE; it does not make it
    // built. The library exposes the geometric prism and no solar operator, and
    // the honest state of a capability that does not exist is absence — not a
    // sun vector computed from a latitude and presented as a study.
    const surface = Object.keys(await import('../src/index.js'))
    expect(surface.join(' ')).not.toMatch(/sunPath|besonnung|solar/i)
  })
})

/**
 * The clear height, which this library got wrong and a second engine caught.
 *
 * `clearHeight` returned the space solid's own height — 2.500 m for a living
 * room whose `IfcCovering` ceiling hangs at 2.200 m — with a caveat explaining
 * that suspended ceilings shorten the real figure and that the intersection
 * test was missing. The caveat carried the truth and the number did not.
 *
 * 30 cm is a large error on exactly the figure a minimum room height is checked
 * against, and it was in the direction that turns a fail into a pass. It was
 * found by porting the operators onto IfcOpenShell and comparing: 40 of 41
 * numbers agreed to micrometres, and this one did not.
 */
describe('clear height, the number a second engine had to catch', () => {
  let graph: BuildingGraph
  let geometry: GeometryIndex

  beforeAll(async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/Ifc4_SampleHouse.ifc', import.meta.url)))
    const opened = await openModel(bytes)
    graph = opened.graph
    geometry = opened.geometry!
  }, 180_000)

  const ROOMS = [
    ['3w0zWKm7n8SB1qbfwUzt0U', 'Living room'],
    ['3w0zWKm7n8SB1qbfwUzt0J', 'Bedroom'],
    ['3w0zWKm7n8SB1qbfwUzt0G', 'Entrance hall'],
  ] as const

  it.each(ROOMS)('measures %s to the ceiling, not to the space solid', (id) => {
    const answer = clearHeight(graph, geometry, id)
    expect(answer.decidable).toBe(true)
    // 2.200 m — the Compound Ceiling. Independently reproduced by IfcOpenShell
    // casting its own rays. The space solids all run 0.000–2.500.
    expect(answer.value!).toBeCloseTo(2.2, 2)
    expect(answer.provenance).toBe('computed')
    // The element responsible is named, so the reader can check it.
    expect(answer.from).toHaveLength(2)
    expect(answer.caveat).toMatch(/Unterkante/)
  })

  it('is not fooled by furniture, walls or the windows in them', () => {
    // Three wrong answers preceded the right one, each from a different way of
    // deciding what counts: unfiltered rays hit a sofa (0.37 m), excluding
    // furniture hit a window sill in the south wall (0.90 m), and a
    // bounding-box test hit the roof spanning the whole building (1.74 m).
    // Only a positive list of things that can be OVERHEAD gets this right.
    for (const [id] of ROOMS) {
      const answer = clearHeight(graph, geometry, id)
      expect(answer.value!).toBeGreaterThan(2.0)
      expect(answer.value!).toBeLessThan(2.5)
    }
  })
})
