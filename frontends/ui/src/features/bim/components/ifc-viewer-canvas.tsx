'use client'

/**
 * The 3D viewport: ifc-lite's WASM geometry kernel + WebGPU renderer, wrapped
 * for React.
 *
 * ## Why the model is parsed in the browser
 *
 * There is no server-side render of a BIM model to hand down. Triangulating IFC
 * means running a CSG kernel, and ifc-lite's is WASM built for the browser; the
 * renderer is WebGPU, which only exists in a browser. So the client fetches the
 * `.ifc` through a short-lived presigned URL and does the work locally. The
 * metadata the agent queries was extracted server-side once, at ingestion —
 * these are two different jobs over the same file, not a duplicated one.
 *
 * ## Why this module is loaded dynamically
 *
 * The geometry WASM and the renderer are several megabytes. Statically
 * importing them would put that in the chat bundle for every user, most of whom
 * never open a model. The parent (`IfcModelViewer`) `next/dynamic`s this file
 * with `ssr: false`, so it is fetched the first time a viewport actually mounts
 * and never on the server, where `navigator.gpu` and `HTMLCanvasElement` do not
 * exist.
 *
 * ## Axes
 *
 * The kernel emits Y-UP meshes (the glTF convention), not IFC's Z-up — it does
 * the axis conversion so a renderer does not have to. Nothing in this file
 * touches a coordinate, which is why that has never mattered here: meshes go
 * straight from `processAdaptive` into ifc-lite's own `Renderer`, and
 * everything this component reasons about is an expressId. Written down
 * because the first thing anyone who DOES touch a coordinate will assume is
 * that a BIM kernel speaks Z-up, and the symptom is a building lying on its
 * side with a facade where the roof should be.
 *
 * ## Lifecycle
 *
 * WebGPU resources are not garbage-collected: a renderer left undisposed keeps
 * its device, its swap chain and every vertex buffer alive, and a few
 * navigations exhaust VRAM. Every path out of this component disposes, and the
 * async init is guarded by a `cancelled` flag so a viewport unmounted during
 * parsing does not resurrect itself into a detached canvas.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { BimViewerElement, Rgba } from '../lib/model-index'
import { rendererPreset, type BimCameraView, type BimSection } from '../lib/viewer-camera'

export interface IfcViewerCanvasProps {
  /** Presigned URL of the raw `.ifc`. */
  sourceUrl: string
  /** Elements as extracted server-side, for picking and highlight resolution. */
  elements: readonly BimViewerElement[]
  /** expressId → RGBA, applied as colour overrides. */
  colorOverrides?: Map<number, Rgba>
  /** Only these elements are drawn. `null` shows everything. */
  isolatedExpressIds?: Set<number> | null
  /** Currently selected element, highlighted and used as the orbit pivot. */
  selectedExpressId?: number | null
  /**
   * Ghost everything that is neither selected nor in this set, so a highlighted
   * subset reads against a translucent building instead of being buried inside
   * an opaque one. `null` disables ghosting entirely.
   */
  xrayContextIds?: Set<number> | null
  onSelect?: (element: BimViewerElement | null) => void
  onStatus?: (status: IfcViewerStatus) => void
  /** Named camera direction; `iso` leaves whatever the user orbited to. */
  view?: BimCameraView
  /** Parallel projection — what makes a plan or elevation measurable. */
  orthographic?: boolean
  /** Horizontal cut through the building, in metres. */
  section?: BimSection | null
  /** Reports the model's vertical extent once loaded, for the cut slider. */
  onBounds?: (bounds: { minMetres: number; maxMetres: number } | null) => void
  className?: string
}

/**
 * What the page may ask the viewport to do imperatively.
 *
 * Only actions with no state of their own belong here. `fit` used to be
 * expressed by remounting the component, which re-downloaded the presigned URL
 * and re-triangulated the entire building through the WASM kernel — seconds of
 * work and a full GPU-buffer churn to move a camera. Everything else stays
 * declarative.
 */
export interface IfcViewerHandle {
  fit: () => void
}

export interface IfcViewerStatus {
  phase: 'idle' | 'downloading' | 'parsing' | 'ready' | 'error'
  /** 0..100 while parsing; null when the phase has no meaningful progress. */
  percent: number | null
  meshCount: number
  message?: string
}

interface Vec3Like {
  x: number
  y: number
  z: number
}

/** Minimal structural types for the dynamically-imported ifc-lite classes. */
interface RendererLike {
  init(): Promise<void>
  loadGeometry(meshes: unknown[]): void
  addMeshes(meshes: unknown[], streaming?: boolean): void
  fitToView(): void
  render(options?: Record<string, unknown>): void
  resize(width: number, height: number): void
  destroy(): void
  pick(x: number, y: number): Promise<{ expressId?: number } | null>
  getCamera(): {
    orbit(dx: number, dy: number): void
    pan(dx: number, dy: number): void
    zoom(delta: number): void
    setAspect(aspect: number): void
    zoomExtent(
      min: { x: number; y: number; z: number },
      max: { x: number; y: number; z: number }
    ): Promise<void>
    setPresetView(
      view: 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right',
      bounds?: { min: Vec3Like; max: Vec3Like }
    ): void
    setProjectionMode(mode: 'perspective' | 'orthographic'): void
  }
  getModelBounds(): { min: Vec3Like; max: Vec3Like } | null
  getScene(): {
    setColorOverrides(overrides: Map<number, Rgba>, device: unknown, pipeline: unknown): void
    clearColorOverrides(): void
  }
  getGPUDevice(): unknown
  getPipeline(): unknown
}

export const IfcViewerCanvas = forwardRef<IfcViewerHandle, IfcViewerCanvasProps>(function IfcViewerCanvas(
  {
    sourceUrl,
    elements,
    colorOverrides,
    isolatedExpressIds = null,
    selectedExpressId = null,
    xrayContextIds = null,
    onSelect,
    onStatus,
    view = 'iso',
    orthographic = false,
    section = null,
    onBounds,
    className,
  },
  handleRef
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<RendererLike | null>(null)
  const [ready, setReady] = useState(false)

  // Render inputs live in refs as well as props: the draw call reads them from
  // the animation frame, which is outside React's render, and re-creating the
  // frame callback on every prop change would restart the loop mid-orbit.
  const overridesRef = useRef(colorOverrides)
  const isolatedRef = useRef(isolatedExpressIds)
  const selectedRef = useRef(selectedExpressId)
  const xrayRef = useRef(xrayContextIds)
  const sectionRef = useRef(section)
  sectionRef.current = section
  overridesRef.current = colorOverrides
  isolatedRef.current = isolatedExpressIds
  selectedRef.current = selectedExpressId
  xrayRef.current = xrayContextIds

  const elementsRef = useRef(elements)
  elementsRef.current = elements

  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const onBoundsRef = useRef(onBounds)
  onBoundsRef.current = onBounds

  /** Ask for one frame. Rendering is on demand — a static model must not spin the GPU. */
  const frameRef = useRef<number | null>(null)
  const requestFrame = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      const renderer = rendererRef.current
      if (!renderer) return
      try {
        renderer.render({
          isolatedIds: isolatedRef.current,
          selectedId: selectedRef.current,
          // The renderer treats an ABSENT set as "no ghosting" and an empty one
          // as "ghost everything", so passing an empty set through would fade
          // the whole building the moment a highlight resolved to nothing.
          xrayContextIds: xrayRef.current && xrayRef.current.size > 0 ? xrayRef.current : null,
          ghostAlpha: 0.12,
          // `down` is the renderer's horizontal plane. Absent rather than
          // `enabled: false` when there is no cut: the option is snapshotted
          // per frame and a disabled plane still costs the cap/outline setup.
          sectionPlane: sectionRef.current
            ? {
                axis: 'down' as const,
                position: sectionRef.current.atMetres,
                enabled: true,
                flipped: sectionRef.current.flipped,
                // The hatched cap is what makes a section read as a drawing
                // rather than as a model with its front wall deleted.
                showCap: true,
                showOutlines: true,
              }
            : undefined,
        })
      } catch {
        // A lost device makes render() a no-op upstream; anything else here is
        // a frame we skip rather than an error we surface mid-orbit.
      }
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    const canvas = canvasRef.current
    if (!canvas) return

    const report = (status: IfcViewerStatus) => {
      if (!cancelled) onStatusRef.current?.(status)
    }

    const run = async () => {
      report({ phase: 'downloading', percent: null, meshCount: 0 })
      try {
        const response = await fetch(sourceUrl)
        if (!response.ok) throw new Error(`model download failed (${response.status})`)
        const buffer = new Uint8Array(await response.arrayBuffer())
        if (cancelled) return

        report({ phase: 'parsing', percent: 0, meshCount: 0 })
        const [{ GeometryProcessor }, { Renderer }] = await Promise.all([
          import('@ifc-lite/geometry'),
          import('@ifc-lite/renderer'),
        ])
        if (cancelled) return

        const geometry = new GeometryProcessor()
        const renderer = new Renderer(canvas) as unknown as RendererLike
        await Promise.all([geometry.init(), renderer.init()])
        if (cancelled) {
          renderer.destroy()
          return
        }
        rendererRef.current = renderer

        // Streaming rather than one blocking parse: the first triangles land in
        // a second or two on a large model instead of after the whole file, and
        // the progress the user sees is real work rather than a spinner.
        let meshCount = 0
        for await (const event of geometry.processAdaptive(buffer)) {
          if (cancelled) break
          if (event.type !== 'batch') continue
          renderer.addMeshes(event.meshes, true)
          meshCount += event.meshes.length
          report({ phase: 'parsing', percent: null, meshCount })
          requestFrame()
        }
        if (cancelled) return

        renderer.fitToView()
        setReady(true)
        report({ phase: 'ready', percent: 100, meshCount })
        requestFrame()
      } catch (error) {
        report({
          phase: 'error',
          percent: null,
          meshCount: 0,
          message: error instanceof Error ? error.message : 'unknown error',
        })
      }
    }

    void run()

    return () => {
      cancelled = true
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      // WebGPU resources are not garbage-collected. Skipping this leaks a
      // device and every buffer per mount, and a handful of navigations
      // exhausts VRAM.
      rendererRef.current?.destroy()
      rendererRef.current = null
      setReady(false)
    }
  }, [sourceUrl, requestFrame])

  // Colour overrides are pushed to the scene rather than passed per frame: the
  // scene rebuilds overlay batches when they change, which is not something to
  // redo sixty times a second.
  useEffect(() => {
    const renderer = rendererRef.current
    if (!renderer || !ready) return
    const device = renderer.getGPUDevice()
    const pipeline = renderer.getPipeline()
    if (!device || !pipeline) return
    if (colorOverrides && colorOverrides.size > 0) {
      renderer.getScene().setColorOverrides(colorOverrides, device, pipeline)
    } else {
      renderer.getScene().clearColorOverrides()
    }
    requestFrame()
  }, [colorOverrides, ready, requestFrame])

  useEffect(() => {
    if (ready) requestFrame()
  }, [isolatedExpressIds, selectedExpressId, xrayContextIds, ready, requestFrame])

  // Keep the drawing buffer in step with the element's CSS box, in device
  // pixels — a canvas sized only by CSS renders blurry on every retina display.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const width = Math.max(1, Math.round(entry.contentRect.width * ratio))
      const height = Math.max(1, Math.round(entry.contentRect.height * ratio))
      canvas.width = width
      canvas.height = height
      const renderer = rendererRef.current
      if (renderer) {
        renderer.resize(width, height)
        renderer.getCamera().setAspect(width / height)
        requestFrame()
      }
    })
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [requestFrame])

  const dragRef = useRef<{ x: number; y: number; button: number; moved: boolean } | null>(null)

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { x: event.clientX, y: event.clientY, button: event.button, moved: false }
  }

  /**
   * Fit, without remounting.
   *
   * `fitToView` is on the renderer already; the page only ever lacked a way to
   * reach it. Guarded on `ready` because a fit before the first batch lands
   * frames an empty scene and leaves the camera there.
   */
  useImperativeHandle(
    handleRef,
    () => ({
      fit: () => {
        if (!ready) return
        rendererRef.current?.fitToView()
        requestFrame()
      },
    }),
    [ready, requestFrame]
  )

  // Report the model's vertical extent once, so the cut slider has a range
  // that belongs to this building rather than an arbitrary one. Y is up in the
  // kernel's output — see the axes note at the top of this file.
  useEffect(() => {
    if (!ready) {
      onBoundsRef.current?.(null)
      return
    }
    const bounds = rendererRef.current?.getModelBounds() ?? null
    onBoundsRef.current?.(
      bounds ? { minMetres: bounds.min.y, maxMetres: bounds.max.y } : null
    )
  }, [ready])

  // A named view is declarative state, not a one-shot action: arriving on a
  // link with `?view=north` must land on the north elevation, and so must
  // pressing the button afterwards.
  useEffect(() => {
    if (!ready) return
    const renderer = rendererRef.current
    if (!renderer) return
    const preset = rendererPreset(view)
    if (preset === null) renderer.fitToView()
    else renderer.getCamera().setPresetView(preset, renderer.getModelBounds() ?? undefined)
    requestFrame()
  }, [view, ready, requestFrame])

  useEffect(() => {
    if (!ready) return
    rendererRef.current?.getCamera().setProjectionMode(orthographic ? 'orthographic' : 'perspective')
    requestFrame()
  }, [orthographic, ready, requestFrame])

  useEffect(() => {
    if (ready) requestFrame()
  }, [section, ready, requestFrame])

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    const renderer = rendererRef.current
    if (!drag || !renderer) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true
    drag.x = event.clientX
    drag.y = event.clientY
    // Middle button or shift-drag pans; anything else orbits. Same convention
    // as every BIM viewer an architect already uses.
    if (drag.button === 1 || event.shiftKey) renderer.getCamera().pan(dx, dy)
    else renderer.getCamera().orbit(dx, dy)
    requestFrame()
  }

  const handlePointerUp = async (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    const renderer = rendererRef.current
    // A click is a pointer-up that did not drag: orbiting past an element must
    // not select it.
    if (!renderer || !drag || drag.moved || drag.button !== 0) return

    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    try {
      const hit = await renderer.pick(
        Math.round((event.clientX - rect.left) * ratio),
        Math.round((event.clientY - rect.top) * ratio)
      )
      const expressId = hit?.expressId
      const element =
        expressId === undefined
          ? null
          : (elementsRef.current.find((candidate) => candidate.expressId === expressId) ?? null)
      onSelectRef.current?.(element)
    } catch {
      onSelectRef.current?.(null)
    }
  }

  const handleWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current
    if (!renderer) return
    renderer.getCamera().zoom(event.deltaY * 0.01)
    requestFrame()
  }

  return (
    <canvas
      ref={canvasRef}
      className={className}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onWheel={handleWheel}
      // The canvas is a graphical view of data that is also available as text in
      // the element table beside it, so it is labelled rather than described.
      role="img"
      aria-label="3D-Ansicht des IFC-Modells"
    />
  )
})

export default IfcViewerCanvas
