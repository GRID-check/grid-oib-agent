'use client'

/**
 * The building, in a box.
 *
 * The smallest complete viewport: a canvas, a loading state, and an honest
 * sentence when there is nothing to draw. No controls — this is what a file
 * preview and a dev fixture want, and adding chrome for the surfaces that DO
 * want controls is what turned the previous version into a component with a
 * `variant` prop and four conditionally-rendered overlays.
 *
 * The full-screen surface is `model-stage.tsx`. It shares every line of state
 * with this file through `useModelViewport` and differs only in what it draws
 * on top.
 *
 * The fallbacks are the reason this component is not just the canvas. WebGPU
 * shipped in Chrome and Edge first; Safari and Firefox arrived later and
 * plenty of installed browsers still do not have it. A viewer that renders a
 * blank canvas there would make the whole feature look broken, when in fact
 * everything except the picture is available.
 */

import dynamic from 'next/dynamic'
import { MonitorX } from 'lucide-react'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { useModelViewport, type UseModelViewportOptions } from '../hooks/use-model-viewport'
import { ViewerLegend, ViewerNotice, ViewerProgress } from './viewer'

/**
 * `ssr: false` is not an optimisation here, it is a correctness requirement:
 * the module reaches for `navigator.gpu` and constructs a `Renderer` around a
 * real `HTMLCanvasElement`, neither of which exists while rendering on the
 * server. The dynamic boundary also keeps the multi-megabyte WASM kernel out of
 * every bundle that merely links to a project.
 */
export const IfcViewerCanvasLazy = dynamic(
  () => import('./ifc-viewer-canvas').then((module) => module.IfcViewerCanvas),
  { ssr: false }
)

export interface IfcModelViewerProps extends UseModelViewportOptions {
  className?: string
}

export function IfcModelViewer({ className, ...options }: IfcModelViewerProps): JSX.Element {
  const t = useTranslations('bim')
  const viewport = useModelViewport({ ...options, compact: options.compact ?? true })

  /*
    Two situations, not one.

    `canvasProps` is null whenever there is no source URL yet — which is the
    whole time the presigned URL is being minted, and forever if that request
    failed. Folding it in with the WebGPU check told a browser that HAS WebGPU
    that it does not, for a second on every card and permanently on a failure.
    The stage next door has always split these three; this shared component,
    which the chat cards use, contradicted it.
  */
  if (!viewport.webGpu) {
    return (
      <div className={cn('rounded-xl border border-dashed', className)}>
        <ViewerNotice
          icon={MonitorX}
          title={t('viewer.unsupported.title')}
          description={t('viewer.unsupported.description')}
        />
      </div>
    )
  }

  if (!viewport.canvasProps) {
    return (
      <div className={cn('rounded-xl border border-dashed', className)}>
        <ModelViewportProgress phase="downloading" percent={null} />
      </div>
    )
  }

  /**
   * The viewport started and then failed — and until this branch existed, that
   * left an empty grey box with one line of status text in the corner, which
   * reads as a broken feature rather than as a missing picture.
   *
   * It is not a rare path. `supportsWebGpu` can only ask whether the API is
   * PRESENT; whether an adapter can actually be acquired is a separate question
   * a browser only answers when asked. Headless Chromium, a blocked or
   * blocklisted driver, a remote desktop session and a VM all expose
   * `navigator.gpu` and then refuse the adapter — and an interrupted download of
   * a hundred-megabyte model lands here too.
   */
  if (viewport.status.phase === 'error') {
    return (
      <div className={cn('rounded-xl border border-dashed', className)}>
        <ViewerNotice
          icon={MonitorX}
          title={t('viewer.unavailable.title')}
          description={t('viewer.unavailable.description')}
          detail={
            viewport.status.message
              ? t('viewer.unavailable.reason', { message: viewport.status.message })
              : undefined
          }
        />
      </div>
    )
  }

  return (
    <div className={cn('bg-muted relative overflow-hidden rounded-xl border', className)}>
      <IfcViewerCanvasLazy {...viewport.canvasProps} className="size-full" />
      <ModelViewportProgress phase={viewport.status.phase} percent={viewport.status.percent} />
      <ViewerLegend
        className="absolute bottom-2 left-2"
        entries={viewport.highlights.map((highlight) => ({
          status: highlight.status,
          label: highlight.label,
          count: highlight.expressIds.length,
        }))}
      />
    </div>
  )
}

/**
 * The loading veil, shared by both surfaces.
 *
 * Two phases and two honest labels. A download knows how far it has got, so it
 * shows the number; parsing does not, so it does not pretend to. The old
 * version reported neither and instead published a mesh count, which is a
 * measure of the exporter's tessellation settings and tells an architect
 * nothing about how much longer they are waiting.
 */
export function ModelViewportProgress({
  phase,
  percent,
}: {
  phase: 'idle' | 'downloading' | 'parsing' | 'ready' | 'error'
  percent: number | null
}): JSX.Element | null {
  const t = useTranslations('bim')
  if (phase === 'ready' || phase === 'error') return null
  return (
    <ViewerProgress
      label={t(phase === 'parsing' ? 'stage.building' : 'stage.loading')}
      percent={phase === 'downloading' ? percent : null}
    />
  )
}
