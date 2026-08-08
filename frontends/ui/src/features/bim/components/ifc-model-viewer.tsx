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

import { useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { Eye, EyeOff, Layers, Maximize2, MonitorX } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  className,
  variant = 'page',
}: IfcModelViewerProps): JSX.Element {
  const t = useTranslations('bim')
  const [status, setStatus] = useState<IfcViewerStatus>({ phase: 'idle', percent: null, meshCount: 0 })
  const [remountKey, setRemountKey] = useState(0)

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
        key={`${sourceUrl}-${remountKey}`}
        sourceUrl={sourceUrl}
        elements={elements}
        colorOverrides={colorOverrides}
        isolatedExpressIds={isolatedExpressIds}
        selectedExpressId={selectedExpressId}
        xrayContextIds={xrayContextIds}
        onSelect={onSelect}
        onStatus={setStatus}
        className="size-full touch-none"
      />

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg bg-background/85 px-2 py-1 text-xs text-muted-foreground backdrop-blur">
          {(status.phase === 'downloading' || status.phase === 'parsing') && <Spinner className="size-3" />}
          <span>{statusLabel}</span>
        </div>
        {variant === 'page' && (
          <div className="pointer-events-auto flex gap-1">
            {onXrayChange && (
              <Button
                type="button"
                size="sm"
                variant={xray ? 'default' : 'secondary'}
                aria-pressed={xray}
                onClick={() => onXrayChange(!xray)}
              >
                {xray ? (
                  <EyeOff className="size-3.5" aria-hidden="true" />
                ) : (
                  <Eye className="size-3.5" aria-hidden="true" />
                )}
                {t('viewer.xray')}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              // Remounting the canvas is how "fit" is expressed without holding
              // an imperative handle to the renderer: it is a rare, explicit
              // action, and a fresh mount refits by construction.
              onClick={() => setRemountKey((key) => key + 1)}
            >
              <Maximize2 className="size-3.5" aria-hidden="true" />
              {t('viewer.fit')}
            </Button>
          </div>
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
