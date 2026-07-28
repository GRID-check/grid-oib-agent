/**
 * The wiring guard for interactive cards.
 *
 * `CARD_INTERACTIVITY` (card-decision.ts) is exhaustive over `GridCard['type']`,
 * so a newly generated card type fails `tsc` until someone classifies it. This
 * spec closes the other half: once a type is classified `'interactive'`, it
 * must ALSO be wired through `GridCards` with a `cardKey` and record its
 * outcome via `setCardDecision` — otherwise the decision dies on reload and the
 * card re-offers a write that already happened.
 *
 * Adding an interactive card type without teaching this spec how to settle it
 * fails the first test below. That is the intended failure: write the case,
 * and you will discover whether the wiring exists.
 */
import { render, screen, waitFor } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GridCard } from '@/shared/cards/schemas'
import { INTERACTIVE_CARD_TYPES } from './card-decision'
import { GridCards } from './components/GridCards'

const setCardDecision = vi.fn()

const mockStoreState = () => ({
  projectId: 'proj-1',
  currentConversation: { id: 'conv-1', messages: [{ id: 'msg-1', cardInteractions: undefined }] },
  conversations: [],
  setCardDecision,
})

vi.mock('@/features/chat/store', () => {
  const useChatStore = (selector: (s: unknown) => unknown) => selector(mockStoreState())
  // `useCardDecision` re-reads the store imperatively after writing, to detect a
  // write that could not land.
  useChatStore.getState = () => mockStoreState()
  return { useChatStore }
})

/**
 * One fixture per interactive card type: a renderable card plus the label of an
 * action that settles it. Keyed by card type so a missing entry is an explicit,
 * readable failure rather than silent under-coverage.
 */
const SETTLE_CASES: Partial<Record<GridCard['type'], { card: GridCard; action: string }>> = {
  project_profile_patch: {
    card: {
      type: 'project_profile_patch',
      title: 'Update brief',
      rationale: 'Learned the class.',
      patch: [{ op: 'add', path: '/facts/gebaeudeklasse', value: 'GK4' }],
    } as GridCard,
    // Reject settles without a network round trip — this spec is about wiring,
    // not about each card's own API contract (that lives in its own spec).
    action: 'Reject',
  },
  memory_proposal: {
    card: {
      type: 'memory_proposal',
      title: 'Save this finding?',
      content: 'The firm always uses REI 90 for GK4.',
      kind: 'preference',
      confidence: 'high',
    } as GridCard,
    action: 'No',
  },
}

describe('interactive card wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('has a settle case for every card classified as interactive', () => {
    const uncovered = INTERACTIVE_CARD_TYPES.filter((type) => !SETTLE_CASES[type])
    expect(
      uncovered,
      `Card type(s) ${uncovered.join(', ')} are classified 'interactive' in CARD_INTERACTIVITY but ` +
        'have no settle case here. Add one — and make sure the card takes messageId + cardKey and ' +
        'uses useCardDecision, or its answer will not survive a reload.',
    ).toEqual([])
  })

  for (const [type, testCase] of Object.entries(SETTLE_CASES)) {
    it(`records the decision on the owning message for ${type}`, async () => {
      const user = userEvent.setup()
      render(<GridCards cards={[testCase.card]} projectId="proj-1" messageId="msg-1" />)

      await user.click(screen.getByRole('button', { name: testCase.action }))

      await waitFor(() => expect(setCardDecision).toHaveBeenCalled())
      const [messageId, cardKey] = setCardDecision.mock.calls[0]
      expect(messageId).toBe('msg-1')
      // The key GridCards hands down must be the positional card identity, so a
      // decision and the card it belongs to cannot drift apart.
      expect(cardKey).toBe(`${type}-0`)
    })
  }
})
