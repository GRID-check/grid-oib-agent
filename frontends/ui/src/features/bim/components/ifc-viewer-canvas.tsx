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

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from '@/i18n'
import type { BimViewerElement, Rgba } from '../lib/model-index'
import {
  boundsCentre,
  downloadWithProgress,
  rendererPreset,
  wheelZoomDelta,
  type BimCameraView,
  type BimSection,
} from '../lib/viewer-camera'

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
  /**
   * Bumped every time the reader ASKS for {@link view} — including when they
   * ask for the one already active.
   *
   * A named view cannot be expressed by the name alone. Orbit away from the
   * plan and press "Grundriss" again: the name has not changed, so an effect
   * keyed on `[view]` never re-runs and the button sits visibly pressed and
   * inert. A counter makes "do it again" a state change.
   */
  viewNonce?: number
  /** Bumped to re-frame the model. Same reason: fitting twice is two events. */
  fitNonce?: number
  /**
   * Fly the camera to {@link selectedExpressId} when it changes.
   *
   * Off by default, and deliberately not implied by selection: clicking an
   * element in the viewport must not move the camera out from under the hand
   * that clicked it. The list, the search result and the chat chip are the
   * callers that want it, because there "find the red thing" in a
   * five-thousand-element building is the entire task.
   */
  zoomToSelection?: boolean
  className?: string
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
    /**
     * `addVelocity` feeds the renderer's own inertia system. Omitting it — which
     * this interface used to force, by not declaring the parameter — makes every
     * drag a raw per-event jump with no momentum and no damping.
     */
    orbit(dx: number, dy: number, addVelocity?: boolean): void
    pan(dx: number, dy: number, addVelocity?: boolean): void
    /**
     * The cursor arguments are the difference between "zoom toward what I am
     * pointing at" and "zoom toward the middle of the screen, and watch the
     * detail I wanted slide off the edge". They were absent from this
     * declaration, so the call site could not pass them and nobody could see
     * that the renderer had supported it all along.
     */
    zoom(
      delta: number,
      addVelocity?: boolean,
      mouseX?: number,
      mouseY?: number,
      canvasWidth?: number,
      canvasHeight?: number,
      fastZoom?: boolean
    ): void
    /**
     * Advance inertia and any running tween; true while still moving.
     *
     * Nothing called this, which is why momentum never existed AND why
     * `zoomExtent` and the preset views did not animate: both are tweens that
     * only advance when something drives them, and the on-demand renderer drew
     * exactly one frame and stopped.
     */
    update(deltaTime: number): boolean
    /** Rotate about this point instead of the scene centre. `null` restores it. */
    setOrbitCenter(center: Vec3Like | null): void
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
    /** World-space AABB of one element, or null before its geometry lands. */
    getEntityBoundingBox(expressId: number): { min: Vec3Like; max: Vec3Like } | null
  }
  getGPUDevice(): unknown
  getPipeline(): unknown
}

export function IfcViewerCanvas({
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
    viewNonce = 0,
    fitNonce = 0,
    zoomToSelection = false,
    className,
}: IfcViewerCanvasProps): JSX.Element {
  const t = useTranslations('bim')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<RendererLike | null>(null)
  // The geometry kernel is a WASM instance with its own heap, and it outlives
  // the parse: `processAdaptive` returns but the module stays resident. Only
  // the renderer used to be disposed, so every viewport mount leaked a kernel.
  const geometryRef = useRef<{ dispose(): void } | null>(null)
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

  /**
   * Draw one frame, now. Split out of {@link requestFrame} so the camera loop
   * below can render synchronously inside its own animation frame rather than
   * scheduling a second one behind it.
   */
  const drawFrame = useCallback(() => {
    const renderer = rendererRef.current
    if (!renderer) return
    try {
      {
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
      }
    } catch {
      // A lost device makes render() a no-op upstream; anything else here is
      // a frame we skip rather than an error we surface mid-orbit.
    }
  }, [])

  /** Ask for one frame. Rendering is on demand — a static model must not spin the GPU. */
  const frameRef = useRef<number | null>(null)
  const requestFrame = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      drawFrame()
    })
  }, [drawFrame])

  /**
   * Run frames while the camera is still moving, then stop.
   *
   * On-demand rendering and inertia pull in opposite directions: one draws a
   * frame per input event, the other needs frames AFTER the input stops. So
   * anything that gives the camera velocity — a drag, a wheel, a pinch — starts
   * this loop, and `Camera.update` decides when it is over. Tweens
   * (`zoomExtent`, preset views) ride the same loop; they never animated before
   * because nothing was advancing them.
   *
   * Idle cost is unchanged: `update` returns false on the first frame after the
   * motion decays, the loop cancels itself, and a static model spins nothing.
   */
  const cameraLoopRef = useRef<number | null>(null)
  const lastFrameRef = useRef(0)
  const runCameraLoop = useCallback(() => {
    if (cameraLoopRef.current !== null) return
    lastFrameRef.current = performance.now()
    const step = (now: number) => {
      // Clamped: a backgrounded tab resumes with a multi-second gap, which
      // would otherwise land as one enormous integration step and fling the
      // camera across the model.
      const deltaSeconds = Math.min((now - lastFrameRef.current) / 1000, 0.1)
      lastFrameRef.current = now
      const renderer = rendererRef.current
      if (!renderer) {
        cameraLoopRef.current = null
        return
      }
      let moving = false
      try {
        moving = renderer.getCamera().update(deltaSeconds)
      } catch {
        moving = false
      }
      drawFrame()
      cameraLoopRef.current = moving ? requestAnimationFrame(step) : null
    }
    cameraLoopRef.current = requestAnimationFrame(step)
  }, [drawFrame])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const canvas = canvasRef.current
    if (!canvas) return

    const report = (status: IfcViewerStatus) => {
      if (!cancelled) onStatusRef.current?.(status)
    }

    const run = async () => {
      report({ phase: 'downloading', percent: 0, meshCount: 0 })
      try {
        // Aborted on unmount. Without a signal, leaving the page mid-download
        // left the whole model transferring to a component that no longer
        // exists — on the large models this feature is for, that is hundreds of
        // megabytes per abandoned visit.
        const response = await fetch(sourceUrl, { signal: controller.signal })
        if (!response.ok) throw new Error(`model download failed (${response.status})`)
        // Read the body as it arrives rather than awaiting `arrayBuffer()`.
        // Same bytes and the same total time, but the progress the user sees is
        // now the download's real position instead of an indeterminate spinner
        // that sits still for a minute on a 149 MB file and reads as a hang.
        const buffer = await downloadWithProgress(response, (percent) => {
          if (!cancelled) report({ phase: 'downloading', percent, meshCount: 0 })
        })
        if (cancelled) return

        report({ phase: 'parsing', percent: 0, meshCount: 0 })
        const [{ GeometryProcessor }, { Renderer }] = await Promise.all([
          import('@ifc-lite/geometry'),
          import('@ifc-lite/renderer'),
        ])
        if (cancelled) return

        const geometry = new GeometryProcessor()
        geometryRef.current = geometry
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
      controller.abort()
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      if (cameraLoopRef.current !== null) cancelAnimationFrame(cameraLoopRef.current)
      cameraLoopRef.current = null
      // Neither WebGPU resources nor the WASM heap are garbage-collected.
      // Skipping either leaks a device, every vertex buffer, and the kernel's
      // whole arena per mount; a handful of navigations exhausts VRAM.
      rendererRef.current?.destroy()
      rendererRef.current = null
      geometryRef.current?.dispose()
      geometryRef.current = null
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
  /**
   * Every pointer currently down, by id — the whole of touch support.
   *
   * A single-pointer drag orbits, which a phone could already do. Nothing
   * mapped the SECOND finger, and the canvas is `touch-action: none`, so the
   * browser's own pinch was suppressed as well: a tablet could turn the
   * building and never get closer to it. Two fingers now pinch to zoom and
   * drag to pan, which is what every BIM viewer on a tablet does.
   */
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{ distance: number; centreX: number; centreY: number } | null>(null)

  /** Spread and midpoint of the two active pointers. */
  const pinchState = (): { distance: number; centreX: number; centreY: number } | null => {
    const [a, b] = [...pointersRef.current.values()]
    if (!a || !b) return null
    return {
      distance: Math.hypot(a.x - b.x, a.y - b.y),
      centreX: (a.x + b.x) / 2,
      centreY: (a.y + b.y) / 2,
    }
  }

  /** Forget a pointer and leave gesture state consistent, however it ended. */
  const endPointer = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    pointersRef.current.delete(event.pointerId)
    if (pointersRef.current.size < 2) pinchRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointersRef.current.size >= 2) {
      // A gesture that became a pinch is no longer a click or an orbit.
      pinchRef.current = pinchState()
      dragRef.current = null
      return
    }
    dragRef.current = { x: event.clientX, y: event.clientY, button: event.button, moved: false }
  }

  /**
   * A pointer that the BROWSER took away — a system gesture, a palm rejection,
   * a lost capture. Without this the drag state survives, and the next tap is
   * read as the continuation of a drag that ended minutes ago: an orbit that
   * jumps, or a selection that never fires because `moved` is still true.
   */
  const handlePointerCancel = (event: React.PointerEvent<HTMLCanvasElement>) => {
    endPointer(event)
    dragRef.current = null
  }

  /**
   * Fit, without remounting.
   *
   * `fitToView` is on the renderer already; the page only ever lacked a way to
   * reach it. Guarded on `ready` because a fit before the first batch lands
   * frames an empty scene and leaves the camera there.
   */
  // This used to be a `useImperativeHandle`, which never worked. The parent
  // reaches this component through `next/dynamic`, whose `LoadableComponent`
  // is a plain function component, so on React 18 the JSX runtime strips `ref`
  // out of props before it can arrive. `ref.current` was React's internal
  // lazy-retry object — truthy, so the parent's `?.fit()` did not
  // short-circuit; it threw a TypeError on every click. A nonce crosses
  // `dynamic` because it is an ordinary prop.
  //
  // The initial value is skipped: the load path fits once on its own, and
  // fitting before the first batch lands frames an empty scene.
  const fittedRef = useRef(fitNonce)
  useEffect(() => {
    if (!ready || fitNonce === fittedRef.current) return
    fittedRef.current = fitNonce
    rendererRef.current?.fitToView()
    requestFrame()
  }, [fitNonce, ready, requestFrame])

  // Frame the selected element, when the selection came from somewhere other
  // than a click in this canvas. `zoomExtent` is on the camera and
  // `getEntityBoundingBox` on the scene; nothing was missing but the wiring.
  //
  // Skipped when the element has no geometry yet (streaming has not reached
  // it) and when it has none at all — an IfcSpace in a model exported without
  // volumes is selectable in the table and invisible here, and flying the
  // camera to an empty box would leave the reader staring at nothing with no
  // way back.
  useEffect(() => {
    if (!ready || !zoomToSelection || selectedExpressId === null) return
    const renderer = rendererRef.current
    if (!renderer) return
    const box = renderer.getScene().getEntityBoundingBox(selectedExpressId)
    if (!box) return
    runCameraLoop()
    void renderer
      .getCamera()
      .zoomExtent(box.min, box.max)
      .then(() => requestFrame())
      .catch(() => {
        // A camera that refuses the move leaves the view where it was, which
        // is a worse answer than moving but a much better one than a crash
        // mid-selection.
      })
  }, [selectedExpressId, zoomToSelection, ready, requestFrame, runCameraLoop])

  /**
   * Orbit around the selected element rather than the scene centre.
   *
   * The renderer supports a pivot and defaults to `camera.target`, which on a
   * building means the middle of the whole model. Inspecting a stair core in
   * one corner therefore swung the camera in a huge arc around the centre of
   * the building — the element you were looking at left the screen on every
   * drag. Pivoting on the selection makes the drag rotate the thing under
   * examination, which is what every BIM viewer does.
   *
   * Cleared on deselect, so orbiting with nothing selected behaves as before.
   */
  useEffect(() => {
    if (!ready) return
    const renderer = rendererRef.current
    if (!renderer) return
    const camera = renderer.getCamera()
    if (selectedExpressId === null) {
      camera.setOrbitCenter(null)
      return
    }
    const box = renderer.getScene().getEntityBoundingBox(selectedExpressId)
    // No geometry (streaming has not reached it, or the element has none at
    // all) leaves the previous pivot alone rather than snapping to the origin.
    if (!box) return
    camera.setOrbitCenter(boundsCentre(box))
  }, [selectedExpressId, ready])

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
  }, [view, viewNonce, ready, requestFrame])

  useEffect(() => {
    if (!ready) return
    rendererRef.current?.getCamera().setProjectionMode(orthographic ? 'orthographic' : 'perspective')
    requestFrame()
  }, [orthographic, ready, requestFrame])

  useEffect(() => {
    if (ready) requestFrame()
  }, [section, ready, requestFrame])

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current
    if (!renderer) return

    if (pointersRef.current.has(event.pointerId)) {
      pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    }

    // Two fingers: the change in spread zooms, the change in midpoint pans.
    // Both at once, because that is one gesture to the hand holding the
    // tablet even though it is two numbers here.
    const previous = pinchRef.current
    if (previous) {
      const current = pinchState()
      if (!current) return
      pinchRef.current = current
      const rect = event.currentTarget.getBoundingClientRect()
      if (previous.distance > 0 && current.distance > 0) {
        // Ratio, not difference: pinching the same physical distance should
        // zoom the same PROPORTION whether the fingers started 40 px or
        // 400 px apart, which a subtraction gets wrong at both ends.
        //
        // Anchored between the fingers, which is where a hand expects a pinch
        // to converge. No velocity: the fingers are still on the glass, so
        // momentum here would fight them.
        renderer
          .getCamera()
          .zoom(
            Math.log(previous.distance / current.distance) * 4,
            false,
            current.centreX - rect.left,
            current.centreY - rect.top,
            rect.width,
            rect.height
          )
      }
      renderer.getCamera().pan(current.centreX - previous.centreX, current.centreY - previous.centreY)
      requestFrame()
      return
    }

    const drag = dragRef.current
    if (!drag) return
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true
    drag.x = event.clientX
    drag.y = event.clientY
    // Middle button or shift-drag pans; anything else orbits. Same convention
    // as every BIM viewer an architect already uses.
    if (drag.button === 1 || event.shiftKey) renderer.getCamera().pan(dx, dy, true)
    else renderer.getCamera().orbit(dx, dy, true)
    runCameraLoop()
  }

  const handlePointerUp = async (event: React.PointerEvent<HTMLCanvasElement>) => {
    const wasPinching = pinchRef.current !== null
    const drag = dragRef.current
    dragRef.current = null
    endPointer(event)
    // Lifting one finger of a pinch is not a click on whatever was under it.
    if (wasPinching) return
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
    const rect = event.currentTarget.getBoundingClientRect()
    // Zoom toward the CURSOR, not the middle of the canvas. Without these
    // arguments the detail you point at slides off-screen as you approach it,
    // and the only way back is to orbit and try again — the single thing that
    // makes a viewer feel broken to someone used to Revit or Navisworks.
    //
    // Deltas are normalised per `deltaMode`: a mouse wheel reports pixels, but
    // a trackpad or a Firefox line-mode wheel reports lines or pages, and
    // treating 3 lines as 3 pixels is why a trackpad barely moved.
    renderer
      .getCamera()
      .zoom(
        wheelZoomDelta(event.deltaY, event.deltaMode, rect.height),
        true,
        event.clientX - rect.left,
        event.clientY - rect.top,
        rect.width,
        rect.height
      )
    runCameraLoop()
  }

  return (
    <canvas
      ref={canvasRef}
      className={className}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onWheel={handleWheel}
      // The canvas is a graphical view of data that is also available as text in
      // the element table beside it, so it is labelled rather than described.
      // Through the dictionary like every other string a reader sees: a
      // hardcoded German label is the one piece of the page an English screen
      // reader cannot read.
      role="img"
      aria-label={t('viewer.canvasLabel')}
    />
  )
}

export default IfcViewerCanvas
