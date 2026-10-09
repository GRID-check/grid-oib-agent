'use client'

/**
 * One card slot, drawn through A2UI (ADR-0065).
 *
 * A slot is a lone card or a composed `surface`; either becomes an A2UI
 * surface (`cardToSurfaceMessages`) on a processor of its own, and
 * `A2uiSurface` draws it with the Piloti catalog, whose card components call
 * back into `render`. It is drawn once, by A2UI:
 *
 *  - **Until A2UI has drawn.** `A2uiSurface` has no server snapshot (it
 *    throws under SSR) and resolves its tree in a subscription, so its first
 *    frame is a grey "[Loading root...]". The surface is mounted hidden behind
 *    a `CardPlaceholder` and shown in the commit its first real component
 *    reports itself (`useReportDrawn`, a layout effect), before paint.
 *  - **On failure.** A message A2UI refuses, or a render that throws inside
 *    it, falls back to the direct card: a card is never lost to the library.
 *    A surface falls back to its cards stacked in order.
 *
 * Either way, whatever holds the card's place (a `DrawnProvider` above it) is
 * told once the card is on screen.
 */

import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ErrorInfo,
  type ReactNode,
} from 'react'
import { MessageProcessor } from '@a2ui/web_core/v0_9'
import { A2uiSurface, type ReactComponentImplementation } from '@a2ui/react/v0_9'

import type { GridCard } from '@/shared/cards/schemas'
import { CardPlaceholder } from '@/features/grid-cards/components/CardPlaceholder'
import {
  CardRendererProvider,
  DrawnProvider,
  pilotiCatalog,
  preflight,
  TextBlock,
  useDrawnReporter,
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

type FallbackProps = { fallback: ReactNode; onFail: (() => void) | null; children: ReactNode }

class Fallback extends Component<FallbackProps, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('[A2UI] surface render failed; drawing the card directly', error, info.componentStack)
    this.props.onFail?.()
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

const noSubscription = () => () => {}
/** False on the server and while hydrating; true on every other render, a later mount's first included. */
const useHydrated = () => useSyncExternalStore(noSubscription, () => true, () => false)

export function A2uiCard({ card, surfaceKey, render }: A2uiCardProps) {
  const hydrated = useHydrated()
  // Keyed on the card's CONTENT, not its identity: a parent that re-parses
  // its cards on every render would otherwise rebuild the surface each time,
  // remounting every card in it and resetting the open tab.
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
  const refused = hydrated && surface === null
  const reportOnScreen = useDrawnReporter()
  // Whether the reader SAW the placeholder: a frame went by with the surface
  // still undrawn. A stored card draws in the layout pass before its first
  // paint, and must not fade in on every thread open; one that took a frame
  // or more to draw replaced a visible placeholder, and fades in over it.
  const drawnNow = useRef(drawn)
  useLayoutEffect(() => {
    drawnNow.current = drawn
  }, [drawn])
  const [placeholderSeen, setPlaceholderSeen] = useState(false)
  useEffect(() => {
    if (!surface || drawn || placeholderSeen) return
    const frame = requestAnimationFrame(() => {
      if (!drawnNow.current) setPlaceholderSeen(true)
    })
    return () => cancelAnimationFrame(frame)
  }, [surface, drawn, placeholderSeen])
  useLayoutEffect(() => {
    if (drawn || refused) reportOnScreen?.()
  }, [drawn, refused, reportOnScreen])

  const direct = <Direct card={card} render={render} />
  const body = (
    <div className="relative">
      {!surface && (refused ? direct : <CardPlaceholder />)}
      {surface && (
        <CardRendererProvider value={render}>
          <DrawnProvider value={reportDrawn}>
            {/* Keyed on the content: a surface that failed once is retried
                when it changes, rather than staying on the fallback for good. */}
            <Fallback key={`${surfaceKey}|${content}`} fallback={direct} onFail={reportOnScreen}>
              {!drawn && <CardPlaceholder />}
              <div
                data-a2ui-surface={surfaceKey}
                data-a2ui-root={card.type}
                aria-hidden={drawn ? undefined : true}
                // Drawn after a placeholder, the surface fades in over where the
                // placeholder stood instead of replacing it in one frame. Not
                // when a `CardSlot` is taking the report (`reportOnScreen`): it
                // cross-fades the whole card itself, and two fades of one card
                // play the entrance twice.
                className={
                  drawn
                    ? reportOnScreen || !placeholderSeen
                      ? undefined
                      : 'animate-in fade-in-0 duration-base ease-entrance motion-reduce:animate-none'
                    : 'pointer-events-none invisible absolute inset-x-0 top-0'
                }
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
