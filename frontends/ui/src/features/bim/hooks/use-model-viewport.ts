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

import { useCallback, useMemo, useState } from 'react'
import {
  buildColorOverrides,
  expressIdsForStorey,
  resolveHighlights,
  supportsWebGpu,
  type BimHighlightGroup,
  type BimViewerElement,
  type ResolvedHighlight,
} from '../lib/model-index'
import {
  clampCut,
  defaultCameraState,
  type BimCameraView,
  type BimSection,
  type BimViewerCameraState,
} from '../lib/viewer-camera'
import type { IfcViewerCanvasProps, IfcViewerStatus } from '../components/ifc-viewer-canvas'

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
}

export interface ModelViewport {
  /** False when the browser has no WebGPU at all — the canvas cannot mount. */
  webGpu: boolean
  status: IfcViewerStatus
  /** The model's vertical extent in metres, once it has loaded. */
  bounds: { minMetres: number; maxMetres: number } | null
  /** The cut, clamped into this model's extent. */
  section: BimSection | null
  camera: BimViewerCameraState
  highlights: ResolvedHighlight[]
  /** Spread onto `IfcViewerCanvas`. Null when there is nothing to render. */
  canvasProps: IfcViewerCanvasProps | null
  /** Snap to a named direction — and again, if it is already the active one. */
  setView: (view: BimCameraView) => void
  setSection: (section: BimSection | null) => void
  setOrthographic: (orthographic: boolean) => void
  /** Frame the whole model. */
  fit: () => void
  /** Where a cut should land when it is switched on, in metres. */
  defaultCut: (storeyElevation: number | null) => number
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
   * The canvas is behind `next/dynamic`, and a `ref` cannot cross that on
   * React 18 — see the note in `ifc-viewer-canvas.tsx`. These are ordinary
   * props, and they also give "press the view you are already on" a state
   * change to hang off, which a bare view name cannot.
   */
  const [viewNonce, setViewNonce] = useState(0)
  const [fitNonce, setFitNonce] = useState(0)

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

  // A cut arriving from a link may name a height this model does not have —
  // the link was copied from a different revision, or typed. Clamping keeps
  // the plane inside the building instead of slicing empty space, which the
  // reader would read as a model that failed to load.
  const section = useMemo(() => {
    if (!cameraState.section) return null
    if (!bounds) return cameraState.section
    return {
      ...cameraState.section,
      atMetres: clampCut(cameraState.section.atMetres, {
        minY: bounds.minMetres,
        maxY: bounds.maxMetres,
      }),
    }
  }, [cameraState.section, bounds])

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
  const setOrthographic = useCallback(
    (orthographic: boolean) => setCamera({ orthographic }),
    [setCamera]
  )
  const fit = useCallback(() => setFitNonce((n) => n + 1), [])

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

  // Evaluated once per mount rather than per render: it cannot change without a
  // page reload, and calling it during render on the server would be wrong.
  const webGpu = useMemo(() => supportsWebGpu(), [])

  const resolved = useMemo(() => resolveHighlights(highlights, elements), [highlights, elements])
  const colorOverrides = useMemo(() => buildColorOverrides(resolved), [resolved])
  const isolatedExpressIds = useMemo(
    () => expressIdsForStorey(elements, isolatedStorey),
    [elements, isolatedStorey]
  )

  const selectedExpressId = useMemo(
    () => elements.find((element) => element.globalId === selectedGlobalId)?.expressId ?? null,
    [elements, selectedGlobalId]
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
      selectedExpressId,
      xrayKeepIds,
      view: cameraState.view,
      viewNonce,
      fitNonce,
      orthographic: cameraState.orthographic,
      section,
      onBounds: setBounds,
      onSelect: handleCanvasSelect,
      zoomToSelection,
      compact,
      onStatus: handleStatus,
    }
  }, [
    webGpu,
    sourceUrl,
    elements,
    colorOverrides,
    isolatedExpressIds,
    selectedExpressId,
    xrayKeepIds,
    cameraState.view,
    cameraState.orthographic,
    viewNonce,
    fitNonce,
    section,
    handleCanvasSelect,
    zoomToSelection,
    compact,
    handleStatus,
  ])

  return {
    webGpu,
    status: current,
    bounds,
    section,
    camera: cameraState,
    highlights: resolved,
    canvasProps,
    setView,
    setSection,
    setOrthographic,
    fit,
    defaultCut,
  }
}
