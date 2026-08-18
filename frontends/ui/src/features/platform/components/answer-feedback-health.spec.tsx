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
  topics: [],
  turns: [],
  ...overrides,
})

const turn = (overrides: Record<string, unknown> = {}) => ({
  id: 'f1',
  organizationId: 'org_1',
  projectId: null,
  conversationId: null,
  messageId: 'm-1',
  verdict: 'down',
  reason: 'inaccurate',
  createdAt: new Date().toISOString(),
  answer: null,
  question: null,
  conversationTitle: null,
  topics: [],
  ...overrides,
})

/**
 * The digest has its own route and its own component; every test here is about
 * the numbers, so it is stubbed to "nothing to summarise" and stays out of the
 * way. Its own behaviour is covered in `feedback-digest.spec.tsx`.
 */
const stubFetch = (body: unknown, ok = true): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/answer-feedback/digest')) {
        return new Response(JSON.stringify({ digest: null, error: 'no_feedback' }), { status: 200 })
      }
      return new Response(JSON.stringify(body), { status: ok ? 200 : 403 })
    }),
  )
}

/** URLs of the health reads only — the digest fetch is a different question. */
const healthUrls = (): string[] =>
  vi
    .mocked(globalThis.fetch)
    .mock.calls.map((call) => String(call[0]))
    .filter((url) => !url.includes('/digest'))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AnswerFeedbackHealth', () => {
  /**
   * The headline used to be the negative rate, which made the card a scoreboard
   * you could only lose on. Same arithmetic, opposite reading — and this is the
   * number that gets quoted, so which one it is matters more than it looks.
   */
  it('leads with the helpful rate, not the failure rate', async () => {
    stubFetch(health())
    render(<AnswerFeedbackHealth />)

    // 8 of 10 votes were helpful.
    await waitFor(() => expect(screen.getByText('80.0%')).toBeInTheDocument())
    expect(screen.getByText('of votes were helpful')).toBeInTheDocument()
    expect(screen.queryByText('20.0%')).toBeNull()
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
  it('lists a rated turn that was never stored, and says so', async () => {
    stubFetch(health({ turns: [turn({ messageId: 'm-unpersisted' })] }))
    render(<AnswerFeedbackHealth />)

    const row = await screen.findByTestId('feedback-turn')
    expect(within(row).getByText(/was not stored/i)).toBeInTheDocument()
    // …and it is still identifiable as a real defect, not a broken row.
    expect(within(row).getByText('Inaccurate')).toBeInTheDocument()
    expect(within(row).getByText('org_1')).toBeInTheDocument()
  })

  it('shows the question when the turn WAS stored — the point of the surface', async () => {
    stubFetch(
      health({
        turns: [
          turn({
            id: 'f2',
            conversationId: 'c-1',
            reason: 'wrong_source',
            answer: 'Die Fluchtweglänge beträgt 40 m.',
            question: 'Gilt die 40-m-Grenze auch für das nördliche Treppenhaus?',
            conversationTitle: 'Atrium',
            topics: ['brandschutz'],
          }),
        ],
      }),
    )
    render(<AnswerFeedbackHealth />)

    const row = await screen.findByTestId('feedback-turn')
    expect(
      within(row).getByText('Gilt die 40-m-Grenze auch für das nördliche Treppenhaus?'),
    ).toBeInTheDocument()
    expect(within(row).getByText(/Die Fluchtweglänge/)).toBeInTheDocument()
    // The topic travels with the row, so a reader can see the theme without
    // opening the conversation.
    expect(within(row).getByText('Fire safety')).toBeInTheDocument()
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
 * The half the surface used not to have. Feedback that only ever surfaces
 * failures cannot tell anybody which of last month's changes to keep, and that
 * was the complaint that produced these.
 */
describe('AnswerFeedbackHealth — the answers that landed', () => {
  it('offers the praised answers as a peer of the failed ones', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth />)

    // Both controls exist from the start; neither is hidden behind a disclosure.
    const missed = await screen.findByRole('radio', { name: 'Missed' })
    const landed = screen.getByRole('radio', { name: 'Landed' })
    expect(missed).toHaveAttribute('aria-checked', 'true')

    await user.click(landed)
    await waitFor(() => expect(healthUrls().at(-1)).toContain('verdict=up'))
    expect(await screen.findByText('Answers that landed')).toBeInTheDocument()
  })

  it('renders a helpful turn with its own chip, not a borrowed failure label', async () => {
    stubFetch(
      health({
        turns: [
          turn({
            id: 'g1',
            verdict: 'up',
            reason: null,
            question: 'Ab wann ist ein Aufzug barrierefrei erforderlich?',
          }),
        ],
      }),
    )
    render(<AnswerFeedbackHealth />)

    const row = await screen.findByTestId('feedback-turn')
    expect(within(row).getByText('Helpful')).toBeInTheDocument()
    // 'Other' is the fallback reason label — a praised answer must never wear it.
    expect(within(row).queryByText('Other')).toBeNull()
  })

  it('drops the reason filter when switching to the praised list', async () => {
    // A reason only exists on a down-vote. Carrying it across would return an
    // empty list that reads as "nobody liked anything".
    stubFetch(health())
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth />)

    await user.click(await screen.findByRole('button', { name: 'Inaccurate' }))
    await waitFor(() => expect(healthUrls().at(-1)).toContain('reason=inaccurate'))

    await user.click(screen.getByRole('radio', { name: 'Landed' }))
    await waitFor(() => {
      const url = healthUrls().at(-1) ?? ''
      expect(url).toContain('verdict=up')
      expect(url).not.toContain('reason=')
    })
  })

  it('sorts topics best-first and withholds a rate below the floor', async () => {
    stubFetch(
      health({
        topics: [
          { topic: 'schallschutz', up: 6, down: 6, voters: 4 },
          { topic: 'brandschutz', up: 18, down: 2, voters: 9 },
          // 2 votes: counts stay, the percentage does not.
          { topic: 'statik', up: 1, down: 1, voters: 1 },
        ],
      }),
    )
    render(<AnswerFeedbackHealth />)

    const rows = await screen.findAllByTestId('feedback-topic')
    expect(within(rows[0]).getByText('Fire safety')).toBeInTheDocument()
    expect(within(rows[0]).getByText('90%')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Sound insulation')).toBeInTheDocument()
    // Unreadable rows sink below the readable ones rather than sorting as 50%.
    expect(within(rows[2]).getByText('Structural')).toBeInTheDocument()
    expect(within(rows[2]).getByText('n/a')).toBeInTheDocument()
  })

  it('says the topic table is not a second denominator', async () => {
    stubFetch(health({ topics: [{ topic: 'brandschutz', up: 18, down: 2, voters: 9 }] }))
    render(<AnswerFeedbackHealth />)

    await waitFor(() =>
      expect(screen.getByText(/do not add up to the totals above/)).toBeInTheDocument(),
    )
  })
})

/**
 * The rate is the number that will get quoted, and on its own it is misleading in
 * three specific ways. These are the guards, and each one is a number the rate
 * cannot contain. They matter MORE now the headline is the flattering half: a
 * 94% helpful rate over 4% of answers is exactly as misquotable as its inverse.
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
          // 1 of 2 either way is a verdict built on one person.
          { organizationId: 'org_tiny', up: 1, down: 1, voters: 1 },
        ],
      }),
    )
    render(<AnswerFeedbackHealth />)

    const rows = await screen.findAllByTestId('feedback-org')
    // Helpful share, matching the headline — 20 of 25.
    expect(within(rows[0]).getByText('80%')).toBeInTheDocument()
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
  it('asks the server for the window, rather than trimming what arrived', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth />)

    await waitFor(() => expect(healthUrls().at(-1)).toContain('days=30'))
    await user.click(screen.getByRole('radio', { name: 'Last 7 days' }))
    await waitFor(() => expect(healthUrls().at(-1)).toContain('days=7'))
  })

  it('turns the reason breakdown into the filter for it', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth />)

    await user.click(await screen.findByRole('button', { name: 'Inaccurate' }))
    await waitFor(() => expect(healthUrls().at(-1)).toContain('reason=inaccurate'))

    // …and pressing it again is how you get back, rather than hunting for a reset.
    await user.click(screen.getByRole('button', { name: 'Inaccurate' }))
    await waitFor(() => expect(healthUrls().at(-1)).not.toContain('reason='))
  })

  it('sends the topic filter to the server when a topic row is pressed', async () => {
    stubFetch(health({ topics: [{ topic: 'brandschutz', up: 18, down: 2, voters: 9 }] }))
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth />)

    await user.click(await screen.findByRole('button', { name: 'Fire safety' }))
    await waitFor(() => expect(healthUrls().at(-1)).toContain('topic=brandschutz'))
  })

  /**
   * The warning follows the AGGREGATES, not any filter. Reason and free text
   * narrow the drill-in only, so flagging the headline as "a claim about your
   * selection" when a reason is picked would be crying wolf on a number that
   * has not moved — and a warning that fires when nothing happened is one
   * people stop reading before it fires for real.
   */
  it('warns the headline is about a selection only when the aggregates narrow', async () => {
    stubFetch(health({ topics: [{ topic: 'brandschutz', up: 18, down: 2, voters: 9 }] }))
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth />)

    await user.click(await screen.findByRole('button', { name: 'Inaccurate' }))
    await waitFor(() => expect(healthUrls().at(-1)).toContain('reason='))
    expect(screen.queryByText(/describe the current selection/)).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Fire safety' }))
    await waitFor(() =>
      expect(screen.getByText(/describe the current selection/)).toBeInTheDocument(),
    )
  })

  it('exports exactly what is on screen, filters and direction alike', async () => {
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

    // …including which half of the feedback is being looked at.
    await user.click(screen.getByRole('radio', { name: 'Landed' }))
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /Export CSV/ })).toHaveAttribute(
        'href',
        expect.stringContaining('verdict=up'),
      ),
    )
  })
})
