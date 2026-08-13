/**
 * The drawings, against the real sample house.
 *
 * ## What these tests assert, and why it is not "what the code produced today"
 *
 * A drawing test that compared an SVG to a stored SVG would pass forever while
 * the picture drifted away from the building. So every geometric assertion here
 * is checked against a number the FILE states somewhere else:
 *
 *   - the wall's drawn length and height against its bounding box, which the
 *     geometry pass derives independently of anything in `project.ts`;
 *   - the window's drawn height against its own IFC type name,
 *     `Windows_Sgl_Plain:1810x1210mm` — 1.210 m from sill to head, which is what
 *     the elevation and the section must both show;
 *   - the roof's overhang in the section against the wall's outer face, which is
 *     the one thing a section is FOR and the one thing a bounding box cannot
 *     produce;
 *   - the model bounds (x −9.23…7.63, y −2.75…5.92, z −0.47…3.50) against the
 *     returned `viewBox`.
 *
 * ## The properties that are about honesty, not geometry
 *
 * The rest of the file tests the refusals: a requested element with no geometry
 * appears in `elementsWithoutGeometry`, a bounding box drawn in place of a shape
 * says so ON the drawing, a cut plane that meets nothing returns
 * `decidable: false` instead of an empty picture, and a north arrow appears only
 * for a file that declares north. Each of those is a way for a picture to become
 * a lie, and each one is cheaper to catch here than in a submission.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildGraph } from '../src/graph/build.js'
import { runGeometryPass, type GeometryIndex } from '../src/geometry/pass.js'
import type { BuildingGraph } from '../src/graph/types.js'
import { project, type Annotation } from '../src/render/project.js'
import { UnknownElementError } from '../src/operators/topology.js'

/** IfcWall, the north facade — 14.145 m long, 2.474 m high, five openings. */
const WALL = '3cUkl32yn9qRSPvBJVyWw5'
/** IfcWindow `Windows_Sgl_Plain:1810x1210mm` in that wall, sill 0.90, head 2.11. */
const WINDOW = '3cUkl32yn9qRSPvBJVyWcE'
/** IfcRoof — named `Roof_Flat-…` and in fact curved, which the section shows. */
const ROOF = '3cUkl32yn9qRSPvBJVyWh4'
/** IfcWindowLiningProperties: a real node in the graph that never had a body. */
const NO_BODY = '2YIwE60BLCBQZbE8slzVOB'
/** The three IfcSpaces on the ground floor; the fourth, `4 - Roof`, is above them. */
const LIVING = '3w0zWKm7n8SB1qbfwUzt0U'
const BEDROOM = '3w0zWKm7n8SB1qbfwUzt0J'
const HALL = '3w0zWKm7n8SB1qbfwUzt0G'

let graph: BuildingGraph
let geometry: GeometryIndex

// ── reading the SVG back ────────────────────────────────────────────────────
//
// The tests parse the emitted SVG rather than trusting the numbers the operator
// also returned: `viewBox` and `elementsDrawn` come from the same code path that
// might have drawn nothing at all, and an assertion that never looks at the `d`
// attribute cannot tell a drawing from an empty frame.

interface DrawnPath {
  id: string | null
  d: string
  /** The whole `<path …/>` tag, so a test can read fill and weight too. */
  raw: string
}

function paths(svg: string): DrawnPath[] {
  const out: DrawnPath[] = []
  // `raw` keeps the whole tag: fill, fill-rule and stroke weight are as much
  // part of what a drawing says as its coordinates are, and a test that only
  // reads `d` cannot tell a filled section from a wireframe.
  for (const m of svg.matchAll(/<path d="([^"]*)"[^>]*?(?:data-id="([^"]*)")?\/>/g)) {
    out.push({ d: m[1]!, id: m[2] ?? null, raw: m[0] })
  }
  return out
}

function byId(svg: string, id: string): DrawnPath {
  // Never the background layer. In a section an element that is both cut and
  // extends past the plane is drawn twice under one id, and the cut is the one
  // a question about "this element in this drawing" means.
  const found = paths(svg).find((p) => p.id === id && !p.raw.includes('data-layer="beyond"'))
  if (!found) throw new Error(`no path for ${id}`)
  return found
}

/** Extent of every coordinate in a path, in drawing units (metres). */
function boxOf(d: string): { minU: number; minV: number; maxU: number; maxV: number } {
  const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  const box = { minU: Infinity, minV: Infinity, maxU: -Infinity, maxV: -Infinity }
  for (let i = 0; i + 1 < nums.length; i += 2) {
    box.minU = Math.min(box.minU, nums[i]!)
    box.maxU = Math.max(box.maxU, nums[i]!)
    box.minV = Math.min(box.minV, nums[i + 1]!)
    box.maxV = Math.max(box.maxV, nums[i + 1]!)
  }
  return box
}

/**
 * How far a drawn length may sit from the measured one: 20 mm.
 *
 * Not a tolerance on the geometry — the projection is exact. It is the price of
 * emitting coordinates at two decimals, which the module does on purpose to keep
 * the file small: a length is the difference of two coordinates and therefore
 * carries two centimetre-roundings. Asserting tighter would be asserting
 * precision the SVG does not claim; asserting looser would stop catching a wall
 * drawn at the wrong length.
 */
const ROUNDING = 0.02

function expectMetres(actual: number, expected: number, tolerance = ROUNDING): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance)
}

/** Subpaths, i.e. rings for a filled view and polylines for a section. */
function subpaths(d: string): number {
  return (d.match(/M/g) ?? []).length
}

function segments(svg: string): number {
  return paths(svg).reduce((sum, p) => sum + (p.d.match(/L/g) ?? []).length, 0)
}

/** The same index with one element's triangles thrown away — the box-only case. */
function withoutTriangles(base: GeometryIndex, id: string): GeometryIndex {
  const elements = new Map(base.elements)
  elements.set(id, { ...elements.get(id)!, triangles: null })
  return { ...base, elements }
}

/**
 * The same index with one element inflated past the byte budget.
 *
 * Cheaper and more honest than shipping a second fixture: what the size guard
 * reacts to is the number of triangles that survive projection, and this puts a
 * known number of survivors in front of it.
 */
function withTriangleFlood(base: GeometryIndex, id: string, count: number): GeometryIndex {
  const element = base.elements.get(id)!
  const t = new Float64Array(count * 9)
  const { min, max } = element.box
  for (let i = 0; i < count; i++) {
    // Each one comfortably larger than the sliver threshold, all inside the
    // element's own box so the view extent does not change.
    const x = min[0] + ((max[0] - min[0]) * (i % 100)) / 100
    const y = min[1] + ((max[1] - min[1]) * Math.floor(i / 100)) / Math.max(1, count / 100)
    t.set([x, y, min[2], x + 0.2, y, min[2], x, y + 0.2, min[2]], i * 9)
  }
  const elements = new Map(base.elements)
  elements.set(id, { ...element, triangles: t, triangleCount: count })
  return { ...base, elements }
}

describe('project() on Ifc4_SampleHouse.ifc', () => {
  beforeAll(async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/Ifc4_SampleHouse.ifc', import.meta.url)))
    graph = await buildGraph(bytes)
    geometry = await runGeometryPass(bytes, graph)
  }, 300_000)

  describe('plan of the whole building', () => {
    it('spans the model bounds, drawn from the retained triangles', () => {
      const answer = project(graph, geometry, { view: 'plan' })
      expect(answer.decidable).toBe(true)
      expect(answer.provenance).toBe('computed')
      const view = answer.value!

      // Every element the geometry pass found, none dropped.
      expect(view.elementsDrawn).toBe(geometry.elements.size)
      expect(view.elementsWithoutGeometry).toEqual([])

      // A plan draws (x, −y), so the viewBox must bracket the model's x and −y
      // bounds. The padding is a small fraction of the extent — asserting an
      // upper bound on it catches a view that fits the model into a frame ten
      // times too large, which is how an empty drawing hides.
      const [vx, vy, vw, vh] = view.viewBox
      expect(vx).toBeLessThanOrEqual(-9.23)
      expect(vx).toBeGreaterThan(-9.23 - 1)
      expect(vx + vw).toBeGreaterThanOrEqual(7.63)
      expect(vx + vw).toBeLessThan(7.63 + 1)
      expect(vy).toBeLessThanOrEqual(-5.92)
      expect(vy).toBeGreaterThan(-5.92 - 1)
      // The footer (scale bar and captions) is allowed to extend the height and
      // is not allowed to extend the width.
      expect(vy + vh).toBeGreaterThanOrEqual(2.746)

      // Real triangles, not a frame: the sample house retains 24,494 of which
      // roughly a third survive a plan projection — every vertical face is a
      // zero-area sliver seen from above and is dropped on purpose.
      const rings = paths(view.svg).reduce((sum, p) => sum + subpaths(p.d), 0)
      expect(rings).toBeGreaterThan(3000)
      expect(view.svg.startsWith('<svg')).toBe(true)
      expect(view.svg.endsWith('</svg>')).toBe(true)
    })

    it('stays well under the size budget and says how it is scaled', () => {
      const view = project(graph, geometry, { view: 'plan' }).value!
      expect(view.svg.length).toBeLessThan(500_000)
      // No stylesheet, no class attribute, no external reference: the SVG has to
      // survive being pasted into a mail on its own.
      expect(view.svg).not.toContain('<style')
      expect(view.svg).not.toContain('class=')
      expect(view.svg).not.toContain('http://www.w3.org/1999/xlink')
      expect(view.scale).toMatch(/^1:\d+ \(1 m = \d+ px, 96 dpi\)$/)
      // Two decimals, i.e. a centimetre — three would be false precision and
      // 30 % more bytes.
      expect(view.svg).not.toMatch(/\d\.\d{3}/)
    })

    it('caps `from` at 50 and says how many were left out', () => {
      const answer = project(graph, geometry, { view: 'plan' })
      expect(answer.from).toHaveLength(50)
      expect(answer.caveat).toContain(`50 von ${answer.value!.elementsDrawn}`)
      expect(answer.method).toContain('project(plan')
      // The standing qualification: a drawing is a check, never a source.
      expect(answer.caveat).toContain('keine Quelle')
    })
  })

  describe('plan of the four IfcSpaces', () => {
    it('draws four separate closed shapes, each the size of its own space', () => {
      const spaces = graph.byType.get('IfcSpace') ?? []
      expect(spaces).toHaveLength(4)
      const view = project(graph, geometry, { view: 'plan', include: spaces }).value!
      expect(view.elementsDrawn).toBe(4)

      const drawn = paths(view.svg).filter((p) => p.id !== null)
      expect(drawn.map((p) => p.id).sort()).toEqual([...spaces].sort())

      for (const space of spaces) {
        const path = byId(view.svg, space)
        // Closed rings, and more than one: a room's floor tessellates into at
        // least two triangles, and the L-shaped living room into four per face.
        expect(path.d).toContain('Z')
        expect(subpaths(path.d)).toBeGreaterThanOrEqual(2)

        // The drawn shape IS the element's own geometry, to the centimetre the
        // coordinates are rounded to. This is the assertion that would fail if
        // the projection ever silently became a schematic.
        const box = geometry.elements.get(space)!.box
        const drawnBox = boxOf(path.d)
        expect(drawnBox.minU).toBeCloseTo(box.min[0], 1)
        expect(drawnBox.maxU).toBeCloseTo(box.max[0], 1)
        expect(drawnBox.minV).toBeCloseTo(-box.max[1], 1)
        expect(drawnBox.maxV).toBeCloseTo(-box.min[1], 1)
      }

      // Separate, and demonstrably so: the three ground-floor rooms do not
      // overlap in plan. (The fourth space is `4 - Roof` and sits above all
      // three, so it overlaps them by construction — a plan that separated it
      // would be hiding a storey.)
      const rooms = [LIVING, BEDROOM, HALL].map((id) => boxOf(byId(view.svg, id).d))
      for (let i = 0; i < rooms.length; i++) {
        for (let j = i + 1; j < rooms.length; j++) {
          const a = rooms[i]!
          const b = rooms[j]!
          const apart = a.maxU <= b.minU || b.maxU <= a.minU || a.maxV <= b.minV || b.maxV <= a.minV
          expect(apart).toBe(true)
        }
      }
    })
  })

  describe('elevation of the north wall with its window highlighted', () => {
    it('shows the wall at its real length and the window at its real opening', () => {
      const answer = project(graph, geometry, {
        view: 'elevation',
        include: [WALL, WINDOW],
        highlight: [WINDOW],
      })
      const view = answer.value!
      expect(view.elementsDrawn).toBe(2)

      const wall = boxOf(byId(view.svg, WALL).d)
      const wallBox = geometry.elements.get(WALL)!.box
      // The viewing plane defaults to the wall's own facade, so the drawn width
      // is the wall's length and the drawn height its height. Both are compared
      // against the bounding box the geometry pass produced independently.
      expectMetres(wall.maxU - wall.minU, wallBox.max[0] - wallBox.min[0])
      expectMetres(wall.maxV - wall.minV, wallBox.max[2] - wallBox.min[2])

      const window_ = boxOf(byId(view.svg, WINDOW).d)
      // v is −z, so the window's head is at −2.11 and its sill at −0.90. The
      // 1.210 m between them is the file's own type name: 1810x1210mm.
      expectMetres(window_.minV, -2.11)
      expectMetres(window_.maxV, -0.9)
      expectMetres(window_.maxV - window_.minV, 1.21)
      // 1.860 m drawn against 1.810 m nominal: the lining overlaps the reveal on
      // both sides, which is the sort of 25 mm a drawing is allowed to show and
      // a schedule is not.
      expectMetres(window_.maxU - window_.minU, 1.86)

      // The window sits inside the wall, and is drawn in the accent colour.
      expect(window_.minU).toBeGreaterThan(wall.minU)
      expect(window_.maxU).toBeLessThan(wall.maxU)
      expect(byId(view.svg, WINDOW).d.length).toBeGreaterThan(0)
      expect(view.svg).toContain('#e08a2e')
    })

    it('carries no north arrow — north belongs to a plan', () => {
      const view = project(graph, geometry, { view: 'elevation', include: [WALL] }).value!
      expect(view.svg).not.toContain('>N</text>')
    })
  })

  describe('section through the window', () => {
    const cut = (): { x: number; annotation: Annotation } => {
      const box = geometry.elements.get(WINDOW)!.box
      return {
        x: (box.min[0] + box.max[0]) / 2,
        annotation: {
          kind: 'dimension',
          points: [
            [(box.min[0] + box.max[0]) / 2, 4.9, 0.9],
            [(box.min[0] + box.max[0]) / 2, 4.9, 2.11],
          ],
          text: '1,21 m Brüstung → Sturz',
        },
      }
    }

    it('cuts real profiles, chained into polylines', () => {
      const { x, annotation } = cut()
      const answer = project(graph, geometry, {
        view: 'section',
        planeNormal: [1, 0, 0],
        planeOffset: x,
        highlight: [WINDOW],
        annotations: [annotation],
      })
      const view = answer.value!

      // 15 elements meet the plane on this file and produce several hundred
      // segments. The bound is deliberately far below that: the test is "the cut
      // produced a real profile", not "the tessellator produced today's count".
      expect(view.elementsDrawn).toBeGreaterThan(8)
      expect(segments(view.svg)).toBeGreaterThan(50)

      // Chaining did something: far fewer polylines than segments, or the
      // endpoint matching silently failed and every segment stands alone.
      //
      // `M` counts polylines and `L` counts segments, so the ratio between them
      // over the SAME set of paths is the whole measurement. Getting that set
      // right is the difficult part, and two selections that look right are not:
      //
      //   - `fill="none"` looks like "the cut", and is not. A closed ring is
      //     emitted FILLED (`ringPath(ring, true)`), so the profiles chaining
      //     managed to close are exactly the ones this filter throws away,
      //     while the scale bar, the north arrow and the tick marks — which
      //     chaining never touched — are exactly the ones it keeps. On this
      //     view it selects 14 paths carrying 168 subpaths over 211 segments:
      //     a ratio of 1.3 that would fail the bound below however well the
      //     chaining worked.
      //   - `segments(view.svg)` counts every path in the drawing, including
      //     the faint `data-layer="beyond"` background that makes a section
      //     read as a building rather than as fragments floating in white.
      //     That layer is one subpath per triangle by construction — measured
      //     here at 1605 subpaths for 3210 segments, exactly two apiece — and
      //     it outweighs the cut eightfold, so `polylines < segments/3` reduces
      //     to 168 < 1263 and passes on any input whatsoever.
      //
      // The honest set is the paths that carry a `data-id` and are not the
      // beyond layer: the cut itself, filled rings and open profiles alike.
      // Measured on this file that is 16 paths, 26 polylines, 403 segments —
      // 15.5 segments per polyline. Had the endpoint matching failed, every
      // segment would stand alone and the two counts would be equal.
      const cutPaths = paths(view.svg).filter(
        (p) => p.raw.includes('data-id=') && !p.raw.includes('data-layer="beyond"')
      )
      const polylines = cutPaths.reduce((sum, p) => sum + subpaths(p.d), 0)
      const cutSegments = cutPaths.reduce((sum, p) => sum + (p.d.match(/L/g) ?? []).length, 0)
      // The cut has to exist before its shape means anything: 50 is the same
      // floor the whole-drawing assertion above uses, and the cut alone clears
      // it by 8x.
      expect(cutSegments).toBeGreaterThan(50)
      expect(polylines).toBeLessThan(cutSegments / 3)

      // Cut material is filled; profiles the mesh left open are not.
      //
      // This asserted the opposite — that a section never closes a path and
      // never fills — on the reasoning that a greedy chaining walk cannot know
      // which side of a profile is solid. That is true of an OPEN profile and
      // does not apply once the walk returns to its start: a closed ring
      // encloses the same region whichever way round it is walked, and it is
      // exactly the material the plane passed through. Refusing to fill it
      // turned every section into a wireframe of fragments.
      const drawn = paths(view.svg).filter((q) => q.id !== null && !q.raw.includes('data-layer="beyond"'))
      const closed = drawn.filter((p) => p.d.includes('Z'))
      const open = drawn.filter((p) => !p.d.includes('Z'))
      expect(closed.length).toBeGreaterThan(0)
      for (const p of closed) {
        expect(p.raw).toMatch(/fill="#/)
        expect(p.raw).toContain('fill-rule="evenodd"')
      }
      // Openings must read as holes in the cut face, not as a second slab
      // sitting inside the first — which is what a non-zero fill rule would do.
      for (const p of open) expect(p.raw).toContain('fill="none"')

      // The window's cut spans exactly its opening, sill to head …
      const window_ = boxOf(byId(view.svg, WINDOW).d)
      expect(window_.minV).toBeCloseTo(-2.11, 2)
      expect(window_.maxV).toBeCloseTo(-0.9, 2)

      // … and the annotation is on the drawing, escaped, with its ticks.
      expect(view.svg).toContain('Brüstung')
      expect(view.svg).toContain('<text')
    })

    it("shows the roof overhanging the wall — the fact a bounding box cannot give", () => {
      const { x } = cut()
      const view = project(graph, geometry, { view: 'section', planeNormal: [1, 0, 0], planeOffset: x }).value!
      // u is the world +Y axis for this cut. The north wall's outer face is at
      // y = 4.70; the roof reaches past it. That overhang is the number this
      // whole library exists for, and here it has to be visible.
      const wall = boxOf(byId(view.svg, WALL).d)
      const roof = boxOf(byId(view.svg, ROOF).d)
      expect(roof.maxU).toBeGreaterThan(wall.maxU + 0.3)
      // And the roof of this "Roof_Flat-…" is curved: its cut rises well above
      // the wall head, which a flat slab's would not.
      expect(-roof.minV).toBeGreaterThan(3)
    })

    it('cuts horizontally too — the drawing an architect calls a Grundriss', () => {
      // A section a metre above the floor, seen from above. The axes have to
      // fall back to (x, −y) here; taken as a vertical view the whole drawing
      // would collapse onto a line.
      const answer = project(graph, geometry, {
        view: 'section',
        planeNormal: [0, 0, 1],
        planeOffset: 1,
        include: [WALL, WINDOW],
      })
      const view = answer.value!
      expect(view.viewBox[2]).toBeGreaterThan(10)
      expect(view.viewBox[3]).toBeGreaterThan(0.2)
      // The wall is cut across its thickness, 0.29 m, and along its full length.
      const wall = boxOf(byId(view.svg, WALL).d)
      expectMetres(wall.maxV - wall.minV, 0.29)
      expectMetres(wall.maxU - wall.minU, 14.145)
      // At z = 1.00 the plane passes through the window between sill and head,
      // and there the cut measures 1.810 m — the type's own name to the
      // millimetre (`Windows_Sgl_Plain:1810x1210mm`). The elevation showed
      // 1.860 m for the same window because its silhouette includes the lining
      // that overlaps the reveal; the two drawings disagree by exactly the
      // 25 mm of overlap on each side, which is the sort of thing a section is
      // read for.
      const window_ = boxOf(byId(view.svg, WINDOW).d)
      expectMetres(window_.maxU - window_.minU, 1.81)
    })

    it('refuses when the cut plane meets nothing', () => {
      const answer = project(graph, geometry, { view: 'section', planeNormal: [1, 0, 0], planeOffset: 999 })
      expect(answer.decidable).toBe(false)
      expect(answer.value).toBeNull()
      expect(answer.missing?.remedy).toContain('planeOffset')
    })
  })

  describe('what a drawing must never hide', () => {
    it('lists a requested element the geometry pass produced nothing for', () => {
      const answer = project(graph, geometry, { view: 'plan', include: [WALL, NO_BODY] })
      expect(answer.value!.elementsWithoutGeometry).toEqual([NO_BODY])
      expect(answer.value!.elementsDrawn).toBe(1)
      expect(answer.caveat).toContain(NO_BODY)
    })

    it('says on the drawing itself when a box stands in for a shape', () => {
      const answer = project(graph, withoutTriangles(geometry, WALL), { view: 'plan', include: [WALL] })
      expect(answer.caveat).toContain('Hüllquader')
      // ON the drawing, not only in the answer: an SVG gets separated from the
      // envelope the moment somebody forwards it.
      expect(answer.value!.svg).toContain('Hüllquader')
      // Still the wall's real footprint, just convex: the box is the box.
      const drawn = boxOf(byId(answer.value!.svg, WALL).d)
      const box = geometry.elements.get(WALL)!.box
      expect(drawn.minU).toBeCloseTo(box.min[0], 1)
      expect(drawn.maxU).toBeCloseTo(box.max[0], 1)
    })

    it('drops to outlines rather than emitting half a megabyte, and says so', () => {
      // The budget is 400 KB at ~42 bytes a triangle; 12,000 survivors on one
      // element is past it whatever else is in the view.
      const flooded = withTriangleFlood(geometry, WALL, 12_000)
      const answer = project(graph, flooded, { view: 'plan', include: [WALL, WINDOW] })
      const view = answer.value!
      expect(view.svg.length).toBeLessThan(500_000)
      expect(answer.caveat).toContain('Umrisslinie')
      expect(view.svg).toContain('Nur Umrisse')
      // One outline per element, not 12,000 triangles.
      expect(subpaths(byId(view.svg, WALL).d)).toBe(1)
    })

    it('throws on an id this model does not contain', () => {
      expect(() => project(graph, geometry, { view: 'plan', include: ['0000000000000000000000'] })).toThrow(
        UnknownElementError
      )
    })

    it('escapes annotation text instead of letting it become markup', () => {
      const view = project(graph, geometry, {
        view: 'plan',
        include: [WALL],
        annotations: [{ kind: 'label', points: [[0, 0, 0]], text: '<script>&"' }],
      }).value!
      expect(view.svg).not.toContain('<script>')
      expect(view.svg).toContain('&lt;script&gt;&amp;&quot;')
    })
  })

  describe('north', () => {
    it('draws the arrow when the file declares true north', () => {
      expect(graph.trueNorth).not.toBeNull()
      const view = project(graph, geometry, { view: 'plan' }).value!
      expect(view.svg).toContain('>N</text>')
    })

    it('draws no arrow, and says why, when the file declares none', () => {
      // A north arrow on a file that states no north is a fabricated fact — and
      // the one a reader is least likely to question.
      const view = project({ ...graph, trueNorth: null }, geometry, { view: 'plan' }).value!
      expect(view.svg).not.toContain('>N</text>')
      expect(view.svg).toContain('Ohne Nordangabe')
    })

    it('omits the scale bar on request but keeps the drawing', () => {
      const view = project(graph, geometry, { view: 'plan', include: [WALL], showScaleBar: false }).value!
      expect(view.svg).not.toMatch(/>\d+ m</)
      expect(byId(view.svg, WALL).d.length).toBeGreaterThan(100)
    })
  })

  describe('roles', () => {
    it('draws context faintly, the included set normally, and the highlight last', () => {
      const view = project(graph, geometry, {
        view: 'plan',
        include: [WALL, WINDOW],
        context: [WALL],
        highlight: [WINDOW],
      }).value!
      const order = paths(view.svg)
        .filter((p) => p.id !== null)
        .map((p) => p.id)
      // Highlight paints over everything, whatever its depth.
      expect(order[order.length - 1]).toBe(WINDOW)
      expect(view.svg).toContain('stroke-opacity="0.3"')
      expect(view.elementsDrawn).toBe(2)
    })
  })
})
