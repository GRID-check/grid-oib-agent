'use client'

/**
 * One card slot, drawn through A2UI (ADR-0065).
 *
 * A slot is a lone card or a composed `surface`; either becomes an A2UI
 * surface (`cardToSurfaceMessages`) on a processor of its own, and
 * `A2uiSurface` draws it with the Piloti catalog, whose card components call
 * back into `render`.
 *
 * Two fallbacks, both to the same component A2UI would have drawn:
 *
 *  - **Until A2UI has drawn.** `A2uiSurface` has no server snapshot (it
 *    throws under SSR), and its first frame after mount is a grey
 *    "[Loading root...]" placeholder, because it resolves the tree in its
 *    subscription. So the card is drawn directly on the server and on screen
 *    until A2UI's copy, mounted invisibly behind it, draws a real component,
 *    which reports itself in a layout effect (`useReportDrawn`); the swap
 *    happens in that commit, before paint. The reader sees one card
 *    throughout, and never the placeholder.
 *  - **On failure.** A message A2UI refuses, or a render that throws inside
 *    it, falls back to the direct card: a card is never lost to the library.
 *    A surface falls back to its cards stacked in order.
 */

import { Component, useCallback, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from 'react'
import { MessageProcessor } from '@a2ui/web_core/v0_9'
import { A2uiSurface, type ReactComponentImplementation } from '@a2ui/react/v0_9'

import type { GridCard } from '@/shared/cards/schemas'
import {
  CardRendererProvider,
  DrawnProvider,
  pilotiCatalog,
  preflight,
  TextBlock,
  type CardRenderer,
} from './catalog'
import { cardToSurfaceMessages, surfaceComponents, surfaceLeaves } from './surface-messages'

interface A2uiCardProps {
  card: GridCard
  /** Unique within the page; the surface id. */
  surfaceKey: string
  render: CardRenderer
}

/** The direct drawing: the card itself, or a surface's leaves stacked in order. */
function Direct({ card, render }: Pick<A2uiCardProps, 'card' | 'render'>) {
  if (card.type !== 'surface') return <>{render(card, 'root')}</>
  return (
    <div className="flex flex-col gap-3">
      {surfaceLeaves(card).map(({ id, leaf }) => (
        <div key={id}>{'text' in leaf ? <TextBlock text={leaf.text} /> : render(leaf, id)}</div>
      ))}
    </div>
  )
}

class Fallback extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('[A2UI] surface render failed; drawing the card directly', error, info.componentStack)
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

function useMounted(): boolean {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  return mounted
}

export function A2uiCard({ card, surfaceKey, render }: A2uiCardProps) {
  const mounted = useMounted()
  // Keyed on the card's CONTENT, not its identity: a parent that re-parses
  // its cards on every render would otherwise rebuild the surface each time,
  // remounting every card in it and resetting the open tab.
  const content = useMemo(() => JSON.stringify(card), [card])
  const surface = useMemo(() => {
    if (!mounted) return null
    const refusal = preflight(surfaceComponents(card), { surface: card.type === 'surface' })
    if (refusal) {
      console.warn('[A2UI] surface refused; drawing the card directly', card.type, refusal)
      return null
    }
    const processor = new MessageProcessor<ReactComponentImplementation>([pilotiCatalog()])
    try {
      processor.processMessages(cardToSurfaceMessages(card, surfaceKey))
    } catch (error) {
      console.warn('[A2UI] surface refused; drawing the card directly', card.type, error)
      return null
    }
    return processor.model.getSurface(surfaceKey) ?? null
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `content` stands for `card`
  }, [mounted, content, surfaceKey])

  // Reset per surface; set by the first component A2UI draws (`useReportDrawn`).
  const [drawnSurface, setDrawnSurface] = useState<object | null>(null)
  const drawn = surface !== null && drawnSurface === surface
  const reportDrawn = useCallback(() => setDrawnSurface(surface), [surface])

  // `direct` sits at the same place in the tree whether A2UI is drawing or
  // not, so the mount that turns the surface on does not remount it (the
  // wrapper used to appear only then, and every card mounted three times).
  const direct = <Direct card={card} render={render} />
  const body = (
    <div className="relative">
      {!drawn && direct}
      {surface && (
        <CardRendererProvider value={render}>
          <DrawnProvider value={reportDrawn}>
            {/* Keyed on the content: a surface that failed once is retried
                when it changes, rather than staying on the fallback for good. */}
            <Fallback key={`${surfaceKey}|${content}`} fallback={drawn ? direct : null}>
              <div
                data-a2ui-surface={surfaceKey}
                data-a2ui-root={card.type}
                aria-hidden={drawn ? undefined : true}
                className={drawn ? undefined : 'pointer-events-none invisible absolute inset-x-0 top-0'}
              >
                <A2uiSurface surface={surface} />
              </div>
            </Fallback>
          </DrawnProvider>
        </CardRendererProvider>
      )}
    </div>
  )
  const title = card.type === 'surface' ? card.title?.trim() : undefined
  if (!title) return body
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <p className="card-title text-foreground">{title}</p>
      {body}
    </section>
  )
}
