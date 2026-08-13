/**
 * The constructive operators: geometry the file does not contain, built from
 * geometry it does.
 *
 * Topology answers *which thing sits in which*. The metric operators answer
 * *how big, how far apart*. This module answers the third kind of question, the
 * one the failed turn in the roadmap died on: **what does this arrangement do to
 * a construction that is not in the file at all** — a plane, a ray, a prism of
 * light. Nothing here can be looked up. Every value is built.
 *
 * ## What each operator is modelled on
 *
 * §7 of `docs/roadmap/agent-spatial-reasoning.md` lists a production
 * implementation next to every operator, and the point of the column is that we
 * copy semantics rather than invent them:
 *
 *   - {@link ray} mirrors IfcOpenShell's `geom.tree.select_ray(origin,
 *     direction, length)`: first surface hit, reported as position **and**
 *     distance, not as a boolean. A boolean would make "is the light blocked"
 *     answerable and "by how much are we off" not.
 *   - {@link obstructions} mirrors `geom.tree.select(shape, extend=…)` and
 *     Solibri's free-area check: the set of elements occupying a volume that is
 *     required to be free, each with how far it reaches in.
 *   - {@link overhang} is `projection(element, plane)` — the number the product
 *     reported as *"Überstand nicht messbar"* on a file that measures it fine.
 *   - {@link prism} is the 45°/30° light prism of OIB 3 §9, as a construction.
 *
 * ## What this module refuses to do
 *
 * **No verdicts.** Not one function here returns `compliant`, `ok`, or a
 * percentage of a floor area. Whether 45° and 30° are the right numbers, whether
 * a cut prism bans a window or merely enlarges the required Lichteintrittsfläche
 * (§11 says it is the latter), and what a blocked prism costs the design are the
 * rulebook's business. An operator that answered `compliant: false` would be
 * claiming a competence it does not have — it knows where the roof is, not what
 * the OIB says about it. The angles are therefore **parameters the caller
 * binds**, never constants in this file.
 *
 * **No sun.** §11 is explicit: the 45° prism stays computable without
 * georeferencing because it is a geometric construction, while a
 * *Besonnungsstudie* needs `IfcSite.RefLatitude`/`RefLongitude` and a true-north
 * angle that exports routinely omit. There is deliberately no `sunPath()` here,
 * and adding one that assumed north = +Y would produce a shadow study that is
 * wrong by an unknown angle and looks right.
 *
 * **No silent approximation.** Surface tests run against retained triangles.
 * Where the geometry pass dropped them, an operator either degrades to the
 * bounding box **and says so in a `caveat`**, or returns `decidable: false`
 * where a box would be meaningless. Box-accuracy on a pitched or curved roof is
 * an overestimate, and an overestimate presented as a measurement is the failure
 * this library exists to prevent.
 *
 * ## Three things about `pass.ts` that this module has to correct
 *
 * Discovered by measuring, not by reading:
 *
 *  1. **Triangle winding is inverted.** On `Ifc4_SampleHouse.ifc` the north
 *     wall's OUTER face (y = 4.699) carries the normal `(0,−1,0)` and its inner
 *     face (y = 4.409) carries `(0,+1,0)` — every face normal points *into* the
 *     solid. `Plane.normal` from the geometry pass therefore says which
 *     ORIENTATION a face has, never which side is outside. Hence
 *     {@link facadePlaneOf}, which orients the normal against
 *     `GeometryIndex.planCentre`, and hence the double-sided ray test below.
 *  2. **Plane bins ignore the offset.** `measureTriangles` keys its bins on the
 *     quantised normal alone, so parallel faces at different offsets — the layer
 *     boundaries a sliced multi-layer wall exports — are averaged into one
 *     plane. The same north wall reports `facade.point.y = 4.4221`, which lies
 *     on no surface of the building: it is a blend of faces at 4.409 (26.5 m²)
 *     and 4.521 (0.9 m²), and blended by TRIANGLE COUNT rather than by area, so
 *     a finely tessellated sliver drags the plane further than its size
 *     warrants. {@link facadePlaneOf} re-seats onto a real face, which on this
 *     file moves the reference 0.28 m outward.
 *  3. **Which of a wall's two faces wins is a coin flip.** Both leaves of a wall
 *     have nearly equal area (26.5 m² against 25.7 m² here), so the "largest
 *     vertical cluster" picks one arbitrarily — on all three exterior walls of
 *     the sample house it picked the INNER one. An overhang measured from that
 *     plane is over-reported by the wall thickness. {@link facadePlaneOf} takes
 *     the outermost parallel face instead, which is uniquely determined.
 *
 * None of the three is fixed in `pass.ts`, because `facade` is honest about what
 * it promises (the largest coplanar cluster) and other callers may want exactly
 * that. What they are not is a facade *reference plane*, and this module builds
 * one.
 */

import { computed, undecidable, type Answer, type MissingFact } from '../envelope.js'
import { into, node, out, type BuildingGraph, type GraphNode } from '../graph/types.js'
import { signedDistance, type Box, type ElementGeometry, type GeometryIndex, type Vec3 } from '../geometry/pass.js'
import { UnknownElementError } from './topology.js'

// ── tolerances ──────────────────────────────────────────────────────────────
//
// Every number this module returns states one of these. They are constants
// rather than options because a caller who could tune them could tune an answer
// into compliance, and because the two sources of error they stand for —
// tessellation, and reading a solid off its bounding box — are properties of the
// pipeline, not of the question.

/** Tessellation error on a surface-based measurement, metres. §7's ±5 mm. */
const TESSELLATION_TOLERANCE = 0.005

/**
 * Tolerance on a measurement taken from a bounding box instead of surfaces.
 *
 * Ten times the tessellation figure and still optimistic: on a curved roof the
 * box is wrong by the sag, which on the sample house is 1.7 m. The number is a
 * floor on the error, which is why every box-derived answer also carries a
 * caveat naming the degradation instead of relying on this alone.
 */
const BOX_TOLERANCE = 0.05

/** Below this, an intrusion into a volume is tessellation noise, metres. */
const MIN_INTRUSION = 0.005

/** |dot| above which two unit normals count as parallel (≈ 10°). */
const PARALLEL_DOT = 0.985

/** A parallel face smaller than this fraction of the largest one is a sliver. */
const FACE_AREA_FRACTION = 0.05

/** Absolute floor under the sliver test, m² — keeps tiny elements usable. */
const MIN_FACE_AREA = 0.01

/** Offsets closer than this along the normal are the same face, metres. */
const FACE_MERGE = 0.01

/** Within this of the facade plane, an obstruction touches it, metres. */
const FACADE_CONTACT = 0.005

/**
 * Beyond this elevation an "unobstructed angle" is not a usable statement.
 *
 * An obstruction that meets the facade plane above the sill — which is what a
 * roof overhang does — leaves no elevation below 90° that frees the prism. That
 * is a true statement and a useless one, so {@link freeLightIncidence} reports
 * `worstAngleDeg: null` with a caveat pointing at {@link overhang}, which is the
 * number that can actually be acted on in that case.
 */
const NEAR_VERTICAL_DEG = 89

/** Angular resolution of the horizon scan, degrees. */
const ANGLE_TOLERANCE_DEG = 0.5

/**
 * |cos| between the facade normal and the direction out of the plan centre,
 * below which "outward" is not established.
 *
 * An interior partition standing near the middle of the plan has no outside, and
 * a facade plane whose orientation was decided by a near-zero dot product would
 * point out of the building on one model and into it on the next.
 */
const OUTWARD_MIN_DOT = 0.15

/** Minimum distance from the plan centre for the outward test to mean anything. */
const OUTWARD_MIN_SPAN = 0.25

/** |normal.z| above which a "vertical" facade plane is visibly out of plumb. */
const PLUMB_TOLERANCE = 0.05

// ── types ───────────────────────────────────────────────────────────────────

/**
 * A facade plane with a side.
 *
 * `outward` is not decoration: every measurement in this module is signed
 * against this normal, so a plane whose orientation could not be established
 * turns "the roof projects 0.65 m past the facade" into the same sentence with
 * the sign silently reversed. When `outward` is false the value is still
 * returned — the plane is real, only its side is a guess — and the answer
 * carries a caveat saying so.
 */
export interface OrientedPlane {
  /** Unit normal, pointing away from the model's plan centre. */
  normal: Vec3
  /** A point ON a real face of the element, not on an averaged one. */
  point: Vec3
  /**
   * The summed area of the co-planar triangle bin that SEATED the plane, m² —
   * an internal ranking key, not the area of a face.
   *
   * Named `seatedArea` rather than `area` because the shorter name was read as
   * the face's area and it is not one. `outermostParallelFace` bins triangles
   * by offset along the normal and sums BOTH facings (the winding is
   * unreliable), so the total covers every co-planar sliver within `FACE_MERGE`
   * — the wall's outer leaf plus whatever else happens to lie in that plane.
   *
   * The clearest proof is that the two bin totals in this package disagree
   * about the same wall. On the sample house's south wall
   * (`3cUkl32yn9qRSPvBJVyWy4`, 8.955 × 2.821 m gross, carrying a 1.81 × 1.21 m
   * window and a 1.81 × 2.11 m door, so ≈19.25 m² of face once the openings
   * are taken out):
   *
   *     seatedArea (this field)              17.958 m²
   *     Plane.binArea (the geometry pass)    20.652 m²
   *
   * Two numbers for one wall's plane, one under the face and one over it,
   * because each is a sum over whichever triangles its own binning rule
   * collected — not a measurement of anything an architect would point at. At
   * most one could be "the area of the face", and neither is. Feeding either
   * into an OIB 6 window-to-wall ratio would put square metres that are not
   * there on one side of the fraction.
   *
   * The Python engine withdrew the equivalent field from `facade_plane_of`
   * for this reason — it publishes `{normal, point, outward}` only. This one
   * survives because `outermostParallelFace` needs it to choose a winning bin,
   * and the only sound use is comparing two bins of the SAME element to each
   * other.
   *
   * It IS public: `index.ts` re-exports this module wholesale (`export * from
   * './operators/constructive.js'`), so the name is the only thing standing
   * between a consumer and the wrong reading. That is exactly why it was
   * renamed rather than left as `area` with a warning attached — a caller who
   * writes `plane.area` has already decided what it means, and a caller who
   * writes `plane.seatedArea` has to come here to find out.
   */
  seatedArea: number
  /** Whether the outward orientation could be established at all. */
  outward: boolean
}

/**
 * One bounding plane of a {@link PrismVolume}.
 *
 * Half-spaces rather than a mesh because the prism is unbounded — it opens
 * upward and outward to the sky — and because every test this module performs
 * against it (is a point inside, clip a triangle to it, how deep does an element
 * reach past it) is a dot product against a plane. A caller can serialise these
 * four planes and re-derive the volume exactly; a triangulated approximation of
 * an infinite wedge would only be re-derivable to within its own resolution.
 *
 * A point `x` is inside the volume when
 * `dot(x − point, normal) ≥ 0` holds for **every** half-space.
 */
export interface HalfSpace {
  normal: Vec3
  point: Vec3
  /** Which bound this is, so a caller can reason about a partial intrusion. */
  role: 'facade' | 'incline' | 'lateralLeft' | 'lateralRight'
}

/** One sample direction the prism was probed along. */
export interface PrismRay {
  origin: Vec3
  /** Unit direction: elevation `angleDeg`, azimuth `swivelDeg` off the normal. */
  direction: Vec3
  /** Lateral swivel of this sample, degrees; 0 is straight out of the facade. */
  swivelDeg: number
}

/**
 * The light prism — the volume in front of a light opening that has to stay
 * free, as a construction rather than as a verdict.
 *
 * ## The construction, against §10
 *
 * §10 binds `prism(openingSurface, 45, 30)` and expects a real volume in model
 * space that the roof can be shown to cut. This is that volume:
 *
 *  - **Anchor.** The LOWER EDGE of the light opening, lying in the facade plane
 *    — the opening's outer face, not its centre and not the wall's inner leaf.
 *    Anchoring at the sill is what makes the volume cover every path by which
 *    light at `angleDeg` or steeper can reach ANY point of the opening: a ray
 *    that arrives at the window head at 45° passes above the 45° plane drawn
 *    from the sill. That is why the prism is a volume anchored at one edge and
 *    not a ray from each point of the glazing.
 *  - **Incline.** A plane through that edge rising at `angleDeg` from the
 *    horizontal, tilting about the edge, opening outward. The volume is the side
 *    ABOVE it.
 *  - **Swivel.** The lateral bounds start at the opening's own side edges and
 *    flare outward by `swivelDeg` each way, so at distance `d` from the facade
 *    the prism is wider than the opening by `d · tan(swivelDeg)` on each side.
 *    The clause's swivel is a permission to take the light from within that
 *    band, so the band is the region light may traverse.
 *  - **Facade.** Everything behind the facade plane is outside the volume. Which
 *    is why the host wall does not report itself as blocking its own window —
 *    though a RECESSED window's reveal legitimately does, and that is the case
 *    {@link obstructions}' `exclude` exists for.
 *
 * ## What the construction does not decide
 *
 * That an element sits in the lateral flare rather than straight in front of the
 * opening is visible in the geometry and is NOT interpreted here: whether the
 * remaining band still satisfies the clause is a legal reading. `halfSpaces`
 * carries `role` precisely so a caller can make that distinction itself.
 *
 * The angles are the caller's. This file contains no OIB numbers.
 */
export interface PrismVolume {
  /** The light opening (or its filler) the prism was built for. */
  openingId: string
  /** The element whose facade plane set the direction, when there was one. */
  facadeElementId: string | null
  angleDeg: number
  swivelDeg: number
  /** Outward facade normal, forced horizontal — see {@link prism}. */
  normal: Vec3
  /** Horizontal in-plane direction, pointing from `lowerEdge[0]` to `[1]`. */
  lateral: Vec3
  /** The opening's lower edge, in the facade plane. */
  lowerEdge: [Vec3, Vec3]
  /** Sill height in the file's frame, metres. */
  sillZ: number
  halfSpaces: HalfSpace[]
  rays: PrismRay[]
  /** How far out the sample rays are traced, metres — the model's own diagonal. */
  reach: number
}

/** An element occupying a volume that was required to be free. */
export interface Obstruction {
  globalId: string
  name: string | null
  /**
   * How far the element reaches past the prism's inclined plane, measured
   * PERPENDICULAR to that plane, metres.
   *
   * Read it as: move this element that far along the incline's normal and it
   * clears the prism. It is not the overhang depth and not a distance from the
   * window — for the overhang use {@link overhang}, which measures against the
   * facade plane and is the number an Auskragungs-rule is written on.
   */
  intrusionDepth: number
}

/** First surface a ray meets. */
export interface RayHit {
  /** GlobalId of the element hit. */
  hit: string
  point: Vec3
  distance: number
}

/** The composed daylight geometry — still no verdict. See {@link freeLightIncidence}. */
export interface LightIncidence {
  free: boolean
  blockedBy: Obstruction[]
  worstAngleDeg: number | null
}

// ── facade plane ────────────────────────────────────────────────────────────

/**
 * The element's facade plane, with its normal pointing away from the building.
 *
 * The reference plane every other operator in this module measures from, which
 * is why it does more work than reading `ElementGeometry.facade` back:
 *
 *  1. **Orientation.** `facade.normal` points into the solid on this kernel (see
 *     the module header), so it is re-oriented against `planCentre` — the
 *     direction from the model's plan centre to the element's centroid. When
 *     that direction is degenerate (an interior wall standing near the middle of
 *     the plan) the answer says `outward: false` and carries a caveat rather
 *     than picking a side and sounding certain.
 *  2. **Seating.** The plane is moved onto the OUTERMOST face of the element
 *     that is parallel to it. `facade.point` is an area-weighted average over
 *     every face sharing a quantised normal, so on a layered wall it lands
 *     inside the masonry, and on a two-leaf wall it lands on whichever leaf won
 *     a coin flip. The outermost parallel face is unique, is a real surface, and
 *     is the plane an architect means by "die Fassade".
 *
 * Slivers cannot win the seating: a face carries the plane only if it holds at
 * least {@link FACE_AREA_FRACTION} of the largest parallel face's area, so a
 * 3 cm chamfer or a reveal return does not move the facade 3 cm outward.
 *
 * Without retained triangles this degrades to the bounding box's outermost
 * vertical face, which is right for an axis-aligned wall and wrong by up to 45°
 * for a rotated one — hence the caveat, which a caller must not drop.
 */
export function facadePlaneOf(graph: BuildingGraph, geometry: GeometryIndex, globalId: string): Answer<OrientedPlane> {
  const method = `facadePlaneOf(${globalId})`
  requireNode(graph, globalId, method)

  const geo = geometry.elements.get(globalId)
  if (!geo) return noGeometry<OrientedPlane>(globalId, method)

  const centre = geometry.planCentre
  if (!centre) {
    return undecidable<OrientedPlane>({
      from: [globalId],
      method,
      provenance: 'computed',
      missing: {
        what: 'Modellausdehnung (kein Bauteil mit Geometrie)',
        remedy: 'Ohne Grundriss-Mittelpunkt lässt sich "außen" nicht bestimmen — Modell mit Volumenkörpern exportieren',
      },
    })
  }

  // The outward direction, decided in plan only: a facade plane is vertical, so
  // the z component of the centroid-to-centre vector carries no information
  // about which side is outside and would only add noise on a sloping wall.
  const span: [number, number] = [geo.centroid[0] - centre[0], geo.centroid[1] - centre[1]]
  const spanLength = Math.hypot(span[0], span[1])

  if (!geo.triangles) {
    const seated = boxFacade(geo.box, span)
    if (!seated) {
      return undecidable<OrientedPlane>({
        from: [globalId],
        method,
        provenance: 'computed',
        missing: {
          what: 'senkrechte Fläche (Bauteil ohne Dreiecksnetz und ohne Grundrissausdehnung)',
          remedy: 'Geometriepass ohne Kappung laufen lassen (maxRetainedTriangles erhöhen)',
        },
      })
    }
    const outward = spanLength >= OUTWARD_MIN_SPAN && Math.abs(dot2(seated.normal, span) / spanLength) >= OUTWARD_MIN_DOT
    return computed<OrientedPlane>(
      { normal: seated.normal, point: seated.point, seatedArea: seated.area, outward },
      {
        unit: 'm',
        tolerance: BOX_TOLERANCE,
        from: [globalId],
        method,
        caveat:
          'Für dieses Bauteil wurden keine Dreiecke aufbewahrt; die Fassadenebene stammt aus der Bounding Box und ' +
          'ist achsparallel angenommen. Bei einer schräg im Grundriss stehenden Wand ist die Richtung um bis zu 45° falsch. ' +
          'Als Maß nicht belastbar.' + (outward ? '' : ' Zusätzlich ließ sich die Außenseite nicht bestimmen.'),
      }
    )
  }

  const base = geo.facade
  if (!base) {
    return undecidable<OrientedPlane>({
      from: [globalId],
      method,
      provenance: 'computed',
      missing: {
        what: `senkrechte Fläche an ${globalId}`,
        remedy:
          'facadePlaneOf() erwartet ein Bauteil mit senkrechter Fläche (Wand, Fassadenelement, Öffnung); ' +
          'ein Dach oder eine Decke hat keine — dafür ist dominant (größte Ebene beliebiger Lage) gedacht',
        elements: [globalId],
      },
    })
  }

  // Orient in plan, then flatten: a facade plane that leans a degree or two out
  // of plumb would tilt every prism built on it, and the light prism's angles are
  // defined against the horizon, not against the wall.
  const leaning = Math.abs(base.normal[2])
  let normal: Vec3 = [base.normal[0], base.normal[1], 0]
  const horizontal = Math.hypot(normal[0], normal[1])
  if (horizontal < 1e-9) {
    return undecidable<OrientedPlane>({
      from: [globalId],
      method,
      provenance: 'computed',
      missing: {
        what: `waagrechte Normale der Fassadenebene an ${globalId}`,
        remedy: 'Die größte "senkrechte" Fläche dieses Bauteils steht waagrecht — für Dächer und Decken ist facadePlaneOf() nicht zuständig',
        elements: [globalId],
      },
    })
  }
  normal = [normal[0] / horizontal, normal[1] / horizontal, 0]
  if (dot2(normal, span) < 0) normal = [-normal[0], -normal[1], 0]
  const outward = spanLength >= OUTWARD_MIN_SPAN && Math.abs(dot2(normal, span) / spanLength) >= OUTWARD_MIN_DOT

  const seated = outermostParallelFace(geo.triangles, normal)
  if (!seated) {
    return undecidable<OrientedPlane>({
      from: [globalId],
      method,
      provenance: 'computed',
      missing: {
        what: `Fläche parallel zur Fassadenebene an ${globalId}`,
        remedy: 'Das Bauteil hat keine zusammenhängende Fläche in dieser Richtung — Geometrie prüfen',
        elements: [globalId],
      },
    })
  }

  const caveats: string[] = []
  if (!outward) {
    caveats.push(
      'Die Außenseite ließ sich nicht bestimmen: das Bauteil steht zu nahe am Grundriss-Mittelpunkt ' +
        '(Innenwand?). Die Normale ist geraten — jedes damit gemessene Vorzeichen ebenso.'
    )
  }
  if (leaning > PLUMB_TOLERANCE) {
    caveats.push(
      `Die Fassadenfläche steht nicht lotrecht (Neigung ${(Math.asin(Math.min(1, leaning)) * (180 / Math.PI)).toFixed(1)}°); ` +
        'die Bezugsebene wurde für die Winkelkonstruktion senkrecht gestellt.'
    )
  }

  return computed<OrientedPlane>(
    { normal, point: seated.point, seatedArea: seated.area, outward },
    {
      unit: 'm',
      tolerance: TESSELLATION_TOLERANCE,
      from: [globalId],
      method,
      ...(caveats.length > 0 ? { caveat: caveats.join(' ') } : {}),
    }
  )
}

// ── overhang ────────────────────────────────────────────────────────────────

/**
 * How far one element projects past another's facade plane, metres.
 *
 * **This is the number the product could not produce.** Asked how far the roof
 * projects, the agent said *"Das Modell liefert keine zuverlässig auslesbare
 * Überstandstiefe"* and compressed it to *"Überstand im IFC nicht messbar"*. It
 * is measurable: the roof's vertices and the wall's outer face are both in the
 * file, and the projection is the largest positive signed distance from that
 * plane to any of them.
 *
 * Measured against {@link facadePlaneOf}, so it inherits that operator's
 * corrections — which are not cosmetic here. Measured against
 * `ElementGeometry.facade` as the geometry pass reports it, the sample house's
 * roof would come out 0.92 m past the north wall instead of 0.65 m, because the
 * binned plane sits on the wall's inner leaf.
 *
 * ## Degradation
 *
 * With triangles, the maximum runs over every vertex — exact for the mesh. With
 * none, it runs over the eight box corners, which on a pitched or curved roof
 * OVERSTATES the projection (the box's corner is above and beyond the eave the
 * roof actually has). That fallback is reported with a caveat and a tolerance an
 * order of magnitude worse, because an overestimate that passes silently as a
 * measurement is how a compliant design gets reported as failing.
 *
 * A negative maximum — the element never reaches the plane — is returned as 0
 * with a caveat naming the gap, since "projects −0.4 m" is not a sentence.
 */
export function overhang(
  graph: BuildingGraph,
  geometry: GeometryIndex,
  projectingId: string,
  facadeElementId: string
): Answer<number> {
  const method = `overhang(${projectingId}, facadePlaneOf(${facadeElementId}))`
  requireNode(graph, projectingId, method)
  requireNode(graph, facadeElementId, method)

  const planeAnswer = facadePlaneOf(graph, geometry, facadeElementId)
  if (!planeAnswer.decidable || !planeAnswer.value) {
    return undecidable<number>({
      from: [projectingId, facadeElementId],
      method,
      provenance: 'computed',
      missing: planeAnswer.missing ?? {
        what: `Fassadenebene von ${facadeElementId}`,
        remedy: 'Ohne Bezugsebene ist kein Überstand messbar',
      },
    })
  }
  const plane = planeAnswer.value

  const geo = geometry.elements.get(projectingId)
  if (!geo) return noGeometry<number>(projectingId, method)

  // `area: 0` rather than `plane.seatedArea`: `signedDistance` requires the
  // field to satisfy `Plane` and never reads it (line ~1256 already passes 0).
  // Handing it the seated bin's area would move no number and would plant the
  // misreading the rename above exists to remove.
  const reference = { normal: plane.normal, point: plane.point, area: 0 }
  let max = -Infinity
  if (geo.triangles) {
    const t = geo.triangles
    for (let i = 0; i < t.length; i += 3) {
      const d = signedDistance([t[i]!, t[i + 1]!, t[i + 2]!], reference)
      if (d > max) max = d
    }
  } else {
    for (const corner of boxCorners(geo.box)) {
      const d = signedDistance(corner, reference)
      if (d > max) max = d
    }
  }

  const caveats: string[] = []
  if (!geo.triangles) {
    caveats.push(
      'Für dieses Bauteil wurden keine Dreiecke aufbewahrt; gemessen wurde an den Ecken der Bounding Box. ' +
        'Bei einem geneigten oder gekrümmten Dach ist das eine OBERGRENZE, keine Messung.'
    )
  }
  if (!plane.outward) caveats.push(planeAnswer.caveat ?? 'Die Außenseite der Bezugsebene ist ungesichert.')
  if (max < 0) {
    caveats.push(
      `Das Bauteil erreicht die Fassadenebene nicht — es bleibt ${Math.abs(max).toFixed(3)} m dahinter. ` +
        'Gemeldet ist 0, nicht ein negativer Überstand.'
    )
  }

  return computed(Math.max(0, max), {
    unit: 'm',
    tolerance: geo.triangles ? TESSELLATION_TOLERANCE : BOX_TOLERANCE,
    from: [projectingId, facadeElementId],
    method,
    ...(caveats.length > 0 ? { caveat: caveats.join(' ') } : {}),
  })
}

// ── ray ─────────────────────────────────────────────────────────────────────

/**
 * First surface hit along a ray — position and distance, after `select_ray`.
 *
 * §3.1's `geom.tree.select_ray(origin, direction, length)` reports the hit
 * position, the distance and the surface normal; this reports the first two and
 * the element that owns the surface, which is the part a language agent can use
 * (a normal it cannot name is not an answer to anything it was asked).
 *
 * Möller–Trumbore, run **double-sided**. Not a shortcut: this kernel's winding
 * points into the solid (module header, finding 1), so back-face culling would
 * discard exactly the front faces and report the far wall of a room instead of
 * the near one.
 *
 * `null` with `decidable: true` is the real answer "nothing in the way" — the
 * distinction from `decidable: false` ("this model has no surfaces to test") is
 * the whole point of the envelope, and a caller that reads a falsy value as
 * "free" collapses them.
 *
 * Elements whose triangles the pass dropped are NOT intersected as boxes: a box
 * hit reports a point that lies on no surface, and a false hit is worse than a
 * named gap. They are listed in the caveat instead, so the caller knows the ray
 * passed through untested volume.
 */
export function ray(
  graph: BuildingGraph,
  geometry: GeometryIndex,
  origin: Vec3,
  direction: Vec3,
  length?: number,
  exclude?: string[]
): Answer<RayHit | null> {
  const method = `ray([${fmtVec(origin)}], [${fmtVec(direction)}]${length !== undefined ? `, ${length}` : ''})`

  const dirLength = Math.hypot(direction[0], direction[1], direction[2])
  if (!(dirLength > 1e-9) || !origin.every(Number.isFinite)) {
    // Follows topology.ts' wrongKind precedent: a mis-aimed call is answered,
    // not thrown, because the caller is an agent and one line of correction is
    // cheaper than one lost turn.
    return undecidable<RayHit | null>({
      from: [],
      method,
      provenance: 'computed',
      missing: {
        what: 'brauchbarer Strahl (Richtung ≠ 0, endlicher Ursprung)',
        remedy: 'ray() mit einem Richtungsvektor ungleich Null und endlichen Koordinaten aufrufen',
      },
    })
  }
  const d: Vec3 = [direction[0] / dirLength, direction[1] / dirLength, direction[2] / dirLength]
  const reach = length ?? modelDiagonal(geometry)

  const skip = new Set(exclude ?? [])
  let anyTriangles = false
  let best: RayHit | null = null
  const untested: string[] = []

  for (const [globalId, geo] of geometry.elements) {
    if (skip.has(globalId)) continue
    const n = node(graph, globalId)
    if (!n || !isSolid(n)) continue
    if (!hitsBox(geo.box, origin, d, reach)) continue
    if (!geo.triangles) {
      untested.push(globalId)
      continue
    }
    anyTriangles = true
    const t = geo.triangles
    for (let i = 0; i < t.length; i += 9) {
      const distance = intersectTriangle(origin, d, t, i)
      if (distance === null || distance > reach) continue
      if (!best || distance < best.distance) {
        best = {
          hit: globalId,
          point: [origin[0] + d[0] * distance, origin[1] + d[1] * distance, origin[2] + d[2] * distance],
          distance,
        }
      }
    }
  }

  if (!anyTriangles && geometry.stats.retainedTriangles === 0) {
    return undecidable<RayHit | null>({
      from: [],
      method,
      provenance: 'computed',
      missing: {
        what: 'Dreiecksnetze (Geometriepass hat keine aufbewahrt)',
        remedy: 'Geometriepass mit höherem maxRetainedTriangles laufen lassen — ein Strahl braucht Flächen, eine Box genügt nicht',
      },
    })
  }

  return computed<RayHit | null>(best, {
    unit: best ? 'm' : null,
    tolerance: best ? TESSELLATION_TOLERANCE : null,
    from: best ? [best.hit] : [],
    method,
    ...(untested.length > 0
      ? {
          caveat:
            `${untested.length} Bauteil(e) im Strahlengang hatten kein aufbewahrtes Dreiecksnetz und wurden NICHT geprüft ` +
            `(${untested.slice(0, 5).join(', ')}${untested.length > 5 ? ' …' : ''}). Ein Treffer an ihnen fehlt in diesem Ergebnis.`,
        }
      : {}),
  })
}

// ── prism ───────────────────────────────────────────────────────────────────

/**
 * The light prism of a light opening — a construction, not a check.
 *
 * See {@link PrismVolume} for the geometry and for why it is anchored at the
 * lower edge. What this function adds is the binding of that construction to a
 * real opening in a real file:
 *
 *  - **Which element.** Either the `IfcOpeningElement` (the light-entry opening
 *    §10 wants the area of) or its filler. The opening is the better subject —
 *    a window's own solid includes its frame, which projects past the facade and
 *    would otherwise stand in its own prism — and {@link obstructions} excludes
 *    the pair either way.
 *  - **Which direction.** The host wall's facade plane when the graph can reach
 *    one through `voids`/`fills`, because a wall's facade is decided by tens of
 *    square metres while an opening's is decided by one or two, and a narrow
 *    tall opening in a thick wall can have jamb faces larger than its own face.
 *    Falls back to the opening's own plane, and says which was used in `method`.
 *  - **Where the plane sits.** On the OPENING's outermost face, even when the
 *    direction came from the wall. Light enters at the opening, and seating the
 *    prism on the wall's outer face would shift it by the reveal depth of a
 *    recessed window — in the wrong direction, hiding the reveal's own shading.
 *
 * The angles are parameters. This function knows how to build a prism at
 * `angleDeg` with `swivelDeg` of lateral flare; it does not know that OIB 3
 * says 45 and 30, and it must not, or the next clause with different numbers
 * would need a different geometry engine.
 */
export function prism(
  graph: BuildingGraph,
  geometry: GeometryIndex,
  openingId: string,
  angleDeg: number,
  swivelDeg: number
): Answer<PrismVolume> {
  const method = `prism(${openingId}, ${angleDeg}, ${swivelDeg})`
  requireNode(graph, openingId, method)

  if (!(angleDeg > 0 && angleDeg < 90) || !(swivelDeg >= 0 && swivelDeg < 90)) {
    return undecidable<PrismVolume>({
      from: [openingId],
      method,
      provenance: 'computed',
      missing: {
        what: 'brauchbare Winkel (0° < angleDeg < 90°, 0° ≤ swivelDeg < 90°)',
        remedy: 'Die Winkel kommen aus der Bestimmung, nicht aus dem Modell — prism() mit den Werten der Klausel aufrufen',
        elements: [openingId],
      },
    })
  }

  const geo = geometry.elements.get(openingId)
  if (!geo) return noGeometry<PrismVolume>(openingId, method)

  const host = hostOf(graph, openingId)
  const planeSource = host ?? openingId
  const planeAnswer = facadePlaneOf(graph, geometry, planeSource)
  if (!planeAnswer.decidable || !planeAnswer.value) {
    // Retry on the opening itself before giving up: a host wall with no retained
    // triangles must not take the opening's own usable plane down with it.
    const own = planeSource === openingId ? planeAnswer : facadePlaneOf(graph, geometry, openingId)
    if (!own.decidable || !own.value) {
      return undecidable<PrismVolume>({
        from: [openingId, ...(host ? [host] : [])],
        method,
        provenance: 'computed',
        missing: own.missing ?? {
          what: `Fassadenebene für ${openingId}`,
          remedy: 'Ohne Fassadenebene ist die Richtung des Prismas unbestimmt',
        },
      })
    }
    return buildPrism(geometry, openingId, null, own, angleDeg, swivelDeg, method, geo)
  }

  return buildPrism(geometry, openingId, host, planeAnswer, angleDeg, swivelDeg, method, geo)
}

function buildPrism(
  geometry: GeometryIndex,
  openingId: string,
  facadeElementId: string | null,
  planeAnswer: Answer<OrientedPlane>,
  angleDeg: number,
  swivelDeg: number,
  method: string,
  geo: ElementGeometry
): Answer<PrismVolume> {
  const plane = planeAnswer.value!
  const n = plane.normal
  // Right-handed in-plane horizontal: {lateral, normal, up} is orthonormal, so a
  // point decomposes into (u, v, w) by three dot products and reassembles the
  // same way — the whole prism is built in those coordinates.
  const lateral = normalize(cross([0, 0, 1], n))

  const points: Vec3[] = geo.triangles ? verticesOf(geo.triangles) : boxCorners(geo.box)
  let uMin = Infinity
  let uMax = -Infinity
  let vMax = -Infinity
  let zMin = Infinity
  for (const p of points) {
    const u = dot(p, lateral)
    const v = dot(p, n)
    if (u < uMin) uMin = u
    if (u > uMax) uMax = u
    if (v > vMax) vMax = v
    if (p[2] < zMin) zMin = p[2]
  }

  const at = (u: number, v: number, w: number): Vec3 => [
    lateral[0] * u + n[0] * v,
    lateral[1] * u + n[1] * v,
    w,
  ]
  const left = at(uMin, vMax, zMin)
  const right = at(uMax, vMax, zMin)

  const a = (angleDeg * Math.PI) / 180
  const s = (swivelDeg * Math.PI) / 180
  const halfSpaces: HalfSpace[] = [
    { role: 'facade', normal: n, point: left },
    // Above the incline: in (v, w) about the edge, w·cos a − v·sin a ≥ 0.
    { role: 'incline', normal: normalize([-Math.sin(a) * n[0], -Math.sin(a) * n[1], Math.cos(a)]), point: left },
    { role: 'lateralLeft', normal: normalize(addScaled(scale(lateral, Math.cos(s)), n, Math.sin(s))), point: left },
    { role: 'lateralRight', normal: normalize(addScaled(scale(lateral, -Math.cos(s)), n, Math.sin(s))), point: right },
  ]

  const reach = modelDiagonal(geometry)
  const rays: PrismRay[] = []
  const swivels = swivelDeg > 0 ? [-swivelDeg, -swivelDeg / 2, 0, swivelDeg / 2, swivelDeg] : [0]
  for (const origin of [left, midpoint(left, right), right]) {
    for (const phi of swivels) {
      const r = (phi * Math.PI) / 180
      const horizontal = normalize([
        Math.cos(r) * n[0] + Math.sin(r) * lateral[0],
        Math.cos(r) * n[1] + Math.sin(r) * lateral[1],
        0,
      ])
      rays.push({
        origin,
        direction: normalize([Math.cos(a) * horizontal[0], Math.cos(a) * horizontal[1], Math.sin(a)]),
        swivelDeg: phi,
      })
    }
  }

  const from = [openingId, ...(facadeElementId ? [facadeElementId] : [])]
  const caveats: string[] = []
  if (planeAnswer.caveat) caveats.push(planeAnswer.caveat)
  if (!facadeElementId) {
    caveats.push(
      'Kein Wandbauteil über voids/fills erreichbar — die Richtung stammt aus der Öffnung selbst. ' +
        'Bei einer schmalen, tiefen Öffnung kann die größte senkrechte Fläche eine Laibung statt der Öffnungsfläche sein.'
    )
  }
  if (!geo.triangles) {
    caveats.push('Die Öffnung hat kein aufbewahrtes Dreiecksnetz; Unterkante und Breite stammen aus der Bounding Box.')
  }

  return computed<PrismVolume>(
    {
      openingId,
      facadeElementId,
      angleDeg,
      swivelDeg,
      normal: n,
      lateral,
      lowerEdge: [left, right],
      sillZ: zMin,
      halfSpaces,
      rays,
      reach,
    },
    {
      unit: 'm',
      tolerance: geo.triangles ? TESSELLATION_TOLERANCE : BOX_TOLERANCE,
      from,
      method: facadeElementId ? `${method} über facadePlaneOf(${facadeElementId})` : `${method} über facadePlaneOf(${openingId})`,
      ...(caveats.length > 0 ? { caveat: caveats.join(' ') } : {}),
    }
  )
}

// ── obstructions ────────────────────────────────────────────────────────────

/**
 * Elements occupying the prism, and how deep each reaches into it.
 *
 * After `geom.tree.select(shape, extend=…)` and Solibri's free-area check: the
 * question is not "does anything touch this volume" but "what, and by how much",
 * because the second form is the only one a design decision can be made from.
 *
 * ## What is tested, and how exactly
 *
 * Every candidate triangle is **clipped** against the prism's half-spaces
 * (Sutherland–Hodgman; the volume is convex, so the clip is exact), and the
 * depth is the maximum of a linear function over the clipped polygon — attained
 * at a vertex, so the maximum over the clipped vertices is the true maximum over
 * the intersection. A vertex-inside test would have missed this file entirely:
 * the sample house's roof is 376 triangles over 108 m², and a triangle spanning
 * the whole prism can have every corner outside it.
 *
 * ## What is never a candidate
 *
 *  - **Spaces.** An `IfcSpace` is air. A room reported as blocking the light of
 *    its own window would be a category error, and every window has one.
 *  - **Openings.** An `IfcOpeningElement` is a subtraction, not a solid.
 *  - **The subject opening and its filler**, always: a window's frame projects a
 *    few centimetres past the facade — 40 mm on this file — and would report
 *    itself as its own obstruction.
 *
 * The **host wall** is not auto-excluded, because a recessed window genuinely is
 * shaded by its own reveal and that is a real finding. It is what `exclude` is
 * for, and a caller checking a flush window must pass it: a wall whose outer
 * face is COPLANAR with the prism's base plane still meets the volume, and on
 * the sample house the unexcluded north wall reports a 0.98 m intrusion off a
 * face of zero thickness. The wall a window sits in is always "in the way" of
 * that window; only the caller knows whether that is the finding it wanted.
 */
export function obstructions(
  graph: BuildingGraph,
  geometry: GeometryIndex,
  volume: PrismVolume,
  exclude?: string[]
): Answer<Obstruction[]> {
  const method = `obstructions(prism(${volume.openingId}, ${volume.angleDeg}, ${volume.swivelDeg})${
    exclude && exclude.length > 0 ? `, exclude: [${exclude.join(', ')}]` : ''
  })`

  const skip = selfExclusions(graph, volume.openingId)
  for (const id of exclude ?? []) skip.add(id)

  const swept = sweep(graph, geometry, volume, skip)
  const found = swept.hits
    .filter((h) => h.depth > MIN_INTRUSION)
    .sort((x, y) => y.depth - x.depth)
    .map<Obstruction>((h) => ({ globalId: h.globalId, name: h.name, intrusionDepth: round(h.depth) }))

  const caveats: string[] = []
  if (swept.boxOnly.length > 0) {
    caveats.push(
      `${swept.boxOnly.length} Bauteil(e) ohne aufbewahrtes Dreiecksnetz wurden als Bounding Box geprüft ` +
        `(${swept.boxOnly.slice(0, 5).join(', ')}${swept.boxOnly.length > 5 ? ' …' : ''}); ` +
        'deren Eindringtiefe ist eine Obergrenze, keine Messung.'
    )
  }
  if (geometry.stats.trianglesTruncated) {
    caveats.push('Der Geometriepass hat Dreiecke gekappt (trianglesTruncated) — das Ergebnis kann Bauteile übersehen.')
  }

  return computed(found, {
    unit: 'm',
    tolerance: swept.boxOnly.length > 0 ? BOX_TOLERANCE : TESSELLATION_TOLERANCE,
    from: [volume.openingId, ...found.map((f) => f.globalId)],
    method,
    ...(caveats.length > 0 ? { caveat: caveats.join(' ') } : {}),
  })
}

// ── the composed check ──────────────────────────────────────────────────────

/**
 * Is the light prism of this opening free, and if not, by how much is it missed.
 *
 * The composition §7 promises — `hostedIn` → `facadePlaneOf` → `prism` →
 * `obstructions` — behind one call, because that chain is four chances for an
 * agent to bind an argument wrongly and the answer to the architect's question
 * is one object.
 *
 * ## `worstAngleDeg`, and why it is not a second boolean
 *
 * "Blocked" tells an architect they failed. The shallowest elevation at which
 * the prism WOULD be free tells them how far off they are, and it is a different
 * computation: it scans the same lateral band with the incline removed and takes
 * the steepest sight line any solid occupies, `atan(max Δz / Δn)` over every
 * clipped point in front of the facade. Below `angleDeg` the prism is free with
 * that much margin; above it, that is the angle the design would have to reach.
 *
 * It is `null` in exactly one situation, and it is a common one: an obstruction
 * that MEETS the facade plane above the sill leaves no elevation under 90° that
 * frees the prism, because the ratio diverges. A roof overhang always does this
 * — it is continuous through the wall. Reporting 89.7° there would be arithmetic
 * dressed as advice; the caveat says so and points at {@link overhang}, whose
 * metres are what an Auskragungs-rule is written on.
 *
 * ## Still no verdict
 *
 * `free: false` means the constructed volume is not empty. §11: a blocked prism
 * ENLARGES the required Lichteintrittsfläche rather than banning the window. The
 * percentage, the depth surcharge and the conclusion belong to the rulebook;
 * this returns the geometry the rulebook needs and stops.
 */
export function freeLightIncidence(
  graph: BuildingGraph,
  geometry: GeometryIndex,
  openingId: string,
  opts: { angleDeg: number; swivelDeg: number; exclude?: string[] }
): Answer<LightIncidence> {
  const method =
    `freeLightIncidence(${openingId}, ${opts.angleDeg}°, ±${opts.swivelDeg}°` +
    `${opts.exclude && opts.exclude.length > 0 ? `, exclude: [${opts.exclude.join(', ')}]` : ''})`

  const volumeAnswer = prism(graph, geometry, openingId, opts.angleDeg, opts.swivelDeg)
  if (!volumeAnswer.decidable || !volumeAnswer.value) {
    return undecidable<LightIncidence>({
      from: [openingId],
      method,
      provenance: 'computed',
      missing: volumeAnswer.missing ?? {
        what: `Lichtprisma für ${openingId}`,
        remedy: 'Ohne Prisma keine Aussage über den Lichteinfall',
      },
    })
  }
  const volume = volumeAnswer.value

  const skip = selfExclusions(graph, openingId)
  for (const id of opts.exclude ?? []) skip.add(id)
  const swept = sweep(graph, geometry, volume, skip)

  const blockedBy = swept.hits
    .filter((h) => h.depth > MIN_INTRUSION)
    .sort((x, y) => y.depth - x.depth)
    .map<Obstruction>((h) => ({ globalId: h.globalId, name: h.name, intrusionDepth: round(h.depth) }))

  const contact = swept.hits.some((h) => h.contact)
  let ratio = -Infinity
  for (const h of swept.hits) if (h.ratio > ratio) ratio = h.ratio
  const horizonDeg = Number.isFinite(ratio) ? (Math.atan(Math.max(0, ratio)) * 180) / Math.PI : 0
  const worstAngleDeg = contact || horizonDeg >= NEAR_VERTICAL_DEG ? null : round(horizonDeg, 1)

  const caveats: string[] = []
  if (volumeAnswer.caveat) caveats.push(volumeAnswer.caveat)
  if (swept.boxOnly.length > 0) {
    caveats.push(
      `${swept.boxOnly.length} Bauteil(e) ohne Dreiecksnetz wurden als Bounding Box geprüft ` +
        `(${swept.boxOnly.slice(0, 5).join(', ')}${swept.boxOnly.length > 5 ? ' …' : ''}) — Eindringtiefen sind dort Obergrenzen.`
    )
  }
  if (worstAngleDeg === null) {
    caveats.push(
      'Kein flacherer Winkel macht das Prisma frei: ein Bauteil reicht bis an die Fassadenebene über der Fensterbrüstung ' +
        '(bei einem Dachüberstand ist das der Normalfall). Die belastbare Zahl ist hier der Überstand — overhang() — nicht ein Winkel.'
    )
  }
  caveats.push(
    'Diese Antwort ist Geometrie, kein Befund: ein geschnittenes Prisma vergrößert nach OIB 3 die erforderliche ' +
      'Lichteintrittsfläche, es verbietet das Fenster nicht. Die Bewertung gehört zum Regelwerk.'
  )

  return computed<LightIncidence>(
    { free: blockedBy.length === 0, blockedBy, worstAngleDeg },
    {
      unit: '°',
      tolerance: ANGLE_TOLERANCE_DEG,
      from: [openingId, ...(volume.facadeElementId ? [volume.facadeElementId] : []), ...blockedBy.map((b) => b.globalId)],
      method,
      caveat: caveats.join(' '),
    }
  )
}

// ── the sweep behind obstructions() and freeLightIncidence() ────────────────

interface SweepHit {
  globalId: string
  name: string | null
  /** Max distance past the inclined plane, metres. Negative: below it. */
  depth: number
  /** Max Δz/Δn over clipped points in front of the facade — the sight line. */
  ratio: number
  /** True when the element reaches the facade plane itself above the sill. */
  contact: boolean
}

/**
 * One clipping pass that serves both the volume test and the horizon.
 *
 * Deliberately clipped against the facade and the two lateral planes ONLY, with
 * the incline evaluated afterwards as a depth. Clipping against the incline as
 * well would discard everything below it — and everything below it is exactly
 * what sets `worstAngleDeg` when the prism turns out to be free. One pass, two
 * answers, and no chance of the two disagreeing about which elements were even
 * looked at.
 */
function sweep(
  graph: BuildingGraph,
  geometry: GeometryIndex,
  volume: PrismVolume,
  skip: Set<string>
): { hits: SweepHit[]; boxOnly: string[] } {
  const bounds = volume.halfSpaces.filter((h) => h.role !== 'incline')
  const incline = volume.halfSpaces.find((h) => h.role === 'incline')!
  const facade = volume.halfSpaces.find((h) => h.role === 'facade')!
  const edge = volume.lowerEdge[0]

  const hits: SweepHit[] = []
  const boxOnly: string[] = []

  for (const [globalId, geo] of geometry.elements) {
    if (skip.has(globalId)) continue
    const n = node(graph, globalId)
    if (!n || !isSolid(n)) continue
    if (boxOutside(geo.box, bounds)) continue

    const triangles = geo.triangles ?? boxTriangles(geo.box)
    if (!geo.triangles) boxOnly.push(globalId)

    let depth = -Infinity
    let ratio = -Infinity
    let contact = false
    let touched = false

    for (let i = 0; i < triangles.length; i += 9) {
      let poly: Vec3[] = [
        [triangles[i]!, triangles[i + 1]!, triangles[i + 2]!],
        [triangles[i + 3]!, triangles[i + 4]!, triangles[i + 5]!],
        [triangles[i + 6]!, triangles[i + 7]!, triangles[i + 8]!],
      ]
      for (const bound of bounds) {
        poly = clip(poly, bound)
        if (poly.length === 0) break
      }
      if (poly.length === 0) continue
      touched = true
      for (const p of poly) {
        const dz = p[2] - edge[2]
        const dn = planeDistance(p, facade)
        const past = planeDistance(p, incline)
        if (past > depth) depth = past
        if (dn >= FACADE_CONTACT) {
          const r = dz / dn
          if (r > ratio) ratio = r
        } else if (dz > MIN_INTRUSION) {
          contact = true
        }
      }
    }

    if (!touched) continue
    hits.push({ globalId, name: n.longName ?? n.name, depth, ratio, contact })
  }

  return { hits, boxOnly: boxOnly.filter((id) => hits.some((h) => h.globalId === id)) }
}

/**
 * The opening itself plus whatever fills it, in both directions.
 *
 * `openingId` may be the `IfcOpeningElement` or the window that fills it, and
 * both must fall out of the candidate set either way — otherwise the answer to
 * "what blocks this window's light" is "this window".
 */
function selfExclusions(graph: BuildingGraph, openingId: string): Set<string> {
  const skip = new Set<string>([openingId])
  for (const id of out(graph, 'fills', openingId)) skip.add(id)
  for (const id of into(graph, 'fills', openingId)) skip.add(id)
  return skip
}

/** The wall a window or opening sits in, or null when the export lost the chain. */
function hostOf(graph: BuildingGraph, globalId: string): string | null {
  const n = node(graph, globalId)
  if (!n) return null
  if (n.kind === 'opening') return into(graph, 'voids', globalId)[0] ?? null
  return out(graph, 'hostedIn', globalId)[0] ?? null
}

/**
 * Solids only.
 *
 * Spaces are air and openings are subtractions; both have geometry and neither
 * blocks light. Groups and spatial containers have no shape of their own. What
 * remains — `kind === 'element'` — is what can stand in the way, including the
 * furniture an architect may well want excluded, which is the caller's call and
 * not ours.
 */
function isSolid(n: GraphNode): boolean {
  return n.kind === 'element'
}

// ── geometry helpers ────────────────────────────────────────────────────────

/**
 * The outermost face of an element parallel to `normal`.
 *
 * Triangles are binned by offset along the normal (both facings, since the
 * winding is unreliable), near-equal offsets are merged, slivers are dropped,
 * and the surviving bin with the greatest offset wins. That is the wall's outer
 * leaf, the opening's outer face, the roof's fascia — the surface an architect
 * points at, rather than the area-weighted average of every parallel face that
 * `measureTriangles` produces.
 */
function outermostParallelFace(
  triangles: Float64Array,
  normal: Vec3
): { point: Vec3; area: number; offset: number } | null {
  const bins: Array<{ offset: number; area: number; sum: Vec3 }> = []

  for (let i = 0; i < triangles.length; i += 9) {
    const ax = triangles[i]!, ay = triangles[i + 1]!, az = triangles[i + 2]!
    const bx = triangles[i + 3]!, by = triangles[i + 4]!, bz = triangles[i + 5]!
    const cx = triangles[i + 6]!, cy = triangles[i + 7]!, cz = triangles[i + 8]!
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    const doubled = Math.hypot(nx, ny, nz)
    if (doubled < 1e-12) continue
    if (Math.abs((nx * normal[0] + ny * normal[1] + nz * normal[2]) / doubled) < PARALLEL_DOT) continue

    const offset = ax * normal[0] + ay * normal[1] + az * normal[2]
    const area = doubled / 2
    const centroid: Vec3 = [(ax + bx + cx) / 3, (ay + by + cy) / 3, (az + bz + cz) / 3]
    const bin = bins.find((b) => Math.abs(b.offset - offset) <= FACE_MERGE)
    if (bin) {
      // Area-weighted so the merged offset tracks the dominant face rather than
      // drifting toward whichever sliver happened to be within FACE_MERGE.
      bin.offset = (bin.offset * bin.area + offset * area) / (bin.area + area)
      bin.area += area
      bin.sum[0] += centroid[0] * area
      bin.sum[1] += centroid[1] * area
      bin.sum[2] += centroid[2] * area
    } else {
      bins.push({ offset, area, sum: [centroid[0] * area, centroid[1] * area, centroid[2] * area] })
    }
  }

  if (bins.length === 0) return null
  const largest = bins.reduce((m, b) => Math.max(m, b.area), 0)
  const floor = Math.max(largest * FACE_AREA_FRACTION, MIN_FACE_AREA)
  const usable = bins.filter((b) => b.area >= floor)
  if (usable.length === 0) return null
  const winner = usable.reduce((best, b) => (b.offset > best.offset ? b : best))
  return {
    point: [winner.sum[0] / winner.area, winner.sum[1] / winner.area, winner.sum[2] / winner.area],
    area: winner.area,
    offset: winner.offset,
  }
}

/** The box's outermost vertical face in the direction of `span`. The degraded path. */
function boxFacade(box: Box, span: [number, number]): { normal: Vec3; point: Vec3; area: number } | null {
  const sx = box.max[0]! - box.min[0]!
  const sy = box.max[1]! - box.min[1]!
  const sz = box.max[2]! - box.min[2]!
  if (!(sz > 0) || (!(sx > 0) && !(sy > 0))) return null
  // The long side of a wall is its facade; the short side is its end. Choosing by
  // area rather than by which way `span` points keeps a wall's facade a facade
  // even for a wall that straddles the plan centre.
  const useX = sy > sx
  const normal: Vec3 = useX ? [span[0] >= 0 ? 1 : -1, 0, 0] : [0, span[1] >= 0 ? 1 : -1, 0]
  const point: Vec3 = [
    useX ? (normal[0] > 0 ? box.max[0]! : box.min[0]!) : (box.min[0]! + box.max[0]!) / 2,
    useX ? (box.min[1]! + box.max[1]!) / 2 : normal[1] > 0 ? box.max[1]! : box.min[1]!,
    (box.min[2]! + box.max[2]!) / 2,
  ]
  return { normal, point, area: (useX ? sy : sx) * sz }
}

/** Sutherland–Hodgman against one half-space. Exact: the prism is convex. */
function clip(poly: Vec3[], hs: HalfSpace): Vec3[] {
  const kept: Vec3[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!
    const b = poly[(i + 1) % poly.length]!
    const da = planeDistance(a, hs)
    const db = planeDistance(b, hs)
    if (da >= 0) kept.push(a)
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db)
      kept.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t])
    }
  }
  return kept
}

/**
 * Signed distance to a bounding plane that carries no area.
 *
 * Delegates to the geometry pass' {@link signedDistance} rather than repeating
 * the dot product, so a half-space and a {@link Plane} can never drift apart on
 * which side is positive.
 */
function planeDistance(p: Vec3, hs: { normal: Vec3; point: Vec3 }): number {
  return signedDistance(p, { normal: hs.normal, point: hs.point })
}

/** True when the box is entirely outside at least one half-space. Conservative. */
function boxOutside(box: Box, halfSpaces: HalfSpace[]): boolean {
  const corners = boxCorners(box)
  for (const hs of halfSpaces) {
    let anyInside = false
    for (const c of corners) {
      if (planeDistance(c, hs) >= 0) {
        anyInside = true
        break
      }
    }
    if (!anyInside) return true
  }
  return false
}

function boxCorners(box: Box): Vec3[] {
  const corners: Vec3[] = []
  for (const x of [box.min[0]!, box.max[0]!])
    for (const y of [box.min[1]!, box.max[1]!])
      for (const z of [box.min[2]!, box.max[2]!]) corners.push([x, y, z])
  return corners
}

/** The box as 12 triangles — the surface a box-only element is tested through. */
function boxTriangles(box: Box): Float64Array {
  const c = boxCorners(box)
  // Corner order from boxCorners: index bits are (x, y, z) high to low.
  const faces: Array<[number, number, number]> = [
    [0, 1, 3], [0, 3, 2], // x = min
    [4, 6, 7], [4, 7, 5], // x = max
    [0, 4, 5], [0, 5, 1], // y = min
    [2, 3, 7], [2, 7, 6], // y = max
    [0, 2, 6], [0, 6, 4], // z = min
    [1, 5, 7], [1, 7, 3], // z = max
  ]
  const out = new Float64Array(faces.length * 9)
  faces.forEach((face, f) => {
    face.forEach((corner, v) => {
      const p = c[corner]!
      out[f * 9 + v * 3] = p[0]
      out[f * 9 + v * 3 + 1] = p[1]
      out[f * 9 + v * 3 + 2] = p[2]
    })
  })
  return out
}

/** Möller–Trumbore, double-sided — see {@link ray} for why. */
function intersectTriangle(origin: Vec3, dir: Vec3, t: Float64Array, i: number): number | null {
  const ax = t[i]!, ay = t[i + 1]!, az = t[i + 2]!
  const e1x = t[i + 3]! - ax, e1y = t[i + 4]! - ay, e1z = t[i + 5]! - az
  const e2x = t[i + 6]! - ax, e2y = t[i + 7]! - ay, e2z = t[i + 8]! - az
  const px = dir[1] * e2z - dir[2] * e2y
  const py = dir[2] * e2x - dir[0] * e2z
  const pz = dir[0] * e2y - dir[1] * e2x
  const det = e1x * px + e1y * py + e1z * pz
  if (Math.abs(det) < 1e-12) return null
  const inv = 1 / det
  const tx = origin[0] - ax, ty = origin[1] - ay, tz = origin[2] - az
  const u = (tx * px + ty * py + tz * pz) * inv
  if (u < -1e-9 || u > 1 + 1e-9) return null
  const qx = ty * e1z - tz * e1y
  const qy = tz * e1x - tx * e1z
  const qz = tx * e1y - ty * e1x
  const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv
  if (v < -1e-9 || u + v > 1 + 1e-9) return null
  const distance = (e2x * qx + e2y * qy + e2z * qz) * inv
  return distance > 1e-9 ? distance : null
}

/** Slab test — the broad phase in front of every triangle loop. */
function hitsBox(box: Box, origin: Vec3, dir: Vec3, reach: number): boolean {
  let near = 0
  let far = reach
  for (let k = 0; k < 3; k++) {
    const o = origin[k]!
    const d = dir[k]!
    const lo = box.min[k]!
    const hi = box.max[k]!
    if (Math.abs(d) < 1e-12) {
      if (o < lo - 1e-6 || o > hi + 1e-6) return false
      continue
    }
    let t0 = (lo - o) / d
    let t1 = (hi - o) / d
    if (t0 > t1) [t0, t1] = [t1, t0]
    near = Math.max(near, t0)
    far = Math.min(far, t1)
    if (near > far) return false
  }
  return true
}

function verticesOf(triangles: Float64Array): Vec3[] {
  const points: Vec3[] = []
  for (let i = 0; i < triangles.length; i += 3) points.push([triangles[i]!, triangles[i + 1]!, triangles[i + 2]!])
  return points
}

function modelDiagonal(geometry: GeometryIndex): number {
  const b = geometry.bounds
  if (!b) return 100
  return Math.max(1, Math.hypot(b.max[0]! - b.min[0]!, b.max[1]! - b.min[1]!, b.max[2]! - b.min[2]!))
}

// ── small vector arithmetic ─────────────────────────────────────────────────

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
function dot2(a: Vec3, b: [number, number]): number {
  return a[0] * b[0] + a[1] * b[1]
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
function scale(a: Vec3, k: number): Vec3 {
  return [a[0] * k, a[1] * k, a[2] * k]
}
function addScaled(a: Vec3, b: Vec3, k: number): Vec3 {
  return [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]
}
function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2])
  return l < 1e-12 ? [0, 0, 0] : [a[0] / l, a[1] / l, a[2] / l]
}
function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
}
function round(n: number, digits = 3): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}
function fmtVec(v: Vec3): string {
  return v.map((n) => round(n, 2)).join(', ')
}

// ── guards ──────────────────────────────────────────────────────────────────

/**
 * The node, or a throw.
 *
 * Same contract as topology.ts: an id this model does not contain is not a fact
 * about the building, so it is an exception rather than an `undecidable` that a
 * renderer would print as "das Modell sagt dazu nichts".
 */
function requireNode(graph: BuildingGraph, globalId: string, method: string): GraphNode {
  const n = node(graph, globalId)
  if (!n) throw new UnknownElementError(globalId, method)
  return n
}

/**
 * The element exists in the graph and the geometry pass produced nothing for it.
 *
 * A finding about the EXPORT, not about the building: `IfcCurtainWall` on the
 * sample house has no shape of its own (its panels and mullions carry it), and a
 * type-only element such as `IfcDoorLiningProperties` never had one. Both are
 * worth telling the architect, and neither is an error.
 */
function noGeometry<T>(globalId: string, method: string): Answer<T> {
  const missing: MissingFact = {
    what: `Körpergeometrie für ${globalId}`,
    remedy:
      'Der Geometriepass liefert für dieses Bauteil keinen Körper — entweder trägt es seine Geometrie in Unterbauteilen ' +
      '(Fassade → Paneele, Pfosten) oder es wurde ohne Volumenkörper exportiert. Unterbauteile abfragen oder mit Körpern exportieren.',
    elements: [globalId],
  }
  return undecidable<T>({ from: [globalId], method, provenance: 'computed', missing })
}
