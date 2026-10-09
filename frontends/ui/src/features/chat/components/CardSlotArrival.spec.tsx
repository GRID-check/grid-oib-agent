/**
 * A card's place in a streamed answer (ADR-0066), through the REAL markdown
 * renderer: the place is a slot the card-marker plugin leaves in the parsed
 * document, so a stubbed renderer would only test the stub.
 */
import { render, screen, waitFor } from '@/test-utils'
import { useLayoutEffect, useState, type ReactNode } from 'react'
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'
import { AgentResponse } from './AgentResponse'
import { CardSlot, CardSlotLiveProvider, forgetArrivals, resetArrivalsForTests } from './CardSlotArrival'
import { useDrawnReporter } from '@/features/a2ui/catalog'
import { asStoreState, type DeepPartial, type StoreSelector } from '@/test-utils/store-fixtures'
import type { ChatStoreWithHydration } from '../store'
import type { GridCard } from '@/shared/cards/schemas'
import { CARD_PREVIEW_FIXTURES } from '@/features/grid-cards/preview-fixtures'

vi.mock('../store', () => ({
  useChatStore: vi.fn((selector?: StoreSelector<ChatStoreWithHydration>) => {
    const state: DeepPartial<ChatStoreWithHydration> = {
      currentConversation: null,
      patchConversationMessage: vi.fn(),
    }
    return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
  }),
}))

let reducedMotion = false
vi.mock('motion/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('motion/react')>()),
  useReducedMotion: () => reducedMotion,
}))

vi.mock('@/adapters/api', () => ({
  cancelJob: vi.fn(),
}))

vi.mock('@/adapters/auth', () => ({
  useAuth: () => ({
    accessToken: null,
  }),
}))

const PROSE = 'Die Antwort.\n\n[[card:1]]\n\nDanach.'

describe('a placed card while the answer streams', () => {
  test('its marker holds the place, between the paragraphs it was written between', () => {
    render(<AgentResponse content={PROSE} isStreaming />)

    const slot = screen.getByTestId('pending-card-slot')
    const before = screen.getByText('Die Antwort.')
    const after = screen.getByText('Danach.')
    expect(before.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(slot.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Never the marker as text.
    expect(document.body.textContent).not.toContain('[[card:')
  })

  test('once its card is written, it fills the place and is not drawn again below the prose', () => {
    const cards = [
      { ...CARD_PREVIEW_FIXTURES.calculation!, title: 'Platzierte Karte' } as GridCard,
    ]
    render(<AgentResponse content={PROSE} cards={cards} isStreaming />)

    expect(screen.queryByTestId('pending-card-slot')).not.toBeInTheDocument()
    expect(screen.getAllByText('Platzierte Karte')).toHaveLength(1)
    const card = screen.getByText('Platzierte Karte')
    const after = screen.getByText('Danach.')
    expect(card.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('a final answer with no card behind the marker holds nothing', () => {
    render(<AgentResponse content={PROSE} />)

    expect(screen.queryByTestId('pending-card-slot')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('[[card:')
  })
})

describe('CardSlot', () => {
  let key = 0
  // Every test is a card of its own: an arrival plays once per key and page.
  const nextKey = () => `m1:${(key += 1)}`
  beforeEach(() => {
    reducedMotion = false
  })
  afterEach(() => resetArrivalsForTests())

  const live = (node: ReactNode) => <CardSlotLiveProvider value>{node}</CardSlotLiveProvider>
  const placeholder = () => document.querySelector('[data-slot="card-placeholder"]')
  /** The card is on screen: mounted, and not faded out behind the placeholder. */
  const cardShown = () => screen.getByText('Karte').parentElement?.style.opacity !== '0'

  /** A card that reports itself drawn when `drawn` says so, as `A2uiCard` does. */
  function Card({ drawn = true }: { drawn?: boolean }) {
    const report = useDrawnReporter()
    useLayoutEffect(() => {
      if (drawn) report?.()
    }, [drawn, report])
    return <div>Karte</div>
  }

  test('holds the place with a card-shaped placeholder while the card is pending', () => {
    const { container } = render(live(<CardSlot arrivalKey={nextKey()} />))
    expect(screen.getByTestId('pending-card-slot')).toBe(container.firstElementChild)
    expect(screen.getByTestId('pending-card-slot')).toHaveAttribute('aria-busy', 'true')
    expect(placeholder()).not.toBeNull()
  })

  test('the card arrives into the same frame, behind the placeholder until it has drawn', () => {
    const arrivalKey = nextKey()
    const { container, rerender } = render(live(<CardSlot arrivalKey={arrivalKey} />))
    const frame = container.firstElementChild
    rerender(
      live(
        <CardSlot arrivalKey={arrivalKey}>
          <Card drawn={false} />
        </CardSlot>
      )
    )
    // One element from marker to card: nothing is swapped for anything else.
    expect(container.firstElementChild).toBe(frame)
    expect(placeholder()).not.toBeNull()
    expect(cardShown()).toBe(false)
  })

  test('once drawn, the card fades in over the placeholder, which then goes', async () => {
    const arrivalKey = nextKey()
    function Arriving() {
      const [drawn, setDrawn] = useState(false)
      return (
        <>
          <button onClick={() => setDrawn(true)}>draw</button>
          <CardSlot arrivalKey={arrivalKey}>
            <Card drawn={drawn} />
          </CardSlot>
        </>
      )
    }
    render(live(<Arriving />))
    expect(cardShown()).toBe(false)
    screen.getByText('draw').click()
    await waitFor(() => expect(placeholder()).toBeNull())
    expect(cardShown()).toBe(true)
    expect(screen.getByText('Karte').closest('[aria-busy]')).toBeNull()
  })

  test('a card that has already arrived does not arrive again when its slot remounts', async () => {
    const arrivalKey = nextKey()
    const slot = live(
      <CardSlot arrivalKey={arrivalKey}>
        <Card />
      </CardSlot>
    )
    const first = render(slot)
    await waitFor(() => expect(placeholder()).toBeNull())
    first.unmount()

    render(slot)
    expect(placeholder()).toBeNull()
    expect(cardShown()).toBe(true)
  })

  // A retraction withdraws a round, and the next one writes its cards at the
  // same indices: remembered as arrived, they appeared without an entrance.
  test('after its answer is retracted, the next card at the same place arrives again', async () => {
    const slot = live(
      <CardSlot arrivalKey="m-retracted:0">
        <Card drawn={false} />
      </CardSlot>
    )
    const first = render(
      live(
        <CardSlot arrivalKey="m-retracted:0">
          <Card />
        </CardSlot>
      )
    )
    await waitFor(() => expect(placeholder()).toBeNull())
    first.unmount()

    forgetArrivals('m-retracted')
    render(slot)
    expect(placeholder()).not.toBeNull()
    expect(cardShown()).toBe(false)
  })

  test('forgets only the retracted answer’s arrivals', async () => {
    const first = render(
      live(
        <CardSlot arrivalKey="m-kept:0">
          <Card />
        </CardSlot>
      )
    )
    await waitFor(() => expect(placeholder()).toBeNull())
    first.unmount()

    forgetArrivals('m-kept-not')
    render(
      live(
        <CardSlot arrivalKey="m-kept:0">
          <Card drawn={false} />
        </CardSlot>
      )
    )
    expect(placeholder()).toBeNull()
  })

  test('a card that was already there is shown at once', () => {
    render(
      <CardSlot arrivalKey={nextKey()}>
        <Card drawn={false} />
      </CardSlot>
    )
    expect(placeholder()).toBeNull()
    expect(cardShown()).toBe(true)
  })

  test('with reduced motion, a card that arrives live is shown at once', () => {
    reducedMotion = true
    render(
      live(
        <CardSlot arrivalKey={nextKey()}>
          <Card drawn={false} />
        </CardSlot>
      )
    )
    expect(placeholder()).toBeNull()
    expect(cardShown()).toBe(true)
  })

  test('a finished answer holds no place for a card that never came', () => {
    const { container } = render(<CardSlot arrivalKey={nextKey()} />)
    expect(container.firstElementChild).toBeNull()
  })

  test('a place held for a card that never came folds away at the settle, then is gone', async () => {
    const arrivalKey = nextKey()
    const { container, rerender } = render(live(<CardSlot arrivalKey={arrivalKey} />))
    const frame = container.firstElementChild
    expect(frame).not.toBeNull()
    rerender(
      <CardSlotLiveProvider value={false}>
        <CardSlot arrivalKey={arrivalKey} />
      </CardSlotLiveProvider>
    )
    // Not dropped in one frame: the same element folds first.
    expect(container.firstElementChild).toBe(frame)
    expect(frame).not.toHaveAttribute('aria-busy')
    await waitFor(() => expect(container.firstElementChild).toBeNull())
  })

  test('a card refused while the answer still arrives folds its place away too', async () => {
    const arrivalKey = nextKey()
    const { container, rerender } = render(live(<CardSlot arrivalKey={arrivalKey} />))
    rerender(live(<CardSlot arrivalKey={arrivalKey} refused />))
    expect(container.firstElementChild).not.toBeNull()
    await waitFor(() => expect(container.firstElementChild).toBeNull())
  })

  test('a refused card that never held a place renders nothing at all', () => {
    const { container } = render(live(<CardSlot arrivalKey={nextKey()} refused />))
    expect(container.firstElementChild).toBeNull()
  })

  test('an unplaced card the reader watches arrive comes in like a placed one', () => {
    // Mounted outside the live provider (the settle frame), told it arrives.
    render(
      <CardSlot arrivalKey={nextKey()} arriving>
        <Card drawn={false} />
      </CardSlot>
    )
    expect(placeholder()).not.toBeNull()
    expect(cardShown()).toBe(false)
  })
})
