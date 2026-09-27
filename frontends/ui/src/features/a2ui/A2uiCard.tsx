'use client'

/**
 * One card slot, drawn through A2UI (ADR-0065).
 *
 * A slot is a lone card or a composed `surface`; either becomes an A2UI
 * surface (`cardToSurfaceMessages`) on a processor of its own, and
 * `A2uiSurface` draws it with the Piloti catalog, whose card components call
 * back into `render`.
 *
 * Drawn ONCE: A2UI's surface is the card, and nothing else is mounted beside
 * it.
 *
 *  - **Until A2UI has drawn.** `A2uiSurface` resolves its tree in a
 *    subscription, so its first frame is a grey "[Loading root...]". The
 *    surface is mounted hidden behind a `CardPlaceholder` of the card's type
 *    and shown in the commit its first real component reports itself
 *    (`useReportDrawn`, a layout effect), before paint. It used to be mounted
 *    behind a second, direct drawing of the whole card that was swapped out at
 *    that moment: two copies of every card, three commits, and an arrival
 *    height measured off the copy that was then thrown away.
 *  - **On the server, and while hydrating.** `A2uiSurface` has no server
 *    snapshot (it throws under SSR), so there the placeholder stands alone and
 *    A2UI draws after hydration. There is no server drawing of the card: that
 *    was a second render path kept for pages that never server-render a card
 *    (the chat's messages come from the client store).
 *  - **On failure.** A message A2UI refuses, or a render that throws inside
 *    it, falls back to the direct card: a card is never lost to the library.
 *    A surface falls back to its cards stacked in order.
 *
 * Whatever holds the card's place in a streaming answer is told when the card
 * is on screen, either way (`useCardDrawnReporter`).
 */

import {
  Component,
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import { MessageProcessor } from '@a2ui/web_core/v0_9'
import { A2uiSurface, type ReactComponentImplementation } from '@a2ui/react/v0_9'

import type { GridCard } from '@/shared/cards/schemas'
import { CardPlaceholder } from '@/features/grid-cards/components/CardPlaceholder'
import { useCardDrawnReporter } from '@/features/grid-cards/card-drawn'
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

class Fallback extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('[A2UI] surface render failed; drawing the card directly', error, info.componentStack)
    this.props.onFail()
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

const noSubscription = () => () => {}

/**
 * False on the server and while hydrating, true for every other client
 * render, the FIRST render of a component mounted later included. The
 * `useEffect` flag this replaces was false on every mount's first render,
 * which is what drew every card directly before A2UI could.
 */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false
  )
}

export function A2uiCard({ card, surfaceKey, render }: A2uiCardProps) {
  const hydrated = useHydrated()
  // Keyed on the card's CONTENT, not its identity: a parent that re-parses
  // its cards on every render would otherwise rebuild the surface each time,
  // remounting every card in it and resetting the open tab. One processor per
  // content, however often the card object is rebuilt.
  const content = useMemo(() => JSON.stringify(card), [card])
  const surface = useMemo(() => {
    if (!hydrated) return null
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
  }, [hydrated, content, surfaceKey])

  // Reset per surface; set by the first component A2UI draws (`useReportDrawn`).
  const [drawnSurface, setDrawnSurface] = useState<object | null>(null)
  const drawn = surface !== null && drawnSurface === surface
  const reportDrawn = useCallback(() => setDrawnSurface(surface), [surface])
  // Per content: a surface that failed is retried when the card changes.
  const [failedContent, setFailedContent] = useState<string | null>(null)
  const failed = surface !== null && failedContent === content
  const onFail = useCallback(() => setFailedContent(content), [content])

  // A2UI refused the card or failed drawing it: the card is drawn directly.
  const refused = hydrated && (surface === null || failed)
  // The card is on screen, A2UI's drawing or the direct one.
  const onScreen = refused || drawn
  const reportOnScreen = useCardDrawnReporter()
  useLayoutEffect(() => {
    if (onScreen) reportOnScreen?.()
  }, [onScreen, reportOnScreen])

  // What stands in the card's place instead of A2UI's drawing.
  let stand: ReactNode = null
  if (refused) stand = <Direct card={card} render={render} />
  else if (!drawn) stand = <CardPlaceholder type={card.type} />

  const body = (
    <div className="relative">
      {stand}
      {surface && !failed && (
        <CardRendererProvider value={render}>
          <DrawnProvider value={reportDrawn}>
            {/* Keyed on the content: a surface that failed once is retried
                when it changes, rather than staying on the fallback for good. */}
            <Fallback key={`${surfaceKey}|${content}`} onFail={onFail}>
              {/* Hidden until drawn but laid out at the column's width, so a
                  card that measures itself as it mounts measures the column. */}
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
