/**
 * The follow-up chips make one promise the rest of the card set does not: a
 * click puts a question into the composer and does NOTHING else. So the tests
 * that matter are the negative ones — no fetch, no send — alongside the proof
 * that the exact question text reaches the same prefill pipe the welcome chips
 * use, and that each chip is a real, keyboard-operable button.
 */
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FollowUpsCard } from './FollowUpsCard'

const setComposerPrefill = vi.fn()
const chatSendFn = vi.fn()

const mockStoreState = () => ({ setComposerPrefill, chatSendFn })

vi.mock('@/features/chat/store', () => {
  const useChatStore = (selector: (s: ReturnType<typeof mockStoreState>) => unknown) => selector(mockStoreState())
  useChatStore.getState = () => mockStoreState()
  return { useChatStore }
})

const items = [
  { question: 'Wie wird das Fluchtniveau genau gemessen?', hint: 'Messpunkt und Bezugsebene' },
  { question: 'Was wäre bei Gebäudeklasse 5 anders?' },
]

describe('FollowUpsCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: async () => ({}) })))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders every question as its own button', () => {
    render(<FollowUpsCard title="Weiterführende Fragen" items={items} />)

    expect(screen.getByText('Weiterführende Fragen')).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(2)
    for (const item of items) {
      expect(screen.getByRole('button', { name: item.question })).toBeInTheDocument()
    }
  })

  it('prefills the composer with the question exactly as written', async () => {
    const user = userEvent.setup()
    render(<FollowUpsCard title={null} items={items} />)

    await user.click(screen.getByRole('button', { name: /Fluchtniveau/ }))

    // Verbatim: the string in the card is the string the user is about to send,
    // so anything appended or trimmed here would be words they never wrote.
    expect(setComposerPrefill).toHaveBeenCalledWith('Wie wird das Fluchtniveau genau gemessen?')
  })

  it('sends nothing and calls nothing on click', async () => {
    const user = userEvent.setup()
    render(<FollowUpsCard title={null} items={items} />)

    await user.click(screen.getByRole('button', { name: /Gebäudeklasse 5/ }))

    // „nicht zurück zum LLM" — the chip queues a draft and stops there. A turn
    // fired from a click would spend the user's tokens on a question they had
    // not decided to ask.
    expect(chatSendFn).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('is operable from the keyboard alone', async () => {
    const user = userEvent.setup()
    render(<FollowUpsCard title={null} items={items} />)

    await user.tab()
    expect(screen.getByRole('button', { name: /Fluchtniveau/ })).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(setComposerPrefill).toHaveBeenCalledWith('Wie wird das Fluchtniveau genau gemessen?')
  })

  it('has no frame around it — the chips sit straight on the answer surface', () => {
    // The flat register (grid-card-charter.md §A1/§B1). This card closes every
    // subject-matter answer, so its box was the most-seen box in the product,
    // and it is also the one card that is not evidence: nothing here belongs in
    // an Einreichung, and being the only unframed trailing block says so.
    const { container } = render(<FollowUpsCard title={null} items={items} />)

    expect(
      container.querySelector('[data-slot="card"]'),
      'follow_ups is the flat register — a `Card` here puts a border back at the bottom of every answer',
    ).toBeNull()

    // The chips keep their OWN chrome, which is why the frame could go.
    expect(screen.getByRole('button', { name: /Fluchtniveau/ })).toHaveClass('border', 'shadow-xs')
  })

  it('renders nothing at all when the offer is empty', () => {
    // Not an eyebrow over a blank row: with no frame there is not even a box
    // left to explain the gap.
    const { container } = render(<FollowUpsCard title="Weiterführende Fragen" items={[]} />)

    expect(container).toBeEmptyDOMElement()
  })

  it('carries the whole question in the tooltip, with the hint after it', () => {
    render(<FollowUpsCard title={null} items={items} />)

    // The chip truncates to one line, so the title is where the full question
    // survives — and the hint rides along instead of replacing it.
    expect(screen.getByRole('button', { name: /Fluchtniveau/ })).toHaveAttribute(
      'title',
      'Wie wird das Fluchtniveau genau gemessen? — Messpunkt und Bezugsebene',
    )
    expect(screen.getByRole('button', { name: /Gebäudeklasse 5/ })).toHaveAttribute(
      'title',
      'Was wäre bei Gebäudeklasse 5 anders?',
    )
  })
})
