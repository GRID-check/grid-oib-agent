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
 * The kernel emits **Y-up** (the glTF convention) while IFC is **Z-up**, and it
 * may shift coordinates toward the origin for far-from-origin models. Every
 * vertex is therefore converted once, here, into the file's own frame:
 *
 *     ifc.x = k.x + shift.x     ifc.y = -(k.z + shift.z)     ifc.z = k.y + shift.y
 *
 * Verified rather than assumed: on a sample house whose storeys are declared at
 * 0.00 and 2.50, the ground-floor walls come back spanning ifc.z 0.00–2.47. A
 * frame error would put them somewhere plausible and wrong, and every answer
 * downstream would inherit it with full confidence.
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
 * For a wall this is the facade — the plane a light-incidence prism is measured
 * from and the plane an overhang projects past. Stored as normal + a point on
 * it rather than as a polygon, because every operator that uses it wants a
 * signed distance and none of them wants an outline.
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
  /** Largest vertical planar cluster — the facade plane, when there is one. */
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
  /** Centre of the model's plan extent — the reference for "which way is out". */
  plannCentre: [number, number] | null
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
  let shift: Vec3 = [0, 0, 0]

  for await (const event of processor.processStreaming(bytes)) {
    const info = (event as { coordinateInfo?: { originShift?: { x: number; y: number; z: number } } }).coordinateInfo
    if (info?.originShift) shift = [info.originShift.x, info.originShift.y, info.originShift.z]
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
        const kx = positions[v * 3]! + origin[0]! + shift[0]
        const ky = positions[v * 3 + 1]! + origin[1]! + shift[1]
        const kz = positions[v * 3 + 2]! + origin[2]! + shift[2]
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
    plannCentre: hasBounds ? [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2] : null,
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

    const key = `${quantize(nx)} ${quantize(ny)} ${quantize(nz)}`
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
    bin.point[0] += cx3
    bin.point[1] += cy3
    bin.point[2] += cz3
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
      point: [bin.point[0] / bin.count, bin.point[1] / bin.count, bin.point[2] / bin.count],
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
