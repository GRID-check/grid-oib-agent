/**
 * Drawings: the same triangles the operators measure, projected to an SVG.
 *
 * ## Why this exists
 *
 * The agent can measure a building and cannot look at one. A picture earns its
 * place for exactly three jobs:
 *
 *   1. **sanity-checking an absurd number** — a VLM, or a human, glancing at a
 *      section can see that a 4.2 m "clear height" is the roof ridge and not the
 *      room;
 *   2. **disambiguating which element a person means** — "the window on the
 *      left" is a question about a drawing, not about a GlobalId;
 *   3. **showing a human the reasoning** — §8.3 wants every number to be a
 *      citable derivation, and a derivation an architect can *see* is one they
 *      can disagree with in specific terms.
 *
 * And it is dangerous for a fourth job: **producing numbers**. §14 settles this
 * — a vision model over rendered views is "useful as a *check*, not a source: a
 * VLM looking at a section can notice a computed answer is absurd; it cannot
 * produce 1.32 m." Nothing in this module returns a measurement, and nothing
 * downstream should read one off the picture. The metric operators measure; this
 * one draws.
 *
 * ## Why it draws from the operators' own triangles
 *
 * This module projects **exactly the triangle set in {@link GeometryIndex}** —
 * the arrays `overhang()`, `clearHeight()` and the ray casts read. It does not
 * re-tessellate, does not open the file, and does not ask a viewer for a
 * screenshot.
 *
 * That is the whole point. A screenshot taken by a viewer is a SECOND reading of
 * the model, and a second reading can disagree with the numbers — the day it
 * does, the agent and the picture contradict each other in front of the user,
 * which is the failure ADR-0045 and §14 both exist to prevent. A projection of
 * the same triangle set *cannot* disagree: if the drawing is wrong, the numbers
 * are wrong in the same way, and the picture is then evidence about the numbers
 * rather than a rival to them. When triangles were not retained (the pass caps
 * them), this module says so on the drawing itself rather than substituting
 * something that looks like a shape.
 *
 * ## Why pure math and no renderer
 *
 * No GPU, no WebGPU, no headless browser, no dependency. ADR-0045 records that
 * headless Chromium routinely refuses a WebGPU adapter, so anything that needs
 * one is unreliable exactly where this has to run — a server turn, in a
 * container, with no display. Projection, plane intersection and a scale bar are
 * arithmetic; taking a GPU dependency for arithmetic would trade a guaranteed
 * picture for a probable one.
 *
 * ## The frame
 *
 * Input is the file's own frame (IFC **Z-up**, metres). SVG's y axis grows
 * DOWNWARD, so every drawing coordinate is the world value NEGATED (`-y` for a
 * plan, `-z` for an elevation) rather than mirrored with a `transform`. The
 * transform would be shorter and would also mirror every glyph of every label;
 * negating the coordinates keeps text upright with no counter-transform to
 * forget.
 *
 * Drawing coordinates are therefore **metres**, and the returned `viewBox` is
 * the world extent — so a caller can check a drawing against the model bounds
 * without decoding a transform.
 */

import { computed, undecidable, type Answer } from '../envelope.js'
import type { Box, ElementGeometry, GeometryIndex, Vec3 } from '../geometry/pass.js'
import { label, node, type BuildingGraph } from '../graph/types.js'
import { UnknownElementError } from '../operators/topology.js'

// ── the contract ────────────────────────────────────────────────────────────

export type ViewKind = 'plan' | 'section' | 'elevation'

/**
 * Something drawn ON TOP of the geometry, in world coordinates.
 *
 * World coordinates and not drawing coordinates, because the caller that has
 * something to annotate has it as a measurement — a sill at z = 0.90, a ray from
 * a window head to a roof edge — and making it convert into the view's own 2D
 * frame first would put the projection maths in two places, one of which is not
 * tested.
 */
export interface Annotation {
  kind: 'dimension' | 'outline' | 'ray' | 'label'
  points: Array<[number, number, number]>
  text?: string
  emphasis?: 'normal' | 'warn' | 'good'
}

export interface ProjectOptions {
  view: ViewKind
  /** Only these elements; omit for everything with geometry. */
  include?: string[]
  /** Drawn faintly for context — the "isolate but keep the shell" view. */
  context?: string[]
  /** Drawn in the emphasis colour. */
  highlight?: string[]
  /** For 'section'/'elevation': the cut/viewing plane. Defaults derived from the included set. */
  planeNormal?: [number, number, number]
  planeOffset?: number
  /** Slab thickness for a section cut, metres. Default 0.05. */
  sliceDepth?: number
  annotations?: Annotation[]
  widthPx?: number
  showScaleBar?: boolean
}

/**
 * The drawing, and enough about it to judge whether it is worth looking at.
 *
 * `elementsWithoutGeometry` is not a diagnostic — it is part of the answer. A
 * plan of a room that silently omits the wall the question is about is worse
 * than no plan, because it looks complete.
 */
export interface ProjectedView {
  svg: string
  /** `[minX, minY, width, height]` in metres, in the view's own 2D frame. */
  viewBox: [number, number, number, number]
  /** Human-readable, e.g. `1:75 (1 m = 50 px, 96 dpi)`. */
  scale: string
  elementsDrawn: number
  /** Requested ids the geometry pass produced nothing for. Never dropped silently. */
  elementsWithoutGeometry: string[]
}

// ── the constants, and what each one prevents ───────────────────────────────

const DEFAULT_WIDTH_PX = 900
/** Below this an SVG is unreadable; above it, nothing is gained but bytes. */
const MIN_WIDTH_PX = 200
const MAX_WIDTH_PX = 4000

/** Default slab thickness of a section cut, metres. */
const DEFAULT_SLICE_DEPTH = 0.05

/**
 * Byte budget for the geometry of one drawing.
 *
 * The brief is "well under 500 KB for a whole house". A projected triangle
 * serialises to roughly `M-9.23 -5.92L-8.11 -5.42L-7.98 -4.11Z` — 42 bytes at
 * building coordinates — so the budget converts to a triangle count. Past it the
 * drawing degrades to one outline per element, which stays useful for
 * disambiguation and says so in the caveat, rather than emitting a file no chat
 * turn can carry.
 */
const SVG_BUDGET_BYTES = 400_000
const BYTES_PER_TRIANGLE = 42
const MAX_DRAWN_TRIANGLES = Math.floor(SVG_BUDGET_BYTES / BYTES_PER_TRIANGLE)

/**
 * Smallest triangle worth drawing, in square pixels.
 *
 * Not only a size optimisation. In a plan EVERY vertical face — both sides of
 * every wall, every window reveal — projects to a zero-area sliver, and a sliver
 * drawn with a stroke is a stray line across the footprint. Dropping them is
 * what turns the projection into a plan: a wall keeps its top and bottom faces,
 * which are its footprint, and loses the noise. On the sample house it removes
 * 16,235 of 24,494 triangles.
 */
const MIN_TRIANGLE_PX2 = 0.25

/**
 * How close two section-segment endpoints must be to be the same point, metres.
 *
 * Segments come from intersecting a shared triangle edge from both of its faces,
 * so the two values are computed from identical vertices and agree to floating
 * point. A millimetre is far looser than that and far tighter than any real
 * feature of a building, which is the band a chaining tolerance wants to sit in.
 */
const CHAIN_TOLERANCE = 0.001

/**
 * Font size annotations are drawn at, in px.
 *
 * Shared between the extent reservation and the emission, so a label cannot be
 * measured at one size and drawn at another — which would put the clipping back
 * quietly, the first time somebody tuned one of the two.
 */
const ANNOTATION_FONT_PX = 12

/**
 * Ink.
 *
 * A drawing that is only legible on the background it was designed for gets
 * pasted into a dark chat and disappears. Everything here is a MID tone —
 * readable against white and against near-black — and every filled shape carries
 * a stroke, so a fill that washes out on one background still leaves an outline.
 */
const INK = {
  context: '#8a8f98',
  normal: '#6b7280',
  highlight: '#e08a2e',
  warn: '#dc4a4a',
  good: '#2f9e5f',
  furniture: '#8a8f98',
} as const

type Role = 'context' | 'normal' | 'highlight'

/**
 * Stroke opacity is low on purpose, and it is not a style choice.
 *
 * Every triangle carries its own outline, so a slab split into two triangles
 * draws a diagonal across itself — the mesh, honestly, but visual noise a reader
 * has to look past. Alpha does the sorting for free: an edge that two triangles
 * share (or that the top and bottom face of a solid both project onto — every
 * real outline in a plan) is drawn twice and composites to nearly full strength,
 * while a lone tessellation diagonal stays faint. The picture that emerges
 * emphasises the boundaries WITHOUT the module deciding which edges are real,
 * which is a decision it has no reliable way to make on a mesh with unreliable
 * winding.
 */
const ROLE_STYLE: Record<Role, { colour: string; fillOpacity: number; strokeOpacity: number; strokePx: number }> = {
  context: { colour: INK.context, fillOpacity: 0.06, strokeOpacity: 0.3, strokePx: 0.5 },
  normal: { colour: INK.normal, fillOpacity: 0.16, strokeOpacity: 0.5, strokePx: 0.5 },
  highlight: { colour: INK.highlight, fillOpacity: 0.28, strokeOpacity: 1, strokePx: 1.4 },
}

// ── the operator ────────────────────────────────────────────────────────────

/**
 * Draw the model, or a part of it, as a self-contained SVG.
 *
 * ## Which elements get drawn
 *
 * `include ?? everything with geometry`, plus `context` and `highlight` — an id
 * in `highlight` is drawn whether or not it is also in `include`, because
 * "highlight the window in this wall" is the natural call and silently dropping
 * the window would defeat the request. Where the sets overlap, `highlight` wins
 * over `context`.
 *
 * ## Three ways this refuses
 *
 *   - An id that names nothing in this model throws {@link UnknownElementError}.
 *     Same reasoning as every other operator: a hallucinated id must never come
 *     back as a picture that merely happens to be missing something.
 *   - An id that names a real element the geometry pass produced nothing for is
 *     listed in `elementsWithoutGeometry` and drawn not at all — a finding about
 *     the export, in the answer, not a gap in a picture nobody notices.
 *   - Nothing drawable at all — or a cut plane that meets no surface — returns
 *     `decidable: false`. An empty drawing looks like a building with nothing in
 *     it, which is a lie a blank answer does not tell.
 */
export function project(
  graph: BuildingGraph,
  geometry: GeometryIndex,
  options: ProjectOptions
): Answer<ProjectedView> {
  const view = options.view
  const widthPx = clamp(Math.round(options.widthPx ?? DEFAULT_WIDTH_PX), MIN_WIDTH_PX, MAX_WIDTH_PX)
  const sliceDepth = Math.abs(options.sliceDepth ?? DEFAULT_SLICE_DEPTH)
  const annotations = options.annotations ?? []
  const method = describeCall(options, widthPx)

  // ── which elements, and in which role ─────────────────────────────────────
  const contextIds = options.context ?? []
  const highlightIds = options.highlight ?? []
  const baseIds = options.include ?? [...geometry.elements.keys()]

  // Later wins, deliberately: an id named twice is drawn in the role that is
  // hardest to overlook. `context` demotes an element out of the included set
  // (that IS the isolate-but-keep-the-shell call), and `highlight` promotes it
  // out of either.
  const roles = new Map<string, Role>()
  for (const id of baseIds) roles.set(id, 'normal')
  for (const id of contextIds) roles.set(id, 'context')
  for (const id of highlightIds) roles.set(id, 'highlight')

  const elementsWithoutGeometry: string[] = []
  const drawable: Array<{ id: string; role: Role; geo: ElementGeometry }> = []
  for (const [id, role] of roles) {
    if (!node(graph, id)) throw new UnknownElementError(id, method)
    const geo = geometry.elements.get(id)
    if (!geo) {
      elementsWithoutGeometry.push(id)
      continue
    }
    drawable.push({ id, role, geo })
  }

  if (drawable.length === 0) {
    return undecidable<ProjectedView>({
      from: [...roles.keys()].slice(0, 50),
      method,
      provenance: 'computed',
      missing: {
        what: 'Geometrie (IfcShapeRepresentation) für die angeforderten Bauteile',
        remedy:
          'Das Modell mit Körpergeometrie exportieren — ohne Dreiecke lässt sich keine Zeichnung erzeugen, ' +
          'auch keine ungefähre.',
        ...(elementsWithoutGeometry.length > 0 ? { elements: elementsWithoutGeometry.slice(0, 50) } : {}),
      },
    })
  }

  // ── the frame: what "u" and "v" mean in this view ─────────────────────────
  const focus = pickFocus(drawable, options)
  const frame = buildFrame(view, options, focus, geometry)
  // Now that the plane is resolved, the citation can name it — including when
  // nobody passed one.
  const cited = describeCall(options, widthPx, frame)

  // ── geometry → polygons or polylines ──────────────────────────────────────
  const extent = new Extent()
  let drawn: DrawnElement[]
  let outlineMode = false

  if (view === 'section') {
    // A section is the cut PLUS what stands behind it. Drawing only the cut
    // produced exactly what it sounds like: fragments floating in white, a
    // roof band over a slab bar with nothing to say how they relate. Every
    // real Schnitt carries the view beyond the plane in a lighter weight, and
    // that background is most of what makes it legible as a building.
    //
    // The background is the ordinary filled projection of everything on the far
    // side of the plane, demoted to `context` so it can never compete with the
    // cut. It is emitted FIRST so the cut draws over it.
    const beyond = drawable
      .filter(({ geo }) => farSideOf(geo, frame.plane!))
      .map((d) => ({ ...d, role: 'context' as Role }))
    const background = (beyond.length > 0 ? fillElements(beyond, frame, extent, widthPx, MAX_DRAWN_TRIANGLES) ?? [] : []).map(
      (d) => ({ ...d, beyond: true })
    )
    drawn = [...background, ...sectionElements(drawable, frame, sliceDepth, extent)]
    // Both halves of the cut count. This read `d.lines` alone, which was right
    // while a section could only ever produce open polylines and became wrong
    // the moment closed rings started going to `d.polys` instead: a section
    // consisting entirely of closed profiles — which is to say, a good one
    // through solid material — reported that the plane met nothing at all. An
    // emptiness check that looks at one of two output channels turns a correct
    // answer into a confident "impossible", which is the failure this whole
    // library is built to prevent.
    const segments = drawn.reduce((sum, d) => sum + d.lines.length + d.polys.length, 0)
    if (segments === 0) {
      return undecidable<ProjectedView>({
        from: drawable.map((d) => d.id).slice(0, 50),
        method: cited,
        provenance: 'computed',
        missing: {
          what: `Schnittfläche in der Ebene n=(${frame.plane!.normal.map((v) => v.toFixed(2)).join(', ')}), d=${frame.plane!.offset.toFixed(3)} m`,
          remedy:
            'Die Schnittebene trifft keine einzige Dreiecksfläche der gewählten Bauteile. ' +
            'planeOffset oder planeNormal so wählen, dass die Ebene durch das Bauteil geht.',
          elements: drawable.map((d) => d.id).slice(0, 50),
        },
      })
    }
  } else {
    // Two passes rather than an estimate: the number of triangles that SURVIVE
    // the projection is what costs bytes, and on a plan that is a third of the
    // number that went in. Budgeting on the raw count would push a house that
    // fits comfortably into the degraded outline mode for no reason.
    const filled = fillElements(drawable, frame, extent, widthPx, MAX_DRAWN_TRIANGLES)
    if (filled) {
      drawn = filled
    } else {
      outlineMode = true
      extent.reset()
      drawn = outlineElements(drawable, frame, extent)
    }
  }

  for (const annotation of annotations) {
    for (const p of annotation.points) extent.add(frame.toU(p[0], p[1], p[2]), frame.toV(p[0], p[1], p[2]))
  }

  // Labels are wider than the thing they label, and the drawing has to hold
  // them. Feeding only the annotation ENDPOINTS to the extent was enough to
  // keep a dimension's line on the sheet and not its text: on the first
  // section this produced, "Dachüberstand 0.65 m" — twenty characters over a
  // 0.65 m dimension — ran off the top edge, and a 45° ray's label was cut to
  // "45° L" at the right.
  //
  // The width is estimated rather than measured because there is no font
  // metric here and there will not be one: this must stay a string-producing
  // module with no rendering dependency. Half the font size per character is
  // the usual approximation for a proportional sans, and it is deliberately
  // generous — a drawing with too much air costs nothing, a clipped dimension
  // costs the reader the number.
  if (annotations.length > 0) {
    // Provisional scale, from the geometry alone: the labels cannot influence
    // the scale they are measured in without going round in circles, and one
    // pass is close enough at these text sizes.
    const provisional = Math.max(extent.width(), 1e-6) / Math.max(widthPx, 1)
    const lineHeight = ANNOTATION_FONT_PX * provisional
    for (const annotation of annotations) {
      if (!annotation.text) continue
      const anchor = annotation.points[annotation.kind === 'dimension' ? 0 : annotation.points.length - 1]
      if (!anchor) continue
      const u = frame.toU(anchor[0], anchor[1], anchor[2])
      const v = frame.toV(anchor[0], anchor[1], anchor[2])
      // Reserve the way the label is ANCHORED, not symmetrically. A dimension
      // is centred on its midpoint and needs half the width each side; a ray or
      // a free label is left-anchored at its tip and needs the whole width to
      // the right. Reserving symmetrically for both under-reserves the right
      // side of every left-anchored label by half its width, which is precisely
      // how "45° Prismengrenze" came back off the edge as "45° Prismen".
      // 0.6 em per character, not 0.5: the usual rule of thumb is an average
      // over lowercase English, and these labels carry capitals, digits, units
      // and German compounds. The last character of "45° Prismengrenze" was
      // still shaving the edge at 0.5. Plus the offset the label itself is
      // drawn at, which is part of where it ends up and was not counted.
      const width = annotation.text.length * ANNOTATION_FONT_PX * 0.6 * provisional + ANNOTATION_FONT_PX * 0.5 * provisional
      const centred = annotation.kind === 'dimension'
      extent.add(u - (centred ? width / 2 : 0), v - lineHeight)
      extent.add(u + (centred ? width / 2 : width), v + lineHeight)
    }
  }

  if (extent.empty()) {
    return undecidable<ProjectedView>({
      from: drawable.map((d) => d.id).slice(0, 50),
      method: cited,
      provenance: 'computed',
      missing: {
        what: 'sichtbare Fläche in dieser Ansicht',
        remedy: 'Die gewählten Bauteile projizieren in dieser Blickrichtung auf nichts. Andere Ansicht oder andere Ebene wählen.',
        elements: drawable.map((d) => d.id).slice(0, 50),
      },
    })
  }

  // ── layout ────────────────────────────────────────────────────────────────
  const boxOnly = drawn.filter((d) => d.boxOnly).map((d) => d.id)
  const layout = layoutView(extent, widthPx, {
    scaleBar: options.showScaleBar !== false,
    captions: captionLines(view, outlineMode, boxOnly, graph),
  })

  const svg = emit(graph, drawn, annotations, frame, layout, {
    view,
    outlineMode,
    boxOnly,
    scaleBar: options.showScaleBar !== false,
  })

  // ── the answer ────────────────────────────────────────────────────────────
  const drawnIds = drawn.map((d) => d.id)
  const drawnSet = new Set(drawnIds)
  // Had geometry, projected to nothing visible — a flat plate seen edge-on, a
  // solid smaller than a pixel. In a SECTION that is the normal case (the plane
  // simply misses it) and says nothing; in a plan or an elevation it is a
  // request that produced no ink, which the caller has to hear about.
  const invisible = view === 'section' ? [] : drawable.filter((d) => !drawnSet.has(d.id)).map((d) => d.id)

  const caveats: string[] = []
  if (outlineMode) {
    caveats.push(
      `Diese Zeichnung zeigt pro Bauteil nur eine Umrisslinie, nicht die tatsächliche Fläche: ` +
        `die Dreiecke der ${drawn.length} Bauteile hätten die Größenschranke von ${Math.round(SVG_BUDGET_BYTES / 1000)} KB gesprengt. ` +
        `Zur Auswahl und Orientierung brauchbar, als Formaussage nicht.`
    )
  }
  if (boxOnly.length > 0) {
    caveats.push(
      `${boxOnly.length} Bauteil(e) sind als Hüllquader gezeichnet, weil für sie keine Dreiecke aufbewahrt wurden ` +
        `(${boxOnly.slice(0, 5).join(', ')}${boxOnly.length > 5 ? ' …' : ''}). Ein Quader an der Stelle einer Form ist eine ` +
        `Lüge in Bildform — diese Umrisse sind nicht die Bauteilform.`
    )
  }
  if (elementsWithoutGeometry.length > 0) {
    caveats.push(
      `${elementsWithoutGeometry.length} angefragte(s) Bauteil(e) fehlen in der Zeichnung, weil der Geometriedurchlauf ` +
        `nichts dazu geliefert hat (${elementsWithoutGeometry.slice(0, 5).join(', ')}${elementsWithoutGeometry.length > 5 ? ' …' : ''}).`
    )
  }
  if (invisible.length > 0) {
    caveats.push(
      `${invisible.length} Bauteil(e) mit Geometrie erscheinen in dieser Blickrichtung als Linie ohne Fläche und ` +
        `sind deshalb nicht gezeichnet (${invisible.slice(0, 5).join(', ')}${invisible.length > 5 ? ' …' : ''}).`
    )
  }
  if (drawnIds.length > 50) {
    caveats.push(`Die Herkunftsliste nennt 50 von ${drawnIds.length} gezeichneten Bauteilen.`)
  }
  if (geometry.stats.trianglesTruncated) {
    caveats.push(
      'Der Geometriedurchlauf hat die Dreiecksmenge gekappt; für die betroffenen Bauteile zeigt diese Zeichnung Hüllquader.'
    )
  }
  caveats.push('Eine Zeichnung ist eine Kontrolle, keine Quelle: Maße kommen aus den Messoperatoren, nicht aus diesem Bild.')

  return computed<ProjectedView>(
    {
      svg,
      viewBox: layout.viewBox,
      scale: layout.scale,
      elementsDrawn: drawn.length,
      elementsWithoutGeometry,
    },
    {
      unit: null,
      tolerance: null,
      from: drawnIds.slice(0, 50),
      method: cited,
      caveat: caveats.join(' '),
    }
  )
}

// ── the view frame ──────────────────────────────────────────────────────────

/**
 * A view is two world axes and a depth order, and nothing else.
 *
 * `toU`/`toV` are the drawing coordinates in metres (v already negated for
 * SVG's downward y). `depth` orders the painter's algorithm: bigger draws later.
 */
interface Frame {
  toU(x: number, y: number, z: number): number
  toV(x: number, y: number, z: number): number
  depth(x: number, y: number, z: number): number
  /** Present for `section`: the cut plane, `dot(p, normal) = offset`. */
  plane: { normal: Vec3; offset: number } | null
  /** The viewing/cut normal, for the method string. */
  normal: Vec3 | null
}

/**
 * The elements the default plane is derived from.
 *
 * `highlight` first, because "section through this window" is the call that
 * needs a default at all and the window is the thing it is about. Falling back
 * to `include` and then to everything keeps a bare `{ view: 'section' }`
 * meaningful instead of an error about a parameter the caller did not know to
 * pass.
 */
function pickFocus(
  drawable: Array<{ id: string; role: Role; geo: ElementGeometry }>,
  options: ProjectOptions
): ElementGeometry[] {
  const highlighted = drawable.filter((d) => d.role === 'highlight').map((d) => d.geo)
  if (highlighted.length > 0) return highlighted
  if (options.include && options.include.length > 0) {
    const included = drawable.filter((d) => d.role !== 'context').map((d) => d.geo)
    if (included.length > 0) return included
  }
  return drawable.map((d) => d.geo)
}

function buildFrame(view: ViewKind, options: ProjectOptions, focus: ElementGeometry[], geometry: GeometryIndex): Frame {
  if (view === 'plan') {
    return {
      toU: (x) => x,
      toV: (_x, y) => -y,
      depth: (_x, _y, z) => z,
      plane: null,
      normal: null,
    }
  }

  const normal = resolveNormal(view, options, focus, geometry)
  const offset = options.planeOffset ?? dot(centreOf(focus), normal)

  // A HORIZONTAL cut plane is the drawing architects actually mean by
  // "Grundriss": a section a metre above the floor, seen from above. It also has
  // to be handled explicitly, because the in-plane horizontal axis below is
  // undefined for a normal pointing at the sky — left as it was, the whole view
  // would collapse onto u = 0 and the SVG would be a vertical line.
  if (Math.abs(normal[2]) > 0.99) {
    return {
      toU: (x) => x,
      toV: (_x, y) => -y,
      depth: (_x, _y, z) => z,
      plane: view === 'section' ? { normal, offset } : null,
      normal,
    }
  }

  // The in-plane horizontal axis, right-handed with world Z up: with the viewer
  // standing along +normal looking back at the building, u runs to the right.
  const len = Math.hypot(normal[0], normal[1]) || 1
  const ux = -normal[1] / len
  const uy = normal[0] / len

  return {
    toU: (x, y) => x * ux + y * uy,
    toV: (_x, _y, z) => -z,
    depth: (x, y, z) => x * normal[0] + y * normal[1] + z * normal[2],
    plane: view === 'section' ? { normal, offset } : null,
    normal,
  }
}

/**
 * Which way the view looks — measured where possible, defaulted loudly where not.
 *
 * For an ELEVATION the default is the facade plane of the first focus element
 * that has one, flipped to point AWAY from the model's plan centre. The flip is
 * not cosmetic: `pass.ts` bins triangle normals and the kernel's meshes are
 * double-sided, so a wall's outward and inward faces land in two bins of nearly
 * equal area (27.4 m² against 25.7 m² on the sample house) and which one becomes
 * `facade` is close to a coin toss. Taking it unflipped would mirror the
 * elevation left-for-right on an arbitrary half of the walls in a model, which
 * is the kind of error nobody notices until they count windows.
 *
 * For a SECTION the default is perpendicular to that facade — i.e. a cut ACROSS
 * the wall, which is the section that shows a sill, a head and a roof overhang.
 * A cut parallel to the facade would show the wall's elevation again.
 */
function resolveNormal(view: ViewKind, options: ProjectOptions, focus: ElementGeometry[], geometry: GeometryIndex): Vec3 {
  if (options.planeNormal) {
    const n = options.planeNormal
    const len = Math.hypot(n[0], n[1], n[2])
    if (len > 1e-9) return [n[0] / len, n[1] / len, n[2] / len]
  }

  const withFacade = focus.find((g) => g.facade !== null)
  if (withFacade?.facade) {
    // The reference point is the FACADE plane's own centre, not the element's:
    // `azimuth()` in metric.ts decides outward the same way, and a drawing that
    // faced the opposite way from the compass bearing printed beside it would be
    // the two halves of one answer contradicting each other.
    const outward = orientOutward(withFacade.facade.normal, withFacade.facade.point, geometry.planCentre)
    if (view === 'elevation') return outward
    // Across the facade: horizontal, perpendicular to it.
    const len = Math.hypot(outward[0], outward[1]) || 1
    return [-outward[1] / len, outward[0] / len, 0]
  }

  // No facade anywhere in the focus — take the view that shows the widest side,
  // and say nothing about which side of the building it is.
  const box = boxOf(focus)
  const wide = box.max[0] - box.min[0] >= box.max[1] - box.min[1]
  if (view === 'elevation') return wide ? [0, -1, 0] : [1, 0, 0]
  return wide ? [1, 0, 0] : [0, 1, 0]
}

/**
 * Flip a facade normal so it points away from the model's plan centre.
 *
 * Right for every facade of a convex-ish building and wrong for the inner face
 * of a courtyard wing — the same rule, and the same limitation, that
 * `azimuth()` states in metric.ts. On a drawing the cost of getting it wrong is
 * a mirrored elevation rather than a wrong bearing.
 */
function orientOutward(normal: Vec3, from: Vec3, planCentre: [number, number] | null): Vec3 {
  if (!planCentre) return normal
  const away = (from[0] - planCentre[0]) * normal[0] + (from[1] - planCentre[1]) * normal[1]
  return away >= 0 ? normal : [-normal[0], -normal[1], -normal[2]]
}

// ── geometry → drawing primitives ───────────────────────────────────────────

interface DrawnElement {
  id: string
  role: Role
  depth: number
  /** Closed rings, flat `[u, v, u, v, …]`. */
  polys: number[][]
  /** True for elements produced by a section cut — they carry poché. */
  cut?: boolean
  /**
   * True for the faint layer drawn BEHIND a section's cut.
   *
   * An element both cut by the plane and extending past it is drawn twice, and
   * the two drawings mean different things: one is its cut profile, the other
   * its silhouette beyond. Both carry the element's `data-id`, so without a
   * second marker a consumer asking "where is this window in the drawing"
   * silently gets whichever came first — which is the background, and is the
   * wrong shape. `data-layer="beyond"` is how they are told apart.
   */
  beyond?: boolean
  /**
   * Silhouette edges of a filled projection: the edges belonging to exactly ONE
   * projected triangle.
   *
   * Filled views used to stroke every triangle, so the tessellation showed
   * through — a wall in elevation came out as a cat's cradle of diagonals and a
   * room in plan as a rectangle with an X through it. Nothing about the
   * building; entirely about how the kernel happened to triangulate it. Filling
   * without a stroke and outlining only the edges that bound the shape draws
   * the element instead of its mesh, and keeps the holes (a window opening's
   * edges are shared by no second triangle either).
   */
  outline?: number[][]
  /** Open polylines, flat `[u, v, u, v, …]` — sections only. */
  lines: number[][]
  /** True when the shape shown is the bounding box, not the element. */
  boxOnly: boolean
}

/**
 * Filled projection, one polygon per triangle — or `null` when it would not fit.
 *
 * Returning `null` rather than a truncated set is deliberate: half a house drawn
 * in full detail and half of it missing is a picture that reads as a finding
 * about the building.
 */
function fillElements(
  drawable: Array<{ id: string; role: Role; geo: ElementGeometry }>,
  frame: Frame,
  extent: Extent,
  widthPx: number,
  budget: number
): DrawnElement[] | null {
  // Pixel-area culling needs a scale, and the scale needs the extent, which is
  // not known until everything is projected. One cheap pass over the bounding
  // boxes gives a scale good enough for a threshold that only ever removes
  // slivers.
  const scale = provisionalScale(drawable, frame, widthPx)
  const minArea = MIN_TRIANGLE_PX2 / (scale * scale)

  const out: DrawnElement[] = []
  let total = 0

  for (const { id, role, geo } of drawable) {
    const element: DrawnElement = {
      id,
      role,
      depth: frame.depth(geo.centroid[0], geo.centroid[1], geo.centroid[2]),
      polys: [],
      lines: [],
      boxOnly: geo.triangles === null,
    }

    if (geo.triangles) {
      const t = geo.triangles
      const ordered: Array<{ ring: number[]; depth: number; front: boolean }> = []
      for (let i = 0; i < t.length; i += 9) {
        const u1 = frame.toU(t[i]!, t[i + 1]!, t[i + 2]!)
        const v1 = frame.toV(t[i]!, t[i + 1]!, t[i + 2]!)
        const u2 = frame.toU(t[i + 3]!, t[i + 4]!, t[i + 5]!)
        const v2 = frame.toV(t[i + 3]!, t[i + 4]!, t[i + 5]!)
        const u3 = frame.toU(t[i + 6]!, t[i + 7]!, t[i + 8]!)
        const v3 = frame.toV(t[i + 6]!, t[i + 7]!, t[i + 8]!)
        const signed = ((u2 - u1) * (v3 - v1) - (u3 - u1) * (v2 - v1)) / 2
        const area = Math.abs(signed)
        if (area < minArea) continue
        if (++total > budget) return null
        // Wound consistently, so the non-zero fill below UNIONS the triangles
        // instead of cancelling them. Under `evenodd` a closed solid's front
        // and back faces overlap exactly and annihilate — the fill came out
        // empty and only the per-triangle strokes made the element visible,
        // which is why removing those strokes appeared to delete the wall.
        // Winding out of the kernel is unreliable, so it is imposed here rather
        // than trusted.
        ordered.push({
          front: signed > 0,
          ring: signed < 0 ? [u1, v1, u3, v3, u2, v2] : [u1, v1, u2, v2, u3, v3],
          depth: Math.max(
            frame.depth(t[i]!, t[i + 1]!, t[i + 2]!),
            frame.depth(t[i + 3]!, t[i + 4]!, t[i + 5]!),
            frame.depth(t[i + 6]!, t[i + 7]!, t[i + 8]!)
          ),
        })
      }
      // Which edges bound the projected shape, given what can actually be
      // trusted about this mesh.
      //
      // Two rules were tried and both are wrong here, for reasons worth keeping:
      //
      //   - **Parity** ("an edge shared by two triangles is interior") fails
      //     under projection. A closed solid projects its front and back faces
      //     onto the same area, so every edge pairs up and cancels — applying
      //     it erased a wall entirely and left three lines where a window was.
      //   - **Facing** (the classic silhouette test: an edge between a
      //     front-facing and a back-facing triangle) needs reliable winding, and
      //     `pass.ts` states in its own contract that this kernel's winding is
      //     unreliable because its meshes are double-sided by design. It left
      //     long diagonals across the wall, because which of a face's two
      //     triangles counts as "front" is a coin toss.
      //
      // What is left that is TRUE: an edge used exactly once belongs to an open
      // boundary. For a closed solid that yields no outline at all, and the
      // fill alone defines the shape — which is correct, and is why the fill is
      // no longer stroked per triangle. A crisp outline for closed solids needs
      // a real union of the projected polygons; that is a polygon-clipping
      // problem and deliberately not solved here rather than approximated with
      // a rule that is wrong in ways a reader cannot see.
      //
      // Keys are quantised to a millimetre so two triangles meeting at a shared
      // vertex agree despite float error — finer than any feature of a
      // building, coarser than the noise.
      const edges = new Map<string, { seg: [number, number, number, number]; pos: boolean; neg: boolean; count: number }>()
      for (const { ring, front } of ordered) {
        for (let e = 0; e < 3; e++) {
          const ax = ring[e * 2]!
          const ay = ring[e * 2 + 1]!
          const bx = ring[((e + 1) % 3) * 2]!
          const by = ring[((e + 1) % 3) * 2 + 1]!
          const ka = `${Math.round(ax * 1000)},${Math.round(ay * 1000)}`
          const kb = `${Math.round(bx * 1000)},${Math.round(by * 1000)}`
          const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
          const found = edges.get(key)
          if (found) {
            found.count++
            if (front) found.pos = true
            else found.neg = true
          } else {
            edges.set(key, { seg: [ax, ay, bx, by], pos: front, neg: !front, count: 1 })
          }
        }
      }
      element.outline = [...edges.values()]
        .filter((e) => e.count === 1)
        .map((e) => [e.seg[0], e.seg[1], e.seg[2], e.seg[3]])

      // Within one element, nearest to the viewer draws last. Between elements
      // the same is done by `depth` at emit time.
      ordered.sort((a, b) => a.depth - b.depth)
      for (const o of ordered) element.polys.push(o.ring)
    } else {
      element.polys.push(hull(projectBox(geo.box, frame)))
    }

    for (const ring of element.polys) for (let k = 0; k < ring.length; k += 2) extent.add(ring[k]!, ring[k + 1]!)
    if (element.polys.length > 0) out.push(element)
  }

  return out
}

/** One convex outline per element — the degraded mode, and the box-only mode. */
function outlineElements(
  drawable: Array<{ id: string; role: Role; geo: ElementGeometry }>,
  frame: Frame,
  extent: Extent
): DrawnElement[] {
  const out: DrawnElement[] = []
  for (const { id, role, geo } of drawable) {
    const points: number[] = []
    if (geo.triangles) {
      const t = geo.triangles
      for (let i = 0; i < t.length; i += 3) {
        points.push(frame.toU(t[i]!, t[i + 1]!, t[i + 2]!), frame.toV(t[i]!, t[i + 1]!, t[i + 2]!))
      }
    } else {
      points.push(...projectBox(geo.box, frame))
    }
    const ring = hull(points)
    if (ring.length < 6) continue
    for (let k = 0; k < ring.length; k += 2) extent.add(ring[k]!, ring[k + 1]!)
    out.push({
      id,
      role,
      depth: frame.depth(geo.centroid[0], geo.centroid[1], geo.centroid[2]),
      polys: [ring],
      lines: [],
      // A convex hull is not the element either, but the caveat for outline mode
      // already says the shapes are outlines; `boxOnly` stays reserved for the
      // stronger claim that we never had the shape at all.
      boxOnly: geo.triangles === null,
    })
  }
  return out
}

/**
 * The cut: triangles ∩ plane, chained into polylines.
 *
 * This is the view an architect actually reads, and it is the one that cannot be
 * faked from a bounding box — a room's real profile and a roof's overhang are
 * exactly what the box threw away. No poché hatch: a fill would have to assume
 * which side is solid, and on a mesh with unreliable winding (see `pass.ts`) that
 * assumption is a coin toss drawn as a fact.
 */
function sectionElements(
  drawable: Array<{ id: string; role: Role; geo: ElementGeometry }>,
  frame: Frame,
  sliceDepth: number,
  extent: Extent
): DrawnElement[] {
  const plane = frame.plane!
  const half = Math.max(sliceDepth, 0) / 2
  const out: DrawnElement[] = []

  for (const { id, role, geo } of drawable) {
    if (!boxMeetsPlane(geo.box, plane, half)) continue

    const segments: Array<[number, number, number, number]> = []

    if (geo.triangles) {
      const t = geo.triangles
      for (let i = 0; i < t.length; i += 9) {
        const d0 = pointDistance(t[i]!, t[i + 1]!, t[i + 2]!, plane)
        const d1 = pointDistance(t[i + 3]!, t[i + 4]!, t[i + 5]!, plane)
        const d2 = pointDistance(t[i + 6]!, t[i + 7]!, t[i + 8]!, plane)

        // A face lying IN the cut plane produces no crossing and would vanish —
        // exactly the case of a wall face modelled flush with the cut. Its
        // edges are the section there, so the slab thickness earns its keep.
        if (Math.abs(d0) <= half && Math.abs(d1) <= half && Math.abs(d2) <= half) {
          pushSegment(segments, frame, t[i]!, t[i + 1]!, t[i + 2]!, t[i + 3]!, t[i + 4]!, t[i + 5]!)
          pushSegment(segments, frame, t[i + 3]!, t[i + 4]!, t[i + 5]!, t[i + 6]!, t[i + 7]!, t[i + 8]!)
          pushSegment(segments, frame, t[i + 6]!, t[i + 7]!, t[i + 8]!, t[i]!, t[i + 1]!, t[i + 2]!)
          continue
        }

        const hits: Array<[number, number, number]> = []
        crossing(hits, t, i, 0, 3, d0, d1)
        crossing(hits, t, i, 3, 6, d1, d2)
        crossing(hits, t, i, 6, 0, d2, d0)
        if (hits.length < 2) continue
        const a = hits[0]!
        const b = hits[1]!
        pushSegment(segments, frame, a[0], a[1], a[2], b[0], b[1], b[2])
      }
    } else {
      // No triangles: the honest cut through a bounding box is the box's own
      // rectangle in the plane, and the caveat says that is what it is.
      const ring = hull(projectBox(geo.box, frame))
      if (ring.length >= 6) {
        for (let k = 0; k < ring.length; k += 2) {
          const n = (k + 2) % ring.length
          segments.push([ring[k]!, ring[k + 1]!, ring[n]!, ring[n + 1]!])
        }
      }
    }

    if (segments.length === 0) continue
    const chained = chain(segments)

    // A CLOSED loop is the outline of solid material the plane passed through,
    // and filling it is what makes a section a section rather than a wireframe
    // of fragments. The reason this used to draw lines only was that a greedy
    // walk cannot say which side of an OPEN profile is solid — true, and it
    // does not apply once the walk returns to where it started: a closed ring's
    // interior is the same region whichever way round you walk it.
    //
    // Rings are emitted together under `fill-rule: evenodd`, so a wall cut
    // through a window reads as a hole rather than as a second slab of
    // material sitting inside the first.
    const rings: number[][] = []
    const open: number[][] = []
    for (const line of chained) {
      const closed =
        line.length >= 8 &&
        Math.hypot(line[0]! - line[line.length - 2]!, line[1]! - line[line.length - 1]!) <= CHAIN_TOLERANCE * 2
      ;(closed ? rings : open).push(line)
    }

    for (const line of chained) for (let k = 0; k < line.length; k += 2) extent.add(line[k]!, line[k + 1]!)
    out.push({
      id,
      role,
      depth: frame.depth(geo.centroid[0], geo.centroid[1], geo.centroid[2]),
      polys: rings,
      lines: open,
      boxOnly: geo.triangles === null,
      cut: true,
    })
  }

  return out
}

function pushSegment(
  into: Array<[number, number, number, number]>,
  frame: Frame,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number
): void {
  const u1 = frame.toU(ax, ay, az)
  const v1 = frame.toV(ax, ay, az)
  const u2 = frame.toU(bx, by, bz)
  const v2 = frame.toV(bx, by, bz)
  if (Math.abs(u1 - u2) < 1e-9 && Math.abs(v1 - v2) < 1e-9) return
  into.push([u1, v1, u2, v2])
}

/** Where edge (i+a → i+b) crosses the plane, if it does. */
function crossing(
  hits: Array<[number, number, number]>,
  t: Float64Array,
  i: number,
  a: number,
  b: number,
  da: number,
  db: number
): void {
  if ((da > 0 && db > 0) || (da < 0 && db < 0)) return
  const span = da - db
  if (Math.abs(span) < 1e-12) return
  const s = da / span
  hits.push([
    t[i + a]! + (t[i + b]! - t[i + a]!) * s,
    t[i + a + 1]! + (t[i + b + 1]! - t[i + a + 1]!) * s,
    t[i + a + 2]! + (t[i + b + 2]! - t[i + a + 2]!) * s,
  ])
}

function pointDistance(x: number, y: number, z: number, plane: { normal: Vec3; offset: number }): number {
  return x * plane.normal[0] + y * plane.normal[1] + z * plane.normal[2] - plane.offset
}

function boxMeetsPlane(box: Box, plane: { normal: Vec3; offset: number }, half: number): boolean {
  let min = Infinity
  let max = -Infinity
  for (let c = 0; c < 8; c++) {
    const d = pointDistance(
      c & 1 ? box.max[0] : box.min[0],
      c & 2 ? box.max[1] : box.min[1],
      c & 4 ? box.max[2] : box.min[2],
      plane
    )
    if (d < min) min = d
    if (d > max) max = d
  }
  return min <= half && max >= -half
}

/**
 * Segments → polylines, joining ends that coincide.
 *
 * Greedy and single-pass. A section of a closed solid is a closed loop, and a
 * greedy walk finds it; where the mesh is not closed the walk simply stops,
 * which draws the open profile the mesh actually has rather than inventing a
 * join across the gap.
 */
function chain(segments: Array<[number, number, number, number]>): number[][] {
  const key = (u: number, v: number): string =>
    `${Math.round(u / CHAIN_TOLERANCE)}:${Math.round(v / CHAIN_TOLERANCE)}`

  const at = new Map<string, number[]>()
  segments.forEach((s, i) => {
    for (const k of [key(s[0], s[1]), key(s[2], s[3])]) {
      const list = at.get(k)
      if (list) list.push(i)
      else at.set(k, [i])
    }
  })

  const used = new Array<boolean>(segments.length).fill(false)
  const lines: number[][] = []

  const step = (u: number, v: number): [number, number] | null => {
    for (const i of at.get(key(u, v)) ?? []) {
      if (used[i]) continue
      const s = segments[i]!
      used[i] = true
      // Whichever end is nearer is the one we arrived at. Testing "does the
      // start match" against the tolerance instead would pick the wrong end for
      // a point that sits just inside the bucket but just outside the
      // tolerance, and the polyline would jump across the section.
      const startFirst = Math.hypot(s[0] - u, s[1] - v) <= Math.hypot(s[2] - u, s[3] - v)
      return startFirst ? [s[2], s[3]] : [s[0], s[1]]
    }
    return null
  }

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue
    used[i] = true
    const s = segments[i]!
    const forward: number[] = [s[0], s[1], s[2], s[3]]
    for (;;) {
      const next = step(forward[forward.length - 2]!, forward[forward.length - 1]!)
      if (!next) break
      forward.push(next[0], next[1])
      // A closed loop: stop rather than walk it twice.
      if (Math.abs(next[0] - forward[0]!) <= CHAIN_TOLERANCE && Math.abs(next[1] - forward[1]!) <= CHAIN_TOLERANCE) break
    }
    for (;;) {
      const prev = step(forward[0]!, forward[1]!)
      if (!prev) break
      forward.unshift(prev[0], prev[1])
    }
    lines.push(forward)
  }

  return lines
}

// ── little geometry ─────────────────────────────────────────────────────────

/**
 * Whether any part of an element lies BEYOND the cut plane — the half a section
 * looks into.
 *
 * Box-based on purpose: this only decides whether an element joins the
 * background layer, and an element straddling the plane belongs there too (its
 * far half is visible behind its own cut).
 */
function farSideOf(geo: ElementGeometry, plane: { normal: Vec3; offset: number }): boolean {
  let max = -Infinity
  for (let c = 0; c < 8; c++) {
    const x = c & 1 ? geo.box.max[0] : geo.box.min[0]
    const y = c & 2 ? geo.box.max[1] : geo.box.min[1]
    const z = c & 4 ? geo.box.max[2] : geo.box.min[2]
    const d = x * plane.normal[0] + y * plane.normal[1] + z * plane.normal[2] - plane.offset
    if (d > max) max = d
  }
  return max > 0
}

/** The eight box corners, projected — flat `[u, v, …]`. */
function projectBox(box: Box, frame: Frame): number[] {
  const points: number[] = []
  for (let c = 0; c < 8; c++) {
    const x = c & 1 ? box.max[0] : box.min[0]
    const y = c & 2 ? box.max[1] : box.min[1]
    const z = c & 4 ? box.max[2] : box.min[2]
    points.push(frame.toU(x, y, z), frame.toV(x, y, z))
  }
  return points
}

/** Monotone-chain convex hull over flat `[u, v, …]`, returning a closed ring. */
function hull(points: number[]): number[] {
  const n = points.length / 2
  if (n < 3) return points.slice()
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => points[a * 2]! - points[b * 2]! || points[a * 2 + 1]! - points[b * 2 + 1]!
  )
  const cross = (o: number, a: number, b: number): number =>
    (points[a * 2]! - points[o * 2]!) * (points[b * 2 + 1]! - points[o * 2 + 1]!) -
    (points[a * 2 + 1]! - points[o * 2 + 1]!) * (points[b * 2]! - points[o * 2]!)

  const build = (seq: number[]): number[] => {
    const stack: number[] = []
    for (const i of seq) {
      while (stack.length >= 2 && cross(stack[stack.length - 2]!, stack[stack.length - 1]!, i) <= 0) stack.pop()
      stack.push(i)
    }
    stack.pop()
    return stack
  }

  const ring = [...build(order), ...build([...order].reverse())]
  const out: number[] = []
  for (const i of ring) out.push(points[i * 2]!, points[i * 2 + 1]!)
  return out.length >= 6 ? out : points.slice()
}

function boxOf(elements: ElementGeometry[]): Box {
  const box: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
  for (const e of elements) {
    for (let k = 0; k < 3; k++) {
      box.min[k] = Math.min(box.min[k]!, e.box.min[k]!)
      box.max[k] = Math.max(box.max[k]!, e.box.max[k]!)
    }
  }
  return box
}

function centreOf(elements: ElementGeometry[]): Vec3 {
  const box = boxOf(elements)
  return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/** Pixels per metre, from bounding boxes alone — good enough to size a sliver. */
function provisionalScale(drawable: Array<{ geo: ElementGeometry }>, frame: Frame, widthPx: number): number {
  const extent = new Extent()
  for (const { geo } of drawable) {
    const points = projectBox(geo.box, frame)
    for (let k = 0; k < points.length; k += 2) extent.add(points[k]!, points[k + 1]!)
  }
  const width = Math.max(extent.width(), 0.001)
  return widthPx / width
}

class Extent {
  minU = Infinity
  minV = Infinity
  maxU = -Infinity
  maxV = -Infinity

  add(u: number, v: number): void {
    if (u < this.minU) this.minU = u
    if (v < this.minV) this.minV = v
    if (u > this.maxU) this.maxU = u
    if (v > this.maxV) this.maxV = v
  }

  reset(): void {
    this.minU = this.minV = Infinity
    this.maxU = this.maxV = -Infinity
  }

  empty(): boolean {
    return !Number.isFinite(this.minU)
  }

  width(): number {
    return this.maxU - this.minU
  }

  height(): number {
    return this.maxV - this.minV
  }
}

// ── layout ──────────────────────────────────────────────────────────────────

interface Layout {
  viewBox: [number, number, number, number]
  widthPx: number
  heightPx: number
  /** Metres per pixel — every stroke width and font size is stated in pixels and converted here. */
  unitsPerPx: number
  scale: string
  scaleBarMetres: number
  captions: string[]
  fontSize: number
}

/**
 * Where the drawing sits, and how big a metre is.
 *
 * The footer is added to the viewBox HEIGHT only, never to its width, so the
 * horizontal extent a caller reads back out of `viewBox` is still the model's
 * own — a scale bar must not silently widen the reported bounds.
 */
function layoutView(
  extent: Extent,
  widthPx: number,
  opts: { scaleBar: boolean; captions: string[] }
): Layout {
  const contentW = Math.max(extent.width(), 0.01)
  const contentH = Math.max(extent.height(), 0.01)
  const pad = Math.max(0.025 * Math.max(contentW, contentH), 0.1)

  const viewW = contentW + 2 * pad
  const unitsPerPx = viewW / widthPx
  const fontSize = ANNOTATION_FONT_PX * unitsPerPx

  const footer =
    (opts.scaleBar ? fontSize * 2.8 : fontSize * 0.4) + opts.captions.length * fontSize * 1.25
  const viewH = contentH + 2 * pad + footer

  const scaleBarMetres = niceBarLength(contentW)
  const pxPerMetre = widthPx / viewW
  // 96 dpi is the CSS reference pixel, which is what an SVG at `width="900"`
  // means on screen and in a browser's print path. Stated rather than implied,
  // because a ratio without a device is not a scale.
  const ratio = 1000 / (pxPerMetre * (25.4 / 96))

  return {
    viewBox: [extent.minU - pad, extent.minV - pad, viewW, viewH],
    widthPx,
    heightPx: Math.max(1, Math.round((widthPx * viewH) / viewW)),
    unitsPerPx,
    scale: `1:${Math.round(ratio)} (1 m = ${pxPerMetre.toFixed(0)} px, 96 dpi)`,
    scaleBarMetres,
    captions: opts.captions,
    fontSize,
  }
}

/** A scale bar is only readable at a round length: 1, 2, 5, 10 … metres. */
function niceBarLength(contentWidth: number): number {
  const target = contentWidth * 0.2
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500]
  let best = steps[0]!
  for (const s of steps) if (Math.abs(s - target) < Math.abs(best - target)) best = s
  return best
}

function captionLines(view: ViewKind, outlineMode: boolean, boxOnly: string[], graph: BuildingGraph): string[] {
  const lines: string[] = []
  if (outlineMode) lines.push('Nur Umrisse je Bauteil — Dreiecksmenge zu groß für diese Zeichnung.')
  if (boxOnly.length > 0) {
    lines.push(
      `${boxOnly.length} Bauteil(e) als Hüllquader gezeichnet (keine Dreiecke aufbewahrt) — nicht die Bauteilform.`
    )
  }
  // Only on a plan: that is the view where a reader expects an orientation and
  // would otherwise assume the drawing is north-up. On a section the absence of
  // an arrow says nothing, and the line would be noise.
  if (view === 'plan' && graph.trueNorth === null) lines.push('Ohne Nordangabe im Modell — kein Nordpfeil.')
  return lines
}

// ── emission ────────────────────────────────────────────────────────────────

function emit(
  graph: BuildingGraph,
  drawn: DrawnElement[],
  annotations: Annotation[],
  frame: Frame,
  layout: Layout,
  opts: { view: ViewKind; outlineMode: boolean; boxOnly: string[]; scaleBar: boolean }
): string {
  const parts: string[] = []
  const [vx, vy, vw, vh] = layout.viewBox

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(vx)} ${n(vy)} ${n(vw)} ${n(vh)}" ` +
      `width="${layout.widthPx}" height="${layout.heightPx}" font-family="sans-serif" ` +
      `stroke-linejoin="round" stroke-linecap="round">`
  )
  parts.push(`<title>${escape_(titleOf(opts.view, drawn, graph))}</title>`)

  // Painter's algorithm, but roles outrank depth: a highlighted window buried
  // under the roof it sits below would defeat the only reason it was requested.
  const order: Role[] = ['context', 'normal', 'highlight']
  for (const role of order) {
    const group = drawn.filter((d) => d.role === role).sort((a, b) => a.depth - b.depth)
    for (const element of group) parts.push(pathFor(element, layout))
  }

  for (const annotation of annotations) parts.push(...annotationSvg(annotation, frame, layout))

  if (opts.scaleBar) parts.push(...scaleBarSvg(layout))
  // A north arrow belongs to a plan and to no other view, and only to a file
  // that declares north. See {@link northArrowSvg}.
  if (opts.view === 'plan' && graph.trueNorth !== null) parts.push(...northArrowSvg(graph.trueNorth, layout))
  parts.push(...captionSvg(layout))

  parts.push('</svg>')
  return parts.join('')
}

/**
 * The drawing's own title — what it is, of what, and what is picked out.
 *
 * The highlighted element is named with {@link label}, the same German string
 * the prose answer uses for it, so a reader comparing the sentence with the
 * picture is comparing identical names rather than a name against a GlobalId.
 */
function titleOf(view: ViewKind, drawn: DrawnElement[], graph: BuildingGraph): string {
  const kind = view === 'plan' ? 'Grundriss' : view === 'section' ? 'Schnitt' : 'Ansicht'
  const highlighted = drawn.filter((d) => d.role === 'highlight')
  const focus =
    highlighted.length === 1
      ? ` — ${label(node(graph, highlighted[0]!.id))} hervorgehoben`
      : highlighted.length > 1
        ? ` — ${highlighted.length} Bauteile hervorgehoben`
        : ''
  const source = graph.sourceName ? ` (${graph.sourceName})` : ''
  return `${kind}, ${drawn.length} Bauteil(e)${focus}${source}`
}

function pathFor(element: DrawnElement, layout: Layout): string {
  const style = ROLE_STYLE[element.role]
  const out: string[] = []
  const id = escape_(element.id)

  // Cut material is drawn heavy and filled; everything else keeps the lighter
  // weight. That hierarchy is not decoration — it is how a section is read. A
  // drawing where the cut wall and a projected handrail share one line weight
  // makes the reader work out which is which, and they will sometimes get it
  // wrong.
  const cutWeight = element.cut ? 2.2 : 1
  const fillOpacity = element.cut ? Math.min(0.55, style.fillOpacity + 0.25) : style.fillOpacity

  const rings = element.polys.map((ring) => ringPath(ring, true)).join('')
  if (rings) {
    // A filled projection is stroked ONLY where it has a silhouette. Stroking
    // every triangle drew the tessellation instead of the element; leaving the
    // fill unstroked and outlining the boundary separately draws the shape the
    // mesh represents. A section keeps its stroke on the rings themselves,
    // because there the ring IS the cut line and there is no interior edge to
    // suppress.
    const strokeRings = element.cut || !element.outline
    // `evenodd` is right for a SECTION, where a ring inside a ring is a hole in
    // the cut face. It is wrong for a filled projection, where overlapping
    // triangles are the same material seen twice and must union.
    const fillRule = element.cut ? 'evenodd' : 'nonzero'
    out.push(
      `<path d="${rings}" fill="${style.colour}" fill-opacity="${fillOpacity}" fill-rule="${fillRule}" ` +
        (strokeRings
          ? `stroke="${style.colour}" stroke-width="${n(style.strokePx * cutWeight * layout.unitsPerPx)}" ` +
            `stroke-opacity="${Math.max(style.strokeOpacity, element.cut ? 0.95 : style.strokeOpacity)}" `
          : 'stroke="none" ') +
        (element.beyond ? 'data-layer="beyond" ' : '') +
        `data-id="${id}"/>`
    )
  }

  if (element.outline && element.outline.length > 0 && !element.cut) {
    const d = element.outline.map((e) => `M${pt(e[0]!, e[1]!)}L${pt(e[2]!, e[3]!)}`).join('')
    out.push(
      `<path d="${d}" fill="none" stroke="${style.colour}" ` +
        `stroke-width="${n(style.strokePx * 1.6 * layout.unitsPerPx)}" ` +
        // The role's own opacity, not a floor. A floor of 0.75 here drew a
        // context element's outline as strongly as the subject's and flattened
        // the whole hierarchy — the thing `context` exists to avoid.
        `stroke-opacity="${style.strokeOpacity}"/>`
    )
  }

  // Open profiles keep the old treatment, and for the old reason: where the
  // mesh did not close, nothing here knows which side is solid, so it stays a
  // line rather than becoming a guess with a fill behind it.
  const lines = element.lines.map((line) => ringPath(line, false)).join('')
  if (lines) {
    out.push(
      `<path d="${lines}" fill="none" stroke="${style.colour}" ` +
        `stroke-width="${n(Math.max(style.strokePx, 1.1) * layout.unitsPerPx)}" ` +
        `stroke-opacity="${Math.max(style.strokeOpacity, 0.9)}" data-id="${id}"/>`
    )
  }

  return out.join('')
}

function ringPath(flat: number[], close: boolean): string {
  if (flat.length < 4) return ''
  let d = `M${pt(flat[0]!, flat[1]!)}`
  for (let k = 2; k < flat.length; k += 2) d += `L${pt(flat[k]!, flat[k + 1]!)}`
  return close ? `${d}Z` : d
}

// ── annotations ─────────────────────────────────────────────────────────────

/**
 * Annotations draw last and in full opacity — they are the claim the picture is
 * being used to make, and a claim behind a roof is not a claim.
 */
function annotationSvg(annotation: Annotation, frame: Frame, layout: Layout): string[] {
  const colour =
    annotation.emphasis === 'warn' ? INK.warn : annotation.emphasis === 'good' ? INK.good : INK.normal
  const stroke = n(1.2 * layout.unitsPerPx)
  const flat: number[] = []
  for (const p of annotation.points) flat.push(frame.toU(p[0], p[1], p[2]), frame.toV(p[0], p[1], p[2]))
  if (flat.length < 2) return []

  const out: string[] = []
  const text = annotation.text ? escape_(annotation.text) : null

  if (annotation.kind === 'label') {
    if (text) out.push(textSvg(flat[0]!, flat[1]!, text, colour, layout, 'start'))
    return out
  }

  if (annotation.kind === 'ray') {
    const dash = n(6 * layout.unitsPerPx)
    out.push(
      `<path d="${ringPath(flat, false)}" fill="none" stroke="${colour}" stroke-width="${stroke}" ` +
        `stroke-dasharray="${dash} ${dash}"/>`
    )
    // Set off the tip so the label does not sit on the ray it names.
    if (text)
      out.push(
        textSvg(
          flat[flat.length - 2]! + layout.fontSize * 0.4,
          flat[flat.length - 1]! - layout.fontSize * 0.25,
          text,
          colour,
          layout,
          'start'
        )
      )
    return out
  }

  if (annotation.kind === 'outline') {
    out.push(`<path d="${ringPath(flat, true)}" fill="none" stroke="${colour}" stroke-width="${stroke}"/>`)
    if (text) out.push(textSvg(flat[0]!, flat[1]!, text, colour, layout, 'start'))
    return out
  }

  // dimension: the line, a tick at each end, and the value beside the midpoint.
  out.push(`<path d="${ringPath(flat, false)}" fill="none" stroke="${colour}" stroke-width="${stroke}"/>`)
  const u1 = flat[0]!
  const v1 = flat[1]!
  const u2 = flat[flat.length - 2]!
  const v2 = flat[flat.length - 1]!
  const len = Math.hypot(u2 - u1, v2 - v1) || 1
  const px = -((v2 - v1) / len)
  const py = (u2 - u1) / len
  const tick = 5 * layout.unitsPerPx
  for (const [tu, tv] of [
    [u1, v1],
    [u2, v2],
  ] as Array<[number, number]>) {
    out.push(
      `<path d="M${pt(tu - px * tick, tv - py * tick)}L${pt(tu + px * tick, tv + py * tick)}" ` +
        `fill="none" stroke="${colour}" stroke-width="${stroke}"/>`
    )
  }
  if (text) {
    // Offset off the line rather than haloed with a white outline: a halo is a
    // background assumption, and this drawing does not get to make one.
    //
    // The offset used to be half a font size along the perpendicular, applied
    // the same way whatever the line's direction, and both cases came out
    // struck through. SVG's `y` is the BASELINE, so half a font size below a
    // horizontal line puts the glyph bodies across it; and a vertical dimension
    // with `text-anchor="middle"` centres the label on the line no matter what
    // the perpendicular offset is. On the first sections this produced, both
    // "Überstand 0.65 m" and "Fenster 1,21 m" read as struck out, which is
    // exactly how a drawing marks a dimension as WRONG.
    //
    // So the two orientations are handled as a draughtsman handles them: above
    // the line when it runs horizontally, beside it when it runs vertically.
    const horizontal = Math.abs(v2 - v1) <= Math.abs(u2 - u1)
    if (horizontal) {
      // A full font size clears the descenders; `min` puts it on the upper side
      // in SVG's downward-growing y, which is where a dimension value belongs.
      const v = Math.min(v1, v2) - layout.fontSize * 0.45
      out.push(textSvg((u1 + u2) / 2, v, text, colour, layout, 'middle'))
    } else {
      // 0.35 em down from the midpoint centres the x-height on the line rather
      // than hanging the whole glyph below it.
      const u = Math.max(u1, u2) + layout.fontSize * 0.45
      out.push(textSvg(u, (v1 + v2) / 2 + layout.fontSize * 0.35, text, colour, layout, 'start'))
    }
  }
  return out
}

function textSvg(
  u: number,
  v: number,
  escaped: string,
  colour: string,
  layout: Layout,
  anchor: 'start' | 'middle'
): string {
  return (
    `<text x="${n(u)}" y="${n(v)}" font-size="${n(layout.fontSize)}" fill="${colour}" ` +
    `text-anchor="${anchor}">${escaped}</text>`
  )
}

// ── furniture of the drawing ────────────────────────────────────────────────

function scaleBarSvg(layout: Layout): string[] {
  const [vx, vy, , vh] = layout.viewBox
  const x0 = vx + layout.fontSize * 0.5
  const y = vy + vh - layout.fontSize * (1.2 + layout.captions.length * 1.25)
  const total = layout.scaleBarMetres
  const x1 = x0 + total
  const stroke = n(1.2 * layout.unitsPerPx)
  const height = layout.fontSize * 0.42

  // A bare line with "2 m" under one end does not say what it means — it reads
  // as a label on something, and the first person shown one asked what the 2 m
  // referred to. A chequered bar is the convention every map and drawing uses
  // precisely because it needs no caption: alternating segments make it obvious
  // that the LENGTH is the quantity, "0" fixes where the measurement starts,
  // and the ratio spells out the same fact in the other notation.
  const segments = 4
  const step = total / segments
  const bars: string[] = []
  for (let i = 0; i < segments; i++) {
    const from = x0 + i * step
    bars.push(
      `<path d="M${pt(from, y - height)}L${pt(from + step, y - height)}L${pt(from + step, y)}L${pt(from, y)}Z" ` +
        `fill="${i % 2 === 0 ? INK.furniture : 'none'}" fill-opacity="${i % 2 === 0 ? 0.75 : 0}" ` +
        `stroke="${INK.furniture}" stroke-width="${stroke}"/>`
    )
  }

  return [
    ...bars,
    textSvg(x0, y + layout.fontSize * 1.05, '0', INK.furniture, layout, 'middle'),
    textSvg(x1, y + layout.fontSize * 1.05, `${fmtMetres(total)} m`, INK.furniture, layout, 'middle'),
    textSvg(x1 + layout.fontSize * 0.9, y - height * 0.1, layout.scale.replace(/\s*\(.*\)$/, ''), INK.furniture, layout, 'start'),
  ]
}

/**
 * North, and only when the file says where north is.
 *
 * `graph.trueNorth === null` means the file does not declare it. An arrow drawn
 * anyway is a fabricated fact — and the one fact on the drawing a reader is most
 * likely to take at face value, because a north arrow is never wrong on paper.
 */
function northArrowSvg(trueNorth: number, layout: Layout): string[] {
  const [vx, vy, vw] = layout.viewBox
  const size = Math.max(layout.fontSize * 1.8, 0.3)
  const cx = vx + vw - size * 1.4
  const cy = vy + size * 1.6
  // trueNorth is measured from +Y in the file's frame; drawing v is -y.
  const dx = Math.sin(trueNorth)
  const dy = -Math.cos(trueNorth)
  const tipX = cx + dx * size
  const tipY = cy + dy * size
  const tailX = cx - dx * size * 0.6
  const tailY = cy - dy * size * 0.6
  const wingX = -dy * size * 0.22
  const wingY = dx * size * 0.22
  const stroke = n(1.2 * layout.unitsPerPx)
  return [
    `<path d="M${pt(tailX, tailY)}L${pt(tipX, tipY)}" fill="none" stroke="${INK.furniture}" stroke-width="${stroke}"/>`,
    `<path d="M${pt(tipX, tipY)}L${pt(tipX - dx * size * 0.3 + wingX, tipY - dy * size * 0.3 + wingY)}` +
      `L${pt(tipX - dx * size * 0.3 - wingX, tipY - dy * size * 0.3 - wingY)}Z" fill="${INK.furniture}" ` +
      `fill-opacity="0.8" stroke="${INK.furniture}" stroke-width="${stroke}"/>`,
    textSvg(tipX + dx * layout.fontSize * 0.9, tipY + dy * layout.fontSize * 0.9 + layout.fontSize * 0.35, 'N', INK.furniture, layout, 'middle'),
  ]
}

/**
 * The qualifications, ON the drawing.
 *
 * The same sentences go into `Answer.caveat`, but a caveat travels with the
 * answer and an SVG travels alone — pasted into a mail, dropped into a chat. A
 * box drawn as if it were the shape has to carry its own disclaimer, or the
 * first time the picture is separated from the answer it becomes a claim nobody
 * qualified.
 */
function captionSvg(layout: Layout): string[] {
  const [vx, vy, , vh] = layout.viewBox
  return layout.captions.map((caption, i) =>
    textSvg(
      vx + layout.fontSize * 0.5,
      vy + vh - layout.fontSize * (0.4 + (layout.captions.length - 1 - i) * 1.25),
      escape_(caption),
      INK.furniture,
      layout,
      'start'
    )
  )
}

// ── strings ─────────────────────────────────────────────────────────────────

/**
 * Two decimals — a centimetre at drawing scale, half a pixel at 50 px/m.
 *
 * Rounding happens ONLY here, at emission. Every intersection, chain and hull
 * above runs at full precision, because a section chained on rounded endpoints
 * would break wherever two faces met at a coordinate that rounded apart.
 */
function n(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

/** A path point, dropping the separator when the sign already provides one. */
function pt(u: number, v: number): string {
  const sv = n(v)
  return sv.startsWith('-') ? `${n(u)}${sv}` : `${n(u)} ${sv}`
}

function escape_(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function fmtMetres(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value).replace('.', ',')
}

function clamp(value: number, low: number, high: number): number {
  return Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : low
}

/**
 * The call, as a reviewer would read it back.
 *
 * §8.3 asks every derivation to be citable; a drawing is a derivation whose
 * inputs are a view, a plane and a set of elements, so all three appear here
 * even when they were defaulted — a reader must be able to tell a plane they
 * chose from a plane we picked for them.
 */
function describeCall(options: ProjectOptions, widthPx: number, frame?: Frame | null): string {
  const bits: string[] = [options.view]
  bits.push(options.include ? `include=${options.include.length}` : 'include=alle mit Geometrie')
  if (options.context?.length) bits.push(`context=${options.context.length}`)
  if (options.highlight?.length) bits.push(`highlight=${options.highlight.length}`)

  // A defaulted plane is marked as one. Reading back `planeNormal=(0, 1, 0)`
  // without knowing whether it was asked for or picked would make a reviewer
  // check a decision nobody made — or trust one they never saw.
  if (options.planeNormal) {
    bits.push(`planeNormal=(${options.planeNormal.map((v) => v.toFixed(2)).join(', ')})`)
  } else if (frame?.normal) {
    bits.push(`planeNormal=(${frame.normal.map((v) => v.toFixed(2)).join(', ')}) [abgeleitet]`)
  }
  if (options.planeOffset !== undefined) bits.push(`planeOffset=${options.planeOffset.toFixed(3)}`)
  else if (frame?.plane) bits.push(`planeOffset=${frame.plane.offset.toFixed(3)} [abgeleitet]`)

  if (options.view === 'section') bits.push(`sliceDepth=${(options.sliceDepth ?? DEFAULT_SLICE_DEPTH).toFixed(3)}`)
  if (options.annotations?.length) bits.push(`annotations=${options.annotations.length}`)
  bits.push(`widthPx=${widthPx}`)
  return `project(${bits.join(', ')})`
}
