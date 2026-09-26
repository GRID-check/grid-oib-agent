/**
 * A card's place in a streamed answer (ADR-0066), through the REAL markdown
 * renderer: the place is a slot the card-marker plugin leaves in the parsed
 * document, so a stubbed renderer would only test the stub.
 */
import { render, screen } from '@/test-utils'
import { vi, describe, test, expect } from 'vitest'
import { AgentResponse } from './AgentResponse'
import { CardArrival, PENDING_CARD_HEIGHT } from './CardSlotArrival'
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

  test('a final answer with no card behind the marker holds nothing', () => {
    render(<AgentResponse content={PROSE} />)

    expect(screen.queryByTestId('pending-card-slot')).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain('[[card:')
  })
})

describe('CardArrival', () => {
  test('a card that arrives live grows from the placeholder, clipped only while it grows', () => {
    const { container } = render(
      <CardArrival live>
        <div>Karte</div>
      </CardArrival>
    )
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.style.height).toBe(`${PENDING_CARD_HEIGHT}px`)
    expect(wrapper.style.overflow).toBe('hidden')
  })

  test('a card that was already there is drawn at once', () => {
    const { container } = render(
      <CardArrival live={false}>
        <div>Karte</div>
      </CardArrival>
    )
    const wrapper = container.firstElementChild as HTMLElement
    expect(wrapper.style.height).not.toBe(`${PENDING_CARD_HEIGHT}px`)
    expect(wrapper.style.overflow).toBe('')
    expect(screen.getByText('Karte')).toBeInTheDocument()
  })
})
