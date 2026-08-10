'use client'

/**
 * The 3D viewport plus everything around it: lazy loading, progress, the
 * graceful degradation when the browser has no WebGPU, and the small toolbar.
 *
 * The fallback is the point of this component. WebGPU shipped in Chrome and
 * Edge first; Safari and Firefox arrived later and plenty of installed browsers
 * still do not have it. A viewer that renders a blank canvas there would make
 * the whole feature look broken, when in fact everything except the picture is
 * available — the structure, the elements, the properties, the quantities, and
 * the assistant's answers. So an unsupported browser is told exactly that, in
 * place of the canvas, and the rest of the page carries on.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { Layers, MonitorX } from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  buildColorOverrides,
  expressIdsForStorey,
  HIGHLIGHT_CSS,
  resolveHighlights,
  supportsWebGpu,
  type BimHighlightGroup,
  type BimViewerElement,
} from '../lib/model-index'
import {
  clampCut,
  defaultCameraState,
  type BimCameraView,
  type BimSection,
  type BimViewerCameraState,
} from '../lib/viewer-camera'
import { IfcViewerToolbar } from './ifc-viewer-toolbar'
import type { IfcViewerStatus } from './ifc-viewer-canvas'

/**
 * `ssr: false` is not an optimisation here, it is a correctness requirement:
 * the module reaches for `navigator.gpu` and constructs a `Renderer` around a
 * real `HTMLCanvasElement`, neither of which exists while rendering on the
 * server. The dynamic boundary also keeps the multi-megabyte WASM kernel out of
 * every bundle that merely links to a project.
 */
const IfcViewerCanvas = dynamic(
  () => import('./ifc-viewer-canvas').then((module) => module.IfcViewerCanvas),
  { ssr: false }
)

export interface IfcModelViewerProps {
  sourceUrl: string | null
  elements: readonly BimViewerElement[]
  highlights?: readonly BimHighlightGroup[]
  /** Storey to isolate, or null for the whole building. */
  isolatedStorey?: string | null
  selectedGlobalId?: string | null
  onSelect?: (element: BimViewerElement | null) => void
  /**
   * Ghost everything that is not highlighted or selected. Controlled by the
   * page (and by the `xray` URL parameter) rather than local, so a shared link
   * reproduces the view it was taken from.
   */
  xray?: boolean
  onXrayChange?: (xray: boolean) => void
  /**
   * Camera direction, projection and section cut.
   *
   * Controlled from the page, like `xray`, because all three belong in the
   * link: "Schnitt bei +2,60 m, Blick nach Norden, diese drei Wände markiert"
   * is a thing one person sends another, and a viewport that kept it locally
   * would hand them a screenshot instead.
   */
  camera?: BimViewerCameraState
  onCameraChange?: (camera: BimViewerCameraState) => void
  /**
   * Elevation of the storey in view, in metres — the cut lands a metre above
   * it, which is where a Grundriss is cut.
   */
  storeyElevation?: number | null
  className?: string
  /** Compact chrome for the in-chat card; full chrome for the model page. */
  variant?: 'page' | 'card'
}

export function IfcModelViewer({
  sourceUrl,
  elements,
  highlights = [],
  isolatedStorey = null,
  selectedGlobalId = null,
  onSelect,
  xray = false,
  onXrayChange,
  camera,
  onCameraChange,
  storeyElevation = null,
  className,
  variant = 'page',
}: IfcModelViewerProps): JSX.Element {
  const t = useTranslations('bim')
  const [status, setStatus] = useState<IfcViewerStatus>({ phase: 'idle', percent: null, meshCount: 0 })
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
   * Controlled when the page passes `camera` + `onCameraChange`, local
   * otherwise.
   *
   * The model page controls it so the view lands in the URL. Anywhere else —
   * an embed, a preview, a future card — the viewport still has to work, and a
   * toolbar whose buttons silently do nothing because a caller forgot a prop is
   * worse than one that keeps its own state.
   */
  const [localCamera, setLocalCamera] = useState(defaultCameraState)
  const cameraState = camera ?? localCamera

  // A cut arriving from a link may name a height this model does not have —
  // the link was copied from a different revision, or typed. Clamping keeps
  // the plane inside the building instead of slicing empty space, which the
  // reader would read as a model that failed to load.
  const section = useMemo(() => {
    if (!cameraState.section) return null
    if (!bounds) return cameraState.section
    return { ...cameraState.section, atMetres: clampCut(cameraState.section.atMetres, {
      minY: bounds.minMetres,
      maxY: bounds.maxMetres,
    }) }
  }, [cameraState.section, bounds])

  const setCamera = useCallback(
    (patch: Partial<BimViewerCameraState>) => {
      const next = { ...cameraState, ...patch }
      if (onCameraChange) onCameraChange(next)
      else setLocalCamera(next)
    },
    [cameraState, onCameraChange]
  )

  const handleView = useCallback(
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
  const handleSection = useCallback((next: BimSection | null) => setCamera({ section: next }), [setCamera])

  // Evaluated once per mount rather than per render: it cannot change without a
  // page reload, and calling it during render on the server would be wrong.
  const webGpu = useMemo(() => supportsWebGpu(), [])

  const resolved = useMemo(() => resolveHighlights(highlights, elements), [highlights, elements])
  const colorOverrides = useMemo(() => buildColorOverrides(resolved), [resolved])
  const isolatedExpressIds = useMemo(
    () => expressIdsForStorey(elements, isolatedStorey),
    [elements, isolatedStorey]
  )
  /**
   * The last element THIS canvas reported a click on.
   *
   * Selecting a wall in the table, from a search result or from a chat chip
   * should fly the camera to it — "find the red thing" in a five-thousand
   * element building is otherwise a manual hunt, and the renderer has had
   * `zoomExtent` all along. Clicking one IN the viewport must not, or the
   * camera moves out from under the hand that just clicked.
   *
   * A ref rather than state: it is read during the render that follows the
   * selection change, and storing it in state would render twice to compute a
   * boolean.
   */
  const clickedInCanvasRef = useRef<string | null>(null)
  const handleCanvasSelect = useCallback(
    (element: BimViewerElement | null) => {
      clickedInCanvasRef.current = element?.globalId ?? null
      onSelect?.(element)
    },
    [onSelect]
  )
  const zoomToSelection = selectedGlobalId !== null && selectedGlobalId !== clickedInCanvasRef.current

  const selectedExpressId = useMemo(
    () => elements.find((element) => element.globalId === selectedGlobalId)?.expressId ?? null,
    [elements, selectedGlobalId]
  )

  // X-ray keeps the highlighted set solid and fades the rest to context. With
  // nothing highlighted there is nothing to keep solid, so the toggle has no
  // set to pass and ghosting stays off rather than fading the whole building.
  const xrayContextIds = useMemo(() => {
    if (!xray) return null
    const ids = new Set<number>()
    for (const group of resolved) for (const id of group.expressIds) ids.add(id)
    if (selectedExpressId !== null) ids.add(selectedExpressId)
    return ids.size > 0 ? ids : null
  }, [xray, resolved, selectedExpressId])

  if (!webGpu || !sourceUrl) {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-8 text-center',
          className
        )}
      >
        <MonitorX className="size-6 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm font-medium">{t('viewer.unsupported.title')}</p>
        <p className="max-w-prose text-sm text-muted-foreground">{t('viewer.unsupported.description')}</p>
      </div>
    )
  }

  const statusLabel =
    status.phase === 'downloading'
      ? t('viewer.downloading')
      : status.phase === 'parsing'
        ? t('viewer.parsing', { count: status.meshCount })
        : status.phase === 'ready'
          ? t('viewer.ready', { count: status.meshCount })
          : status.phase === 'error'
            ? t('viewer.failed', { message: status.message ?? '' })
            : ''

  return (
    <div className={cn('relative overflow-hidden rounded-xl border bg-muted/30', className)}>
      <IfcViewerCanvas
        key={sourceUrl}
        sourceUrl={sourceUrl}
        elements={elements}
        colorOverrides={colorOverrides}
        isolatedExpressIds={isolatedExpressIds}
        selectedExpressId={selectedExpressId}
        xrayContextIds={xrayContextIds}
        view={cameraState.view}
        viewNonce={viewNonce}
        fitNonce={fitNonce}
        orthographic={cameraState.orthographic}
        section={section}
        onBounds={setBounds}
        onSelect={handleCanvasSelect}
        zoomToSelection={zoomToSelection}
        onStatus={setStatus}
        className="size-full touch-none"
      />

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg bg-background/85 px-2 py-1 text-xs text-muted-foreground backdrop-blur">
          {(status.phase === 'downloading' || status.phase === 'parsing') && <Spinner className="size-3" />}
          <span>{statusLabel}</span>
        </div>
        {variant === 'page' && (
          <IfcViewerToolbar
            className="pointer-events-auto"
            view={cameraState.view}
            onViewChange={handleView}
            orthographic={cameraState.orthographic}
            onOrthographicChange={(orthographic) => setCamera({ orthographic })}
            section={section}
            onSectionChange={handleSection}
            cutRange={bounds}
            defaultCutMetres={
              storeyElevation === null ? null : Math.round((storeyElevation + 1) * 100) / 100
            }
            xray={xray}
            onXrayChange={onXrayChange}
            onFit={() => setFitNonce((n) => n + 1)}
            disabled={status.phase !== 'ready'}
          />
        )}
      </div>

      {resolved.length > 0 && (
        <ul className="pointer-events-none absolute bottom-2 left-2 flex max-w-[70%] flex-wrap gap-1.5">
          {resolved.map((highlight) => (
            <li
              key={highlight.label}
              className="flex items-center gap-1.5 rounded-md bg-background/85 px-2 py-1 text-xs backdrop-blur"
            >
              <span
                aria-hidden="true"
                className="size-2.5 rounded-full"
                style={{ backgroundColor: HIGHLIGHT_CSS[highlight.status] }}
              />
              <span>{highlight.label}</span>
              <span className="text-muted-foreground">({highlight.expressIds.length})</span>
            </li>
          ))}
        </ul>
      )}

      {variant === 'page' && (
        <p className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-background/85 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur">
          <Layers className="size-3" aria-hidden="true" />
          {t('viewer.hint')}
        </p>
      )}
    </div>
  )
}
