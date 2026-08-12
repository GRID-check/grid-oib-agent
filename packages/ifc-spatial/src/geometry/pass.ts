/**
 * The geometry pass: triangles in, measurable facts out.
 *
 * ## Why this exists at all
 *
 * Phase 0 recovers what the file *states* — this window fills that opening in
 * that wall. It cannot answer a single question with a number in it, because
 * numbers about arrangements come from coordinates and an IFC's coordinates
 * live inside swept solids, boolean subtractions and nested placements that
 * only a geometry kernel can resolve.
 *
 * Running one server-side was long treated as off-limits here on the grounds
 * that geometry is the renderer's job. That is true of *pictures*. It is not
 * true of *reasoning*: the overhang an architect asks about is a number, not an
 * image, and no amount of metadata substitutes for it. What this module
 * produces is a few hundred bytes per element — a box, a centroid, a floor
 * area, a plane — not a mesh cache to keep in step with the file.
 *
 * ## The frame, which is where this goes wrong silently
 *
 * The kernel emits **Y-up** (the glTF convention) while IFC is **Z-up**. Every
 * vertex is therefore converted once, here, by the axis swap alone:
 *
 *     ifc.x = k.x     ifc.y = -k.z     ifc.z = k.y
 *
 * Verified rather than assumed: on a sample house whose storeys are declared at
 * 0.00 and 2.50, the ground-floor walls come back spanning ifc.z 0.00–2.47. A
 * frame error would put them somewhere plausible and wrong, and every answer
 * downstream would inherit it with full confidence.
 *
 * ## The RTC shift, which used to be read from the wrong field and applied in
 * the wrong frame
 *
 * For a model authored in survey coordinates the kernel re-bases geometry near
 * the origin — float32 has ~7 significant digits and an easting of 417 596 m
 * leaves nothing for millimetres. It reports what it subtracted, and this
 * module used to add back `coordinateInfo.originShift` **before** the axis swap:
 *
 *     ifc.x = k.x + shift.x   ifc.y = -(k.z + shift.z)   ifc.z = k.y + shift.y
 *
 * Two defects, neither of which the sample house could show, because its shift
 * is zero:
 *
 *  1. `originShift` is the field the kernel's JS batch path uses and it is `0`
 *     whenever the WASM path did the re-basing — which is the case for every
 *     real far-from-origin file. The offset actually applied is reported
 *     separately as `wasmRtcOffset`, which this never read.
 *     `Trapelo_Design_Intent.ifc` (Revit, feet) carries
 *     `wasmRtcOffset = (219 917.23, 907 157.92, 59.13)` m and
 *     `Snowdon_IFC2x3.ifc` (Revit 2024) `(417 596.05, 78 709.95, 235.86)` m.
 *     Both were read as zero.
 *  2. Both fields are documented by the kernel as **IFC coordinates (Z-up)**,
 *     and the code added them in the kernel's **Y-up** frame. Had defect 1 been
 *     fixed alone, Trapelo's 907 157 m northing would have been added to the
 *     vertical axis.
 *
 * The offset is now read from `wasmRtcOffset` (falling back to `originShift`)
 * and **recorded rather than baked in** — see {@link GeometryIndex.frameOffset}.
 * Baking it in would be the arithmetically obvious move and the wrong one:
 * `IfcBuildingStorey.Elevation` is measured from the building's own datum, which
 * is usually the very origin the kernel re-based onto, so the re-based frame is
 * the one storey elevations are comparable with. On `Snowdon_IFC2x3.ifc` the
 * kernel's offset (235.8644 m) IS the building datum — its storeys run
 * −5.16…21.59 m and its geometry −4.34…23.62 m in the re-based frame, and adding
 * the offset would have put the building 236 m above its own ground floor.
 *
 * Every measurement this library makes is a difference between two points in one
 * frame, so a rigid translation cannot affect any of them. What the offset IS
 * needed for is naming an absolute position — georeferencing, federating two
 * models — and for that it is published rather than lost.
 *
 * ## What a "floor area" is here
 *
 * Not the convex hull of the footprint — an L-shaped room would gain the corner
 * it does not have. It is the sum of the XY-projected areas of the element's
 * DOWNWARD-facing triangles, which is exact for any prismatic solid whatever
 * its plan shape, and degrades honestly (to zero) for a solid that has no floor.
 */

import type { BuildingGraph } from '../graph/types.js'

/** A point in the file's own frame (IFC Z-up), metres. */
export type Vec3 = [number, number, number]

export interface Box {
  min: Vec3
  max: Vec3
}

/**
 * The largest coplanar cluster of an element's surface.
 *
 * For a wall this is the largest single face — one leaf of it, not both, since
 * bins are keyed on offset as well as orientation. Stored as normal + a point
 * on it rather than as a polygon, because every operator that uses it wants a
 * signed distance and none wants an outline.
 *
 * Two things it is NOT, both of which cost a defect to learn:
 *
 * - **The normal is not an outward direction.** The kernel's faces point into
 *   the solid as often as out of it (winding is unreliable by design), so a
 *   wall's outer face can carry a normal aimed at the building. A caller that
 *   needs "outside" must orient it against something — the model's plan centre
 *   is what `facadePlaneOf` uses.
 * - **The largest face is not necessarily the outer one.** A wall's two leaves
 *   differ in area by whatever its openings happen to remove, so which one wins
 *   is close to a coin flip. Measuring an overhang from the inner leaf
 *   over-reports it by the wall's thickness.
 */
export interface Plane {
  normal: Vec3
  point: Vec3
  area: number
}

export interface ElementGeometry {
  globalId: string
  expressId: number
  box: Box
  /**
   * Area-weighted centre of the element's SURFACES — not a volumetric centroid.
   * Falls back to the mean of mesh vertices when no triangles were retained.
   */
  centroid: Vec3
  /** Sum of XY-projected horizontal triangle areas, halved, m². */
  floorArea: number
  /** Total surface area, m². */
  surfaceArea: number
  /**
   * Largest vertical planar cluster.
   *
   * `area` is the real one-sided area of that face: the kernel emits one
   * triangle per face with unreliable winding, not two opposed copies, so
   * nothing here is double-counted. Verified by binning a wall's triangles by
   * orientation AND offset — the two large bins are its two leaves at different
   * offsets, not one face counted twice.
   */
  facade: Plane | null
  /** Largest planar cluster of any orientation. */
  dominant: Plane | null
  triangleCount: number
  /**
   * Whether the surface-derived measures above were computed from the element's
   * COMPLETE geometry.
   *
   * `false` means retention was capped before this element, so `floorArea`,
   * `surfaceArea`, `facade` and `dominant` are withheld (`0` / `null`) and must
   * not be read as measurements. `box` and `centroid` stay valid either way:
   * they are accumulated from every vertex the kernel produced, before any
   * retention decision.
   */
  complete: boolean
  /**
   * World-space triangles, 9 floats each, in the file's frame.
   *
   * Retained because ray casts, prisms and obstruction tests need real surfaces
   * — a box would answer "does the roof block the light" with the roof's
   * bounding box, which for any pitched or L-shaped roof is a different
   * building. Dropped past {@link GeometryOptions.maxRetainedTriangles} so a
   * large model degrades to box-accuracy loudly rather than exhausting memory
   * quietly.
   */
  triangles: Float64Array | null
}

export interface GeometryIndex {
  /** Keyed by GlobalId. */
  elements: Map<string, ElementGeometry>
  /** Whole-model bounds in the file's frame. */
  bounds: Box | null
  /**
   * Centre of the model's plan extent — the reference for "which way is out".
   *
   * Every operator that needs an outward direction orients against this ONE
   * point rather than inventing its own convention, so a drawing cannot face
   * the opposite way from the bearing printed beside it. It is the plan centre
   * of the bounding box, which is wrong for a strongly L-shaped building and
   * is the known limit of the rule.
   */
  planCentre: [number, number] | null
  /**
   * What the kernel subtracted to re-base a far-from-origin model, in the IFC
   * frame (Z-up, metres) — `null` when it re-based nothing.
   *
   * Add it to any coordinate here to get the file's absolute coordinate. It is
   * NOT applied to the geometry: see the module header for why the re-based
   * frame is the one storey elevations are comparable with, and why every
   * measurement is a difference and therefore indifferent to it.
   *
   * A non-`null` value is also the honest answer to "is this model far from the
   * origin" — `Trapelo_Design_Intent.ifc` and `Snowdon_IFC2x3.ifc` both are, by
   * 220 km and 418 km respectively, and nothing else in the index says so.
   */
  frameOffset: Vec3 | null
  stats: {
    elementsWithGeometry: number
    /** Entities the kernel produced meshes for that no graph node claims. */
    unmatched: number
    triangles: number
    retainedTriangles: number
    ms: number
    /** True when triangle retention was capped; surface tests degrade to boxes. */
    trianglesTruncated: boolean
  }
}

export interface GeometryOptions {
  /**
   * Ceiling on retained triangles across the model.
   *
   * 2 million is roughly 150 MB of float64 and covers a large single building.
   *
   * Past it, elements are dropped WHOLE. This used to be a per-mesh decision
   * while the derived measures were per element, so an element whose first mesh
   * was kept and whose second was dropped reported a floor area computed from
   * half a solid — as a plain number, with `triangleCount` still reporting the
   * full count and nothing on the element saying anything was missing. A
   * confidently wrong area is the exact failure this library exists to prevent,
   * and it would have appeared only on models large enough that nobody checks
   * by hand.
   *
   * Now an element either has all its triangles or none, and one that has none
   * carries `complete: false` with its areas and planes withheld rather than
   * approximated.
   */
  maxRetainedTriangles?: number
  onProgress?: (phase: string, percent: number | null) => void
}

/** Coplanarity threshold for clustering triangles into a plane, in radians. */
const PLANE_TOLERANCE = 0.05
/**
 * How far apart two parallel faces must be to count as different planes, in
 * metres.
 *
 * Binning on the normal ALONE merged them, which is wrong in the one case that
 * matters most: a wall has two faces with the same orientation, roughly 0.3 m
 * apart, and a multi-layer wall sliced by its export has several more. Merging
 * them produced a "plane" whose point was the weighted blend of faces at
 * y = 4.409 and y = 4.521 — a plane passing through no surface of the building,
 * offered as the facade to measure an overhang from. On the sample house that
 * blend sat 0.28 m inside the real outer face, which is a quarter of the
 * overhang being measured.
 *
 * 20 mm is below any real wall leaf and above the tessellation noise of a
 * nominally flat face.
 */
const PLANE_OFFSET_TOLERANCE = 0.02
/** A face is "vertical" when its normal is within this of horizontal. */
const VERTICAL_TOLERANCE = 0.15
/**
 * How horizontal a face must be to count toward the floor area, as |n·z|.
 *
 * Named for what it tests. It was called `DOWNWARD` and documented as "a face
 * is downward when its normal points below this", which described neither its
 * value nor its use: winding is unreliable in this kernel, so a floor triangle
 * may report either an up or a down normal and the test has to be on the
 * magnitude. The behaviour was right and the name sent the next reader looking
 * for a sign convention that is not there.
 */
const HORIZONTAL = 0.5

export async function runGeometryPass(
  bytes: Uint8Array,
  graph: BuildingGraph,
  options: GeometryOptions = {}
): Promise<GeometryIndex> {
  const started = Date.now()
  const maxTriangles = options.maxRetainedTriangles ?? 2_000_000

  // Imported lazily so that a host wanting only the topological half never pays
  // for the WASM kernel — the phase-0 answers must stay available on a machine
  // where the kernel cannot initialise at all.
  const { GeometryProcessor } = await import('@ifc-lite/geometry')
  const processor = new GeometryProcessor()
  await processor.init()

  const byExpressId = new Map<number, string>()
  for (const [globalId, node] of graph.nodes) byExpressId.set(node.expressId, globalId)

  /** Accumulating per element, before the derived facts are computed. */
  interface Accumulator {
    expressId: number
    min: Vec3
    max: Vec3
    sum: Vec3
    vertexCount: number
    triangles: number[]
    triangleCount: number
    abandoned: boolean
  }
  const accumulators = new Map<string, Accumulator>()
  let unmatched = 0
  let totalTriangles = 0
  let retained = 0
  let truncated = false
  /**
   * The kernel's own re-basing offset, in the IFC frame — recorded, never baked
   * into a vertex. `wasmRtcOffset` first because it is the field the WASM path
   * actually fills; `originShift` is the batch path's, and is zero whenever the
   * WASM path did the work.
   */
  let frameOffset: Vec3 | null = null

  for await (const event of processor.processStreaming(bytes)) {
    const info = (event as {
      coordinateInfo?: {
        originShift?: { x: number; y: number; z: number }
        wasmRtcOffset?: { x: number; y: number; z: number }
      }
    }).coordinateInfo
    const reported = info?.wasmRtcOffset ?? info?.originShift
    if (reported && (reported.x !== 0 || reported.y !== 0 || reported.z !== 0)) {
      frameOffset = [reported.x, reported.y, reported.z]
    }
    options.onProgress?.('geometry', null)

    // The stream is a union — `start`, progress and batch events — and only the
    // batch carries meshes. Narrowing on the property rather than on a `type`
    // literal keeps this working if the kernel adds an event kind.
    if (!('meshes' in event) || !event.meshes) continue

    for (const mesh of event.meshes) {
      // Class 2 is an instanced type template: its occurrences appear
      // separately, and counting it would place a phantom solid at the
      // template's own position.
      if ((mesh.geometryClass ?? 0) === 2) continue

      const globalId = byExpressId.get(mesh.expressId)
      if (!globalId) {
        unmatched++
        continue
      }

      let acc = accumulators.get(globalId)
      if (!acc) {
        acc = {
          expressId: mesh.expressId,
          min: [Infinity, Infinity, Infinity],
          max: [-Infinity, -Infinity, -Infinity],
          sum: [0, 0, 0],
          vertexCount: 0,
          triangles: [],
          triangleCount: 0,
          abandoned: false,
        }
        accumulators.set(globalId, acc)
      }

      const origin = mesh.origin ?? [0, 0, 0]
      const positions = mesh.positions
      const indices = mesh.indices

      // Vertices, converted to the file's frame once.
      const vertexCount = positions.length / 3
      const world = new Float64Array(vertexCount * 3)
      for (let v = 0; v < vertexCount; v++) {
        const kx = positions[v * 3]! + origin[0]!
        const ky = positions[v * 3 + 1]! + origin[1]!
        const kz = positions[v * 3 + 2]! + origin[2]!
        const x = kx
        const y = -kz
        const z = ky
        world[v * 3] = x
        world[v * 3 + 1] = y
        world[v * 3 + 2] = z
        if (x < acc.min[0]) acc.min[0] = x
        if (y < acc.min[1]) acc.min[1] = y
        if (z < acc.min[2]) acc.min[2] = z
        if (x > acc.max[0]) acc.max[0] = x
        if (y > acc.max[1]) acc.max[1] = y
        if (z > acc.max[2]) acc.max[2] = z
        acc.sum[0] += x
        acc.sum[1] += y
        acc.sum[2] += z
      }
      acc.vertexCount += vertexCount

      const triangleCount = indices.length / 3
      acc.triangleCount += triangleCount
      totalTriangles += triangleCount

      // All-or-nothing per element. Once an element has been abandoned it stays
      // abandoned even if a later mesh of it would fit, because a solid built
      // from the meshes that happened to fit is not the solid.
      if (acc.abandoned || retained + triangleCount > maxTriangles) {
        acc.abandoned = true
        acc.triangles.length = 0
        truncated = true
      } else {
        for (let t = 0; t < indices.length; t += 3) {
          for (let corner = 0; corner < 3; corner++) {
            const base = indices[t + corner]! * 3
            acc.triangles.push(world[base]!, world[base + 1]!, world[base + 2]!)
          }
        }
        retained += triangleCount
      }
    }
  }

  const elements = new Map<string, ElementGeometry>()
  const bounds: Box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }

  for (const [globalId, acc] of accumulators) {
    if (acc.vertexCount === 0) continue
    const complete = !acc.abandoned && acc.triangles.length > 0
    const triangles = complete ? Float64Array.from(acc.triangles) : null
    const measures = triangles ? measureTriangles(triangles) : null

    elements.set(globalId, {
      globalId,
      expressId: acc.expressId,
      box: { min: [...acc.min] as Vec3, max: [...acc.max] as Vec3 },
      // Area-weighted where surfaces are available; the vertex mean is the
      // fallback, and is the weaker of the two because it drifts toward
      // densely tessellated regions.
      centroid: measures?.centroid ?? [
        acc.sum[0] / acc.vertexCount,
        acc.sum[1] / acc.vertexCount,
        acc.sum[2] / acc.vertexCount,
      ],
      floorArea: measures?.floorArea ?? 0,
      surfaceArea: measures?.surfaceArea ?? 0,
      facade: measures?.facade ?? null,
      dominant: measures?.dominant ?? null,
      triangleCount: acc.triangleCount,
      complete,
      triangles,
    })

    for (let k = 0; k < 3; k++) {
      bounds.min[k] = Math.min(bounds.min[k]!, acc.min[k]!)
      bounds.max[k] = Math.max(bounds.max[k]!, acc.max[k]!)
    }
  }

  const hasBounds = Number.isFinite(bounds.min[0])

  return {
    elements,
    bounds: hasBounds ? bounds : null,
    planCentre: hasBounds ? [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2] : null,
    frameOffset,
    stats: {
      elementsWithGeometry: elements.size,
      unmatched,
      triangles: totalTriangles,
      retainedTriangles: retained,
      ms: Date.now() - started,
      trianglesTruncated: truncated,
    },
  }
}

/**
 * Areas and planes, in one sweep over the triangles.
 *
 * Planes are found by binning triangle normals and keeping the heaviest bins,
 * rather than by a full clustering: a wall's facade is by far the largest
 * coplanar area on it, so the biggest bin IS the facade, and a method that
 * needed to be right about the twentieth-largest face would be solving a
 * problem nobody asked about.
 */
function measureTriangles(triangles: Float64Array): {
  floorArea: number
  surfaceArea: number
  facade: Plane | null
  dominant: Plane | null
  centroid: Vec3 | null
} {
  let floorArea = 0
  let surfaceArea = 0
  const weightedCentroid: Vec3 = [0, 0, 0]
  let totalWeight = 0

  /** normal key → { area, normal, pointSum, count } */
  const bins = new Map<string, { area: number; normal: Vec3; point: Vec3; count: number }>()

  for (let t = 0; t < triangles.length; t += 9) {
    const ax = triangles[t]!, ay = triangles[t + 1]!, az = triangles[t + 2]!
    const bx = triangles[t + 3]!, by = triangles[t + 4]!, bz = triangles[t + 5]!
    const cx = triangles[t + 6]!, cy = triangles[t + 7]!, cz = triangles[t + 8]!

    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const doubleArea = Math.hypot(nx, ny, nz)
    if (doubleArea < 1e-12) continue
    const area = doubleArea / 2
    surfaceArea += area
    nx /= doubleArea
    ny /= doubleArea
    nz /= doubleArea

    // Winding is unreliable in this kernel (meshes are double-sided by design),
    // so a downward face is detected by |nz| and the projected area is taken
    // from the absolute value. Halving the total of both up- and down-facing
    // horizontal faces is what makes this the floor area rather than twice it.
    if (Math.abs(nz) > HORIZONTAL) {
      floorArea += Math.abs(nz) * area
    }

    const cx3 = (ax + bx + cx) / 3
    const cy3 = (ay + by + cy) / 3
    const cz3 = (az + bz + cz) / 3

    // Area-weighted, so a big element does not have its centre pulled toward
    // whichever region happens to be densely tessellated — a wall with three
    // window openings cut out of one half carries most of its triangles there.
    weightedCentroid[0] += cx3 * area
    weightedCentroid[1] += cy3 * area
    weightedCentroid[2] += cz3 * area
    totalWeight += area

    // Keyed on orientation AND offset: two parallel faces are two planes.
    const offset = nx * ax + ny * ay + nz * az
    const key = `${quantize(nx)} ${quantize(ny)} ${quantize(nz)} ${Math.round(offset / PLANE_OFFSET_TOLERANCE)}`
    let bin = bins.get(key)
    if (!bin) {
      bin = { area: 0, normal: [0, 0, 0], point: [0, 0, 0], count: 0 }
      bins.set(key, bin)
    }
    bin.area += area
    // Accumulated and area-weighted rather than taken from whichever triangle
    // opened the bin. `quantize` admits a spread of one PLANE_TOLERANCE (~2.9°)
    // into a single bin, so keeping the first normal inherited that spread as
    // bias — which showed up as a facade bearing off by up to three degrees,
    // and a compass answer is not worth much at that resolution.
    bin.normal[0] += nx * area
    bin.normal[1] += ny * area
    bin.normal[2] += nz * area
    // Area-weighted, for the same reason as the normal: a finely tessellated
    // sliver otherwise drags the representative point further than its size
    // warrants, and the point is what a signed distance is measured from.
    bin.point[0] += cx3 * area
    bin.point[1] += cy3 * area
    bin.point[2] += cz3 * area
    bin.count++
  }

  // Up- and down-facing horizontal surfaces of a closed solid are equal, so the
  // sum above double-counts the floor exactly once.
  floorArea /= 2

  let dominant: Plane | null = null
  let facade: Plane | null = null
  for (const bin of bins.values()) {
    const length = Math.hypot(bin.normal[0], bin.normal[1], bin.normal[2])
    if (length < 1e-12) continue
    const plane: Plane = {
      normal: [bin.normal[0] / length, bin.normal[1] / length, bin.normal[2] / length],
      point: [bin.point[0] / bin.area, bin.point[1] / bin.area, bin.point[2] / bin.area],
      area: bin.area,
    }
    if (!dominant || plane.area > dominant.area) dominant = plane
    if (Math.abs(plane.normal[2]) < VERTICAL_TOLERANCE && (!facade || plane.area > facade.area)) facade = plane
  }

  return {
    floorArea,
    surfaceArea,
    facade,
    dominant,
    centroid:
      totalWeight > 0
        ? [weightedCentroid[0] / totalWeight, weightedCentroid[1] / totalWeight, weightedCentroid[2] / totalWeight]
        : null,
  }
}

function quantize(value: number): number {
  return Math.round(value / PLANE_TOLERANCE)
}

/** Signed distance from a point to a plane, positive along the normal. */
export function signedDistance(point: Vec3, plane: Plane): number {
  return (
    (point[0] - plane.point[0]) * plane.normal[0] +
    (point[1] - plane.point[1]) * plane.normal[1] +
    (point[2] - plane.point[2]) * plane.normal[2]
  )
}

/** Whether two boxes overlap, with a tolerance in metres. */
export function boxesOverlap(a: Box, b: Box, tolerance = 0): boolean {
  for (let k = 0; k < 3; k++) {
    if (a.min[k]! - tolerance > b.max[k]!) return false
    if (b.min[k]! - tolerance > a.max[k]!) return false
  }
  return true
}

/** Gap between two boxes along each axis; negative where they overlap. */
export function boxGap(a: Box, b: Box): Vec3 {
  const gap: Vec3 = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    gap[k] = Math.max(a.min[k]! - b.max[k]!, b.min[k]! - a.max[k]!)
  }
  return gap
}
