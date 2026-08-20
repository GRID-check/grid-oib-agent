/**
 * The rail is the SAME offer as the card, in a different place
 * (`docs/architecture/post-answer-stages.md` §6).
 *
 * So the tests are about the difference and about the sameness, and nothing
 * else: the rail carries no `mt-5` of its own (the message column's `gap-4` is
 * the air), and it still makes the one promise the chips have always made —
 * a click fills the composer and does nothing else.
 */
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FollowUpsRail } from './FollowUpsRail'
import { FollowUpsCard } from '@/features/grid-cards/components/FollowUpsCard'

const setComposerPrefill = vi.fn()
const mockStoreState = () => ({ setComposerPrefill })

vi.mock('@/features/chat/store', () => {
  const useChatStore = (selector: (s: ReturnType<typeof mockStoreState>) => unknown) =>
    selector(mockStoreState())
  useChatStore.getState = () => mockStoreState()
  return { useChatStore }
})

const items = [
  { question: 'Wie wird das Fluchtniveau genau gemessen?', hint: 'Messpunkt und Bezugsebene' },
  { question: 'Was wäre bei Gebäudeklasse 5 anders?' },
]

describe('FollowUpsRail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders every question as its own button', () => {
    render(<FollowUpsRail items={items} />)

    expect(screen.getAllByRole('button')).toHaveLength(2)
    for (const item of items) {
      expect(screen.getByRole('button', { name: item.question })).toBeInTheDocument()
    }
  })

  it('fills the composer and does nothing else', () => {
    render(<FollowUpsRail items={items} />)

    return userEvent.click(screen.getByRole('button', { name: items[0].question })).then(() => {
      expect(setComposerPrefill).toHaveBeenCalledWith(items[0].question)
      expect(fetch).not.toHaveBeenCalled()
    })
  })

  it('renders nothing at all for an empty set', () => {
    // An eyebrow over an empty row is an unkept promise, and with no frame there
    // is not even a box left to explain the gap.
    const { container } = render(<FollowUpsRail items={[]} />)
    expect(container.querySelector('[data-testid="follow-ups-rail"]')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('owns no top margin — the message column’s gap is the air', () => {
    // The one difference from the card, which owns its own 20px because it is a
    // trailing block INSIDE the answer surface. A second margin here would put
    // the rail further from its answer than the answer is from the question.
    const { container } = render(<FollowUpsRail items={items} />)
    expect(container.querySelector('.mt-5')).toBeNull()

    const card = render(<FollowUpsCard items={items} />)
    expect(card.container.querySelector('.mt-5')).not.toBeNull()
  })

  it('offers the same chips as the stored card, question for question', () => {
    // Old threads keep the card form forever (§7.10). A reader scrolling across
    // the migration must see one affordance in two places, not two affordances.
    const rail = render(<FollowUpsRail items={items} />)
    const railLabels = Array.from(rail.container.querySelectorAll('button')).map((b) => b.textContent)
    rail.unmount()

    const card = render(<FollowUpsCard items={items} />)
    const cardLabels = Array.from(card.container.querySelectorAll('button')).map((b) => b.textContent)

    expect(railLabels).toEqual(cardLabels)
  })
})
