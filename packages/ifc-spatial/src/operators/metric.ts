/**
 * The metric operators: numbers off the geometry, each with its error attached.
 *
 * ## Why these are separate from topology
 *
 * `topology.ts` answers arrangement questions by index lookup — no tolerance,
 * nothing to tune, and an answer that is either in the file or is not. Every
 * operator here instead reads coordinates that came out of a tessellator, so
 * every one of them is only true within a band, and the band has to travel with
 * the number. A metric operator that returned a bare `number` would be handing a
 * language model a value it will print to two decimals in a document a human
 * signs, with no way to know that the third decimal is noise.
 *
 * ## Three outcomes, the same three as topology
 *
 *   - **a number** — measured, with `tolerance` in the same unit.
 *   - **undecidable** — most often because the element has no geometric
 *     representation in this file. That is a finding about the EXPORT (an
 *     `IfcDoorLiningProperties` never had one; a wall that lost its body did),
 *     and it is emphatically not an exception.
 *   - **exception** — the GlobalId names nothing in this model. Same reasoning
 *     as `topology.ts`: `UnknownElementError` is reserved for "we could not look
 *     at all", so that a hallucinated id can never be reported back as "das
 *     Modell sagt dazu nichts".
 *
 * ## Where the tolerances come from
 *
 * Two sources of error, and neither is the floating-point arithmetic:
 *
 *  1. **Tessellation.** Curved and swept surfaces arrive as flat triangles, so a
 *     coordinate read off the mesh sits inside the true surface by up to the
 *     kernel's chord height. For building-scale geometry at the deflection these
 *     kernels use, that is a few millimetres.
 *  2. **Modelling.** Wall cores, finishes and joins are authored to the nearest
 *     few millimetres by people, not to the nearest micron.
 *
 * Together: **one coordinate is good to about 5 mm**. A DIMENSION is the
 * difference of two independently-measured coordinates and therefore carries
 * twice that — 10 mm — which is the figure this module reports for widths,
 * heights, gaps and spans. Areas are quadratic in the same error and are
 * reported at **1 %**, which for a room-sized surface is the same 5 mm on each
 * edge, expressed the way an area behaves.
 *
 * These are stated, not measured, and the doc comment on each operator says what
 * it assumed. Inventing more precision than that would be the exact failure this
 * library exists to prevent — but so would refusing to quantify at all, because
 * then the caller invents its own.
 *
 * ## Nothing here rounds
 *
 * Every value is returned at full precision. The renderer rounds. An operator
 * that rounded would destroy {@link triangulate}: two routes to a floor area
 * that agree to 0.4 % must be comparable at 0.4 %, and pre-rounding to two
 * decimals turns that comparison into noise.
 */

import { computed, declared, triangulate, undecidable, type Answer, type MissingFact } from '../envelope.js'
import { boxGap, boxesOverlap, type Box, type ElementGeometry, type GeometryIndex, type Vec3 } from '../geometry/pass.js'
import { label, node, type BuildingGraph, type GraphNode } from '../graph/types.js'
import { UnknownElementError } from './topology.js'
import { ray } from './constructive.js'

// ── the error model ─────────────────────────────────────────────────────────

/**
 * One coordinate off a tessellated solid, in metres.
 *
 * Covers the kernel's chord deviation on curved surfaces plus the millimetre
 * sloppiness of ordinary authoring. Not a measurement of this kernel — a stated
 * assumption, so that a caller who disagrees can see the number to disagree with.
 */
const COORDINATE_TOLERANCE = 0.005

/**
 * A linear dimension, in metres.
 *
 * `max - min` subtracts two independently-tessellated faces, so both errors are
 * in it. 10 mm rather than the √2·5 mm ≈ 7 mm of independent errors, because the
 * two faces of one extrusion are anything but independent — a systematically
 * fat mesh is fat on both sides.
 */
const DIMENSION_TOLERANCE = 2 * COORDINATE_TOLERANCE

/**
 * Areas, relative.
 *
 * 1 % of a 50 m² room is half a square metre, which is what 5 mm of edge error
 * over a ~30 m perimeter actually produces. Expressed relatively because the
 * error scales with the object, and an absolute area tolerance would be absurdly
 * loose for a window pane and absurdly tight for a floor plate.
 */
const AREA_RELATIVE_TOLERANCE = 0.01

/**
 * A compass bearing, in degrees.
 *
 * The facade normal comes out of `measureTriangles`, which bins normals at
 * `PLANE_TOLERANCE = 0.05` rad and then keeps the FIRST triangle's normal as the
 * bin's normal rather than the area-weighted mean of the bin. Two triangles that
 * land in one bin can differ by the bin width, so the retained normal can be off
 * by ~0.05 rad ≈ 2.9°. Rounded up to 3°.
 */
const AZIMUTH_TOLERANCE_DEGREES = 3

/**
 * German 16-point compass, in the notation an Austrian or German architect
 * writes: **O** for east, not E. A bearing printed as "E" in a German report
 * reads as a translation artefact and undermines the number next to it.
 */
const COMPASS = ['N', 'NNO', 'NO', 'ONO', 'O', 'OSO', 'SO', 'SSO', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']

/**
 * The types {@link sillAndHead} will measure.
 *
 * `IfcOpeningElement` is in the list deliberately: an agent chaining off
 * `hosts()` holds the opening's id, not the window's, and the reveal and its
 * filler give the same sill within a millimetre in every export worth reading.
 * Refusing the opening would cost a turn to recover from and teach nothing.
 */
const FENESTRATION = new Set([
  'IfcWindow',
  'IfcWindowStandardCase',
  'IfcDoor',
  'IfcDoorStandardCase',
  'IfcOpeningElement',
])

// ── operators ───────────────────────────────────────────────────────────────

/**
 * The element's bounding box and its three axis-aligned dimensions, in metres.
 *
 * The box is **axis-aligned to the MODEL**, not to the element, and that is the
 * one thing a caller must understand before using `width`: a wall running at 30°
 * in plan has a bounding box far wider and deeper than the wall, and reporting
 * that box's `width` as the wall's length would be wrong by a factor. When the
 * element's own facade plane shows it is skewed to the model axes, the answer
 * says so in a caveat rather than leaving the reader to notice.
 *
 * `height` is exempt from that: buildings are extruded along Z, so the Z extent
 * of an axis-aligned box IS the element's height for anything but a ramp.
 *
 * Tolerance is {@link DIMENSION_TOLERANCE} — each dimension subtracts two
 * tessellated faces.
 */
export function extent(
  graph: BuildingGraph,
  geometry: GeometryIndex,
  globalId: string
): Answer<{ box: Box; width: number; depth: number; height: number; centroid: Vec3 }> {
  const method = `extent(${globalId})`
  const subject = require_(graph, globalId, method)
  const geo = requireGeometry<{ box: Box; width: number; depth: number; height: number; centroid: Vec3 }>(
    geometry,
    subject,
    method
  )
  if ('answer' in geo) return geo.answer

  const box = copyBox(geo.geometry.box)
  const width = box.max[0] - box.min[0]
  const depth = box.max[1] - box.min[1]
  const height = box.max[2] - box.min[2]

  return computed(
    { box, width, depth, height, centroid: [...geo.geometry.centroid] as Vec3 },
    {
      unit: 'm',
      tolerance: DIMENSION_TOLERANCE,
      from: [globalId],
      method,
      ...(isSkewed(geo.geometry)
        ? {
            caveat:
              'Dieses Bauteil steht schräg zu den Modellachsen. Breite und Tiefe sind die Ausdehnung der ' +
              'achsparallelen Hüllbox, NICHT Länge und Dicke des Bauteils selbst — diese Zahlen sind für ein ' +
              'schräges Bauteil systematisch zu groß.',
          }
        : {}),
    }
  )
}

/**
 * The element's floor area in m² — for a space, its usable plan area.
 *
 * Measured as the sum of the XY-projected downward-facing triangle areas (see
 * the geometry pass), which is exact for any prismatic solid whatever its plan
 * shape. An L-shaped room measures as an L, not as the rectangle around it.
 *
 * ## The declared quantity, and why it is a parameter
 *
 * An IFC that publishes `Qto_SpaceBaseQuantities.NetFloorArea` (or `NetArea`)
 * gives a second, independent route to the same number, and the pair is worth
 * more than either: agreement raises confidence in the schedule, and
 * DISAGREEMENT is a finding about the export the architect can act on — their
 * room schedule and their geometry are saying different things. So when a
 * declared area is supplied, this triangulates and lets {@link triangulate}
 * write the German caveat.
 *
 * It arrives as a parameter rather than being read here because this library has
 * no property access yet: the graph carries relations and quantities are not
 * relations. The HOST passes it — read `NetFloorArea`/`NetArea` off the element's
 * quantity set and hand it in. Omitting it is not an error; the answer is then a
 * single measured route and says so.
 *
 * Tolerance is {@link AREA_RELATIVE_TOLERANCE} of the value. A measured zero on
 * an element that HAS geometry is a real answer — a wall has no floor — and
 * carries a caveat so it is not read as a missing value.
 */
export function floorArea(
  graph: BuildingGraph,
  geometry: GeometryIndex,
  globalId: string,
  declaredArea?: number
): Answer<number> {
  const method = declaredArea === undefined ? `floorArea(${globalId})` : `floorArea(${globalId}, declared=${declaredArea})`
  const subject = require_(graph, globalId, method)
  const geo = requireGeometry<number>(geometry, subject, method)
  if ('answer' in geo) return geo.answer

  const area = geo.geometry.floorArea
  const measured = computed(area, {
    unit: 'm²',
    tolerance: Math.abs(area) * AREA_RELATIVE_TOLERANCE,
    from: [globalId],
    method,
    ...(area === 0
      ? {
          caveat:
            'Gemessene Grundfläche 0 m²: dieses Bauteil hat Geometrie, aber keine horizontalen Flächen ' +
            '(eine Wand, ein Pfosten). Das ist ein Messergebnis, keine fehlende Angabe.',
        }
      : {}),
  })

  if (declaredArea === undefined) return measured

  // The measured value goes in first because `triangulate` reports the COMPUTED
  // side when the two disagree: a declared quantity that contradicts the
  // geometry it describes is the thing under suspicion.
  return triangulate(
    measured,
    declared(declaredArea, {
      unit: 'm²',
      from: [globalId],
      method: `NetFloorArea(${globalId})`,
    }),
    { method }
  )
}

/**
 * How high the element sits: its lowest and highest point in the model's own
 * frame, and its bottom relative to the storey it belongs to.
 *
 * `bottom` and `top` are absolute Z in the file's frame — the project datum,
 * which is what "±0,00" means on the drawing. `heightAboveStorey` re-bases the
 * bottom onto the element's own storey, which is the number a person actually
 * asks for ("wie hoch über dem Fußboden hängt das?") and which differs from the
 * absolute Z on every storey but the ground floor.
 *
 * `heightAboveStorey` is `null` — decidably so — when the element resolves to no
 * storey, or to a storey the file gives no `Elevation`. That is a weaker claim
 * than undecidable and the right one: `bottom` and `top` are still measured and
 * still useful, and collapsing the whole answer because one field is unavailable
 * would throw away two good numbers for one missing one.
 *
 * Tolerance is {@link COORDINATE_TOLERANCE}: each field is one measured
 * coordinate, and the storey datum is declared (no measurement error, only
 * authoring error).
 */
export function elevation(
  graph: BuildingGraph,
  geometry: GeometryIndex,
  globalId: string
): Answer<{ bottom: number; top: number; heightAboveStorey: number | null }> {
  const method = `elevation(${globalId})`
  const subject = require_(graph, globalId, method)
  const geo = requireGeometry<{ bottom: number; top: number; heightAboveStorey: number | null }>(geometry, subject, method)
  if ('answer' in geo) return geo.answer

  const bottom = geo.geometry.box.min[2]
  const top = geo.geometry.box.max[2]
  // A storey whose declared elevation is on another vertical reference is no
  // datum at all, so it is dropped here rather than subtracted. `bottom` and
  // `top` stay measured and useful — which is exactly why this field is nulled
  // and the whole answer is not, per this operator's contract above.
  const drift = storeyDatumDrift(graph, geometry)
  const datum = drift > 0 ? null : storeyDatum(graph, subject)
  const mismatch = drift > 0 ? datumMismatch(drift, graph, geometry) : null

  return computed(
    { bottom, top, heightAboveStorey: datum ? bottom - datum.elevation : null },
    {
      unit: 'm',
      tolerance: COORDINATE_TOLERANCE,
      from: datum ? [globalId, datum.storey.globalId] : [globalId],
      method,
      ...(datum
        ? {}
        : {
            caveat: mismatch
              ? `${mismatch.what}. ${mismatch.remedy}`
              : 'Dieses Bauteil ist keinem Geschoss mit Höhenangabe zugeordnet — die Höhe über dem Geschoss ' +
                'ist deshalb offen. Die absoluten Höhen beziehen sich auf den Projektnullpunkt.',
          }),
    }
  )
}

/**
 * Brüstungshöhe and Sturzhöhe of a window or door — the two numbers a file this
 * size almost never declares.
 *
 * Both are measured **above the element's OWN storey**, not above the project
 * zero. That distinction is the whole point of the operator: a window on the
 * first floor sits at absolute z 3.90 and at a sill height of 0.90, and only the
 * second number answers "ist die Brüstung hoch genug" — every guard-rail and
 * every daylight rule is written against the finished floor of the room the
 * window is in. Reporting 3.90 as a Brüstungshöhe would clear an absturzsichernde
 * Brüstung that does not exist.
 *
 * Which is why the storey datum is REQUIRED here, unlike in {@link elevation}: a
 * sill height with an unknown datum is not a weaker answer, it is a different
 * number wearing the same name.
 *
 * `height` is the opening height and can be checked against the file's own type
 * naming — a type called `1810x1210mm` should measure 1.21 m here, and when it
 * does not, one of the two is wrong and both are visible.
 *
 * Tolerance is {@link DIMENSION_TOLERANCE}, the widest of the three fields:
 * `sill` and `head` each subtract a declared datum from one measured coordinate
 * (5 mm), while `height` subtracts two measured coordinates (10 mm), and the
 * envelope carries one tolerance which must cover the worst field.
 */
export function sillAndHead(
  graph: BuildingGraph,
  geometry: GeometryIndex,
  globalId: string
): Answer<{ sill: number; head: number; height: number }> {
  const method = `sillAndHead(${globalId})`
  const subject = require_(graph, globalId, method)

  if (!FENESTRATION.has(subject.ifcType)) {
    return wrongKind<{ sill: number; head: number; height: number }>(
      subject,
      method,
      'sillAndHead',
      'ein Fenster, eine Tür oder eine Öffnung',
      'für die absolute Höhe eines beliebigen Bauteils: elevation(); für seine Abmessungen: extent()'
    )
  }

  const geo = requireGeometry<{ sill: number; head: number; height: number }>(geometry, subject, method)
  if ('answer' in geo) return geo.answer

  const datum = storeyDatum(graph, subject)
  if (!datum) {
    return undecidable<{ sill: number; head: number; height: number }>({
      from: [globalId],
      method,
      provenance: 'computed',
      missing: {
        what: `IfcBuildingStorey.Elevation für ${label(subject)}`,
        remedy:
          'Das Bauteil einem Geschoss zuordnen (IfcRelContainedInSpatialStructure) und die Geschosshöhe ' +
          'setzen. Ohne Geschossnull ist eine Brüstungshöhe nicht bestimmbar — die absolute Höhe über dem ' +
          'Projektnullpunkt liefert elevation().',
        elements: [globalId],
      },
    })
  }

  // The storey datum is DECLARED and the box is MEASURED; nothing in IFC makes
  // them share a reference, and a file where they do not produced sills 58 m
  // below their own floor. See `storeyDatumDrift`.
  const drift = storeyDatumDrift(graph, geometry)
  if (drift > 0) {
    return undecidable<{ sill: number; head: number; height: number }>({
      from: [globalId, datum.storey.globalId],
      method,
      provenance: 'computed',
      missing: datumMismatch(drift, graph, geometry),
    })
  }

  const sill = geo.geometry.box.min[2] - datum.elevation
  const head = geo.geometry.box.max[2] - datum.elevation

  return computed(
    { sill, head, height: head - sill },
    {
      unit: 'm',
      tolerance: DIMENSION_TOLERANCE,
      from: [globalId, datum.storey.globalId],
      method,
      caveat:
        `Höhen über der Geschossebene "${datum.storey.name ?? datum.storey.globalId}" ` +
        `(${datum.elevation} m). Gemessen an der Rohbauöffnung bzw. am Bauteilkörper — ein Fußbodenaufbau ` +
        'über der Geschossebene verringert die tatsächliche Brüstungshöhe um seine Dicke.',
    }
  )
}

/**
 * Which way this element faces, as a compass bearing in degrees clockwise from
 * north, plus the German 16-point name.
 *
 * ## Why this refuses without TrueNorth
 *
 * The model's +Y axis is north only if somebody said so. `IfcGeometricRepresen-
 * tationContext.TrueNorth` is where they say it, and when it is absent the file
 * genuinely does not know which way the building points. Defaulting to zero
 * would produce a confident sentence — "diese Fassade liegt im Süden" — about a
 * building that may be rotated forty degrees, and the sentence would be wrong in
 * exactly the way nobody checks, because it looks like every other answer. This
 * operator therefore returns `undecidable` and names the missing entity. It is
 * the single clearest case for the whole envelope contract.
 *
 * ## Which side is "out"
 *
 * A plane has two normals and the mesh's winding does not reliably say which one
 * faces the weather (the kernel emits double-sided geometry by design). So
 * outward is decided geometrically: of the two normals, the one pointing AWAY
 * from the model's plan centre is the outward one. That is right for every
 * facade of a convex-ish building and wrong for the inner face of a courtyard
 * wing, which is stated in the caveat rather than hidden.
 *
 * The plane itself is the element's largest vertical planar cluster — for a wall
 * or a window, the glazing/facade face. An element with no vertical surface (a
 * slab, a ceiling) has no orientation, and that is undecidable rather than zero.
 * Note what that means for a subject that is not a facade: an IfcSpace or a
 * wardrobe HAS vertical faces, so this returns the bearing of its largest one,
 * which for an L-shaped room is an arbitrary choice between two walls. Aim this
 * at the wall or the window, not at the room — `bounds()` gets you there.
 *
 * Tolerance is {@link AZIMUTH_TOLERANCE_DEGREES}.
 */
export function azimuth(
  graph: BuildingGraph,
  geometry: GeometryIndex,
  globalId: string
): Answer<{ degrees: number; compass: string }> {
  const method = `azimuth(${globalId})`
  const subject = require_(graph, globalId, method)

  // Checked before the geometry, because it is a fact about the whole file: an
  // answer that first complained about this element's mesh would send the
  // architect to fix the wrong thing.
  if (graph.trueNorth === null) {
    return undecidable<{ degrees: number; compass: string }>({
      from: [globalId],
      method,
      provenance: 'computed',
      missing: {
        what: 'IfcGeometricRepresentationContext.TrueNorth',
        remedy:
          'Die Nordrichtung im Modell setzen und mitexportieren. Ohne sie ist jede Himmelsrichtung geraten: ' +
          'ein um 40° gedrehtes Gebäude würde als "Südfassade" berichtet, und der Fehler ist an der Antwort ' +
          'nicht zu erkennen.',
      },
    })
  }

  const geo = requireGeometry<{ degrees: number; compass: string }>(geometry, subject, method)
  if ('answer' in geo) return geo.answer

  const facade = geo.geometry.facade
  if (!facade) {
    return undecidable<{ degrees: number; compass: string }>({
      from: [globalId],
      method,
      provenance: 'computed',
      missing: {
        what: `keine senkrechte Fläche an ${label(subject)}`,
        remedy:
          'Die Himmelsrichtung wird aus der größten senkrechten Fläche eines Bauteils bestimmt. Dieses Bauteil ' +
          'hat keine (z. B. eine Decke oder ein Flachdach). Für die Ausrichtung eines Raumes die begrenzende ' +
          'Außenwand abfragen: bounds() liefert sie.',
        elements: [globalId],
      },
    })
  }

  const centre = geometry.planCentre
  if (!centre) {
    return undecidable<{ degrees: number; compass: string }>({
      from: [globalId],
      method,
      provenance: 'computed',
      missing: {
        what: 'keine Modellausdehnung (kein Bauteil mit Geometrie)',
        remedy:
          'Ohne die Grundriss-Mitte des Modells lässt sich nicht entscheiden, welche der beiden Flächennormalen ' +
          'nach außen zeigt. Das Modell mit Geometrie exportieren.',
      },
    })
  }

  // Point the normal away from the plan centre. Only the XY part matters — the
  // facade plane is vertical by construction, so its normal's Z is ~0.
  let nx = facade.normal[0]
  let ny = facade.normal[1]
  const awayX = facade.point[0] - centre[0]
  const awayY = facade.point[1] - centre[1]
  if (nx * awayX + ny * awayY < 0) {
    nx = -nx
    ny = -ny
  }

  // North in model coordinates: `trueNorth` is the angle from +Y toward +X, so
  // north = (sin θ, cos θ), and east is north turned 90° clockwise = (cos θ, -sin θ).
  const north: [number, number] = [Math.sin(graph.trueNorth), Math.cos(graph.trueNorth)]
  const east: [number, number] = [north[1], -north[0]]
  const degrees = normaliseDegrees((Math.atan2(nx * east[0] + ny * east[1], nx * north[0] + ny * north[1]) * 180) / Math.PI)

  return computed(
    { degrees, compass: COMPASS[Math.round(degrees / 22.5) % 16]! },
    {
      unit: '°',
      tolerance: AZIMUTH_TOLERANCE_DEGREES,
      from: [globalId],
      method,
      caveat:
        'Außen ist die Normale, die von der Grundriss-Mitte des Modells wegzeigt. Für eine Wand am Innenhof ' +
        'oder in einem einspringenden Baukörper kann das die falsche Seite sein — dann ist die Angabe um 180° ' +
        'gedreht.',
    }
  )
}

/**
 * How far apart two elements are, in metres — in one of four senses, because
 * "Abstand" means four different things and picking the wrong one silently is
 * how a clearance gets certified.
 *
 *   - `'min'` — the shortest distance between the two bounding BOXES. This is
 *     the clearance question ("passt da noch was dazwischen"). Zero when the
 *     boxes overlap, and the answer says so in a caveat: overlapping boxes do
 *     NOT prove the solids touch, since a box is a box.
 *   - `'centroid'` — centre to centre in 3D. The spacing question ("Achsabstand
 *     der Stützen").
 *   - `'horizontal'` — centre to centre in plan, Z ignored. What a plan drawing
 *     measures.
 *   - `'vertical'` — the difference in centre height. What a section measures.
 *
 * ## The centroid is a vertex mean, and that matters
 *
 * The geometry pass averages VERTICES, not volume. On a solid whose tessellation
 * is denser at one end — a wall with three windows cut out of one half — the
 * mean drifts toward the detailed end by a few centimetres. The three
 * centroid-based modes therefore carry a caveat; `'min'` does not, because a
 * bounding box does not care how densely its contents were triangulated.
 *
 * Tolerance is {@link DIMENSION_TOLERANCE} throughout: every mode subtracts two
 * measured quantities.
 */
export function distance(
  graph: BuildingGraph,
  geometry: GeometryIndex,
  a: string,
  b: string,
  mode: 'min' | 'centroid' | 'horizontal' | 'vertical'
): Answer<number> {
  const method = `distance(${a}, ${b}, '${mode}')`
  const first = require_(graph, a, method)
  const second = require_(graph, b, method)

  const geoA = requireGeometry<number>(geometry, first, method, [a, b])
  if ('answer' in geoA) return geoA.answer
  const geoB = requireGeometry<number>(geometry, second, method, [a, b])
  if ('answer' in geoB) return geoB.answer

  const from = [a, b]

  if (mode === 'min') {
    const gap = boxGap(geoA.geometry.box, geoB.geometry.box)
    const overlapping = boxesOverlap(geoA.geometry.box, geoB.geometry.box)
    // Per axis, a negative gap means the boxes already share that band; only the
    // positive components separate them, and the true box-to-box distance is
    // their euclidean length.
    const value = overlapping ? 0 : Math.hypot(Math.max(gap[0], 0), Math.max(gap[1], 0), Math.max(gap[2], 0))
    return computed(value, {
      unit: 'm',
      tolerance: DIMENSION_TOLERANCE,
      from,
      method,
      caveat: overlapping
        ? 'Die Hüllboxen der beiden Bauteile überschneiden sich, der Abstand ist deshalb 0 m. Das heißt NICHT, ' +
          'dass sich die Körper berühren — eine achsparallele Hüllbox ist großzügiger als das Bauteil darin. ' +
          'Für eine echte Kollision sind die Flächen zu prüfen.'
        : 'Abstand zwischen den achsparallelen Hüllboxen, nicht zwischen den Körpern. Für ein schräg stehendes ' +
          'oder nicht quaderförmiges Bauteil ist der wahre Abstand größer, nie kleiner.',
    })
  }

  const [ax, ay, az] = geoA.geometry.centroid
  const [bx, by, bz] = geoB.geometry.centroid
  const value =
    mode === 'centroid'
      ? Math.hypot(ax - bx, ay - by, az - bz)
      : mode === 'horizontal'
        ? Math.hypot(ax - bx, ay - by)
        : Math.abs(az - bz)

  return computed(value, {
    unit: 'm',
    tolerance: DIMENSION_TOLERANCE,
    from,
    method,
    caveat:
      'Gemessen zwischen den Schwerpunkten. Diese sind das Mittel der Netzpunkte, nicht der Volumen­schwerpunkt ' +
      '— bei ungleichmäßig triangulierten Bauteilen (eine Wand mit Öffnungen in nur einer Hälfte) wandert der ' +
      'Punkt um einige Zentimeter zur fein vernetzten Seite.',
  })
}

/**
 * The modelled height of a space, in metres.
 *
 * ## What this is NOT
 *
 * It is not the lichte Raumhöhe. It is the Z extent of the IfcSpace SOLID — the
 * volume the modeller drew, which normally runs from finished floor to the
 * underside of the slab above and ignores everything hanging in it. A downstand
 * beam, a duct run, a suspended ceiling or a bulkhead all reduce the real clear
 * height and none of them shortens the space solid.
 *
 * That distinction decides compliance cases: an OIB minimum room height is a
 * clear dimension under the lowest obstruction, and reporting the space solid's
 * height against it would pass a room that fails under its own beam. The honest
 * answer is this number plus the caveat saying what would settle it — which is
 * an intersection test against the elements inside the space, and this library
 * does not have one yet.
 *
 * Tolerance is {@link DIMENSION_TOLERANCE}.
 */
export function clearHeight(graph: BuildingGraph, geometry: GeometryIndex, spaceGlobalId: string): Answer<number> {
  const method = `clearHeight(${spaceGlobalId})`
  const subject = require_(graph, spaceGlobalId, method)

  if (subject.kind !== 'space') {
    return wrongKind<number>(
      subject,
      method,
      'clearHeight',
      'einen Raum (IfcSpace)',
      'für die Höhe eines Bauteils: extent() liefert sie als height'
    )
  }

  const geo = requireGeometry<number>(geometry, subject, method)
  if ('answer' in geo) return geo.answer

  const box = geo.geometry.box
  const floor = box.min[2]
  const solid = box.max[2] - floor

  /**
   * What actually hangs into the room, found by looking upward from inside it.
   *
   * This used to return the space solid's own height with a caveat explaining
   * that beams, ducts and suspended ceilings shorten the real clear height and
   * that the intersection test was missing. On the sample house that answered
   * **2.500 m** for a living room whose `IfcCovering` ceiling sits at
   * **2.200 m**. The caveat carried the truth and the number did not, which is
   * the wrong way round: 30 cm is a large error on precisely the figure a
   * minimum room height is checked against, in the direction that turns a fail
   * into a pass.
   *
   * A bounding-box test was tried first and is not good enough — it cannot
   * tell "hangs into the room" from "is near the room". A window sitting in
   * the enclosing wall overlaps the room's box in plan, and a roof spanning
   * the whole building overlaps every room's; both reported as intrusions and
   * the living room came back at 0.90 m. Only real surfaces answer this, so a
   * grid of rays is cast upward from just above the floor and the nearest hit
   * wins.
   *
   * The grid is coarse (5×5 inset from the walls). It will miss a duct
   * narrower than the spacing, which the caveat says; it will not invent one.
   */
  // What may lower a clear height is an explicit LIST, not an exclusion.
  //
  // Exclusion was tried twice and failed twice, in both directions. Left open,
  // the rays hit a sofa and reported the living room as 0.37 m high. With
  // furniture excluded, they hit a window sill in the south wall at 0.90 m —
  // and a window is part of the enclosure, not something hanging over the
  // floor. Every exclusion list is a bet that nothing unforeseen sits in the
  // room, and an IFC always has something unforeseen in it.
  //
  // Named positively, the rule is one an architect would recognise: a ceiling,
  // a slab, a beam, a duct or a stair above you reduces the room's clear
  // height. Anything not on this list is treated as not overhead, which is a
  // real limit — an exotic soffit modelled as an IfcBuildingElementProxy will
  // be missed — and is stated in the caveat rather than hidden.
  const overhead = new Set<string>()
  for (const [id, n] of graph.nodes) {
    if (!OVERHEAD.has(n.ifcType)) overhead.add(id)
  }

  // Sample points come from the bounding BOX, and a room is not its box. The
  // living room here is L-shaped, so a third of the grid falls inside the
  // enclosing walls — where a ray upward hits a window sill and reports the
  // room as 0.90 m high. Each point is therefore checked against the space
  // SOLID first, by casting the same ray with everything but the space
  // excluded: a point inside the room sees the room's own ceiling face, a
  // point in a wall sees nothing.
  // Containment is tested against the space's OWN triangles, not with `ray()`:
  // that operator only considers `kind === 'element'`, and an IfcSpace is
  // deliberately not a solid anything can hit. Parity counting does the job —
  // a point inside the solid crosses its top face an odd number of times on the
  // way out, a point in a wall crosses nothing.
  const shell = geo.geometry.triangles

  const samples = 5
  const inset = 0.15
  let lowest = Infinity
  let intruder: string | null = null
  let inside = 0
  for (let i = 0; i < samples; i++) {
    for (let j = 0; j < samples; j++) {
      const x = lerp(box.min[0] + inset, box.max[0] - inset, i / (samples - 1))
      const y = lerp(box.min[1] + inset, box.max[1] - inset, j / (samples - 1))
      if (shell && !insideSolid(shell, x, y, floor + 0.05)) continue
      inside++
      const hit = ray(graph, geometry, [x, y, floor + 0.05], [0, 0, 1], solid + 1, [spaceGlobalId, ...overhead])
      const value = hit.value
      if (!value || value.distance >= lowest) continue
      lowest = value.distance
      intruder = value.hit
    }
  }

  if (inside === 0) {
    // Every sample missed the room solid. Rather than fall back to the box
    // height — the very number this operator was corrected away from — say so.
    return undecidable<number>({
      from: [spaceGlobalId],
      method,
      provenance: 'computed',
      missing: {
        what: `Messpunkte innerhalb des Raumkörpers von ${label(subject)}`,
        remedy:
          'Kein Punkt des Prüfrasters liegt im Raumkörper — bei sehr schmalen oder stark gegliederten Räumen ' +
          'ist das Raster zu grob. Die Höhe des Raumkörpers liefert extent().',
        elements: [spaceGlobalId],
      },
    })
  }

  const clear = Number.isFinite(lowest) ? lowest + 0.05 : solid
  const reduced = intruder !== null && clear < solid - DIMENSION_TOLERANCE

  return computed(clear, {
    unit: 'm',
    tolerance: DIMENSION_TOLERANCE,
    from: intruder ? [spaceGlobalId, intruder] : [spaceGlobalId],
    method,
    caveat: reduced
      ? `Lichte Höhe bis zur Unterkante von ${label(node(graph, intruder!))}; der Raumkörper selbst ist ` +
        `${solid.toFixed(2)} m hoch. Gemessen mit ${samples * samples} senkrechten Strahlen — ein Einbau, ` +
        'der schmaler ist als deren Abstand, kann dabei unentdeckt bleiben.'
      : `Kein Bauteil ragt in den Raumkörper; die lichte Höhe entspricht seiner Höhe. Gemessen mit ` +
        `${inside} von ${samples * samples} Strahlen im Raumkörper — ein sehr schmaler Einbau kann ihnen entgehen.`,
  })
}

/**
 * The only types that may lower a room's clear height.
 *
 * Things above you: ceilings, slabs, beams, roofs, stairs, ducts and pipes.
 * Deliberately NOT walls, windows or doors — those bound the room rather than
 * hang into it, and including them made a window sill 0.90 m above the floor
 * report as the room's height.
 */
const OVERHEAD = new Set([
  'IfcCovering',
  'IfcSlab',
  'IfcSlabStandardCase',
  'IfcBeam',
  'IfcBeamStandardCase',
  'IfcRoof',
  'IfcStair',
  'IfcStairFlight',
  'IfcRamp',
  'IfcRampFlight',
  'IfcDuctSegment',
  'IfcDuctFitting',
  'IfcPipeSegment',
  'IfcPipeFitting',
  'IfcCableCarrierSegment',
  'IfcDistributionElement',
  'IfcDistributionFlowElement',
  'IfcEnergyConversionDevice',
])

/**
 * Whether a point lies inside a closed triangle shell, by upward parity.
 *
 * Counts crossings of the +Z ray through the shell's triangles: odd is inside.
 * Winding is irrelevant to a parity count, which matters because this kernel's
 * winding is unreliable — an orientation-based test would be a coin flip.
 */
function insideSolid(triangles: Float64Array, x: number, y: number, z: number): boolean {
  let crossings = 0
  for (let i = 0; i < triangles.length; i += 9) {
    const ax = triangles[i]!, ay = triangles[i + 1]!, az = triangles[i + 2]!
    const bx = triangles[i + 3]!, by = triangles[i + 4]!, bz = triangles[i + 5]!
    const cx = triangles[i + 6]!, cy = triangles[i + 7]!, cz = triangles[i + 8]!
    // Barycentric test in plan, then require the facet to be above the point.
    const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (Math.abs(d) < 1e-12) continue
    const u = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d
    const v = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d
    const w = 1 - u - v
    if (u < 0 || v < 0 || w < 0) continue
    if (u * az + v * bz + w * cz > z) crossings++
  }
  return crossings % 2 === 1
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

// ── guards ──────────────────────────────────────────────────────────────────

/**
 * The subject node, or a throw.
 *
 * Same contract and same trailing underscore as `topology.ts`: an id that is not
 * in this model supports no claim about the model, so it is an exception and
 * never an undecidable.
 */
function require_(graph: BuildingGraph, globalId: string, method: string): GraphNode {
  const n = node(graph, globalId)
  if (!n) throw new UnknownElementError(globalId, method)
  return n
}

/**
 * The element's geometry, or the undecidable that stands in for it.
 *
 * Returned as a tagged union rather than `null` so the caller cannot forget the
 * missing case — every operator here is a `if ('answer' in x) return x.answer`
 * away from being correct, and TypeScript enforces the check.
 *
 * A miss is emphatically not an error. Half the nodes in a real IFC never had a
 * body (`IfcDoorLiningProperties`, `IfcWindowLiningProperties`, curtain-wall
 * shells whose panels carry the geometry instead), and a wall that lost its body
 * in export is a finding worth reporting in exactly the same words.
 */
function requireGeometry<T>(
  geometry: GeometryIndex,
  subject: GraphNode,
  method: string,
  from?: string[]
): { geometry: ElementGeometry } | { answer: Answer<T> } {
  const found = geometry.elements.get(subject.globalId)
  if (found) return { geometry: found }

  return {
    answer: undecidable<T>({
      from: from ?? [subject.globalId],
      method,
      provenance: 'computed',
      missing: {
        what: `keine geometrische Repräsentation für ${label(subject)} in dieser Datei`,
        remedy:
          'Dieses Bauteil trägt in dieser Datei keinen Körper (kein auswertbares IfcProductDefinitionShape). ' +
          'Manche Einträge haben von Haus aus keinen — IfcDoorLiningProperties, IfcWindowLiningProperties, ' +
          'die Hülle einer Vorhangfassade, deren Paneele die Geometrie tragen. Sonst: das Modell mit ' +
          'Körpergeometrie neu exportieren (Body-Repräsentation, kein reiner Bounding-Box-Export).',
        elements: [subject.globalId],
      },
    }),
  }
}

/**
 * The operator was aimed at the wrong kind of element.
 *
 * Copied in spirit from `topology.ts`, including the reason `missing.what` is
 * German here while it names an IFC identifier everywhere else: nothing is
 * missing from the FILE, so naming an entity would send the architect off to
 * re-export something that is already there. `remedy` names the operator that
 * would in fact answer the question.
 */
function wrongKind<T>(subject: GraphNode, method: string, operator: string, expected: string, suggestion: string): Answer<T> {
  return undecidable<T>({
    from: [subject.globalId],
    method,
    provenance: 'computed',
    missing: {
      what: `${operator}() erwartet ${expected}, bekam ${subject.ifcType}`,
      remedy: suggestion,
      elements: [subject.globalId],
    },
  })
}

/**
 * The storey this element sits on, together with its declared elevation.
 *
 * Resolved through `GraphNode.storeyGlobalId` — which the parser fills by
 * walking the real containment chain, including aggregated descendants — and
 * then matched against `graph.storeys`, so a node pointing at a storey the
 * storey list does not contain yields `null` rather than a datum from nowhere.
 * A storey asked about itself is its own datum.
 *
 * Elevations arrive from the parser already converted to metres, even though
 * this file (like most) is authored in millimetres; `graph.units.length` records
 * what the architect would recognise, not what the numbers are in.
 */
function storeyDatum(graph: BuildingGraph, subject: GraphNode): { storey: GraphNode; elevation: number } | null {
  const wanted = subject.kind === 'storey' ? subject.globalId : subject.storeyGlobalId
  if (!wanted) return null
  const storey = graph.storeys.find((s) => s.globalId === wanted)
  if (!storey || storey.elevation === null) return null
  return { storey, elevation: storey.elevation }
}

/**
 * How far the declared storey elevations sit outside the model's measured
 * height, in metres — `0` when they sit inside it.
 *
 * ## The number this exists to stop
 *
 * `IfcBuildingStorey.Elevation` is a DECLARED datum and the geometry pass
 * reports a MEASURED z. Every operator that answers "how high above the floor"
 * subtracts one from the other, and nothing in IFC guarantees the two share a
 * reference. `Trapelo_Design_Intent.ifc` (Revit 2015, feet) declares its storeys
 * at 182.67…231.875 ft — 55.68…70.68 m, on the survey datum — while its
 * geometry, re-based by the kernel, spans −3.62…12.29 m. `sillAndHead` on every
 * one of its 68 windows therefore returned
 *
 *     sill = −58.353 m   head = −56.556 m   height = 1.797 m
 *
 * — a window whose head is fifty-six metres below its own floor, with a unit
 * attached, a tolerance of 10 mm and a `computed` provenance. The height is
 * right (both terms carry the same error), which is what makes it look like a
 * measurement. That is the single worst kind of output this library can produce,
 * and it produced it on the first foot-based file it was ever shown.
 *
 * ## The test
 *
 * Purely a comparison of two ranges the library already holds. The storeys of a
 * building must lie within its own measured height — a storey below the lowest
 * vertex or above the highest is not a storey of this geometry. The slack is
 * generous (one storey height) so that a roof datum above the ridge, or a
 * foundation datum below the lowest slab, is not mistaken for a datum error: the
 * failure being caught is off by tens of metres, not by one.
 *
 * `0` on the twelve other files of the corpus, including the ones whose storeys
 * are negative (`duplex.ifc` −1.25 m) or numerous (`Snowdon_IFC2x3.ifc`, 18
 * storeys spanning −5.16…21.59 m against geometry −4.34…24.69 m).
 */
const DATUM_SLACK_METRES = 5

function storeyDatumDrift(graph: BuildingGraph, geometry: GeometryIndex): number {
  const bounds = geometry.bounds
  if (!bounds) return 0
  const elevations = graph.storeys.map((s) => s.elevation).filter((e): e is number => e !== null)
  if (elevations.length === 0) return 0
  const low = Math.min(...elevations)
  const high = Math.max(...elevations)
  const below = bounds.min[2] - DATUM_SLACK_METRES - low
  const above = high - (bounds.max[2] + DATUM_SLACK_METRES)
  return Math.max(0, below, above)
}

/**
 * The refusal {@link sillAndHead} and {@link elevation} share when the two
 * datums disagree. Named once so both say the same thing about the same file.
 */
function datumMismatch(drift: number, graph: BuildingGraph, geometry: GeometryIndex): MissingFact {
  const bounds = geometry.bounds!
  const elevations = graph.storeys.map((s) => s.elevation).filter((e): e is number => e !== null)
  return {
    what: 'IfcBuildingStorey.Elevation und die Modellgeometrie liegen auf verschiedenen Höhenbezügen',
    remedy:
      `Die Geschosshöhen der Datei laufen von ${Math.min(...elevations).toFixed(2)} m bis ` +
      `${Math.max(...elevations).toFixed(2)} m, die gemessene Geometrie von ${bounds.min[2].toFixed(2)} m bis ` +
      `${bounds.max[2].toFixed(2)} m — sie verfehlen einander um ${drift.toFixed(2)} m. Eine Höhe über ` +
      'Geschossebene wäre um diesen Betrag falsch und wird deshalb nicht ausgegeben. Ursache ist fast immer ein ' +
      'Export, dessen Geschosshöhen auf Meereshöhe bzw. den Vermessungspunkt bezogen sind, während die ' +
      'Bauteilkoordinaten auf dem Projektnullpunkt stehen. Abhilfe: im CAD Projekt- und Vermessungspunkt ' +
      'angleichen oder die Geschosshöhen auf den Projektnullpunkt beziehen. Die absoluten Höhen im Modellbezug ' +
      'liefert elevation() unverändert.',
  }
}

/**
 * Whether the element stands at an angle to the model axes, which is what makes
 * a bounding box's width a lie about the element's length.
 *
 * Read off the facade plane's normal: a wall aligned to the axes has a normal
 * along ±X or ±Y, so one horizontal component is ~0. Both components being
 * appreciable means the element is rotated in plan. 0.1 ≈ 6° off-axis, well
 * outside tessellation noise and well inside "this is a diagonal wall".
 */
function isSkewed(geometry: ElementGeometry): boolean {
  const plane = geometry.facade
  if (!plane) return false
  return Math.abs(plane.normal[0]) > 0.1 && Math.abs(plane.normal[1]) > 0.1
}

function copyBox(box: Box): Box {
  return { min: [...box.min] as Vec3, max: [...box.max] as Vec3 }
}

/** Into [0, 360). */
function normaliseDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360
}
