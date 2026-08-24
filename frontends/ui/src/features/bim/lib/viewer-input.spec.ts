/**
 * @vitest-environment node
 *
 * The 3D viewport's input.
 *
 * Everything else about the model page is tested against extracted METADATA —
 * property sets, quantities, storey containment. The viewport consumes
 * something none of that touches: triangles, produced by ifc-lite's WASM
 * geometry kernel from the raw `.ifc`. Nothing in this repository exercised
 * that path, and the consequence was invisible for as long as it existed:
 * `sample-building.ifc` carries no geometric representation AT ALL — every
 * product has `$` for ObjectPlacement and Representation — so the viewport
 * had nothing to draw and no test could notice.
 *
 * These run the real kernel. No mock: a mocked geometry processor asserts that
 * the mock returns meshes, which is the one thing that was never in doubt.
 *
 * The renderer itself is NOT covered here and cannot be — it is WebGPU, which
 * exists only in a browser with a GPU adapter. What this pins is everything up
 * to the renderer's door: that our fixture triangulates, and that every mesh
 * can be matched back to an element the server extracted, which is what makes
 * click-to-select and highlight-by-GlobalId work.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractIfcModel } from '@/lib/bim/extract'

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'ifc')

function read(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)))
}

interface KernelMesh {
  expressId: number
  ifcType?: string
  positions: Float32Array | number[]
  indices: Uint32Array | number[]
}

/** Run the real kernel and collect every mesh it streams. */
async function triangulate(bytes: Uint8Array): Promise<KernelMesh[]> {
  const { GeometryProcessor } = await import('@ifc-lite/geometry')
  const processor = new GeometryProcessor()
  await processor.init()
  const meshes: KernelMesh[] = []
  for await (const event of processor.processAdaptive(bytes)) {
    if (event.type === 'batch') meshes.push(...(event.meshes as unknown as KernelMesh[]))
  }
  return meshes
}

describe('the viewport input', () => {
  it('triangulates the geometry fixture into meshes the renderer can load', async () => {
    const meshes = await triangulate(read('sample-building-geometry.ifc'))
    const triangles = meshes.reduce((sum, mesh) => sum + mesh.indices.length / 3, 0)

    expect(meshes.length).toBeGreaterThan(0)
    expect(triangles).toBeGreaterThan(0)
    // Every mesh must carry real vertex data — an empty mesh renders as
    // nothing, which is indistinguishable from a missing element.
    for (const mesh of meshes) {
      expect(mesh.positions.length).toBeGreaterThan(0)
      expect(mesh.indices.length % 3).toBe(0)
    }
  }, 30_000)

  it('gives every mesh an expressId the extracted model also knows', async () => {
    // The viewport picks by expressId and highlights by GlobalId, and the map
    // between them comes from the SERVER-side extraction of the same file. If
    // the two disagree, clicking a wall selects nothing and a compliance deep
    // link highlights an empty set — both of which look like a UI bug and are
    // actually a data one.
    const bytes = read('sample-building-geometry.ifc')
    const [meshes, index] = await Promise.all([
      triangulate(bytes),
      extractIfcModel(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        'sample-building-geometry.ifc'
      ),
    ])

    const known = new Set(index.elements.map((element) => element.expressId))
    const orphans = meshes.map((mesh) => mesh.expressId).filter((id) => !known.has(id))

    expect(meshes.length).toBeGreaterThan(0)
    expect(orphans).toEqual([])
  }, 30_000)

  it('extracts the same building the kernel draws', async () => {
    // A file with representations exercises a different extraction path than
    // the metadata-only fixture: the entity count includes hundreds of
    // geometry entities that must NOT be counted as elements.
    const bytes = read('sample-building-geometry.ifc')
    const index = await extractIfcModel(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      'sample-building-geometry.ifc'
    )

    expect(index.storeys.map((storey) => storey.name)).toEqual(['Erdgeschoss', 'Obergeschoss'])
    expect(index.elements.some((element) => element.name === 'Eingangstuer')).toBe(true)
    expect(index.typeCounts.IfcWall).toBe(9)
    // Cartesian points and profiles are geometry, not building elements.
    expect(index.elements.length).toBeLessThan(40)
  }, 30_000)

  it('confirms the metadata-only fixture has nothing to draw', async () => {
    // Not a curiosity — this is the guard. `sample-building.ifc` is the right
    // fixture for extraction and query tests and the WRONG one for anything
    // about the viewport, and the only way to keep that straight is to state
    // it in a test rather than in a comment nobody reads.
    expect(await triangulate(read('sample-building.ifc'))).toEqual([])
  }, 30_000)
})
