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
import { fireEvent, render, waitFor } from '@testing-library/react'
import { IfcViewerCanvas } from './ifc-viewer-canvas'
import type { BimViewerElement } from '../lib/model-index'
import type { Measurement } from '../lib/viewer-measure'

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
  hiddenIds?: Set<number>
  selectedId?: number | null
}

/** The building the fake renderer reports: a basement at -3 m, a roof at +9 m. */
const BOUNDS = { min: { x: -10, y: -3, z: -10 }, max: { x: 10, y: 9, z: 10 } }

const renders: RecordedRender[] = []
const disposed = { renderer: 0, geometry: 0 }

/**
 * What the fake raycaster answers, one entry per call.
 *
 * A queue rather than a fixed value, because the measurement path is a
 * SEQUENCE — a pointer move, a first click, another move, a second click — and
 * the interesting failures are in how those compose.
 */
const raycasts: ({ point: { x: number; y: number; z: number }; snap?: string } | null)[] = []

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
  // The flat projector: world X/Y straight to pixels, Z ignored. Enough to
  // assert that a measurement lands where the camera says it does.
  projectToScreen: vi.fn((point: { x: number; y: number }) => ({
    x: point.x * 10,
    y: point.y * 10,
  })),
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
    raycastScene() {
      const next = raycasts.shift()
      if (!next) return null
      return {
        intersection: { point: next.point, expressId: 21 },
        ...(next.snap ? { snap: { type: next.snap, position: next.point, expressId: 21 } } : {}),
      }
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
  raycasts.length = 0
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

/**
 * happy-dom has no layout and no pointer capture.
 *
 * Both are load-bearing here rather than incidental: the overlay bails out on
 * a zero-sized canvas (it would divide a projection by nothing), and every
 * gesture starts by capturing the pointer so a drag that leaves the element
 * still orbits.
 */
function stubCanvasHost(): void {
  const canvas = HTMLCanvasElement.prototype as unknown as Record<string, unknown>
  Object.defineProperty(canvas, 'clientWidth', { value: 800, configurable: true })
  Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true })
  canvas.setPointerCapture = () => {}
  canvas.releasePointerCapture = () => {}
  canvas.hasPointerCapture = () => false
}

/** Mount, and wait until the model has streamed in and a frame has been drawn. */
async function mountLoaded(props: Partial<Parameters<typeof IfcViewerCanvas>[0]> = {}) {
  const result = render(
    <IfcViewerCanvas sourceUrl="https://example.test/model.ifc" elements={ELEMENTS} {...props} />
  )
  await waitFor(() => expect(renders.length).toBeGreaterThan(0))
  return result
}

/** A click: press and release without travelling, which is what selects. */
function clickCanvas(canvas: Element, at: { clientX: number; clientY: number }): void {
  fireEvent.pointerDown(canvas, { pointerId: 1, button: 0, ...at })
  fireEvent.pointerUp(canvas, { pointerId: 1, button: 0, ...at })
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

describe('measuring', () => {
  beforeEach(() => {
    stubCanvasHost()
  })

  it('closes a measurement on the second click, not the first', async () => {
    const onMeasure = vi.fn()
    raycasts.push(
      { point: { x: 0, y: 0, z: 0 }, snap: 'vertex' },
      { point: { x: 3, y: 0, z: 4 }, snap: 'vertex' }
    )
    const { container } = await mountLoaded({ measuring: true, onMeasure })
    const canvas = container.querySelector('canvas')!

    clickCanvas(canvas, { clientX: 10, clientY: 10 })
    expect(onMeasure).not.toHaveBeenCalled()

    clickCanvas(canvas, { clientX: 90, clientY: 10 })
    await waitFor(() => expect(onMeasure).toHaveBeenCalledTimes(1))
    const measured = onMeasure.mock.calls[0][0] as Measurement
    expect(measured.from.point).toEqual({ x: 0, y: 0, z: 0 })
    expect(measured.to.point).toEqual({ x: 3, y: 0, z: 4 })
  })

  it('does not select the element it measured', async () => {
    // Selecting would open the inspector over the wall being measured, and
    // the second pick would land on the panel rather than the building.
    const onSelect = vi.fn()
    raycasts.push({ point: { x: 0, y: 0, z: 0 }, snap: 'vertex' })
    const { container } = await mountLoaded({ measuring: true, onSelect })

    clickCanvas(container.querySelector('canvas')!, { clientX: 10, clientY: 10 })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('still selects when the tool is off', async () => {
    const onSelect = vi.fn()
    const { container } = await mountLoaded({ onSelect })

    clickCanvas(container.querySelector('canvas')!, { clientX: 10, clientY: 10 })
    await waitFor(() => expect(onSelect).toHaveBeenCalled())
  })

  it('says when a first point is down, so the chrome can say what to click next', async () => {
    const onMeasurePending = vi.fn()
    raycasts.push(
      { point: { x: 0, y: 0, z: 0 }, snap: 'vertex' },
      { point: { x: 1, y: 0, z: 0 }, snap: 'vertex' }
    )
    const { container } = await mountLoaded({ measuring: true, onMeasurePending })
    const canvas = container.querySelector('canvas')!

    clickCanvas(canvas, { clientX: 10, clientY: 10 })
    expect(onMeasurePending).toHaveBeenLastCalledWith(true)

    clickCanvas(canvas, { clientX: 40, clientY: 10 })
    await waitFor(() => expect(onMeasurePending).toHaveBeenLastCalledWith(false))
  })

  it('drops a half-placed measurement when the tool is switched off', async () => {
    // Keeping it would mean the next click, after the reader had orbited
    // somewhere else entirely, silently closes a measurement against a point
    // they had forgotten was down.
    const onMeasure = vi.fn()
    raycasts.push(
      { point: { x: 0, y: 0, z: 0 }, snap: 'vertex' },
      { point: { x: 1, y: 0, z: 0 }, snap: 'vertex' }
    )
    const { container, rerender } = await mountLoaded({ measuring: true, onMeasure })
    const canvas = container.querySelector('canvas')!
    clickCanvas(canvas, { clientX: 10, clientY: 10 })

    rerender(
      <IfcViewerCanvas
        sourceUrl="https://example.test/model.ifc"
        elements={ELEMENTS}
        measuring={false}
        onMeasure={onMeasure}
      />
    )
    rerender(
      <IfcViewerCanvas
        sourceUrl="https://example.test/model.ifc"
        elements={ELEMENTS}
        measuring
        onMeasure={onMeasure}
      />
    )
    clickCanvas(canvas, { clientX: 40, clientY: 10 })

    expect(onMeasure).not.toHaveBeenCalled()
  })

  it('draws the finished measurement over the model', async () => {
    const { container } = await mountLoaded({
      measuring: true,
      measurements: [
        {
          id: 'a',
          from: { point: { x: 0, y: 0, z: 0 }, snap: 'vertex' },
          to: { point: { x: 2, y: 1, z: 0 }, snap: 'vertex' },
        },
      ],
    })

    // Projected by the fake camera at ten pixels per metre.
    await waitFor(() => {
      const line = container.querySelector('svg line')
      expect(line?.getAttribute('x2')).toBe('20')
      expect(line?.getAttribute('y2')).toBe('10')
    })
    expect(container.textContent).toContain('2.24 m')
  })

  it('leaves every gesture reaching the canvas underneath', async () => {
    // The overlay covers the whole viewport. If it took pointer events the
    // model would stop orbiting the moment a measurement existed.
    const { container } = await mountLoaded({ measurements: [] })
    const svg = container.querySelector('svg')!
    const labels = svg.nextElementSibling as HTMLElement
    expect(svg.getAttribute('class')).toContain('pointer-events-none')
    expect(labels.className).toContain('pointer-events-none')
  })
})

describe('taking elements out of the way', () => {
  it('sends the hidden set under the key the renderer reads', async () => {
    await mountLoaded({ hiddenExpressIds: new Set([21, 22]) })
    await waitFor(() => expect(lastRender().hiddenIds).toEqual(new Set([21, 22])))
  })

  it('sends nothing at all when nothing is hidden', async () => {
    // An empty set is a no-op to the renderer either way, but it still costs a
    // per-frame element-wise compare against the previous snapshot on every
    // batch in the scene.
    await mountLoaded({ hiddenExpressIds: new Set() })
    expect(lastRender().hiddenIds).toBeUndefined()

    await mountLoaded()
    expect(lastRender().hiddenIds).toBeUndefined()
  })

  it('keeps hiding separate from isolating', async () => {
    // They are two different verbs and the renderer reads them as two
    // different options. Collapsing either into the other would make "hide
    // this slab" mean "show only this slab".
    await mountLoaded({
      hiddenExpressIds: new Set([21]),
      isolatedExpressIds: new Set([22, 24]),
    })
    await waitFor(() => {
      expect(lastRender().hiddenIds).toEqual(new Set([21]))
      expect(lastRender().isolatedIds).toEqual(new Set([22, 24]))
    })
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
