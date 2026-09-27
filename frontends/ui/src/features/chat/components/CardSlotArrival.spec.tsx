/**
 * A card's place in a streamed answer (ADR-0066), through the REAL markdown
 * renderer: the place is a slot the card-marker plugin leaves in the parsed
 * document, so a stubbed renderer would only test the stub.
 */
import { act, render, screen } from '@/test-utils'
import { useLayoutEffect, type ReactNode } from 'react'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { AgentResponse } from './AgentResponse'
import {
  CardSlot,
  CardSlotLiveProvider,
  hasCardArrived,
  PENDING_CARD_HEIGHT,
  resetArrivedCards,
} from './CardSlotArrival'
import {
  CARD_PLACEHOLDER_HEIGHTS,
  CardPlaceholder,
  cardPlaceholderHeight,
} from '@/features/grid-cards/components/CardPlaceholder'
import { useCardDrawnReporter } from '@/features/grid-cards/card-drawn'
import { asStoreState, type DeepPartial, type StoreSelector } from '@/test-utils/store-fixtures'
import type { ChatStoreWithHydration } from '../store'

vi.mock('../store', () => ({
  useChatStore: vi.fn((selector?: StoreSelector<ChatStoreWithHydration>) => {
    const state: DeepPartial<ChatStoreWithHydration> = {
      currentConversation: null,
      patchConversationMessage: vi.fn(),
    }
    return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
  }),
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
    const cards = [{ type: 'summary' as const, title: 'Platzierte Karte', content: 'Inhalt', key_points: null }]
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
  beforeEach(() => resetArrivedCards())

  const live = (node: ReactNode) => <CardSlotLiveProvider value>{node}</CardSlotLiveProvider>
  const frameOf = (container: HTMLElement) => container.firstElementChild as HTMLElement

  test('a card that arrives live is held at the height a card of its type usually has', () => {
    const { container } = render(
      live(
        <CardSlot arrivalKey="m1:0" type="legal_basis">
          <div>Karte</div>
        </CardSlot>
      )
    )
    const frame = frameOf(container)
    const expected = CARD_PLACEHOLDER_HEIGHTS.legal_basis
    expect(expected).toBeDefined()
    expect(expected).not.toBe(PENDING_CARD_HEIGHT)
    expect(frame.style.height).toBe(`${expected}px`)
    expect(frame.style.overflow).toBe('hidden')
    // The placeholder stays up, in the card's own frame, until the card has drawn.
    expect(container.querySelector('[data-slot="card-placeholder"]')).not.toBeNull()
  })

  test('grows in the frame the pending placeholder already stood in', () => {
    const { container, rerender } = render(live(<CardSlot arrivalKey="m1:0" />))
    const pending = screen.getByTestId('pending-card-slot')
    expect(pending.style.height).toBe(`${PENDING_CARD_HEIGHT}px`)
    rerender(
      live(
        <CardSlot arrivalKey="m1:0" type="comparison_table">
          <div>Karte</div>
        </CardSlot>
      )
    )
    // The same element, so the height moves rather than one box replacing another.
    expect(frameOf(container)).toBe(pending)
    expect(pending.style.height).toBe(`${cardPlaceholderHeight('comparison_table')}px`)
    expect(screen.queryByTestId('pending-card-slot')).not.toBeInTheDocument()
  })

  test('reveals the card once it reports itself drawn, then stands at its own height', () => {
    vi.useFakeTimers()
    try {
      function Reporting() {
        const report = useCardDrawnReporter()
        useLayoutEffect(() => report?.(), [report])
        return <div>Karte</div>
      }
      const { container } = render(
        live(
          <CardSlot arrivalKey="m1:0" type="summary">
            <Reporting />
          </CardSlot>
        )
      )
      expect(frameOf(container)).toHaveAttribute('data-arrival', 'revealing')
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      const frame = frameOf(container)
      expect(frame.style.height).toBe('')
      expect(frame.style.overflow).toBe('')
      expect(container.querySelector('[data-slot="card-placeholder"]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a card that has already arrived does not arrive again when its slot remounts', () => {
    const card = (
      <CardSlot arrivalKey="m1:2" type="legal_basis">
        <div>Karte</div>
      </CardSlot>
    )
    const first = render(live(card))
    expect(frameOf(first.container).style.height).not.toBe('')
    first.unmount()

    expect(hasCardArrived('m1:2')).toBe(true)
    const { container } = render(live(card))
    const frame = frameOf(container)
    expect(frame.style.height).toBe('')
    expect(frame).not.toHaveAttribute('data-arrival')
    expect(container.querySelector('[data-slot="card-placeholder"]')).toBeNull()
    expect(screen.getByText('Karte')).toBeInTheDocument()
  })

  test('a card that was already there is drawn at once', () => {
    const { container } = render(
      <CardSlot arrivalKey="m1:0" type="legal_basis">
        <div>Karte</div>
      </CardSlot>
    )
    const frame = frameOf(container)
    expect(frame.style.height).toBe('')
    expect(frame.style.overflow).toBe('')
    expect(container.querySelector('[data-slot="card-placeholder"]')).toBeNull()
    expect(screen.getByText('Karte')).toBeInTheDocument()
  })

  test('a finished answer holds no place for a card that never came', () => {
    const { container } = render(<CardSlot arrivalKey="m1:0" />)
    expect(container.firstElementChild).toBeNull()
  })
})

describe('CardPlaceholder', () => {
  test('is sized by the card type, and by the default when the type is unknown', () => {
    const { container, rerender } = render(<CardPlaceholder type="verdict_header" />)
    const placeholder = () => container.querySelector('[data-slot="card-placeholder"]') as HTMLElement
    expect(placeholder().style.height).toBe(`${CARD_PLACEHOLDER_HEIGHTS.verdict_header}px`)
    rerender(<CardPlaceholder type="stair_diagram" />)
    expect(placeholder().style.height).toBe(`${CARD_PLACEHOLDER_HEIGHTS.stair_diagram}px`)
    rerender(<CardPlaceholder />)
    expect(placeholder().style.height).toBe(`${PENDING_CARD_HEIGHT}px`)
  })
})
