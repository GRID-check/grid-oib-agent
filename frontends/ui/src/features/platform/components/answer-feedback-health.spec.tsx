import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor, within } from '@/test-utils'

import { NO_RATINGS_FILTERS, type RatingsFilters } from '@/lib/feedback/filters'
import type { QualityScope } from '@/lib/quality/scope'
import { AnswerFeedbackHealth } from './answer-feedback-health'

const MONTH: QualityScope = { from: '2026-09-10', to: '2026-10-09', organizationIds: [], projectIds: [] }
const WEEK: QualityScope = { ...MONTH, from: '2026-10-03' }

/**
 * The workspace's part, in miniature: it owns the scope and the filters (in the
 * URL there, in state here) and hands them down. `scope` given from outside is
 * the page changing the range under the organism.
 */
function Harness({
  scope: outerScope,
  initialFilters = NO_RATINGS_FILTERS,
}: {
  scope?: QualityScope
  initialFilters?: RatingsFilters
}) {
  const [innerScope, setScope] = useState<QualityScope>(MONTH)
  const [filters, setFilters] = useState<RatingsFilters>(initialFilters)
  return (
    <AnswerFeedbackHealth
      scope={outerScope ?? innerScope}
      filters={filters}
      onFiltersChange={setFilters}
      onScopeChange={setScope}
    />
  )
}

const OPTIONS = {
  total: 10,
  scopeTotal: 10,
  cap: 5000,
  overCap: false,
  verdicts: { up: 8, down: 2 },
  reasons: [{ key: 'inaccurate', votes: 2 }],
  topics: [{ key: 'brandschutz', votes: 42 }],
  modes: [{ key: 'deep', votes: 3 }],
  confidences: [{ key: 'low', votes: 1 }],
  withComment: 4,
  withExpectedAnswer: 1,
}

/** The two side reads every test stubs the same way; null for the health read itself. */
const sideRead = (url: string): Response | null => {
  if (url.includes('/answer-feedback/digest')) {
    return new Response(JSON.stringify({ digest: null, error: 'no_feedback' }), { status: 200 })
  }
  if (url.includes('/answer-feedback/options')) return new Response(JSON.stringify(OPTIONS), { status: 200 })
  return null
}

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
      return sideRead(String(input)) ?? new Response(JSON.stringify(body), { status: ok ? 200 : 403 })
    })
  )
}

const urls = (): string[] => vi.mocked(globalThis.fetch).mock.calls.map((call) => String(call[0]))
/** URLs of the health reads only — the digest and the options are different questions. */
const healthUrls = (): string[] => urls().filter((url) => !url.includes('/digest') && !url.includes('/options'))
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
    render(<Harness />)

    const tile = await screen.findByTestId('feedback-kpi-helpful')
    // 8 of 10 votes were helpful.
    expect(within(tile).getByText('80.0%')).toBeInTheDocument()
    expect(within(tile).getByText('8 of 10 votes')).toBeInTheDocument()
    expect(screen.queryByText('20.0%')).toBeNull()
  })

  it('withholds the headline rate below the vote floor', async () => {
    // 1 of 2 is 50%, and 50% on two votes is a coin, not a rate.
    stubFetch(health({ totals: { up: 1, down: 1, voters: 2, downVoters: 1 } }))
    render(<Harness />)

    const tile = await screen.findByTestId('feedback-kpi-helpful')
    expect(within(tile).getByText('—')).toBeInTheDocument()
    expect(within(tile).getByText(/needs at least 5 votes/)).toBeInTheDocument()
    expect(within(tile).queryByText('50.0%')).toBeNull()
  })

  it('publishes coverage, so the rate cannot be read as being about the product', async () => {
    // 10 votes over 100 answers: the headline describes 10% of turns.
    stubFetch(health())
    render(<Harness />)

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
    render(<Harness />)

    const tile = await screen.findByTestId('feedback-kpi-coverage')
    expect(within(tile).getByText('100.0%')).toBeInTheDocument()
    expect(within(tile).queryByText(/142/)).toBeNull()
  })

  /** Bug: with no stored answers the coverage printed a confident "0.0%". */
  it('says coverage is unknown, not zero, when no answers were counted', async () => {
    stubFetch(health({ answers: 0 }))
    render(<Harness />)

    const tile = await screen.findByTestId('feedback-kpi-coverage')
    expect(within(tile).getByText('—')).toBeInTheDocument()
    expect(within(tile).getByText(/No stored answers/)).toBeInTheDocument()
    expect(within(tile).queryByText('0.0%')).toBeNull()
  })

  it('names how many PEOPLE the down-votes came from', async () => {
    stubFetch(health())
    render(<Harness />)

    const tile = await screen.findByTestId('feedback-kpi-down')
    expect(within(tile).getByText('2')).toBeInTheDocument()
    expect(within(tile).getByText('from 2 people')).toBeInTheDocument()
  })

  it('keeps every reason on screen, including the ones nobody picked', async () => {
    stubFetch(health())
    render(<Harness />)

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
    render(<Harness />)

    const bars = await screen.findByTestId('feedback-reason-bars')
    expect(within(bars).getByRole('button', { name: 'Other, 3' })).toBeInTheDocument()
  })

  it('says nothing has been collected rather than rendering an empty chart', async () => {
    stubFetch(health({ totals: { up: 0, down: 0, voters: 0, downVoters: 0 }, reasons: [] }))
    render(<Harness />)

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
        const side = sideRead(String(input))
        if (side) return Promise.resolve(side)
        return new Promise<Response>((resolve) => {
          release = resolve
        })
      })
    )
    const { rerender } = render(<Harness scope={MONTH} />)
    expect(screen.getByTestId('answer-feedback-loading')).toBeInTheDocument()

    release(new Response(JSON.stringify(health())))
    await screen.findByTestId('feedback-kpis')

    // A refetch keeps the figures on screen, marked busy, instead of
    // collapsing the whole surface back into skeletons.
    rerender(<Harness scope={WEEK} />)
    await waitFor(() => expect(healthUrls().at(-1)).toContain('from=2026-10-03'))
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
        const side = sideRead(String(input))
        if (side) return Promise.resolve(side)
        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
          pending.push({ url: String(input), resolve, signal: init?.signal ?? undefined })
        })
      })
    )
    const { rerender } = render(<Harness scope={MONTH} />)
    await waitFor(() => expect(pending).toHaveLength(1))
    rerender(<Harness scope={WEEK} />)
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
    render(<Harness />)

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
      const side = sideRead(url)
      if (side) return side
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
    render(<Harness />)

    await user.click(await screen.findByRole('button', { name: /^Fire safety,/ }))
    expect(await screen.findByText('No ratings match these filters.')).toBeInTheDocument()
    expect(screen.queryByText('No feedback yet')).toBeNull()

    await user.click(screen.getByTestId('clear-filters-empty'))
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
    render(<Harness />)

    const row = await screen.findByTestId('feedback-turn')
    expect(within(row).getByText(/was not stored/i)).toBeInTheDocument()
    expect(within(row).getByText('Inaccurate')).toBeInTheDocument()
    // No name from the server: the id, rather than nothing.
    expect(within(row).getByText('org_1')).toBeInTheDocument()
  })

  it('names the organization instead of printing its id', async () => {
    stubFetch(health({ turns: [turn({ organizationName: 'Architekturbüro Hofer' })] }))
    render(<Harness />)

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
    render(<Harness />)

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
    render(<Harness />)

    await user.click(within(await screen.findByTestId('feedback-turn')).getByRole('button'))
    const sheet = await screen.findByTestId('feedback-turn-sheet')
    expect(within(sheet).queryByRole('link', { name: /Langfuse/ })).toBeNull()
  })

  it('lists both directions by default, and either one on request', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<Harness />)

    const all = await screen.findByRole('radio', { name: 'All' })
    expect(all).toHaveAttribute('aria-checked', 'true')
    expect(healthUrls().at(-1)).not.toContain('verdict=')
    expect(screen.getByText('Rated answers')).toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: 'Helpful' }))
    await waitFor(() => expect(healthUrls().at(-1)).toContain('verdict=up'))
    expect(await screen.findByText('Answers that landed')).toBeInTheDocument()
  })

  it('renders a helpful turn with its own badge, not a borrowed failure label', async () => {
    stubFetch(
      health({ turns: [turn({ id: 'g1', verdict: 'up', reason: null, question: 'Aufzug?' })] })
    )
    render(<Harness />)

    const row = await screen.findByTestId('feedback-turn')
    expect(within(row).getByText('Helpful')).toBeInTheDocument()
    expect(within(row).queryByText('Other')).toBeNull()
  })

  it('drops the reason filter when switching to the praised list', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(await screen.findByRole('button', { name: /^Inaccurate,/ }))
    await waitFor(() => expect(healthUrls().at(-1)).toContain('reason=inaccurate'))

    await user.click(screen.getByRole('radio', { name: 'Helpful' }))
    await waitFor(() => {
      const url = healthUrls().at(-1) ?? ''
      expect(url).toContain('verdict=up')
      expect(url).not.toContain('reason=')
    })
  })

  it('says the list is empty under filters differently from an empty window', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<Harness initialFilters={{ ...NO_RATINGS_FILTERS, verdict: 'down' }} />)

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
    render(<Harness />)

    const rows = await screen.findAllByTestId('feedback-topic')
    expect(within(rows[0]).getByText('Fire safety')).toBeInTheDocument()
    expect(within(rows[0]).getByText('90%')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Sound insulation')).toBeInTheDocument()
    expect(within(rows[2]).getByText('Structural')).toBeInTheDocument()
    expect(within(rows[2]).getByText('n/a')).toBeInTheDocument()
  })

  it('says the topic list is not a second denominator', async () => {
    stubFetch(health({ topics: [{ topic: 'brandschutz', up: 18, down: 2, voters: 9 }] }))
    render(<Harness />)

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
    render(<Harness />)

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
    render(<Harness />)

    const rows = await screen.findAllByTestId('feedback-org')
    expect(within(rows[0]).getByText('80%')).toBeInTheDocument()
    expect(within(rows[1]).getByText('n/a')).toBeInTheDocument()
    expect(within(rows[1]).queryByText('50%')).toBeNull()
    expect(within(rows[1]).getByText('2 votes')).toBeInTheDocument()
  })

  /** An organization row toggles that organization in the PAGE scope, so every tab follows. */
  it('narrows the page to an organization from its row, and back', async () => {
    stubFetch(
      health({
        organizations: [{ organizationId: 'org_big', organizationName: 'Planwerk Graz', up: 20, down: 5, voters: 9 }],
      })
    )
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(await screen.findByRole('button', { name: 'Planwerk Graz' }))
    await waitFor(() => expect(healthUrls().at(-1)).toContain('org=org_big'))
    expect(screen.getByRole('button', { name: 'Planwerk Graz' })).toHaveAttribute('aria-pressed', 'true')

    await user.click(screen.getByRole('button', { name: 'Planwerk Graz' }))
    await waitFor(() => expect(healthUrls().at(-1)).not.toContain('org='))
  })
})

/**
 * Filters go to the SERVER, for every read on the tab. The list is capped
 * server-side, so a client-side `.filter()` would search the 50 rows that
 * happened to arrive; and the figures used to ignore the reason and the search,
 * so the headline described different votes than the list under it.
 */
describe('AnswerFeedbackHealth — filtering and export', () => {
  it('reads the scope it is handed and has no range control of its own', async () => {
    stubFetch(health())
    const { rerender } = render(<Harness scope={MONTH} />)

    await waitFor(() => expect(healthUrls().at(-1)).toBe('/api/platform/answer-feedback?from=2026-09-10&to=2026-10-09'))
    expect(screen.queryByRole('radio', { name: /7 days/ })).toBeNull()
    rerender(<Harness scope={WEEK} />)
    await waitFor(() => expect(healthUrls().at(-1)).toContain('from=2026-10-03'))
  })

  it('turns the reason breakdown into the filter for it, shown in the filter row', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(await screen.findByRole('button', { name: /^Inaccurate,/ }))
    await waitFor(() => expect(healthUrls().at(-1)).toContain('reason=inaccurate'))
    const reasons = screen.getByTestId('feedback-filter-reasons')
    expect(within(reasons).getByRole('button', { name: 'Remove Inaccurate' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^Inaccurate,/ }))
    await waitFor(() => expect(healthUrls().at(-1)).not.toContain('reason='))
  })

  it('sends the topic filter to the server when a topic row is pressed', async () => {
    stubFetch(health({ topics: [{ topic: 'brandschutz', up: 18, down: 2, voters: 9 }] }))
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(await screen.findByRole('button', { name: /^Fire safety,/ }))
    await waitFor(() => expect(healthUrls().at(-1)).toContain('topic=brandschutz'))
  })

  it('sends the answer, note and search filters from the filter row', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(await screen.findByRole('combobox', { name: 'Answer mode' }))
    await user.click(await screen.findByRole('option', { name: /Deep research/ }))
    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('checkbox', { name: 'With a comment' }))
    await user.type(screen.getByRole('textbox', { name: 'Search questions and answers…' }), 'GK 4')

    await waitFor(() => {
      const url = healthUrls().at(-1) ?? ''
      expect(url).toContain('mode=deep')
      expect(url).toContain('has_comment=1')
      expect(url).toContain('q=GK+4')
    })
  })

  it('shows how many votes are behind each value, counted over the scope', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(await screen.findByRole('combobox', { name: 'Topics' }))
    expect(await screen.findByRole('option', { name: /Fire safety\s*42/ })).toBeInTheDocument()
    expect(urls().find((url) => url.includes('/options'))).toBe(
      '/api/platform/answer-feedback/options?from=2026-09-10&to=2026-10-09'
    )
  })

  it('clears the rating filters, and only those', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<Harness initialFilters={{ ...NO_RATINGS_FILTERS, topics: ['statik'], hasComment: true }} />)

    await user.click(await screen.findByTestId('clear-filters'))
    await waitFor(() => expect(healthUrls().at(-1)).toBe('/api/platform/answer-feedback?from=2026-09-10&to=2026-10-09'))
  })

  /** Any filter makes the headline a claim about a selection, and it says so. */
  it('warns the headline is about a selection once anything narrows it', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<Harness />)

    await screen.findByTestId('feedback-kpis')
    expect(screen.queryByText(/describe the current selection/)).toBeNull()
    await user.click(screen.getByRole('button', { name: /^Inaccurate,/ }))
    await waitFor(() => expect(screen.getByText(/describe the current selection/)).toBeInTheDocument())
  })

  /** The sentences describe the same votes as the figures beside them. */
  it('asks the digest about the same votes as the figures', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<Harness />)

    await screen.findByTestId('feedback-kpis')
    await user.click(screen.getByRole('button', { name: /^Inaccurate,/ }))
    await waitFor(() => expect(digestUrls().at(-1)).toContain('reason=inaccurate'))
    const health_ = new URL(healthUrls().at(-1) ?? '', 'http://x').searchParams
    const digest = new URL(digestUrls().at(-1) ?? '', 'http://x').searchParams
    digest.delete('locale')
    expect(digest.toString()).toBe(health_.toString())
  })

  it('exports exactly what the page shows', async () => {
    stubFetch(health())
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(await screen.findByRole('button', { name: /^Inaccurate,/ }))
    await user.click(screen.getByRole('button', { name: 'Export…' }))
    const download = await screen.findByTestId('feedback-export-download')
    expect(download).toHaveAttribute(
      'href',
      '/api/platform/answer-feedback/export?from=2026-09-10&to=2026-10-09&reason=inaccurate&format=xlsx'
    )
  })

  it('links the Langfuse project only when the server knows it', async () => {
    stubFetch(health({ langfuse: { projectUrl: 'https://langfuse.example/project/p' } }))
    const { unmount } = render(<Harness />)
    const link = await screen.findByTestId('feedback-langfuse')
    expect(link).toHaveAttribute('href', 'https://langfuse.example/project/p')
    unmount()

    stubFetch(health())
    render(<Harness />)
    await screen.findByTestId('feedback-kpis')
    expect(screen.queryByTestId('feedback-langfuse')).toBeNull()
  })
})
