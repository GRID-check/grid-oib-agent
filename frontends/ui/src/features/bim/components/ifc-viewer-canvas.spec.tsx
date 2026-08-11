/**
 * The imperative half of the viewport, against a stand-in ifc-lite.
 *
 * A WebGPU device cannot exist in happy-dom, so this suite does not prove that
 * pixels appear. What it proves is the thing that actually kept breaking: the
 * OPTIONS this component hands the renderer. Every defect the section plane and
 * the x-ray control shipped with was of one shape — a key the renderer does not
 * read, or a number in units it does not use — and neither is visible in a
 * screenshot, a type error or a lint rule. The renderer's API is structural and
 * permissive: an unknown key is ignored, and metres in a percentage field are a
 * valid number. Only an assertion on the call catches it.
 *
 * So the fake below is deliberately faithful to ifc-lite's real contract rather
 * than convenient: `render` records what it was given, `getModelBounds` returns
 * a box in the kernel's Y-up world metres, and the mesh stream arrives in
 * batches the way `processAdaptive` delivers them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { IfcViewerCanvas } from './ifc-viewer-canvas'
import type { BimViewerElement } from '../lib/model-index'

interface RecordedRender {
  sectionPlane?: {
    axis: string
    position: number
    enabled: boolean
    flipped?: boolean
    normal?: [number, number, number]
    distance?: number
    min?: number
    max?: number
  }
  ghostExceptIds?: Set<number> | null
  isolatedIds?: Set<number> | null
  selectedId?: number | null
}

/** The building the fake renderer reports: a basement at -3 m, a roof at +9 m. */
const BOUNDS = { min: { x: -10, y: -3, z: -10 }, max: { x: 10, y: 9, z: 10 } }

const renders: RecordedRender[] = []
const disposed = { renderer: 0, geometry: 0 }
const camera = {
  orbit: vi.fn(),
  pan: vi.fn(),
  zoom: vi.fn(),
  update: vi.fn(() => false),
  setOrbitCenter: vi.fn(),
  setAspect: vi.fn(),
  zoomExtent: vi.fn(async () => {}),
  frameBounds: vi.fn(async () => {}),
  setPresetView: vi.fn(),
  setProjectionMode: vi.fn(),
  fitBoundsAdaptive: vi.fn(),
  setSceneBounds: vi.fn(),
}

vi.mock('@ifc-lite/renderer', () => ({
  Renderer: class {
    async init(): Promise<void> {}
    addMeshes(): void {}
    fitToView(): void {}
    resize(): void {}
    render(options: RecordedRender): void {
      renders.push(options)
    }
    destroy(): void {
      disposed.renderer += 1
    }
    async pick(): Promise<null> {
      return null
    }
    getCamera() {
      return camera
    }
    getModelBounds() {
      return BOUNDS
    }
    getScene() {
      return {
        setColorOverrides: vi.fn(),
        clearColorOverrides: vi.fn(),
        getEntityBoundingBox: () => null,
      }
    }
    getGPUDevice() {
      return {}
    }
    getPipeline() {
      return {}
    }
    onDeviceLost() {
      return () => {}
    }
  },
}))

vi.mock('@ifc-lite/geometry', () => ({
  GeometryProcessor: class {
    async init(): Promise<void> {}
    async *processAdaptive(): AsyncGenerator<{ type: string; meshes: unknown[] }> {
      yield { type: 'batch', meshes: [{}, {}] }
    }
    dispose(): void {
      disposed.geometry += 1
    }
  },
}))

const ELEMENTS: BimViewerElement[] = [
  { globalId: 'g-w1', expressId: 21, ifcType: 'IfcWall', name: 'Aussenwand', storeyName: 'EG' },
]

/** The last frame the component drew — what the GPU would have been told. */
const lastRender = (): RecordedRender => {
  const latest = renders.at(-1)
  if (!latest) throw new Error('nothing was rendered')
  return latest
}

beforeEach(() => {
  renders.length = 0
  disposed.renderer = 0
  disposed.geometry = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: null,
      arrayBuffer: async () => new ArrayBuffer(8),
    }))
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Mount, and wait until the model has streamed in and a frame has been drawn. */
async function mountLoaded(props: Partial<Parameters<typeof IfcViewerCanvas>[0]> = {}) {
  const result = render(
    <IfcViewerCanvas sourceUrl="https://example.test/model.ifc" elements={ELEMENTS} {...props} />
  )
  await waitFor(() => expect(renders.length).toBeGreaterThan(0))
  return result
}

describe('the cut the renderer is actually given', () => {
  it('cuts at the height the reader asked for, in world metres', async () => {
    await mountLoaded({ section: { atMetres: 3, flipped: false } })

    await waitFor(() => expect(lastRender().sectionPlane).toBeDefined())
    const plane = lastRender().sectionPlane
    // The clip shader compares `dot(worldPos, normal)` against `distance`, so
    // this pair IS the cut. 3 m means the plane at y = 3, not 3% of anything.
    expect(plane?.normal).toEqual([0, 1, 0])
    expect(plane?.distance).toBe(3)
    expect(plane?.enabled).toBe(true)
  })

  it('states the cardinal position as a percentage of THIS building', async () => {
    // -3 m to +9 m is 12 m of building, so a cut at 3 m is halfway up.
    // Passing `3` here — the old behaviour — meant 3%, i.e. 36 cm above the
    // basement floor, which is why the slider appeared to do nothing.
    await mountLoaded({ section: { atMetres: 3, flipped: false } })

    await waitFor(() => expect(lastRender().sectionPlane).toBeDefined())
    const plane = lastRender().sectionPlane
    expect(plane?.position).toBe(50)
    expect(plane?.min).toBe(-3)
    expect(plane?.max).toBe(9)
  })

  it('moves the plane when the slider moves', async () => {
    const { rerender } = await mountLoaded({ section: { atMetres: 0, flipped: false } })
    await waitFor(() => expect(lastRender().sectionPlane?.distance).toBe(0))

    rerender(
      <IfcViewerCanvas
        sourceUrl="https://example.test/model.ifc"
        elements={ELEMENTS}
        section={{ atMetres: 6, flipped: false }}
      />
    )

    await waitFor(() => expect(lastRender().sectionPlane?.distance).toBe(6))
  })

  it('passes no plane at all when the cut is off', async () => {
    await mountLoaded()
    expect(lastRender().sectionPlane).toBeUndefined()
  })

  it('carries the looking-up direction through', async () => {
    await mountLoaded({ section: { atMetres: 2, flipped: true } })
    await waitFor(() => expect(lastRender().sectionPlane?.flipped).toBe(true))
  })
})

describe('the viewport reports the building it loaded', () => {
  it('hands the cut slider this model own vertical extent', async () => {
    const onBounds = vi.fn()
    await mountLoaded({ onBounds })

    await waitFor(() => expect(onBounds).toHaveBeenCalledWith({ minMetres: -3, maxMetres: 9 }))
  })

  it('walks the load through downloading, parsing and ready', async () => {
    const onStatus = vi.fn()
    await mountLoaded({ onStatus })

    await waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ phase: 'ready' }))
    )
    const phases = onStatus.mock.calls.map(([status]) => status.phase)
    expect(phases[0]).toBe('downloading')
    expect(phases).toContain('parsing')
    // The mesh count is the real one from the stream, not a placeholder.
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ phase: 'ready', meshCount: 2 }))
  })
})

describe('the x-ray set', () => {
  it('is only sent when something is actually kept solid', async () => {
    // An EMPTY set means "ghost everything" to the renderer, so passing one
    // through would fade the whole building the moment a highlight resolves to
    // nothing. Absent is the only correct spelling of "no ghosting".
    await mountLoaded({ xrayKeepIds: new Set<number>() })
    expect(lastRender().ghostExceptIds).toBeNull()
  })

  it('reaches the renderer under the key the renderer reads', async () => {
    await mountLoaded({ xrayKeepIds: new Set([21]) })
    await waitFor(() => expect(lastRender().ghostExceptIds).toEqual(new Set([21])))
  })
})

describe('lifecycle', () => {
  it('disposes the renderer AND the geometry kernel on unmount', async () => {
    // Neither is garbage-collected: a skipped dispose leaks a GPU device and
    // the WASM arena, and a handful of navigations exhausts VRAM.
    const { unmount } = await mountLoaded()
    unmount()
    expect(disposed.renderer).toBe(1)
    expect(disposed.geometry).toBe(1)
  })

  it('reports a failed download as an error rather than an empty canvas', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        headers: { get: () => null },
        body: null,
        arrayBuffer: async () => new ArrayBuffer(0),
      }))
    )
    const onStatus = vi.fn()
    render(
      <IfcViewerCanvas
        sourceUrl="https://example.test/expired.ifc"
        elements={ELEMENTS}
        onStatus={onStatus}
      />
    )

    await waitFor(() =>
      expect(onStatus).toHaveBeenCalledWith(
        expect.objectContaining({ phase: 'error', message: expect.stringContaining('403') })
      )
    )
  })
})
