/**
 * The crossing between the answer and the card-marker plugin.
 *
 * `emit_card` hands the model a `[[card:N]]` marker, the answer writes it, and
 * `remarkCardMarkers` splices the card in at that point while
 * `unplacedCardIndices` sends the rest to the fallback block after the prose.
 * Two halves, and the wiring between them is one line of `AgentResponse` —
 * `[remarkCardMarkers, { count: cardCount }]` in `markerPlugins`.
 *
 * `card-markers.spec.tsx` tests the plugin, handing it to a renderer itself.
 * `AgentResponse.spec.tsx` tests the answer, with `MarkdownRenderer` stubbed to
 * a plain `<span>{content}</span>` — correct for what that file tests, and
 * precisely what steps over the crossing: with the stub in place, dropping the
 * plugin from `markerPlugins` leaves every one of its assertions green while a
 * placed card stops being drawn at all. `unplacedCardIndices` reads the raw
 * markdown rather than the parsed tree, so it still calls the card PLACED and
 * the fallback block still declines to draw it — the card does not fall back,
 * it disappears, and the marker surfaces as literal `[[card:1]]` text.
 *
 * So this file mounts the REAL `AgentResponse` over the REAL
 * `MarkdownRenderer`. Everything else it needs is stubbed exactly as
 * `AgentResponse.spec.tsx` stubs it; the renderer is the one thing that must be
 * real, because it is the thing under test.
 *
 * The bodies here carry no `[N]` citation markers, so nothing in the citation
 * plugin's path is exercised: this is a test about cards.
 */

import { render, screen } from '@/test-utils'
import { vi, describe, test, expect } from 'vitest'
import { AgentResponse } from './AgentResponse'
import { asStoreState, type DeepPartial, type StoreSelector } from '@/test-utils/store-fixtures'
import type { LayoutStore } from '@/features/layout/types'
import type { ChatStoreWithHydration } from '../store'

vi.mock('../hooks/use-conversation-memory', () => ({
  useConversationMemory: () => ({ items: [], loading: false }),
}))

vi.mock('@/features/layout/store', () => ({
  useLayoutStore: vi.fn((selector?: StoreSelector<LayoutStore>) => {
    const state: DeepPartial<LayoutStore> = {
      openRightPanel: vi.fn(),
      setResearchPanelTab: vi.fn(),
    }
    return selector ? selector(asStoreState<LayoutStore>(state)) : state
  }),
}))

vi.mock('../store', () => ({
  useChatStore: vi.fn((selector?: StoreSelector<ChatStoreWithHydration>) => {
    const state: DeepPartial<ChatStoreWithHydration> = {
      reportContent: '',
      deepResearchJobId: null,
      isDeepResearchStreaming: false,
      deepResearchStreamLoaded: false,
      currentConversation: null,
      patchConversationMessage: vi.fn(),
      reconnectToActiveJob: vi.fn(),
    }
    return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
  }),
}))

vi.mock('@/adapters/api', () => ({ cancelJob: vi.fn() }))
vi.mock('@/adapters/auth', () => ({ useAuth: () => ({ accessToken: null }) }))
vi.mock('../hooks', () => ({
  useLoadJobData: () => ({
    loadReport: vi.fn(),
    importJobStream: vi.fn(),
    loadResearchPanelTab: vi.fn(),
    isLoading: false,
    error: null,
    clearError: vi.fn(),
  }),
}))

/** Two cards, told apart by their titles rather than by their order. */
const PLACED = {
  type: 'summary' as const,
  title: 'Platzierte Karte',
  content: 'Zusammenfassung.',
  key_points: null,
}
const UNPLACED = {
  type: 'summary' as const,
  title: 'Nachgestellte Karte',
  content: 'Zweite Zusammenfassung.',
  key_points: null,
}

/** The answer as the reader reads it, whitespace collapsed. */
const readable = (container: HTMLElement): string =>
  (container.textContent ?? '').replace(/\s+/g, ' ').trim()

describe('a card the answer placed itself', () => {
  test('is drawn where the marker sits, between the two paragraphs', () => {
    const { container } = render(
      <AgentResponse
        content={'Die Steigung ist zu hoch.\n\n[[card:1]]\n\nDer Auftritt bleibt zulässig.'}
        cards={[PLACED]}
      />
    )

    // Order is the whole point: a card the answer placed mid-prose must be
    // BETWEEN its paragraphs, not stacked after them like an unplaced one.
    const answer = readable(container)
    expect(answer.indexOf('Die Steigung ist zu hoch.')).toBeLessThan(
      answer.indexOf('Platzierte Karte')
    )
    expect(answer.indexOf('Platzierte Karte')).toBeLessThan(
      answer.indexOf('Der Auftritt bleibt zulässig.')
    )
  })

  test('never leaves its marker on screen as literal text', () => {
    // The reader-visible symptom of an unwired plugin: the marker the model
    // wrote arrives as prose.
    const { container } = render(
      <AgentResponse content={'Die Steigung.\n\n[[card:1]]'} cards={[PLACED]} />
    )

    expect(readable(container)).not.toContain('[[card')
    expect(screen.getByText('Platzierte Karte')).toBeInTheDocument()
  })

  test('is drawn exactly once — the fallback block must not repeat it', () => {
    render(<AgentResponse content={'Die Steigung.\n\n[[card:1]]'} cards={[PLACED]} />)

    expect(screen.getAllByText('Platzierte Karte')).toHaveLength(1)
  })
})

describe('a card the answer did not place', () => {
  test('lands in the fallback block after the prose', () => {
    const { container } = render(
      <AgentResponse content={'Die Steigung ist zu hoch.'} cards={[UNPLACED]} />
    )

    const answer = readable(container)
    expect(answer.indexOf('Nachgestellte Karte')).toBeGreaterThan(
      answer.indexOf('Die Steigung ist zu hoch.')
    )
  })

  test('shares an answer with a placed one without either being lost or doubled', () => {
    // The case the two halves must agree on: `remarkCardMarkers` draws index 0
    // inline and `unplacedCardIndices` must hand only index 1 to the block. A
    // disagreement here shows up as a missing card or as one drawn twice.
    const { container } = render(
      <AgentResponse
        content={'Die Steigung ist zu hoch.\n\n[[card:1]]\n\nDer Auftritt bleibt zulässig.'}
        cards={[PLACED, UNPLACED]}
      />
    )

    expect(screen.getAllByText('Platzierte Karte')).toHaveLength(1)
    expect(screen.getAllByText('Nachgestellte Karte')).toHaveLength(1)
    const answer = readable(container)
    expect(answer.indexOf('Platzierte Karte')).toBeLessThan(
      answer.indexOf('Der Auftritt bleibt zulässig.')
    )
    expect(answer.indexOf('Nachgestellte Karte')).toBeGreaterThan(
      answer.indexOf('Der Auftritt bleibt zulässig.')
    )
  })
})
