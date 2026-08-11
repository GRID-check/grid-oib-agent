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
 *
 * ## Input
 *
 * Navigation matches what an architect already has in their hands: left-drag
 * orbits, right- or middle-drag pans, the wheel zooms toward the cursor, two
 * fingers pinch and pan, double-click frames what was hit. Keyboard does all
 * of it too, because a canvas that can only be driven by a mouse is a canvas
 * half the audience cannot use.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
/**
 * The renderer, typed by the renderer.
 *
 * The declarations below used to be hand-written structural interfaces —
 * `render(options?: Record<string, unknown>)` and a dozen methods copied out by
 * eye — and that is what let every defect this component has shipped through.
 * `xrayContextIds` was not a key the renderer reads; `position: atMetres` was
 * metres in a percentage field. A `Record<string, unknown>` accepts both
 * happily, and neither shows up in a screenshot, so both survived a release.
 *
 * `import type` is erased at build time: it costs nothing in the bundle, does
 * not defeat the `next/dynamic` split this file exists for, and makes the
 * renderer's own `RenderOptions` the contract. A misspelled option is now a
 * type error at the call site, which is where it was always meant to be caught.
 */
import type { Camera, Renderer, Scene } from '@ifc-lite/renderer'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import type { BimViewerElement, Rgba } from '../lib/model-index'
import { MeasureOverlay } from '../lib/measure-overlay'
import {
  completeMeasurement,
  MEASURE_SNAP_OPTIONS,
  type MeasureAnchor,
  type MeasureSnapKind,
  type Measurement,
} from '../lib/viewer-measure'
import {
  boundsCentre,
  downloadWithProgress,
  keyboardCameraStep,
  rendererPreset,
  rendererSectionPlane,
  wheelZoomDelta,
  type BimCameraView,
  type BimSection,
} from '../lib/viewer-camera'
import {
  readViewerTheme,
  VIEWER_CLEAR_COLOR,
  viewerEnhancement,
  viewerEnhancementCompact,
  viewerEnvironment,
} from '../lib/viewer-scene'

export interface IfcViewerCanvasProps {
  /** Presigned URL of the raw `.ifc`. */
  sourceUrl: string
  /** Elements as extracted server-side, for picking and highlight resolution. */
  elements: readonly BimViewerElement[]
  /** expressId → RGBA, applied as colour overrides. */
  colorOverrides?: Map<number, Rgba>
  /** Only these elements are drawn. `null` shows everything. */
  isolatedExpressIds?: Set<number> | null
  /**
   * Elements the reader has taken out of the way.
   *
   * Not the inverse of {@link isolatedExpressIds} and not interchangeable with
   * it: hiding removes the slab in front of the stair and leaves the rest
   * alone, isolating removes everything that is not the stair. Both are live
   * at once when the reader has done both.
   */
  hiddenExpressIds?: ReadonlySet<number> | null
  /** Currently selected element, highlighted and used as the orbit pivot. */
  selectedExpressId?: number | null
  /**
   * Keep these solid and ghost everything else, so a highlighted subset reads
   * against a translucent building instead of being buried inside an opaque
   * one. `null` disables ghosting entirely.
   */
  xrayKeepIds?: Set<number> | null
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
  /**
   * Card-sized viewport: cheaper shading, and no hover testing.
   *
   * A preview a few hundred pixels wide cannot resolve separation lines, and
   * several of them on one page would each pay for an ambient-occlusion pass
   * nobody can see.
   */
  compact?: boolean
  /**
   * Measuring: a click places a dimension point instead of selecting.
   *
   * The two cannot both be on the primary click. A reviewer measuring the
   * clear width of a corridor clicks two wall faces, and if those clicks also
   * selected the walls the inspector would open over the thing being measured
   * and the second pick would land on the panel.
   */
  measuring?: boolean
  /** Finished measurements, drawn over the model. */
  measurements?: readonly Measurement[]
  /** A measurement the reader just closed. The parent owns the list. */
  onMeasure?: (measurement: Measurement) => void
  /** Whether a first point is down, so the chrome can say what to click next. */
  onMeasurePending?: (pending: boolean) => void
  className?: string
}

export interface IfcViewerStatus {
  phase: 'idle' | 'downloading' | 'parsing' | 'ready' | 'error'
  /** 0..100 while downloading; null when the phase has no meaningful progress. */
  percent: number | null
  meshCount: number
  message?: string
}

/**
 * What this component uses of the renderer — the real types, narrowed.
 *
 * Narrowed rather than `Renderer` itself for one reason: the class carries
 * private fields, so a structural stand-in can never satisfy it and the specs
 * would have to cast their fake through `unknown`, which throws away exactly
 * the checking this exists for. Each member below is `Renderer`'s own
 * signature, so a change in the package still lands here as a type error.
 */
type RendererLike = Pick<
  Renderer,
  | 'init'
  | 'addMeshes'
  | 'fitToView'
  | 'render'
  | 'resize'
  | 'destroy'
  | 'pick'
  | 'raycastScene'
  | 'onDeviceLost'
  | 'getModelBounds'
  | 'getGPUDevice'
  | 'getPipeline'
  | 'captureScreenshot'
> & {
  getCamera(): CameraLike
  getScene(): SceneLike
}

/** The camera surface this component drives. Signatures are `Camera`'s own. */
type CameraLike = Pick<
  Camera,
  /**
   * `addVelocity` feeds the renderer's own inertia system. Omitting it — which
   * the old hand-written declaration forced, by not declaring the parameter —
   * makes every drag a raw per-event jump with no momentum and no damping.
   */
  | 'orbit'
  | 'pan'
  /**
   * The cursor arguments are the difference between "zoom toward what I am
   * pointing at" and "zoom toward the middle of the screen, and watch the
   * detail I wanted slide off the edge". They were absent from the old
   * declaration, so the call site could not pass them and nobody could see
   * that the renderer had supported it all along.
   */
  | 'zoom'
  /**
   * Advance inertia and any running tween; true while still moving.
   *
   * Nothing called this, which is why momentum never existed AND why
   * `zoomExtent` and the preset views did not animate: both are tweens that
   * only advance when something drives them, and the on-demand renderer drew
   * exactly one frame and stopped.
   */
  | 'update'
  /** Rotate about this point instead of the scene centre. `null` restores it. */
  | 'setOrbitCenter'
  | 'setAspect'
  /** Zoom to fit a box while KEEPING the current view direction. */
  | 'frameBounds'
  | 'zoomExtent'
  | 'setPresetView'
  | 'setProjectionMode'
  /** Adaptive home pose — isometric for a building, along-axis for a corridor. */
  | 'fitBoundsAdaptive'
  | 'stopInertia'
  | 'setSceneBounds'
  /** World point → canvas pixel, for the DOM overlays drawn over the model. */
  | 'projectToScreen'
  | 'getPosition'
  | 'getFOV'
  | 'enableFirstPersonMode'
  | 'moveFirstPerson'
>

type SceneLike = Pick<Scene, 'setColorOverrides' | 'clearColorOverrides' | 'getEntityBoundingBox'>

/**
 * How long one synchronous hover raycast may take before hover is abandoned.
 *
 * The first `raycastScene` on a model builds a BVH over every triangle, and on
 * a large building that is not a frame's worth of work. Rather than guess a
 * size threshold, the first call is TIMED: if it blew the budget, hover turns
 * itself off for this model and the viewport keeps its cursor as a grab hand.
 * Losing a cursor affordance is a much smaller failure than a viewport that
 * stutters whenever the mouse moves.
 */
const HOVER_BUDGET_MS = 24

/** Pixels of orbit per arrow-key press. One press should be visible, not violent. */
const KEY_ORBIT_PX = 24
const KEY_PAN_PX = 32

/**
 * The model's vertical extent, in the renderer's own Y-up world metres.
 *
 * One reader for two consumers that MUST agree: the cut slider's range, and
 * the plane the cut resolves to. When those two disagree the readout lies —
 * which is the whole class of bug the section plane kept landing in.
 */
function modelBoundsMetres(
  renderer: RendererLike | null
): { minMetres: number; maxMetres: number } | null {
  const bounds = renderer?.getModelBounds()
  if (!bounds) return null
  if (!Number.isFinite(bounds.min.y) || !Number.isFinite(bounds.max.y)) return null
  return { minMetres: bounds.min.y, maxMetres: bounds.max.y }
}

export function IfcViewerCanvas({
  sourceUrl,
  elements,
  colorOverrides,
  isolatedExpressIds = null,
  hiddenExpressIds = null,
  selectedExpressId = null,
  xrayKeepIds = null,
  onSelect,
  onStatus,
  view = 'iso',
  orthographic = false,
  section = null,
  onBounds,
  viewNonce = 0,
  fitNonce = 0,
  zoomToSelection = false,
  compact = false,
  measuring = false,
  measurements,
  onMeasure,
  onMeasurePending,
  className,
}: IfcViewerCanvasProps): JSX.Element {
  const t = useTranslations('bim')
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const overlaySvgRef = useRef<SVGSVGElement | null>(null)
  const overlayLabelsRef = useRef<HTMLDivElement | null>(null)
  const rendererRef = useRef<RendererLike | null>(null)
  // The geometry kernel is a WASM instance with its own heap, and it outlives
  // the parse: `processAdaptive` returns but the module stays resident. Only
  // the renderer used to be disposed, so every viewport mount leaked a kernel.
  const geometryRef = useRef<{ dispose(): void } | null>(null)
  const [ready, setReady] = useState(false)
  /** Over pickable geometry — drives the cursor, and nothing else. */
  const [hovering, setHovering] = useState(false)
  const [dragging, setDragging] = useState(false)

  // Render inputs live in refs as well as props: the draw call reads them from
  // the animation frame, which is outside React's render, and re-creating the
  // frame callback on every prop change would restart the loop mid-orbit.
  const overridesRef = useRef(colorOverrides)
  const isolatedRef = useRef(isolatedExpressIds)
  const hiddenRef = useRef(hiddenExpressIds)
  const selectedRef = useRef(selectedExpressId)
  const xrayRef = useRef(xrayKeepIds)
  const sectionRef = useRef(section)
  const compactRef = useRef(compact)
  sectionRef.current = section
  overridesRef.current = colorOverrides
  isolatedRef.current = isolatedExpressIds
  hiddenRef.current = hiddenExpressIds
  selectedRef.current = selectedExpressId
  xrayRef.current = xrayKeepIds
  compactRef.current = compact

  const elementsRef = useRef(elements)
  elementsRef.current = elements

  const onStatusRef = useRef(onStatus)
  onStatusRef.current = onStatus
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const onBoundsRef = useRef(onBounds)
  onBoundsRef.current = onBounds
  const onMeasureRef = useRef(onMeasure)
  onMeasureRef.current = onMeasure
  const onMeasurePendingRef = useRef(onMeasurePending)
  onMeasurePendingRef.current = onMeasurePending
  const measuringRef = useRef(measuring)
  measuringRef.current = measuring

  /**
   * The measurement in progress, and the drawing of every finished one.
   *
   * Both are refs, and deliberately so. The first point of a measurement and
   * the live cursor change on every pointer move; routing either through React
   * would re-render the whole stage sixty times a second to move a line end.
   * The overlay writes coordinates straight into the DOM instead, from inside
   * the same frame the model is drawn in, so the dimension line cannot lag a
   * frame behind the building it is measuring.
   */
  const overlayRef = useRef<MeasureOverlay | null>(null)
  const anchorRef = useRef<MeasureAnchor | null>(null)
  const cursorRef = useRef<MeasureAnchor | null>(null)

  /**
   * The theme the model is lit for, captured once per mount.
   *
   * Re-lighting on a theme switch would mean re-resolving the environment
   * uniform mid-session, and the viewport lives inside a modal nobody switches
   * themes underneath. Read at mount, honest at mount.
   */
  const themeRef = useRef<'light' | 'dark'>('light')

  /** True while a gesture is in progress, so the renderer can trade detail for latency. */
  const interactingRef = useRef(false)
  /** Still receiving geometry — the renderer skips work that a partial scene invalidates. */
  const streamingRef = useRef(true)

  /** `hiddenIds` for a pick query, or nothing when the reader has hidden nothing. */
  const hiddenPickOption = useCallback(
    (): { hiddenIds?: Set<number> } =>
      hiddenRef.current && hiddenRef.current.size > 0
        ? { hiddenIds: new Set(hiddenRef.current) }
        : {},
    []
  )

  /**
   * Put the measurement drawing where the camera now says it goes.
   *
   * `projectToScreen` wants CSS pixels, and the drawing buffer is in DEVICE
   * pixels — the ResizeObserver below multiplies by the device pixel ratio. On
   * a retina display, projecting against the buffer size would put every
   * dimension line at twice its coordinates, i.e. off the bottom-right of the
   * viewport. So the CSS box is measured here, not `canvas.width`.
   */
  const drawOverlay = useCallback((renderer: RendererLike) => {
    const overlay = overlayRef.current
    const canvas = canvasRef.current
    if (!overlay || !canvas) return
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (width === 0 || height === 0) return
    try {
      const camera = renderer.getCamera()
      overlay.update((point) => camera.projectToScreen(point, width, height))
    } catch {
      // A camera mid-teardown is a frame without an overlay, not a crash.
    }
  }, [])

  /**
   * Draw one frame, now. Split out of {@link requestFrame} so the camera loop
   * below can render synchronously inside its own animation frame rather than
   * scheduling a second one behind it.
   */
  const drawFrame = useCallback(() => {
    const renderer = rendererRef.current
    if (!renderer) return
    try {
      const theme = themeRef.current
      renderer.render({
        isolatedIds: isolatedRef.current,
        // Omitted rather than empty when nothing is hidden. An empty set is a
        // no-op to the renderer either way, but it still costs a per-frame
        // element-wise compare against the previous snapshot on every batch.
        ...(hiddenRef.current && hiddenRef.current.size > 0
          ? { hiddenIds: new Set(hiddenRef.current) }
          : {}),
        selectedId: selectedRef.current,
        // The renderer treats an ABSENT set as "no ghosting" and an empty one
        // as "ghost everything", so passing an empty set through would fade
        // the whole building the moment a highlight resolved to nothing.
        //
        // The option is `ghostExceptIds`. It used to be spelled
        // `xrayContextIds` here, which is not a key the renderer has ever
        // read — so the x-ray control was inert from the day it shipped, and
        // looked like it worked because the button's pressed state is local.
        ghostExceptIds: xrayRef.current && xrayRef.current.size > 0 ? xrayRef.current : null,
        ghostAlpha: 0.1,
        clearColor: VIEWER_CLEAR_COLOR[theme],
        environment: viewerEnvironment(theme),
        visualEnhancement: compactRef.current ? viewerEnhancementCompact() : viewerEnhancement(),
        // Both are hints the renderer uses to shed work it cannot use: a scene
        // that is still loading, and a camera that is still moving, are frames
        // nobody is inspecting closely.
        isStreaming: streamingRef.current,
        isInteracting: interactingRef.current,
        // Absent rather than `enabled: false` when there is no cut: the option
        // is snapshotted per frame and a disabled plane still costs the
        // cap/outline setup.
        //
        // The bounds are read from the renderer HERE rather than taken from
        // the `onBounds` prop round-trip, so the plane is expressed against the
        // box the renderer holds this frame — during streaming that box is
        // still growing, and a percentage computed against a stale one would
        // slide the cut as the building arrived.
        sectionPlane: sectionRef.current
          ? rendererSectionPlane(sectionRef.current, modelBoundsMetres(renderer))
          : undefined,
      })
    } catch {
      // A lost device makes render() a no-op upstream; anything else here is
      // a frame we skip rather than an error we surface mid-orbit.
    }
    // In the SAME frame the model was drawn in, never one behind it: a
    // dimension line that trails the building by a frame reads as the
    // measurement sliding off the wall whenever the camera moves.
    drawOverlay(renderer)
  }, [drawOverlay])

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
   * (`frameBounds`, preset views) ride the same loop; they never animated
   * before because nothing was advancing them.
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

    themeRef.current = readViewerTheme()
    streamingRef.current = true

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

        report({ phase: 'parsing', percent: null, meshCount: 0 })
        const [{ GeometryProcessor }, { Renderer }] = await Promise.all([
          import('@ifc-lite/geometry'),
          import('@ifc-lite/renderer'),
        ])
        if (cancelled) return

        const geometry = new GeometryProcessor()
        geometryRef.current = geometry
        // No cast: `RendererLike` is now built out of `Renderer`'s own member
        // types, so the real class satisfies it and a package change that
        // renames a method lands here as a type error rather than as a
        // viewport that silently stops responding.
        const renderer: RendererLike = new Renderer(canvas)
        await Promise.all([geometry.init(), renderer.init()])
        if (cancelled) {
          renderer.destroy()
          return
        }
        rendererRef.current = renderer

        // A WebGPU device can be taken away — a driver reset, a laptop waking
        // from sleep, a tab backgrounded too long on a machine under memory
        // pressure. Unhandled, every subsequent frame throws into the empty
        // catch in `drawFrame` and the reader is left orbiting a frozen image
        // with no indication anything is wrong.
        renderer.onDeviceLost?.((info) => {
          report({ phase: 'error', percent: null, meshCount: 0, message: info.message })
        })

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

        streamingRef.current = false
        // Tight near/far planes in parallel projection need the scene's extent.
        // Without it an orthographic plan z-fights against itself, which reads
        // as a model with holes punched through the slabs.
        const bounds = renderer.getModelBounds()
        if (bounds) renderer.getCamera().setSceneBounds?.(bounds)
        renderer.fitToView()
        setReady(true)
        report({ phase: 'ready', percent: 100, meshCount })
        requestFrame()
      } catch (error) {
        // An aborted fetch is this component being unmounted, not a failure the
        // reader needs to hear about — and reporting it would replace the next
        // model's viewport with the previous one's error panel.
        if (controller.signal.aborted) return
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
      setHovering(false)
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
  }, [isolatedExpressIds, hiddenExpressIds, selectedExpressId, xrayKeepIds, ready, requestFrame])

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
    if (pointersRef.current.size === 0) {
      interactingRef.current = false
      setDragging(false)
    }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    // Focus the canvas on any press, so the keyboard controls below are one
    // click away rather than a tab-order hunt.
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    interactingRef.current = true
    setDragging(true)
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
   * Frame the model, from wherever the camera is.
   *
   * `fitBoundsAdaptive` rather than `fitToView`: the adaptive policy picks a
   * pose that suits the bounding box's SHAPE — the isometric a building wants,
   * or the along-the-axis view a 400 m corridor wants, where the isometric
   * shows a diagonal hairline. It also animates, so Home reads as the camera
   * travelling rather than as the model teleporting.
   */
  const fitModel = useCallback(() => {
    const renderer = rendererRef.current
    if (!renderer) return
    const bounds = renderer.getModelBounds()
    if (bounds && renderer.getCamera().fitBoundsAdaptive) {
      renderer.getCamera().fitBoundsAdaptive?.(bounds, { animate: true })
    } else {
      renderer.fitToView()
    }
    runCameraLoop()
  }, [runCameraLoop])

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
    fitModel()
  }, [fitNonce, ready, fitModel])

  // Frame the selected element, when the selection came from somewhere other
  // than a click in this canvas.
  //
  // `frameBounds`, not `zoomExtent`: framing keeps the view DIRECTION and only
  // changes the distance, which is what "Frame Selection" means in every CAD
  // tool. `zoomExtent` re-poses the camera as well, so picking a row in a list
  // spun the building — the reader lost their orientation as the price of
  // seeing the thing they asked for.
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
    const camera = renderer.getCamera()
    runCameraLoop()
    const framed = camera.frameBounds
      ? camera.frameBounds(box.min, box.max)
      : camera.zoomExtent(box.min, box.max)
    void framed.then(() => requestFrame()).catch(() => {
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
    // all) clears the pivot back to the model centre — which is what `null`
    // means here, as the branch above shows. Keeping the PREVIOUS element's
    // pivot would orbit the camera around a thing the user just stopped
    // looking at.
    if (!box) {
      camera.setOrbitCenter(null)
      return
    }
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
    onBoundsRef.current?.(modelBoundsMetres(rendererRef.current))
  }, [ready])

  // A named view is declarative state, not a one-shot action: arriving on a
  // link with `?view=north` must land on the north elevation, and so must
  // pressing the button afterwards.
  useEffect(() => {
    if (!ready) return
    const renderer = rendererRef.current
    if (!renderer) return
    const preset = rendererPreset(view)
    if (preset === null) fitModel()
    else {
      renderer.getCamera().setPresetView(preset, renderer.getModelBounds() ?? undefined)
      // A preset view is a TWEEN, and a tween needs `Camera.update()` stepped
      // every frame — which is what `runCameraLoop` does. `requestFrame()` drew
      // exactly one, so pressing a view snapped a fraction of the way there and
      // stopped. Same bug as the one that made `zoomExtent` never animate,
      // surviving in the one place that had not been converted.
      runCameraLoop()
    }
  }, [view, viewNonce, ready, runCameraLoop, fitModel])

  useEffect(() => {
    if (!ready) return
    rendererRef.current?.getCamera().setProjectionMode(orthographic ? 'orthographic' : 'perspective')
    requestFrame()
  }, [orthographic, ready, requestFrame])

  useEffect(() => {
    if (ready) requestFrame()
  }, [section, ready, requestFrame])

  // ---------------------------------------------------------------------------
  // Measuring
  // ---------------------------------------------------------------------------

  /**
   * The overlay lives as long as the two host elements do.
   *
   * Built here rather than at module scope because it holds DOM: one per
   * mounted viewport, torn down with it. The labels are read out of the
   * dictionary at construction — the overlay writes text into the DOM itself
   * and has no translation context of its own.
   */
  useEffect(() => {
    const svg = overlaySvgRef.current
    const labels = overlayLabelsRef.current
    if (!svg || !labels) return
    const overlay = new MeasureOverlay(svg, labels, {
      horizontal: t('viewer.measure.horizontal'),
      vertical: t('viewer.measure.vertical'),
    })
    overlayRef.current = overlay
    return () => {
      overlay.destroy()
      overlayRef.current = null
    }
  }, [t])

  useEffect(() => {
    overlayRef.current?.setMeasurements(measurements ?? [])
    requestFrame()
  }, [measurements, requestFrame])

  /**
   * Leaving measure mode drops the half-finished measurement.
   *
   * The alternative — keeping the anchor so it resumes when the tool comes
   * back — sounds helpful and is not: the reader turned the tool off, orbited
   * somewhere else, and the next click would silently close a measurement
   * against a point they had forgotten was down.
   */
  useEffect(() => {
    if (measuring) return
    anchorRef.current = null
    cursorRef.current = null
    overlayRef.current?.setPending(null, null)
    onMeasurePendingRef.current?.(false)
    requestFrame()
  }, [measuring, requestFrame])

  /**
   * Where a click would land, and what it would lock onto.
   *
   * `raycastScene` with snap options does the whole job in one synchronous
   * call: the exact surface point AND the nearest vertex/edge/face target
   * within the screen radius. Falling back to the raw intersection rather than
   * to nothing is deliberate — a reader measuring a corridor is pointing at
   * two wall faces, and "no corner nearby" must not mean "no measurement".
   */
  const measureAt = useCallback((clientX: number, clientY: number): MeasureAnchor | null => {
    const renderer = rendererRef.current
    const canvas = canvasRef.current
    if (!renderer?.raycastScene || !canvas) return null
    const rect = canvas.getBoundingClientRect()
    try {
      const hit = renderer.raycastScene(clientX - rect.left, clientY - rect.top, {
        isolatedIds: isolatedRef.current,
        ...hiddenPickOption(),
        snapOptions: MEASURE_SNAP_OPTIONS,
      })
      if (!hit) return null
      const snapped = hit.snap
      return snapped
        ? { point: snapped.position, snap: snapped.type as MeasureSnapKind }
        : { point: hit.intersection.point, snap: 'none' }
    } catch {
      // A BVH that cannot be built is a viewport that cannot measure, not one
      // that crashes mid-drag.
      return null
    }
  }, [hiddenPickOption])

  /** Place a point: the first arms the measurement, the second closes it. */
  const placeMeasurePoint = useCallback(
    (clientX: number, clientY: number) => {
      const anchor = measureAt(clientX, clientY)
      if (!anchor) return
      const pending = anchorRef.current
      if (!pending) {
        anchorRef.current = anchor
        onMeasurePendingRef.current?.(true)
      } else {
        const measurement = completeMeasurement(pending, anchor)
        // A rejected measurement (the two picks landed on the same corner)
        // leaves the anchor armed rather than clearing it, so a mis-click
        // costs one more click instead of the whole measurement.
        if (measurement) {
          anchorRef.current = null
          onMeasurePendingRef.current?.(false)
          onMeasureRef.current?.(measurement)
        }
      }
      overlayRef.current?.setPending(anchorRef.current, cursorRef.current)
      requestFrame()
    },
    [measureAt, requestFrame]
  )

  /**
   * Hover testing, and the budget that can switch it off.
   *
   * `raycastScene` is synchronous, so unlike `pick` it can run on pointermove
   * without a GPU round trip. Its FIRST call still builds a BVH over the whole
   * model, which on a large building is not free — so it is timed once, and a
   * model that cannot afford it simply does not get a hover cursor.
   */
  const hoverAffordableRef = useRef(true)
  const hoverFrameRef = useRef<number | null>(null)

  const testHover = useCallback((clientX: number, clientY: number) => {
    const renderer = rendererRef.current
    const canvas = canvasRef.current
    if (!renderer?.raycastScene || !canvas || !hoverAffordableRef.current) return
    if (hoverFrameRef.current !== null) return
    hoverFrameRef.current = requestAnimationFrame(() => {
      hoverFrameRef.current = null
      const active = rendererRef.current
      if (!active?.raycastScene) return
      const rect = canvas.getBoundingClientRect()
      const started = performance.now()
      try {
        const hit = active.raycastScene(clientX - rect.left, clientY - rect.top, {
          isolatedIds: isolatedRef.current,
          ...hiddenPickOption(),
        })
        setHovering(hit?.intersection?.expressId !== undefined)
      } catch {
        hoverAffordableRef.current = false
        setHovering(false)
      }
      if (performance.now() - started > HOVER_BUDGET_MS) {
        hoverAffordableRef.current = false
        setHovering(false)
      }
    })
  }, [hiddenPickOption])

  useEffect(() => {
    hoverAffordableRef.current = !compact
    return () => {
      if (hoverFrameRef.current !== null) cancelAnimationFrame(hoverFrameRef.current)
      hoverFrameRef.current = null
    }
  }, [compact, sourceUrl])

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
    if (!drag) {
      if (!ready) return
      // While measuring, the pointer is a crosshair looking for a corner
      // rather than a cursor looking for an element: the same raycast answers
      // both, and running the hover test as well would pay for it twice.
      if (measuringRef.current) {
        cursorRef.current = measureAt(event.clientX, event.clientY)
        overlayRef.current?.setPending(anchorRef.current, cursorRef.current)
        requestFrame()
        return
      }
      testHover(event.clientX, event.clientY)
      return
    }
    const dx = event.clientX - drag.x
    const dy = event.clientY - drag.y
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true
    drag.x = event.clientX
    drag.y = event.clientY
    // Right or middle button pans, and so does shift-drag; anything else
    // orbits. Right-drag was missing, which is the pan every architect reaches
    // for first — and without a `contextmenu` handler it opened the browser
    // menu over the building instead.
    if (drag.button === 1 || drag.button === 2 || event.shiftKey) {
      renderer.getCamera().pan(dx, dy, true)
    } else {
      renderer.getCamera().orbit(dx, dy, true)
    }
    runCameraLoop()
  }

  /**
   * Resolve a canvas-relative point to the element drawn there.
   *
   * `isolatedIds` travels with the query. Without it the pick pass considers
   * hidden geometry, so isolating a storey and clicking on empty space
   * selected a wall on a level that is not on screen — the selection was
   * real, the element was invisible, and the reader had no way to tell why.
   */
  const pickAt = useCallback(async (clientX: number, clientY: number): Promise<BimViewerElement | null> => {
    const renderer = rendererRef.current
    const canvas = canvasRef.current
    if (!renderer || !canvas) return null
    const rect = canvas.getBoundingClientRect()
    const ratio = Math.min(window.devicePixelRatio || 1, 2)
    const hit = await renderer.pick(
      Math.round((clientX - rect.left) * ratio),
      Math.round((clientY - rect.top) * ratio),
      // Both filters travel with the query. Without them the pick pass
      // considers geometry that is not on screen, so clicking empty space
      // selects a wall the reader deliberately took out of the way — the
      // selection is real, the element is invisible, and nothing explains it.
      { isolatedIds: isolatedRef.current, ...hiddenPickOption() }
    )
    const expressId = hit?.expressId
    if (expressId === undefined) return null
    return elementsRef.current.find((candidate) => candidate.expressId === expressId) ?? null
  }, [hiddenPickOption])

  const handlePointerUp = async (event: React.PointerEvent<HTMLCanvasElement>) => {
    const wasPinching = pinchRef.current !== null
    const drag = dragRef.current
    dragRef.current = null
    endPointer(event)
    // Lifting one finger of a pinch is not a click on whatever was under it.
    if (wasPinching) return
    // A click is a pointer-up that did not drag: orbiting past an element must
    // not select it.
    if (!rendererRef.current || !drag || drag.moved || drag.button !== 0) return

    // Measuring owns the primary click. Selecting as well would open the
    // inspector over the wall being measured, and the second pick would land
    // on the panel rather than on the building.
    if (measuringRef.current) {
      placeMeasurePoint(event.clientX, event.clientY)
      return
    }

    try {
      onSelectRef.current?.(await pickAt(event.clientX, event.clientY))
    } catch {
      onSelectRef.current?.(null)
    }
  }

  /**
   * Double-click frames what is under the cursor.
   *
   * The one navigation gesture every 3D tool shares, and the fastest way out
   * of "I zoomed into the middle of a slab and cannot find my way back".
   */
  const handleDoubleClick = async (event: React.MouseEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current
    if (!renderer || !ready) return
    // Two measurement points in quick succession are also a double-click. Not
    // guarding here would fly the camera to whatever the second point landed
    // on, at exactly the moment the reader is reading the number.
    if (measuringRef.current) return
    try {
      const element = await pickAt(event.clientX, event.clientY)
      if (!element) {
        fitModel()
        return
      }
      const box = renderer.getScene().getEntityBoundingBox(element.expressId)
      if (!box) return
      onSelectRef.current?.(element)
      const camera = renderer.getCamera()
      runCameraLoop()
      void (camera.frameBounds
        ? camera.frameBounds(box.min, box.max)
        : camera.zoomExtent(box.min, box.max)
      )
        .then(() => requestFrame())
        .catch(() => {})
    } catch {
      // A pick that failed is a double-click that did nothing, which is a
      // better outcome than a camera that moved somewhere unexplained.
    }
  }

  /**
   * The wheel, as a NATIVE listener rather than a React prop.
   *
   * React attaches `onWheel` at the root as a passive listener, so
   * `preventDefault` inside it is ignored — the browser scrolls the page as
   * well as zooming the model. `touch-action: none` covers touch and does
   * nothing for a wheel. In a scrollable page that meant every zoom also
   * scrolled the viewport out from under the cursor, which is the single most
   * damning thing a 3D view can do.
   */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (event: WheelEvent) => {
      const renderer = rendererRef.current
      if (!renderer) return
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
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
          rect.height,
          // Ctrl+wheel is a trackpad pinch on every platform; the browser
          // reports it as a wheel with `ctrlKey`. Treating it as an ordinary
          // notch makes a pinch on a laptop crawl.
          event.ctrlKey
        )
      runCameraLoop()
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [runCameraLoop])

  /**
   * Keyboard navigation.
   *
   * Not an accessibility box to tick — it is the difference between a viewport
   * a keyboard user can look around and one they can only stare at. Arrow keys
   * orbit, shift-arrows pan, `+`/`-` zoom, `F` and `Home` frame the model,
   * matching what the same keys do in the tools this audience already uses.
   */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current
    if (!renderer || !ready) return
    const step = keyboardCameraStep(event.key)
    if (step === null) {
      if (event.key === 'f' || event.key === 'F' || event.key === 'Home') {
        event.preventDefault()
        fitModel()
      }
      // Escape drops a half-placed measurement before it reaches the dialog,
      // which would otherwise close the whole model over one stray click.
      if (event.key === 'Escape' && measuringRef.current && anchorRef.current) {
        event.preventDefault()
        event.stopPropagation()
        anchorRef.current = null
        onMeasurePendingRef.current?.(false)
        overlayRef.current?.setPending(null, cursorRef.current)
        requestFrame()
      }
      return
    }
    event.preventDefault()
    const camera = renderer.getCamera()
    if (step.kind === 'zoom') {
      const rect = event.currentTarget.getBoundingClientRect()
      camera.zoom(step.amount, true, rect.width / 2, rect.height / 2, rect.width, rect.height)
    } else if (event.shiftKey) {
      camera.pan(step.x * KEY_PAN_PX, step.y * KEY_PAN_PX, true)
    } else {
      camera.orbit(step.x * KEY_ORBIT_PX, step.y * KEY_ORBIT_PX, true)
    }
    runCameraLoop()
  }

  return (
    /*
      The canvas, and the two layers that draw ON it.

      A wrapper rather than a bare `<canvas>` because a dimension line has to
      be drawn in the page, not in the scene — see `measure-overlay.ts` for
      why. Both layers are `pointer-events-none`, so every gesture still
      reaches the canvas underneath and the viewport behaves exactly as it did
      when it was one element.
    */
    <div className={cn('relative', className)}>
      <canvas
        ref={canvasRef}
        className={cn(
          'size-full touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
          // The cursor IS the affordance. A canvas with a text caret over it
          // reads as a picture; a grab hand reads as something you can turn.
          // Measuring gets the crosshair every CAD tool uses, because the
          // click means something completely different there.
          measuring
            ? 'cursor-crosshair'
            : dragging
              ? 'cursor-grabbing'
              : hovering
                ? 'cursor-pointer'
                : 'cursor-grab'
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onPointerLeave={() => setHovering(false)}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        // Right-drag pans, so the browser's menu must not appear on top of it.
        onContextMenu={(event) => event.preventDefault()}
        // Focusable so the keyboard controls above can be reached at all.
        tabIndex={0}
        // The canvas is a graphical view of data that is also available as text
        // in the element table beside it, so it is labelled rather than
        // described. Through the dictionary like every other string a reader
        // sees: a hardcoded German label is the one piece of the page an
        // English screen reader cannot read.
        role="img"
        aria-label={t('viewer.canvasLabel')}
      />
      <svg
        ref={overlaySvgRef}
        className="pointer-events-none absolute inset-0 size-full overflow-visible"
        // The measurements are also published as text in the list beside the
        // dock, so the drawing itself is decorative to a screen reader.
        aria-hidden="true"
      />
      <div
        ref={overlayLabelsRef}
        className="pointer-events-none absolute inset-0 overflow-hidden"
        aria-hidden="true"
      />
    </div>
  )
}

export default IfcViewerCanvas
