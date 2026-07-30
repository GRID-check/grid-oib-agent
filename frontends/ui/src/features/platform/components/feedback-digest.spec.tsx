import { afterEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor, within } from '@/test-utils'

import { FeedbackDigest } from './feedback-digest'

const digest = (overrides: Record<string, unknown> = {}) => ({
  digest: {
    headline: 'Most answers landed this month.',
    strengths: ['Energy questions are answered well.'],
    concerns: ['Escape-route answers are cited wrongly.'],
    recommendation: 'Review the fire-safety citations.',
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    votes: 147,
    ...overrides,
  },
  error: null,
})

const stubFetch = (body: unknown, ok = true): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })),
  )
}

const lastUrl = (): string => String(vi.mocked(globalThis.fetch).mock.calls.at(-1)?.[0] ?? '')

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FeedbackDigest', () => {
  it('renders what is working and what needs attention as peers', async () => {
    stubFetch(digest())
    render(<FeedbackDigest search="days=30" />)

    const strengths = await screen.findByTestId('feedback-digest-strengths')
    const concerns = screen.getByTestId('feedback-digest-concerns')
    expect(within(strengths).getByText('Energy questions are answered well.')).toBeInTheDocument()
    expect(within(concerns).getByText('Escape-route answers are cited wrongly.')).toBeInTheDocument()
  })

  /**
   * The good column is never dropped when it is empty. A layout that collapses to
   * one column the moment there is nothing positive to say quietly re-privileges
   * the bad half — which is the exact failure this whole card was built to fix.
   */
  it('keeps the "what is working" column even when the model found nothing', async () => {
    stubFetch(digest({ strengths: [] }))
    render(<FeedbackDigest search="days=30" />)

    const strengths = await screen.findByTestId('feedback-digest-strengths')
    expect(within(strengths).getByText(/Nothing in this window stands out as working well/)).toBeInTheDocument()
  })

  /**
   * These sentences are a model's reading of self-selected votes and they are the
   * most quotable thing on the page. The caveat travels with the quote.
   */
  it('says how it was written, when, and on what', async () => {
    stubFetch(digest())
    render(<FeedbackDigest search="days=30" />)

    expect(await screen.findByTestId('feedback-digest-age')).toHaveTextContent(/Written by AI/)
    expect(screen.getByText(/147 voluntary ratings over 30 days/)).toBeInTheDocument()
    expect(screen.getByText(/describes the people who rated/)).toBeInTheDocument()
  })

  it('re-asks the server when refreshed, bypassing the cached text', async () => {
    stubFetch(digest())
    const user = userEvent.setup()
    render(<FeedbackDigest search="days=30" />)

    await screen.findByTestId('feedback-digest')
    expect(lastUrl()).not.toContain('refresh=1')

    await user.click(screen.getByRole('button', { name: 'Write a new summary' }))
    await waitFor(() => expect(lastUrl()).toContain('refresh=1'))
  })

  it('asks for the digest in the reader\'s language', async () => {
    stubFetch(digest())
    render(<FeedbackDigest search="days=30" />)

    await waitFor(() => expect(lastUrl()).toContain('locale=en'))
  })

  /**
   * Filters change faster than a model answers. Without a guard, the slower of
   * two in-flight digests wins simply by finishing last, and the card ends up
   * describing a window nobody is looking at any more.
   */
  it('ignores a stale response that a newer request has already replaced', async () => {
    const answer: Array<(body: unknown) => void> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer.push((body) => resolve(new Response(JSON.stringify(body), { status: 200 })))
          }),
      ),
    )

    const { rerender } = render(<FeedbackDigest search="days=30" />)
    await waitFor(() => expect(answer).toHaveLength(1))

    rerender(<FeedbackDigest search="days=7" />)
    await waitFor(() => expect(answer).toHaveLength(2))

    // The newer request answers first; the abandoned one lands afterwards.
    answer[1](digest({ headline: 'The last seven days went well.' }))
    expect(await screen.findByText('The last seven days went well.')).toBeInTheDocument()

    answer[0](digest({ headline: 'The last thirty days went well.' }))
    await waitFor(() =>
      expect(screen.getByText('The last seven days went well.')).toBeInTheDocument(),
    )
    expect(screen.queryByText('The last thirty days went well.')).not.toBeInTheDocument()
  })
})

/**
 * "No summary" has three causes and they mean different things to the reader:
 * come back tomorrow, come back when there is more data, or go look at the logs.
 * One shared message would flatten all three into "something is broken".
 */
describe('FeedbackDigest — when there are no sentences', () => {
  it('says a young window is young, not broken', async () => {
    stubFetch({ digest: null, error: 'too_few_votes' })
    render(<FeedbackDigest search="days=30" />)

    const empty = await screen.findByTestId('feedback-digest-empty')
    expect(empty).toHaveTextContent(/Too few ratings/)
  })

  it('distinguishes an empty window from a thin one', async () => {
    stubFetch({ digest: null, error: 'no_feedback' })
    render(<FeedbackDigest search="days=30" />)

    expect(await screen.findByTestId('feedback-digest-empty')).toHaveTextContent(
      /nothing to summarise yet/,
    )
  })

  it('says the failure is the summary\'s alone, so the figures are still trusted', async () => {
    stubFetch({ error: 'boom' }, false)
    render(<FeedbackDigest search="days=30" />)

    expect(await screen.findByTestId('feedback-digest-empty')).toHaveTextContent(
      /figures below are unaffected/,
    )
  })
})
