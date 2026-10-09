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
    })
  )
}

const urls = (): string[] => vi.mocked(globalThis.fetch).mock.calls.map((call) => String(call[0]))
/** URLs of the health reads only — the digest fetch is a different question. */
const healthUrls = (): string[] => urls().filter((url) => !url.includes('/digest'))
const digestUrls = (): string[] => urls().filter((url) => url.includes('/digest'))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AnswerFeedbackHealth — the figures', () => {
  /**
   * The headline used to be the negative rate, which made the surface a
   * scoreboard you could only lose on. Same arithmetic, opposite reading.
   */
  it('leads with the helpful rate, not the failure rate', async () => {
    stubFetch(health())
    render(<AnswerFeedbackHealth days={30} />)

    const tile = await screen.findByTestId('feedback-kpi-helpful')
    // 8 of 10 votes were helpful.
    expect(within(tile).getByText('80.0%')).toBeInTheDocument()
    expect(within(tile).getByText('8 of 10 votes')).toBeInTheDocument()
    expect(screen.queryByText('20.0%')).toBeNull()
  })

  it('withholds the headline rate below the vote floor', async () => {
    // 1 of 2 is 50%, and 50% on two votes is a coin, not a rate.
    stubFetch(health({ totals: { up: 1, down: 1, voters: 2, downVoters: 1 } }))
    render(<AnswerFeedbackHealth days={30} />)

    const tile = await screen.findByTestId('feedback-kpi-helpful')
    expect(within(tile).getByText('—')).toBeInTheDocument()
    expect(within(tile).getByText(/needs at least 5 votes/)).toBeInTheDocument()
    expect(within(tile).queryByText('50.0%')).toBeNull()
  })

  it('publishes coverage, so the rate cannot be read as being about the product', async () => {
    // 10 votes over 100 answers: the headline describes 10% of turns.
    stubFetch(health())
    render(<AnswerFeedbackHealth days={30} />)

    const tile = await screen.findByTestId('feedback-kpi-coverage')
    expect(within(tile).getByText('10.0%')).toBeInTheDocument()
    expect(within(tile).getByText('10 votes on 100 answers')).toBeInTheDocument()
  })

  /**
   * Bug: `answers` counts persisted assistant messages, persistence is
   * best-effort, so votes can outnumber them. Coverage printed 140%.
   */
  it('clamps coverage at 100% when votes outnumber stored answers', async () => {
    stubFetch(health({ answers: 7 }))
    render(<AnswerFeedbackHealth days={30} />)

    const tile = await screen.findByTestId('feedback-kpi-coverage')
    expect(within(tile).getByText('100.0%')).toBeInTheDocument()
    expect(within(tile).queryByText(/142/)).toBeNull()
  })

  /** Bug: with no stored answers the coverage printed a confident "0.0%". */
  it('says coverage is unknown, not zero, when no answers were counted', async () => {
    stubFetch(health({ answers: 0 }))
    render(<AnswerFeedbackHealth days={30} />)

    const tile = await screen.findByTestId('feedback-kpi-coverage')
    expect(within(tile).getByText('—')).toBeInTheDocument()
    expect(within(tile).getByText(/No stored answers/)).toBeInTheDocument()
    expect(within(tile).queryByText('0.0%')).toBeNull()
  })

  it('names how many PEOPLE the down-votes came from', async () => {
    stubFetch(health())
    render(<AnswerFeedbackHealth days={30} />)

    const tile = await screen.findByTestId('feedback-kpi-down')
    expect(within(tile).getByText('2')).toBeInTheDocument()
    expect(within(tile).getByText('from 2 people')).toBeInTheDocument()
  })

  it('keeps every reason on screen, including the ones nobody picked', async () => {
    stubFetch(health())
    render(<AnswerFeedbackHealth days={30} />)

    const bars = await screen.findByTestId('feedback-reason-bars')
    for (const label of ['Inaccurate', 'Wrong source', 'Too slow', 'Other']) {
      expect(
        within(bars).getByRole('button', { name: new RegExp(`^${label},`) })
      ).toBeInTheDocument()
    }
  })

  /**
   * Bug: a NULL reason and an explicit 'other' both land on 'other', and the
   * bar list used `Map.set`, so whichever row came second overwrote the first
   * and the bars no longer summed to the down-votes.
   */
  it('adds a NULL reason to "other" rather than overwriting it', async () => {
    stubFetch(
      health({
        totals: { up: 8, down: 5, voters: 5, downVoters: 3 },
        reasons: [
          { reason: 'inaccurate', count: 2 },
          { reason: 'other', count: 2 },
          { reason: null, count: 1 },
        ],
      })
    )
    render(<AnswerFeedbackHealth days={30} />)

    const bars = await screen.findByTestId('feedback-reason-bars')
    expect(within(bars).getByRole('button', { name: 'Other, 3' })).toBeInTheDocument()
  })

  it('says nothing has been collected rather than rendering an empty chart', async () => {
    stubFetch(health({ totals: { up: 0, down: 0, voters: 0, downVoters: 0 }, reasons: [] }))
    render(<AnswerFeedbackHealth days={30} />)

    await waitFor(() => expect(screen.getByText('No feedback yet')).toBeInTheDocument())
    expect(screen.queryByTestId('feedback-reason-bars')).toBeNull()
  })
})

describe('AnswerFeedbackHealth — states', () => {
  it('shows stat-shaped skeletons on the first load only', async () => {
    let release: (value: Response) => void = () => {}
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        if (String(input).includes('/digest')) {
          return Promise.resolve(
            new Response(JSON.stringify({ digest: null, error: 'no_feedback' }))
          )
        }
        return new Promise<Response>((resolve) => {
          release = resolve
        })
      })
    )
    const { rerender } = render(<AnswerFeedbackHealth days={30} />)
    expect(screen.getByTestId('answer-feedback-loading')).toBeInTheDocument()

    release(new Response(JSON.stringify(health())))
    await screen.findByTestId('feedback-kpis')

    // A refetch keeps the figures on screen, marked busy, instead of
    // collapsing the whole surface back into skeletons.
    rerender(<AnswerFeedbackHealth days={7} />)
    await waitFor(() => expect(healthUrls().at(-1)).toContain('days=7'))
    expect(screen.queryByTestId('answer-feedback-loading')).toBeNull()
    expect(screen.getByTestId('feedback-kpis')).toBeInTheDocument()
    expect(screen.getByText('Updating…')).toBeInTheDocument()

    release(new Response(JSON.stringify(health())))
    await waitFor(() => expect(screen.queryByText('Updating…')).toBeNull())
  })

  /**
   * Bug: filters change faster than the server answers, and the slower of two
   * in-flight reads used to win by finishing last.
   */
  it('drops a stale response that a newer request replaced', async () => {
    const pending: { url: string; resolve: (r: Response) => void; signal?: AbortSignal }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes('/digest')) {
          return Promise.resolve(
            new Response(JSON.stringify({ digest: null, error: 'no_feedback' }))
          )
        }
        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
          pending.push({ url: String(input), resolve, signal: init?.signal ?? undefined })
        })
      })
    )
    const { rerender } = render(<AnswerFeedbackHealth days={30} />)
    await waitFor(() => expect(pending).toHaveLength(1))
    rerender(<AnswerFeedbackHealth days={7} />)
    await waitFor(() => expect(pending).toHaveLength(2))

    expect(pending[0].signal?.aborted).toBe(true)
    pending[1].resolve(new Response(JSON.stringify(health({ answers: 50 }))))
    pending[0].resolve(new Response(JSON.stringify(health({ answers: 999 }))))

    const tile = await screen.findByTestId('feedback-kpi-coverage')
    expect(within(tile).getByText('10 votes on 50 answers')).toBeInTheDocument()
  })

  /** A failed read is an error with a way out, not an empty state that reads as "no feedback". */
  it('surfaces a refusal as an alert with a retry', async () => {
    stubFetch({ error: 'Forbidden' }, false)
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth days={30} />)

    const alert = await screen.findByTestId('answer-feedback-error')
    expect(within(alert).getByText('Answer feedback could not be loaded')).toBeInTheDocument()
    expect(screen.queryByText('No feedback yet')).toBeNull()

    const before = healthUrls().length
    await user.click(within(alert).getByRole('button', { name: /Retry/ }))
    await waitFor(() => expect(healthUrls().length).toBe(before + 1))
  })

  /**
   * Bug: a filter that matched nothing said "No feedback yet", which reads as
   * the platform having no feedback at all.
   */
  it('says the filters match nothing, and offers to clear them', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/digest'))
        return new Response(JSON.stringify({ digest: null, error: 'no_feedback' }))
      const empty = url.includes('topic=')
      return new Response(
        JSON.stringify(
          health({
            totals: empty
              ? { up: 0, down: 0, voters: 0, downVoters: 0 }
              : { up: 18, down: 2, voters: 9, downVoters: 2 },
            topics: [{ topic: 'brandschutz', up: 18, down: 2, voters: 9 }],
          })
        )
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth days={30} />)

    await user.click(await screen.findByRole('button', { name: /^Fire safety,/ }))
    expect(await screen.findByText('No ratings match these filters.')).toBeInTheDocument()
    expect(screen.queryByText('No feedback yet')).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Clear filters' }))
    await waitFor(() => expect(healthUrls().at(-1)).not.toContain('topic='))
  })
})

describe('AnswerFeedbackHealth — the drill-in', () => {
  /**
   * `answer_feedback.message_id` has no FK to `messages`, so a turn that was
   * never persisted cannot be joined. It must still be listed, and say why.
   */
  it('lists a rated turn that was never stored, and says so', async () => {
    stubFetch(health({ turns: [turn({ messageId: 'm-unpersisted' })] }))
    render(<AnswerFeedbackHealth days={30} />)

    const row = await screen.findByTestId('feedback-turn')
    expect(within(row).getByText(/was not stored/i)).toBeInTheDocument()
    expect(within(row).getByText('Inaccurate')).toBeInTheDocument()
    // No name from the server: the id, rather than nothing.
    expect(within(row).getByText('org_1')).toBeInTheDocument()
  })

  it('names the organization instead of printing its id', async () => {
    stubFetch(health({ turns: [turn({ organizationName: 'Architekturbüro Hofer' })] }))
    render(<AnswerFeedbackHealth days={30} />)

    const row = await screen.findByTestId('feedback-turn')
    expect(within(row).getByText('Architekturbüro Hofer')).toBeInTheDocument()
    expect(within(row).queryByText('org_1')).toBeNull()
  })

  /** Bug: the rows could not be opened, so the full answer and the voter's note were unreachable. */
  it('opens the whole case in a sheet: question, answer, comment, expected answer, trace', async () => {
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
            comment: 'Falsches Treppenhaus.',
            expectedAnswer: 'OIB-RL 2, Punkt 5.1.3: 50 m.',
            langfuseTraceUrl: 'https://langfuse.example/trace/abc',
          }),
        ],
      })
    )
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth days={30} />)

    const row = await screen.findByTestId('feedback-turn')
    expect(
      within(row).getByText('Gilt die 40-m-Grenze auch für das nördliche Treppenhaus?')
    ).toBeInTheDocument()
    expect(within(row).getByText('Fire safety')).toBeInTheDocument()

    await user.click(within(row).getByRole('button'))
    const sheet = await screen.findByTestId('feedback-turn-sheet')
    expect(within(sheet).getByText('Atrium')).toBeInTheDocument()
    expect(within(sheet).getByText('Die Fluchtweglänge beträgt 40 m.')).toBeInTheDocument()
    expect(within(sheet).getByTestId('feedback-turn-comment')).toHaveTextContent(
      'Falsches Treppenhaus.'
    )
    expect(within(sheet).getByTestId('feedback-turn-expected')).toHaveTextContent(
      'OIB-RL 2, Punkt 5.1.3: 50 m.'
    )
    const trace = within(sheet).getByRole('link', { name: /Open in Langfuse/ })
    expect(trace).toHaveAttribute('href', 'https://langfuse.example/trace/abc')
    expect(trace).toHaveAttribute('target', '_blank')
  })

  it('draws no Langfuse button for a turn without a trace', async () => {
    stubFetch(health({ turns: [turn({ question: 'Frage?', langfuseTraceUrl: null })] }))
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth days={30} />)

    await user.click(within(await screen.findByTestId('feedback-turn')).getByRole('button'))
    const sheet = await screen.findByTestId('feedback-turn-sheet')
    expect(within(sheet).queryByRole('link', { name: /Langfuse/ })).toBeNull()
  })

  it('offers the praised answers as a peer of the failed ones', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth days={30} />)

    const missed = await screen.findByRole('radio', { name: 'Missed' })
    expect(missed).toHaveAttribute('aria-checked', 'true')

    await user.click(screen.getByRole('radio', { name: 'Landed' }))
    await waitFor(() => expect(healthUrls().at(-1)).toContain('verdict=up'))
    expect(await screen.findByText('Answers that landed')).toBeInTheDocument()
  })

  it('renders a helpful turn with its own badge, not a borrowed failure label', async () => {
    stubFetch(
      health({ turns: [turn({ id: 'g1', verdict: 'up', reason: null, question: 'Aufzug?' })] })
    )
    render(<AnswerFeedbackHealth days={30} />)

    const row = await screen.findByTestId('feedback-turn')
    expect(within(row).getByText('Helpful')).toBeInTheDocument()
    expect(within(row).queryByText('Other')).toBeNull()
  })

  it('drops the reason filter when switching to the praised list', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth days={30} />)

    await user.click(await screen.findByRole('button', { name: /^Inaccurate,/ }))
    await waitFor(() => expect(healthUrls().at(-1)).toContain('reason=inaccurate'))

    await user.click(screen.getByRole('radio', { name: 'Landed' }))
    await waitFor(() => {
      const url = healthUrls().at(-1) ?? ''
      expect(url).toContain('verdict=up')
      expect(url).not.toContain('reason=')
    })
  })

  it('says the list is empty under filters differently from an empty window', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth days={30} />)

    expect(await screen.findByText('No negative feedback in this window.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Inaccurate,/ }))
    expect(await screen.findByText('No ratings match these filters.')).toBeInTheDocument()
  })
})

describe('AnswerFeedbackHealth — breakdowns', () => {
  it('sorts topics best-first and withholds a rate below the floor', async () => {
    stubFetch(
      health({
        topics: [
          { topic: 'schallschutz', up: 6, down: 6, voters: 4 },
          { topic: 'brandschutz', up: 18, down: 2, voters: 9 },
          { topic: 'statik', up: 1, down: 1, voters: 1 },
        ],
      })
    )
    render(<AnswerFeedbackHealth days={30} />)

    const rows = await screen.findAllByTestId('feedback-topic')
    expect(within(rows[0]).getByText('Fire safety')).toBeInTheDocument()
    expect(within(rows[0]).getByText('90%')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Sound insulation')).toBeInTheDocument()
    expect(within(rows[2]).getByText('Structural')).toBeInTheDocument()
    expect(within(rows[2]).getByText('n/a')).toBeInTheDocument()
  })

  it('says the topic list is not a second denominator', async () => {
    stubFetch(health({ topics: [{ topic: 'brandschutz', up: 18, down: 2, voters: 9 }] }))
    render(<AnswerFeedbackHealth days={30} />)

    await waitFor(() =>
      expect(screen.getByText(/do not add up to the totals above/)).toBeInTheDocument()
    )
  })

  /** Bug: the organization list printed raw ids (`org_arch_buero`) in mono. */
  it('lists organizations by name, with the id only as the fallback', async () => {
    stubFetch(
      health({
        organizations: [
          {
            organizationId: 'org_big',
            organizationName: 'Planwerk Graz',
            up: 20,
            down: 5,
            voters: 9,
          },
          { organizationId: 'org_tiny', up: 1, down: 1, voters: 1 },
        ],
      })
    )
    render(<AnswerFeedbackHealth days={30} />)

    const rows = await screen.findAllByTestId('feedback-org')
    expect(within(rows[0]).getByRole('button', { name: 'Planwerk Graz' })).toBeInTheDocument()
    expect(within(rows[0]).queryByText('org_big')).toBeNull()
    expect(within(rows[1]).getByRole('button', { name: 'org_tiny' })).toBeInTheDocument()
  })

  it('withholds a percentage from an organization with too few votes', async () => {
    stubFetch(
      health({
        organizations: [
          { organizationId: 'org_big', up: 20, down: 5, voters: 9 },
          { organizationId: 'org_tiny', up: 1, down: 1, voters: 1 },
        ],
      })
    )
    render(<AnswerFeedbackHealth days={30} />)

    const rows = await screen.findAllByTestId('feedback-org')
    expect(within(rows[0]).getByText('80%')).toBeInTheDocument()
    expect(within(rows[1]).getByText('n/a')).toBeInTheDocument()
    expect(within(rows[1]).queryByText('50%')).toBeNull()
    expect(within(rows[1]).getByText('2 votes')).toBeInTheDocument()
  })

  it('filters by organization from a table row, and shows it as a removable chip', async () => {
    stubFetch(
      health({
        organizations: [
          {
            organizationId: 'org_big',
            organizationName: 'Planwerk Graz',
            up: 20,
            down: 5,
            voters: 9,
          },
        ],
      })
    )
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth days={30} />)

    await user.click(await screen.findByRole('button', { name: 'Planwerk Graz' }))
    await waitFor(() => expect(healthUrls().at(-1)).toContain('org=org_big'))

    const chip = await screen.findByRole('button', {
      name: 'Remove filter Organization: Planwerk Graz',
    })
    await user.click(chip)
    await waitFor(() => expect(healthUrls().at(-1)).not.toContain('org='))
  })
})

/**
 * Filters go to the SERVER. The drill-in is capped server-side, so a client-side
 * `.filter()` would search the 50 rows that happened to arrive.
 */
describe('AnswerFeedbackHealth — filtering and export', () => {
  it('takes the window from the page and has no window control of its own', async () => {
    stubFetch(health())
    const { rerender } = render(<AnswerFeedbackHealth days={30} />)

    await waitFor(() => expect(healthUrls().at(-1)).toContain('days=30'))
    expect(screen.queryByRole('radio', { name: /Last 7 days/ })).toBeNull()
    rerender(<AnswerFeedbackHealth days={90} />)
    await waitFor(() => expect(healthUrls().at(-1)).toContain('days=90'))
  })

  it('turns the reason breakdown into the filter for it', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth days={30} />)

    await user.click(await screen.findByRole('button', { name: /^Inaccurate,/ }))
    await waitFor(() => expect(healthUrls().at(-1)).toContain('reason=inaccurate'))
    expect(
      screen.getByRole('button', { name: 'Remove filter Reason: Inaccurate' })
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^Inaccurate,/ }))
    await waitFor(() => expect(healthUrls().at(-1)).not.toContain('reason='))
  })

  it('sends the topic filter to the server when a topic row is pressed', async () => {
    stubFetch(health({ topics: [{ topic: 'brandschutz', up: 18, down: 2, voters: 9 }] }))
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth days={30} />)

    await user.click(await screen.findByRole('button', { name: /^Fire safety,/ }))
    await waitFor(() => expect(healthUrls().at(-1)).toContain('topic=brandschutz'))
  })

  /**
   * The warning follows the AGGREGATES, not any filter. Reason and free text
   * narrow the drill-in only.
   */
  it('warns the headline is about a selection only when the aggregates narrow', async () => {
    stubFetch(health({ topics: [{ topic: 'brandschutz', up: 18, down: 2, voters: 9 }] }))
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth days={30} />)

    await user.click(await screen.findByRole('button', { name: /^Inaccurate,/ }))
    await waitFor(() => expect(healthUrls().at(-1)).toContain('reason='))
    expect(screen.queryByText(/describe the current selection/)).toBeNull()

    await user.click(screen.getByRole('button', { name: /^Fire safety,/ }))
    await waitFor(() =>
      expect(screen.getByText(/describe the current selection/)).toBeInTheDocument()
    )
  })

  /** Bug: every Missed/Landed switch re-asked the model for the same digest. */
  it('re-asks the digest for the window and aggregate filters only', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth days={30} />)

    await screen.findByTestId('feedback-kpis')
    await waitFor(() => expect(digestUrls()).toHaveLength(1))
    await user.click(screen.getByRole('radio', { name: 'Landed' }))
    await waitFor(() => expect(healthUrls().at(-1)).toContain('verdict=up'))
    expect(digestUrls()).toHaveLength(1)
    expect(digestUrls()[0]).not.toContain('verdict=')
  })

  /**
   * The single export button followed the drill-in, which defaults to the
   * failures: "export the feedback" handed people the down-votes only. Every
   * vote is the first item now; the screen's filters are an explicit second.
   */
  it('exports every vote by default, and the selection only when asked for', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth days={30} />)

    await user.click(await screen.findByRole('button', { name: /^Inaccurate,/ }))
    await user.click(screen.getByTestId('feedback-export'))

    const all = await screen.findByRole('menuitem', { name: /Export all votes \(Excel\)/ })
    expect(all).toHaveAttribute('href', '/api/platform/answer-feedback/export?days=30&format=xlsx')
    expect(all).toHaveAttribute('download')

    const selection = screen.getByRole('menuitem', { name: /Export current selection \(Excel\)/ })
    await waitFor(() => expect(selection).toHaveAttribute('href', expect.stringContaining('reason=inaccurate')))
    expect(selection).toHaveAttribute('href', expect.stringContaining('verdict=down'))
    expect(selection).toHaveAttribute('href', expect.stringContaining('scope=selection&format=xlsx'))
    // What the selection holds, in the chips' own words.
    expect(selection).toHaveTextContent('Reason: Inaccurate')

    const csv = screen.getByRole('menuitem', { name: /As CSV \(for scripts\)/ })
    expect(csv).toHaveAttribute('href', '/api/platform/answer-feedback/export?days=30&format=csv')
  })

  it('follows the direction into the selection export', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<AnswerFeedbackHealth days={30} />)

    await user.click(await screen.findByRole('radio', { name: 'Landed' }))
    await user.click(screen.getByTestId('feedback-export'))

    await waitFor(() =>
      expect(screen.getByTestId('feedback-export-selection')).toHaveAttribute(
        'href',
        expect.stringContaining('verdict=up')
      )
    )
    expect(screen.getByTestId('feedback-export-all')).not.toHaveAttribute('href', expect.stringContaining('verdict'))
  })

  it('links the Langfuse project only when the server knows it', async () => {
    stubFetch(health({ langfuse: { projectUrl: 'https://langfuse.example/project/p' } }))
    const { unmount } = render(<AnswerFeedbackHealth days={30} />)
    const link = await screen.findByTestId('feedback-langfuse')
    expect(link).toHaveAttribute('href', 'https://langfuse.example/project/p')
    unmount()

    stubFetch(health())
    render(<AnswerFeedbackHealth days={30} />)
    await screen.findByTestId('feedback-kpis')
    expect(screen.queryByTestId('feedback-langfuse')).toBeNull()
  })
})
