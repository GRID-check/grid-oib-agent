'use client'

/**
 * Everything the viewport knows, minus the chrome.
 *
 * Two surfaces show the same building — the full-screen stage and the
 * card-sized preview in a file dialog — and both need the same seven things:
 * whether this browser can render at all, how far the load has got, how tall
 * the model is, which express ids are highlighted, isolated or kept solid, and
 * two counters that let a button re-trigger a camera move it has already
 * triggered once.
 *
 * That state used to live inside the viewer component, so the only way to give
 * a second surface different chrome was to grow a `variant` prop and branch on
 * it — which is how the old viewer ended up rendering a toolbar, a legend, a
 * status chip and a hint line, each behind a different condition. Pulling the
 * state out means the chrome is just composition: the stage draws a dock, the
 * preview draws nothing, and neither knows what the other does.
 *
 * The hook owns no DOM and no renderer. It hands back a ready-made props
 * object for the canvas so a caller cannot forget to thread one through — the
 * x-ray set went unwired for a whole release because it was one of eleven
 * hand-copied props.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  buildColorOverrides,
  expressIdsForStorey,
  hasVisibilityEdits,
  NOTHING_HIDDEN,
  resolveHighlights,
  resolveIsolation,
  sameIdSet,
  sameVisibility,
  selectionSurvives,
  supportsWebGpu,
  type BimHighlightGroup,
  type BimViewerElement,
  type ResolvedHighlight,
  type ViewerVisibility,
} from '../lib/model-index'
import {
  clampCut,
  defaultCameraState,
  type BimCameraView,
  type BimSection,
  type BimViewerCameraState,
} from '../lib/viewer-camera'
import { addMeasurement, type Measurement } from '../lib/viewer-measure'
import type { IfcViewerCanvasProps, IfcViewerStatus } from '../components/ifc-viewer-canvas'

/** One shared empty list, so "nothing measured" has a stable identity. */
const EMPTY_MEASUREMENTS: readonly Measurement[] = []

export interface UseModelViewportOptions {
  /** Presigned `.ifc` URL, or null until one has been minted. */
  sourceUrl: string | null
  elements: readonly BimViewerElement[]
  highlights?: readonly BimHighlightGroup[]
  /** Storey to isolate, or null for the whole building. */
  isolatedStorey?: string | null
  selectedGlobalId?: string | null
  onSelect?: (element: BimViewerElement | null) => void
  xray?: boolean
  /**
   * Camera state owned by the caller, so it can travel in the URL. Omitted
   * makes the viewport keep its own — a preview still has to work.
   */
  camera?: BimViewerCameraState
  onCameraChange?: (camera: BimViewerCameraState) => void
  /** Cheaper shading and no hover testing, for a card-sized viewport. */
  compact?: boolean
  /** Receives the PNG data URL produced by {@link ModelViewport.capture}. */
  onCapture?: (dataUrl: string | null) => void
  /**
   * Called just before a hide / isolate / show-everything lands, with the
   * state it replaces — so a surface keeping its own history can record the
   * step and hand it back to {@link ModelVisibility.restore}.
   *
   * The hook fires it rather than letting the caller record on the click,
   * because only the hook can tell an edit from a no-op: isolating the same
   * element twice is a press with nothing behind it, and a step recorded for
   * it is an Undo that appears to do nothing.
   */
  onVisibilityEdit?: (previous: ViewerVisibility) => void
}

/**
 * Measuring, as viewport state.
 *
 * Owned here rather than in the stage for the same reason the cut is: two
 * surfaces show the same building, and a control that works on one and
 * silently does nothing on the other is worse than one that exists in neither.
 *
 * Deliberately NOT in the URL, unlike the camera and the cut. A measurement is
 * a working note taken while reading — a reviewer takes six of them checking
 * one corridor and discards all six — and putting them in the query string
 * would make every pick a history entry and every shared link carry someone
 * else's scratch marks. The camera is a VIEW, which is worth sending; a
 * measurement is a question already answered.
 */
export interface ModelMeasuring {
  active: boolean
  /** A first point is down and the tool is waiting for the second. */
  pending: boolean
  measurements: readonly Measurement[]
  setActive: (active: boolean) => void
  clear: () => void
}

/**
 * Taking things out of the way, as viewport state.
 *
 * Like measuring and unlike the camera, this stays out of the URL. Hiding the
 * roof slab to see the stair is a working move, not a view worth sending — and
 * a link that arrives with three elements silently missing is a link whose
 * recipient is looking at a different building from the one they think.
 *
 * Staying out of the URL is also why undo cannot come for free here the way it
 * does for the view: there is no query string to step back through. So the
 * hook reports each edit and accepts a state back — see `onVisibilityEdit` and
 * {@link ModelVisibility.restore} — and whichever surface owns a history owns
 * this too. The stage does; the card-sized preview has no way to edit
 * visibility at all and passes neither.
 */
export interface ModelVisibility extends ViewerVisibility {
  /** Whether anything has been hidden or isolated — drives "show everything". */
  edited: boolean
  hide: (expressId: number) => void
  /**
   * Show nothing but these — and, called again with the same set, show the
   * building again. A toggle, because the control that isolates is the only
   * control still on screen once everything else is gone.
   */
  isolate: (expressIds: readonly number[]) => void
  showEverything: () => void
  /**
   * Put a previous state back, without recording the restore as an edit.
   *
   * The counterpart to {@link UseModelViewportOptions.onVisibilityEdit}: the
   * host holds the history, so undo is a state it hands back rather than a
   * stack the hook keeps. Taking one step back and "show everything" are
   * different acts — the reader who hid four things and then isolated a fifth
   * wants the four back, not a fresh building.
   */
  restore: (edits: ViewerVisibility) => void
}

export interface ModelViewport {
  /** False when the browser has no WebGPU at all — the canvas cannot mount. */
  webGpu: boolean
  status: IfcViewerStatus
  /** The model's vertical extent in metres, once it has loaded. */
  bounds: { minMetres: number; maxMetres: number } | null
  /** The cut, clamped into this model's extent. */
  section: BimSection | null
  /**
   * The renderer id of the selection, or null when there is none — including
   * when the reader has just hidden the thing they had selected.
   */
  selectedExpressId: number | null
  /**
   * The same selection, but resolved through the model alone — still there
   * when the current visibility edits have taken it off screen.
   *
   * Two ids because two questions. "What is the renderer highlighting and
   * pivoting around" must not name something that is not drawn, which is what
   * {@link selectedExpressId} answers. "What did the reader ask about" is a
   * different question with a different answer, and the card is mounted on
   * THAT one: a reader who isolates a wall and then picks another from the
   * rail is looking at a card for an element the viewport has resolved to
   * null, and every control on it that needed an id had quietly gone — the
   * isolate button included, which is the one control that would have put
   * them somewhere else. Null still means no selection at all, and it is null
   * for an element this model does not contain.
   */
  selectedElementExpressId: number | null
  camera: BimViewerCameraState
  highlights: ResolvedHighlight[]
  /** Spread onto `IfcViewerCanvas`. Null when there is nothing to render. */
  canvasProps: IfcViewerCanvasProps | null
  /** Snap to a named direction — and again, if it is already the active one. */
  setView: (view: BimCameraView) => void
  setSection: (section: BimSection | null) => void
  /**
   * Move the cut for THIS frame, leaving the link alone.
   *
   * Pair with {@link setSection} on the gesture's end — see the note on
   * `liveCut` for why a continuous control cannot write to the URL per step.
   */
  previewCut: (atMetres: number) => void
  setOrthographic: (orthographic: boolean) => void
  /** Frame the whole model. */
  fit: () => void
  /** Where a cut should land when it is switched on, in metres. */
  defaultCut: (storeyElevation: number | null) => number
  measure: ModelMeasuring
  visibility: ModelVisibility
  /**
   * Capture the view as a PNG and hand it to `onCapture`.
   *
   * The viewport cannot decide what happens to the image — a stage downloads
   * it, a report would embed it, a BCF topic would attach it — so it produces
   * the bytes and says nothing about their destination.
   */
  capture: () => void
}

export function useModelViewport({
  sourceUrl,
  elements,
  highlights = [],
  isolatedStorey = null,
  selectedGlobalId = null,
  onSelect,
  xray = false,
  camera,
  onCameraChange,
  compact = false,
  onCapture,
  onVisibilityEdit,
}: UseModelViewportOptions): ModelViewport {
  const [status, setStatus] = useState<IfcViewerStatus>({
    phase: 'idle',
    percent: null,
    meshCount: 0,
  })
  /**
   * A failure belongs to the source that produced it.
   *
   * The error fallback returns BEFORE the canvas renders, so once a status of
   * `error` was stored the canvas never mounted again — and only the canvas
   * can report a new status. A new `sourceUrl` (the next model, or a re-signed
   * URL after the first one expired) therefore stayed unavailable until the
   * whole parent unmounted. Deriving from the current source, rather than
   * resetting in an effect, avoids the frame where the old error is still on
   * screen under the new URL.
   */
  const [statusSource, setStatusSource] = useState<string | null>(sourceUrl)
  const current: IfcViewerStatus =
    statusSource === sourceUrl ? status : { phase: 'idle', percent: null, meshCount: 0 }

  const [bounds, setBounds] = useState<{ minMetres: number; maxMetres: number } | null>(null)

  /**
   * Counters, not a ref.
   *
   * The canvas is behind `next/dynamic`, which is where this started — see the
   * note in `ifc-viewer-canvas.tsx`. These are ordinary props, and they give
   * "press the view you are already on" a state change to hang off, which a
   * bare view name cannot.
   */
  const [viewNonce, setViewNonce] = useState(0)
  const [fitNonce, setFitNonce] = useState(0)
  const [captureNonce, setCaptureNonce] = useState(0)

  /**
   * Controlled when the caller passes `camera` + `onCameraChange`, local
   * otherwise.
   *
   * The stage controls it so the view lands in the URL. Anywhere else — a
   * preview, an embed — the viewport still has to work, and a control that
   * silently does nothing because a caller forgot a prop is worse than one
   * that keeps its own state.
   */
  const [localCamera, setLocalCamera] = useState(defaultCameraState)
  const cameraState = camera ?? localCamera

  const setCamera = useCallback(
    (patch: Partial<BimViewerCameraState>) => {
      const next = { ...cameraState, ...patch }
      if (onCameraChange) onCameraChange(next)
      else setLocalCamera(next)
    },
    [cameraState, onCameraChange]
  )

  /**
   * A cut height the reader is still dragging.
   *
   * The camera lives in the URL, which is right — a view is a link. But a
   * continuous control cannot be driven through a router: the cut slider is a
   * controlled input, every step of a drag was a `router.replace`, and in the
   * App Router that re-runs the server component tree. The value the thumb is
   * pinned to therefore lagged the pointer by a round trip, React reset the
   * thumb to it on every render, and the slider did not move at all. It read
   * as a hard floor at whatever height the cut had been switched on at.
   *
   * So the drag has a local value that WINS over the URL until the URL agrees
   * with it. `previewCut` is per step and costs a React render; `setSection`
   * is per gesture and costs the link. Both end at the same number.
   */
  const [liveCut, setLiveCut] = useState<number | null>(null)

  // A cut arriving from a link may name a height this model does not have —
  // the link was copied from a different revision, or typed. Clamping keeps
  // the plane inside the building instead of slicing empty space, which the
  // reader would read as a model that failed to load.
  const section = useMemo(() => {
    if (!cameraState.section) return null
    const atMetres = liveCut ?? cameraState.section.atMetres
    if (!bounds) return { ...cameraState.section, atMetres }
    return {
      ...cameraState.section,
      atMetres: clampCut(atMetres, { minY: bounds.minMetres, maxY: bounds.maxMetres }),
    }
  }, [cameraState.section, liveCut, bounds])

  /**
   * Let go of the local value once the link carries it.
   *
   * Not on commit: the router is asynchronous, so dropping it there shows the
   * PREVIOUS height for however long the round trip takes — the plane would
   * visibly snap back and then forward again on every release. Dropping it
   * when the two agree makes the handover invisible.
   *
   * A cut that is switched off, or a model that is replaced, drops it too:
   * neither has a height for the local value to be a preview OF.
   */
  useEffect(() => {
    if (liveCut === null) return
    if (!cameraState.section || cameraState.section.atMetres === liveCut) setLiveCut(null)
  }, [cameraState.section, liveCut])

  const setView = useCallback(
    (view: BimCameraView) => {
      // The counter is bumped even when the view is unchanged: re-selecting
      // the active view has to re-snap a camera the reader has orbited away
      // from, and the name alone cannot express that.
      setViewNonce((n) => n + 1)
      // Choosing a plan or an elevation implies parallel projection, because a
      // perspective plan is a picture rather than a drawing. Choosing the free
      // view hands perspective back.
      setCamera({ view, orthographic: view !== 'iso' })
    },
    [setCamera]
  )

  const setSection = useCallback((next: BimSection | null) => setCamera({ section: next }), [setCamera])

  /**
   * Move the cut now, without writing the link.
   *
   * The plane follows the drag at the frame rate; the URL learns about it once
   * the reader lets go. Clamped here as well as in {@link section} so a
   * preview cannot escape the building even for one frame.
   */
  const previewCut = useCallback(
    (atMetres: number) =>
      setLiveCut(
        bounds
          ? clampCut(atMetres, { minY: bounds.minMetres, maxY: bounds.maxMetres })
          : atMetres
      ),
    [bounds]
  )
  const setOrthographic = useCallback(
    (orthographic: boolean) => setCamera({ orthographic }),
    [setCamera]
  )
  const fit = useCallback(() => setFitNonce((n) => n + 1), [])
  const capture = useCallback(() => setCaptureNonce((n) => n + 1), [])

  /**
   * Where the cut lands when it is switched on.
   *
   * The storey's own height plus a metre when the caller knows one — that is
   * where a Grundriss is cut, high enough to pass through doors and low enough
   * to stay under a lintel. Otherwise a third of the way up the model, never
   * the floor, where the plane slices the slab and shows an empty view the
   * reader will read as a broken model.
   */
  const defaultCut = useCallback(
    (storeyElevation: number | null): number => {
      if (storeyElevation !== null) return Math.round((storeyElevation + 1) * 100) / 100
      if (!bounds) return 0
      const third = bounds.minMetres + (bounds.maxMetres - bounds.minMetres) / 3
      return Math.round(third * 100) / 100
    },
    [bounds]
  )

  const [measuring, setMeasuring] = useState(false)
  const [measurePending, setMeasurePending] = useState(false)
  const [measurements, setMeasurements] = useState<readonly Measurement[]>(EMPTY_MEASUREMENTS)

  const handleMeasure = useCallback((measurement: Measurement) => {
    setMeasurements((existing) => addMeasurement(existing, measurement))
  }, [])

  /**
   * Turning the tool off keeps the measurements on screen.
   *
   * They are what the reader took them for: they have to survive orbiting to
   * another corner of the building to look at the thing they just measured.
   * `clear` is a separate, deliberate act.
   */
  const setMeasureActive = useCallback((active: boolean) => {
    setMeasuring(active)
    if (!active) setMeasurePending(false)
  }, [])

  const clearMeasurements = useCallback(() => {
    setMeasurements(EMPTY_MEASUREMENTS)
    setMeasurePending(false)
  }, [])

  const measure = useMemo<ModelMeasuring>(
    () => ({
      active: measuring,
      pending: measurePending,
      measurements,
      setActive: setMeasureActive,
      clear: clearMeasurements,
    }),
    [measuring, measurePending, measurements, setMeasureActive, clearMeasurements]
  )

  // A model that is being replaced takes its measurements with it: a dimension
  // taken on one revision means nothing floating over the next one, and the
  // points would land wherever those coordinates happen to be in the new file.
  useEffect(() => {
    setMeasurements(EMPTY_MEASUREMENTS)
    setMeasurePending(false)
  }, [sourceUrl])

  /*
    And it takes its EXTENT with it.

    `bounds` is written once, by the canvas, after the new file has parsed —
    and the canvas unmounts on the way there (a null source URL takes
    `canvasProps` to null) without ever reporting a null. So between picking a
    model in the rail and its geometry arriving, the section slider rendered
    the PREVIOUS building's minimum and maximum metres as a fact about the one
    on screen, and `clampCut` pinned the URL's cut height into that stale
    extent — then wrote the clamped value back on the next commit. A cut
    travels in the link, so this is the ordinary path, not a corner.
  */
  useEffect(() => {
    setBounds(null)
  }, [sourceUrl])

  // Evaluated once per mount rather than per render: it cannot change without a
  // page reload, and calling it during render on the server would be wrong.
  const webGpu = useMemo(() => supportsWebGpu(), [])

  const resolved = useMemo(() => resolveHighlights(highlights, elements), [highlights, elements])
  const colorOverrides = useMemo(() => buildColorOverrides(resolved), [resolved])

  const [edits, setEdits] = useState<ViewerVisibility>(NOTHING_HIDDEN)

  // A new model starts from a clean building. Express ids are per-file, so a
  // hidden set carried over would take out whichever elements happen to hold
  // those numbers in the next one.
  useEffect(() => {
    setEdits(NOTHING_HIDDEN)
  }, [sourceUrl])

  /*
    Through a ref, so the memo below stays keyed on `edits` alone.

    Every caller writes this as an inline arrow, which is a new function on
    every render; depending on it directly would rebuild the whole visibility
    object each time and change the identity of three callbacks the canvas and
    the inspector hold.
  */
  const onVisibilityEditRef = useRef(onVisibilityEdit)
  onVisibilityEditRef.current = onVisibilityEdit

  const visibility = useMemo<ModelVisibility>(() => {
    /*
      Computed against the CURRENT edits rather than inside a functional
      updater, because the decision "is this a step" needs the previous state
      in the same breath as the new one: the host is told what it replaces,
      and an edit that replaces nothing is not announced at all. `edits` is
      this memo's only dependency, so it is never stale.
    */
    const apply = (next: ViewerVisibility): void => {
      if (sameVisibility(edits, next)) return
      onVisibilityEditRef.current?.(edits)
      setEdits(next)
    }
    return {
      ...edits,
      edited: hasVisibilityEdits(edits),
      hide: (expressId) => apply({ ...edits, hidden: new Set(edits.hidden).add(expressId) }),
      /*
        Isolating REPLACES any previous isolation rather than intersecting
        with it. "Isolate this" is a fresh question every time; narrowing an
        existing isolation by clicking a second element would empty the
        viewport, which is the opposite of what the click looked like it did.

        And asking the same question twice takes the answer back.

        Isolating does not clear the selection, so the button stays right
        under the cursor with the whole building gone from around it — which
        is precisely when a reader presses it again. That press used to
        compare equal to the state already on screen and be dropped: the one
        control the reader had just used, still sitting there, now inert. Nor
        was there anything else to press ON the isolated element — the way
        back was a reset pill in the dock, several controls away, that also
        discards every hide made before it. So the press that took everything
        else away is the press that brings it back, and only the isolation
        goes: hides made before it are a separate act and survive.
      */
      isolate: (expressIds) => {
        const next = new Set(expressIds)
        const pressedAgain = sameIdSet(edits.isolated, next)
        apply({ ...edits, isolated: pressedAgain ? null : next })
      },
      showEverything: () => apply(NOTHING_HIDDEN),
      // Not through `apply`: an undo must not record itself as a step, or
      // pressing Undo twice oscillates between two states forever.
      restore: (restored) => setEdits(restored),
    }
  }, [edits])

  const storeyExpressIds = useMemo(
    () => expressIdsForStorey(elements, isolatedStorey),
    [elements, isolatedStorey]
  )
  const isolatedExpressIds = useMemo(
    () => resolveIsolation(storeyExpressIds, edits.isolated),
    [storeyExpressIds, edits.isolated]
  )

  const selectedElementExpressId = useMemo(
    () => elements.find((element) => element.globalId === selectedGlobalId)?.expressId ?? null,
    [elements, selectedGlobalId]
  )

  const selectedExpressId = useMemo(
    // A selection the reader has just hidden stops being a selection. Keeping
    // it would leave the camera orbiting an invisible pivot and the highlight
    // pass painting a component that is not on screen. What it does NOT stop
    // being is the element the card is about — see `selectedElementExpressId`.
    () => (selectionSurvives(selectedElementExpressId, edits) ? selectedElementExpressId : null),
    [selectedElementExpressId, edits]
  )

  // X-ray keeps the highlighted set solid and fades the rest to context. With
  // nothing highlighted there is nothing to keep solid, so the toggle has no
  // set to pass and ghosting stays off rather than fading the whole building.
  const xrayKeepIds = useMemo(() => {
    if (!xray) return null
    const ids = new Set<number>()
    for (const group of resolved) for (const id of group.expressIds) ids.add(id)
    if (selectedExpressId !== null) ids.add(selectedExpressId)
    return ids.size > 0 ? ids : null
  }, [xray, resolved, selectedExpressId])

  /**
   * The last element THIS canvas reported a click on.
   *
   * Selecting a wall in the rail, from a search result or from a chat chip
   * should frame the camera on it — "find the red thing" in a five-thousand
   * element building is otherwise a manual hunt. Clicking one IN the viewport
   * must not, or the camera moves out from under the hand that just clicked.
   *
   * State rather than a ref: a ref written during an event handler is not read
   * again until something else re-renders, and on a selection that arrives
   * from the URL nothing else does — so the ref version silently framed the
   * camera on canvas clicks too, whenever React batched the two updates.
   */
  const [clickedInCanvas, setClickedInCanvas] = useState<string | null>(null)
  const handleCanvasSelect = useCallback(
    (element: BimViewerElement | null) => {
      setClickedInCanvas(element?.globalId ?? null)
      onSelect?.(element)
    },
    [onSelect]
  )

  /**
   * The marker is about the LAST selection, not about the element forever.
   *
   * It was only ever written by the canvas, so once a wall had been clicked in
   * the viewport its id stayed here for the rest of the session: pick that
   * same wall later from the element table, a search result or a chat chip and
   * the camera would not move, while the row above it — a wall never clicked —
   * flew the camera across the building. Same list, same gesture, two
   * behaviours, and nothing on screen to explain the difference.
   *
   * Cleared as soon as the selection moves elsewhere, so the marker only ever
   * describes the selection it was recorded for.
   */
  useEffect(() => {
    if (clickedInCanvas !== null && selectedGlobalId !== clickedInCanvas) setClickedInCanvas(null)
  }, [selectedGlobalId, clickedInCanvas])

  const zoomToSelection = selectedGlobalId !== null && selectedGlobalId !== clickedInCanvas

  const handleStatus = useCallback(
    (next: IfcViewerStatus) => {
      setStatusSource(sourceUrl)
      setStatus(next)
    },
    [sourceUrl]
  )

  const canvasProps = useMemo<IfcViewerCanvasProps | null>(() => {
    if (!webGpu || !sourceUrl) return null
    return {
      sourceUrl,
      elements,
      colorOverrides,
      isolatedExpressIds,
      hiddenExpressIds: edits.hidden,
      selectedExpressId,
      xrayKeepIds,
      view: cameraState.view,
      viewNonce,
      fitNonce,
      captureNonce,
      onCapture,
      orthographic: cameraState.orthographic,
      section,
      onBounds: setBounds,
      onSelect: handleCanvasSelect,
      zoomToSelection,
      compact,
      measuring,
      measurements,
      onMeasure: handleMeasure,
      onMeasurePending: setMeasurePending,
      onStatus: handleStatus,
    }
  }, [
    webGpu,
    sourceUrl,
    elements,
    colorOverrides,
    isolatedExpressIds,
    edits.hidden,
    selectedExpressId,
    xrayKeepIds,
    cameraState.view,
    cameraState.orthographic,
    viewNonce,
    fitNonce,
    captureNonce,
    onCapture,
    section,
    handleCanvasSelect,
    zoomToSelection,
    compact,
    measuring,
    measurements,
    handleMeasure,
    handleStatus,
  ])

  return {
    webGpu,
    status: current,
    bounds,
    section,
    selectedExpressId,
    selectedElementExpressId,
    camera: cameraState,
    highlights: resolved,
    canvasProps,
    setView,
    setSection,
    previewCut,
    setOrthographic,
    fit,
    defaultCut,
    measure,
    visibility,
    capture,
  }
}
