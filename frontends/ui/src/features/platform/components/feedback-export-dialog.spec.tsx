import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@/test-utils'

import { NO_RATINGS_FILTERS, type FeedbackQuery } from '@/lib/feedback/filters'
import { FeedbackExportDialog, feedbackExportHref } from './feedback-export-dialog'

const QUERY: FeedbackQuery = {
  scope: { from: '2026-09-01', to: '2026-09-30', organizationIds: ['org_a'], projectIds: ['p1'] },
  ratings: { ...NO_RATINGS_FILTERS, verdict: 'down', reasons: ['inaccurate', 'wrong_source'], hasComment: true },
}
const ALL_VOTES: FeedbackQuery = { ...QUERY, ratings: NO_RATINGS_FILTERS }

const options = (total: number, overCap = false) => ({
  total,
  scopeTotal: 900,
  cap: 5000,
  overCap,
  verdicts: { up: 800, down: 100 },
  reasons: [],
  topics: [],
  modes: [],
  confidences: [],
  withComment: 0,
  withExpectedAnswer: 0,
})

/** Answers each options request by its query string; `total` per request, in order. */
const stubCounts = (...totals: { total: number; overCap?: boolean; delay?: number }[]) => {
  let call = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const next = totals[Math.min(call++, totals.length - 1)]
      if (next.delay) await new Promise((resolve) => setTimeout(resolve, next.delay))
      return new Response(JSON.stringify(options(next.total, next.overCap)), { status: 200 })
    })
  )
}
const optionUrls = () => vi.mocked(globalThis.fetch).mock.calls.map((call) => String(call[0]))

const open = async (query: FeedbackQuery = QUERY) => {
  const user = userEvent.setup()
  render(
    <FeedbackExportDialog
      query={query}
      organizationName={(id) => (id === 'org_a' ? 'Atelier Nord' : id)}
      projectName={(id) => (id === 'p1' ? 'Stadthaus Lend' : id)}
    />
  )
  await user.click(screen.getByRole('button', { name: 'Export…' }))
  return user
}

afterEach(() => vi.unstubAllGlobals())

describe('feedbackExportHref', () => {
  it('is the export route with the page’s query string and the format', () => {
    expect(feedbackExportHref(QUERY, 'xlsx')).toBe(
      '/api/platform/answer-feedback/export?from=2026-09-01&to=2026-09-30&org=org_a&project=p1' +
        '&verdict=down&reason=inaccurate&reason=wrong_source&has_comment=1&format=xlsx'
    )
    expect(feedbackExportHref(QUERY, 'csv', true)).toBe(
      '/api/platform/answer-feedback/export?from=2026-09-01&to=2026-09-30&org=org_a&project=p1&format=csv'
    )
  })
})

describe('FeedbackExportDialog', () => {
  it('says what the file holds in the page’s own words', async () => {
    stubCounts({ total: 142 })
    await open()
    const summary = screen.getByTestId('feedback-export-summary')

    expect(within(summary).getByText('Atelier Nord')).toBeInTheDocument()
    expect(within(summary).getByText('Stadthaus Lend')).toBeInTheDocument()
    expect(within(summary).getByText('Verdict: Not helpful')).toBeInTheDocument()
    expect(within(summary).getByText('Reason: Inaccurate or Wrong source')).toBeInTheDocument()
    expect(within(summary).getByText('With a comment')).toBeInTheDocument()
  })

  it('counts live, then links the download to exactly that query', async () => {
    stubCounts({ total: 142 })
    await open()

    expect(screen.getByTestId('feedback-export-count')).toHaveTextContent('Counting…')
    await waitFor(() => expect(screen.getByTestId('feedback-export-count')).toHaveTextContent('142 ratings will be exported'))
    expect(optionUrls()[0]).toBe(
      '/api/platform/answer-feedback/options?from=2026-09-01&to=2026-09-30&org=org_a&project=p1&verdict=down&reason=inaccurate&reason=wrong_source&has_comment=1'
    )
    expect(screen.getByTestId('feedback-export-download')).toHaveAttribute('href', feedbackExportHref(QUERY, 'xlsx'))
    expect(screen.getByTestId('feedback-export-download')).toHaveAttribute('download')
  })

  it('disables the download when nothing matches, and says how to fix it', async () => {
    stubCounts({ total: 0 })
    await open()

    await waitFor(() => expect(screen.getByTestId('feedback-export-count')).toHaveTextContent('No rating matches. Loosen the filters.'))
    const download = screen.getByTestId('feedback-export-download')
    expect(download.tagName).toBe('BUTTON')
    expect(download).toBeDisabled()
  })

  it('says which votes go when there are more than the cap', async () => {
    stubCounts({ total: 5000, overCap: true })
    await open()
    await waitFor(() =>
      expect(screen.getByTestId('feedback-export-count')).toHaveTextContent('More than 5,000. Only the newest 5,000 will be exported.')
    )
  })

  it('drops the rating filters on request, and recounts without them', async () => {
    stubCounts({ total: 12 }, { total: 900 })
    const user = await open()
    await waitFor(() => expect(screen.getByTestId('feedback-export-count')).toHaveTextContent('12 ratings'))

    await user.click(screen.getByRole('checkbox', { name: /All ratings in the date range/ }))
    await waitFor(() => expect(screen.getByTestId('feedback-export-count')).toHaveTextContent('900 ratings'))
    expect(optionUrls().at(-1)).toBe('/api/platform/answer-feedback/options?from=2026-09-01&to=2026-09-30&org=org_a&project=p1')
    expect(screen.getByTestId('feedback-export-download')).toHaveAttribute('href', feedbackExportHref(ALL_VOTES, 'xlsx'))
  })

  it('keeps the newest count when an older answer arrives late', async () => {
    // The first request (filters on) answers after the second (filters off).
    stubCounts({ total: 12, delay: 600 }, { total: 900 })
    const user = await open()
    await waitFor(() => expect(optionUrls()).toHaveLength(1))
    await user.click(screen.getByRole('checkbox', { name: /All ratings in the date range/ }))

    await waitFor(() => expect(screen.getByTestId('feedback-export-count')).toHaveTextContent('900 ratings'))
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(screen.getByTestId('feedback-export-count')).toHaveTextContent('900 ratings')
  })

  it('switches the link to CSV', async () => {
    stubCounts({ total: 3 })
    const user = await open()
    await user.click(screen.getByRole('radio', { name: 'CSV' }))
    expect(screen.getByTestId('feedback-export-download')).toHaveAttribute('href', feedbackExportHref(QUERY, 'csv'))
  })

  it('offers no "without filters" choice when there are none to drop', async () => {
    stubCounts({ total: 3 })
    await open(ALL_VOTES)
    expect(screen.queryByRole('checkbox', { name: /All ratings in the date range/ })).not.toBeInTheDocument()
    expect(within(screen.getByTestId('feedback-export-summary')).getByText('none')).toBeInTheDocument()
  })

  it('still offers the download when the count is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    await open()
    await waitFor(() => expect(screen.getByTestId('feedback-export-count')).toHaveTextContent('The count is unavailable'))
    expect(screen.getByTestId('feedback-export-download')).toHaveAttribute('href')
  })
})
