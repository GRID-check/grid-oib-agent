import { afterEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor, within } from '@/test-utils'

import { AnswerFeedbackHealth } from './answer-feedback-health'

const health = (overrides: Record<string, unknown> = {}) => ({
  windowDays: 30,
  answers: 100,
  totals: { up: 8, down: 2, voters: 5, downVoters: 2 },
  reasons: [{ reason: 'inaccurate', count: 2 }],
  daily: [],
  organizations: [],
  defects: [],
  ...overrides,
})

const stubFetch = (body: unknown, ok = true): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 403 })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AnswerFeedbackHealth', () => {
  it('leads with the negative rate, because that is the number being judged', async () => {
    stubFetch(health())
    render(<AnswerFeedbackHealth />)

    // 2 of 10 votes.
    await waitFor(() => expect(screen.getByText('20.0%')).toBeInTheDocument())
  })

  it('keeps every reason on screen, including the ones nobody picked', async () => {
    stubFetch(health())
    render(<AnswerFeedbackHealth />)

    // A reason at zero is information — "nobody says it is slow" — and dropping
    // it would also let the surviving bars change colour between loads.
    const bars = await screen.findByTestId('feedback-reason-bars')
    for (const label of ['Inaccurate', 'Wrong source', 'Too slow', 'Other']) {
      expect(within(bars).getByText(label)).toBeInTheDocument()
    }
  })

  /**
   * The case the whole drill-in turns on. `answer_feedback.message_id` is the
   * chat-store id with no FK to `messages`, so a turn that was never persisted
   * cannot be joined. Such a row must still be listed and must say why it is
   * bare — dropping it would hide exactly the feedback nobody has looked at.
   */
  it('lists a defect whose turn was never stored, and says so', async () => {
    stubFetch(
      health({
        defects: [
          {
            id: 'f1',
            organizationId: 'org_1',
            projectId: null,
            conversationId: null,
            messageId: 'm-unpersisted',
            reason: 'inaccurate',
            createdAt: new Date().toISOString(),
            answer: null,
            question: null,
            conversationTitle: null,
          },
        ],
      }),
    )
    render(<AnswerFeedbackHealth />)

    const row = await screen.findByTestId('feedback-defect')
    expect(within(row).getByText(/was not stored/i)).toBeInTheDocument()
    // …and it is still identifiable as a real defect, not a broken row.
    expect(within(row).getByText('Inaccurate')).toBeInTheDocument()
    expect(within(row).getByText('org_1')).toBeInTheDocument()
  })

  it('shows the question when the turn WAS stored — the point of the surface', async () => {
    stubFetch(
      health({
        defects: [
          {
            id: 'f2',
            organizationId: 'org_1',
            projectId: null,
            conversationId: 'c-1',
            messageId: 'm-1',
            reason: 'wrong_source',
            createdAt: new Date().toISOString(),
            answer: 'Die Fluchtweglänge beträgt 40 m.',
            question: 'Gilt die 40-m-Grenze auch für das nördliche Treppenhaus?',
            conversationTitle: 'Atrium',
          },
        ],
      }),
    )
    render(<AnswerFeedbackHealth />)

    const row = await screen.findByTestId('feedback-defect')
    expect(
      within(row).getByText('Gilt die 40-m-Grenze auch für das nördliche Treppenhaus?'),
    ).toBeInTheDocument()
    expect(within(row).getByText(/Die Fluchtweglänge/)).toBeInTheDocument()
  })

  it('says nothing has been collected rather than rendering an empty chart', async () => {
    stubFetch(health({ totals: { up: 0, down: 0, voters: 0, downVoters: 0 }, reasons: [] }))
    render(<AnswerFeedbackHealth />)

    await waitFor(() => expect(screen.getByText('No feedback yet')).toBeInTheDocument())
    expect(screen.queryByTestId('feedback-reason-bars')).toBeNull()
  })

  it('surfaces a refusal instead of showing zeroes that look like real data', async () => {
    stubFetch({ error: 'Forbidden' }, false)
    render(<AnswerFeedbackHealth />)

    await waitFor(() =>
      expect(screen.getByText('Answer feedback could not be loaded')).toBeInTheDocument(),
    )
  })
})

/**
 * The rate is the number that will get quoted, and on its own it is misleading in
 * three specific ways. These are the guards, and each one is a number the rate
 * cannot contain.
 */
describe('AnswerFeedbackHealth — what the rate does not say', () => {
  it('publishes coverage, so the rate cannot be read as being about the product', async () => {
    // 10 votes over 100 answers: the headline describes 10% of turns, and the
    // people who chose to vote are not a random 10%.
    stubFetch(health())
    render(<AnswerFeedbackHealth />)

    await waitFor(() =>
      expect(screen.getByText(/10 votes on 100 answers — 10\.0% of answers were rated/)).toBeInTheDocument(),
    )
  })

  it('names how many PEOPLE the down-votes came from', async () => {
    // Two down-votes from two people reads differently from two from one; the
    // rate is identical either way.
    stubFetch(health())
    render(<AnswerFeedbackHealth />)

    await waitFor(() => expect(screen.getByText(/from 2 people/)).toBeInTheDocument())
  })

  it('withholds a percentage from an organization with too few votes', async () => {
    stubFetch(
      health({
        organizations: [
          { organizationId: 'org_big', up: 20, down: 5, voters: 9 },
          // 1 of 2 is 50% — arithmetically true, and meaningless.
          { organizationId: 'org_tiny', up: 1, down: 1, voters: 1 },
        ],
      }),
    )
    render(<AnswerFeedbackHealth />)

    const rows = await screen.findAllByTestId('feedback-org')
    expect(within(rows[0]).getByText('20%')).toBeInTheDocument()
    expect(within(rows[1]).getByText('n/a')).toBeInTheDocument()
    expect(within(rows[1]).queryByText('50%')).toBeNull()
    // The counts stay, so the row is still evidence — just not a rate.
    expect(within(rows[1]).getByText('2 votes')).toBeInTheDocument()
  })
})

/**
 * Filters go to the SERVER. The drill-in is capped server-side, so a client-side
 * `.filter()` would search the 50 rows that happened to arrive and then report,
 * confidently, that there was nothing else.
 */
describe('AnswerFeedbackHealth — filtering and export', () => {
  const lastUrl = (): string => {
    const mock = vi.mocked(globalThis.fetch)
    return String(mock.mock.calls.at(-1)?.[0] ?? '')
  }

  it('asks the server for the window, rather than trimming what arrived', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth />)

    await waitFor(() => expect(lastUrl()).toContain('days=30'))
    await user.click(screen.getByRole('button', { name: 'Last 7 days' }))
    await waitFor(() => expect(lastUrl()).toContain('days=7'))
  })

  it('turns the reason breakdown into the filter for it', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth />)

    await user.click(await screen.findByRole('button', { name: 'Inaccurate' }))
    await waitFor(() => expect(lastUrl()).toContain('reason=inaccurate'))

    // …and pressing it again is how you get back, rather than hunting for a reset.
    await user.click(screen.getByRole('button', { name: 'Inaccurate' }))
    await waitFor(() => expect(lastUrl()).not.toContain('reason='))
  })

  it('says the headline is about the selection once anything is filtered', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth />)

    expect(screen.queryByText(/describe the current selection/)).toBeNull()
    await user.click(await screen.findByRole('button', { name: 'Inaccurate' }))
    await waitFor(() =>
      expect(screen.getByText(/describe the current selection/)).toBeInTheDocument(),
    )
  })

  it('exports exactly what is on screen, filters and all', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth />)

    await user.click(await screen.findByRole('button', { name: 'Inaccurate' }))

    // Same query string as the read — an export that disagreed with the view it
    // was taken from would be worse than no export.
    const link = screen.getByRole('link', { name: /Export CSV/ })
    await waitFor(() => expect(link).toHaveAttribute('href', expect.stringContaining('reason=inaccurate')))
    expect(link).toHaveAttribute('href', expect.stringContaining('/export?'))
    expect(link).toHaveAttribute('download')
  })
})
