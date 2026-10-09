import { act, render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { QualityScope } from '@/lib/quality/scope'
import { AgentProfiler, barGeometry, formatSpanDuration } from './agent-profiler'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

const SEPTEMBER: QualityScope = {
  from: '2026-09-01',
  to: '2026-09-30',
  organizationIds: [],
  projectIds: [],
}
const SEPTEMBER_QUERY = 'from=2026-09-01&to=2026-09-30'
const OCTOBER: QualityScope = { ...SEPTEMBER, from: '2026-10-01', to: '2026-10-09' }

/** The list requests a fetch spy saw, as their query parameters. */
const listQueries = (spy: ReturnType<typeof vi.fn>): URLSearchParams[] =>
  spy.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.startsWith('/api/platform/profiler/conversations?'))
    .map((url) => new URLSearchParams(url.split('?')[1]))

const conversation = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  conversationId: id,
  organizationId: 'org_01HZ',
  organizationName: 'Bauwerk Consulting',
  title,
  turnCount: 2,
  totalDurationMs: 12_345,
  lastActiveAt: '2026-10-08T09:00:00Z',
  ...extra,
})

const span = (
  kind: string,
  name: string,
  start: number,
  duration: number,
  children: unknown[] = [],
  error: string | null = null
) => ({
  spanId: `${name}-${start}`,
  kind,
  name,
  startedAt: new Date(Date.UTC(2026, 9, 8, 9) + start).toISOString(),
  endedAt: new Date(Date.UTC(2026, 9, 8, 9) + start + duration).toISOString(),
  durationMs: duration,
  status: error ? 'error' : 'ok',
  errorMessage: error,
  children,
})

const timeline = (conversationId: string, label = 'answer') => ({
  conversationId,
  turns: [
    {
      turnId: 'turn-1',
      jobId: 'job_8f21c7a04e',
      startedAt: '2026-10-08T09:00:00Z',
      durationMs: 2_000,
      status: 'error',
      spanCount: 3,
      root: span('turn', 'piloti_turn', 0, 2_000, [
        span('node', label, 10, 1_500, [span('tool', 'web_search', 20, 900, [], 'HTTP 504')]),
      ]),
    },
    {
      turnId: 'turn-2',
      jobId: null,
      startedAt: '2026-10-08T09:01:00Z',
      durationMs: 800,
      status: 'ok',
      spanCount: 4,
      // The server's stand-in for a root span that never reached the ledger.
      root: {
        ...span('turn', 'turn', 60_000, 800, [span('node', 'retrieve', 60_000, 700)]),
        spanId: 'turn-2:root',
        metadata: { synthetic: true },
      },
    },
  ],
})

const json = (body: unknown) => ({ ok: true, json: async () => body })

function routedFetch(list: unknown[], options: { failList?: boolean } = {}) {
  return vi.fn(async (url: string) => {
    if (url.startsWith('/api/platform/profiler/conversations/')) {
      return json(timeline(decodeURIComponent(url.split('/').pop() ?? '')))
    }
    if (options.failList) return { ok: false, status: 500, json: async () => ({}) }
    return json({ conversations: list, capped: false })
  })
}

describe('formatSpanDuration', () => {
  test('formats for the locale instead of a fixed decimal point', () => {
    expect(formatSpanDuration(850, 'en')).toBe('850 ms')
    expect(formatSpanDuration(2_450, 'de')).toBe('2,45 Sek.')
    expect(formatSpanDuration(12_345, 'en')).toBe('12.3 sec')
  })
})

describe('barGeometry', () => {
  test('keeps a late, long span inside its track', () => {
    // Started at 95% of the turn and ran for half of it: the bar used to be
    // drawn from 95% with a 50% width, far past the row's right edge.
    const { left, width } = barGeometry(950, 500, 1_000)
    expect(left).toBe(95)
    expect(left + width).toBeLessThanOrEqual(100)
  })

  test('clamps a span that starts before the turn', () => {
    expect(barGeometry(-200, 100, 1_000).left).toBe(0)
  })
})

describe('AgentProfiler', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  test('lists conversations with the organization name and labelled counts', async () => {
    vi.stubGlobal('fetch', routedFetch([conversation('c-1', 'Brandabschnitte')]))

    render(<AgentProfiler scope={SEPTEMBER} />)

    expect(await screen.findByText('Brandabschnitte')).toBeDefined()
    expect(screen.getByText('Bauwerk Consulting · 2 turn(s) · 12.3 sec in total')).toBeDefined()
  })

  test('falls back to the organization id, then to a label, never a bare dash', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch([
        conversation('c-1', 'A', { organizationName: undefined }),
        conversation('c-2', 'B', { organizationName: null, organizationId: null }),
      ])
    )

    render(<AgentProfiler scope={SEPTEMBER} />)

    expect(await screen.findByText(/^org_01HZ · /)).toBeDefined()
    expect(screen.getByText(/^No organization · /)).toBeDefined()
  })

  test('draws the selected conversation as a labelled waterfall, failures marked in words', async () => {
    vi.stubGlobal('fetch', routedFetch([conversation('c-1', 'Brandabschnitte')]))

    render(<AgentProfiler scope={SEPTEMBER} />)
    await userEvent.click(await screen.findByRole('button', { name: /Brandabschnitte/ }))

    const card = screen.getByTestId('agent-profiler-timeline')
    expect(await within(card).findByText('web_search')).toBeDefined()
    const legend = within(card).getByRole('list', { name: 'Span types' })
    expect(within(legend).getByText('Model call')).toBeDefined()
    expect(within(legend).getByText('Tool call')).toBeDefined()
    expect(within(card).getByText('Failed: HTTP 504')).toBeDefined()
    expect(within(card).getByText('failed')).toBeDefined()
  })

  test('draws a turn whose root span was lost, and says its top bar is a stand-in', async () => {
    vi.stubGlobal('fetch', routedFetch([conversation('c-1', 'Brandabschnitte')]))

    render(<AgentProfiler scope={SEPTEMBER} initialConversationId="c-1" />)

    const card = screen.getByTestId('agent-profiler-timeline')
    expect(await within(card).findByText(/The start of this turn was not recorded/)).toBeDefined()
    expect(within(card).getByText('Turn (start not recorded)')).toBeDefined()
    expect(within(card).getByText('retrieve')).toBeDefined()
    expect(within(card).queryByText('No spans recorded for this turn.')).toBeNull()
  })

  test('numbers a capped timeline by the turns place in the conversation and says it is capped', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.startsWith('/api/platform/profiler/conversations/')
          ? json({ ...timeline('c-1'), totalTurns: 57, capped: true })
          : json({ conversations: [conversation('c-1', 'Brandabschnitte')], capped: false })
      )
    )

    render(<AgentProfiler scope={SEPTEMBER} initialConversationId="c-1" />)

    const card = screen.getByTestId('agent-profiler-timeline')
    expect(await within(card).findByText('Showing the newest 2 of 57 turns.')).toBeDefined()
    expect(within(card).getByText('Turn 56')).toBeDefined()
    expect(within(card).getByText('Turn 57')).toBeDefined()
  })

  test('preselects a conversation handed in by a link', async () => {
    const fetchSpy = routedFetch([conversation('c-1', 'A'), conversation('c-2', 'B')])
    vi.stubGlobal('fetch', fetchSpy)

    render(<AgentProfiler scope={SEPTEMBER} initialConversationId="c-2" />)

    await screen.findByRole('button', { name: /^B/ })
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/platform/profiler/conversations/c-2',
      expect.anything()
    )
    expect(screen.getByRole('button', { name: /^B/ }).getAttribute('aria-pressed')).toBe('true')
  })

  test('shows the timeline of the conversation clicked last, whatever order the responses land in', async () => {
    const pending = new Map<string, (value: unknown) => void>()
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (!url.startsWith('/api/platform/profiler/conversations/')) {
          return Promise.resolve(
            json({
              conversations: [conversation('c-1', 'First'), conversation('c-2', 'Second')],
              capped: false,
            })
          )
        }
        return new Promise((resolve) => pending.set(url.split('/').pop() ?? '', resolve))
      })
    )

    render(<AgentProfiler scope={SEPTEMBER} />)
    await userEvent.click(await screen.findByRole('button', { name: /First/ }))
    await userEvent.click(screen.getByRole('button', { name: /Second/ }))

    await act(async () => pending.get('c-2')?.(json(timeline('c-2', 'second_step'))))
    await act(async () => pending.get('c-1')?.(json(timeline('c-1', 'first_step'))))

    const card = screen.getByTestId('agent-profiler-timeline')
    expect(within(card).getByText('second_step')).toBeDefined()
    expect(within(card).queryByText('first_step')).toBeNull()
  })

  test('tells an empty search apart from an empty ledger', async () => {
    vi.stubGlobal('fetch', routedFetch([]))

    render(<AgentProfiler scope={SEPTEMBER} />)
    expect(await screen.findByText('No profiled conversations in this period.')).toBeDefined()

    await userEvent.type(screen.getByRole('textbox', { name: /Search by conversation/ }), 'xyz')
    expect(
      await screen.findByText('No conversation matches “xyz”.', {}, { timeout: 2000 })
    ).toBeDefined()
  })

  test('shows a destructive alert with a retry when the list fails, keeping the search usable', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce(
        json({ conversations: [conversation('c-1', 'Recovered')], capped: false })
      )
    vi.stubGlobal('fetch', fetchSpy)

    render(<AgentProfiler scope={SEPTEMBER} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Could not load the profiler data.')
    expect(screen.getByRole('textbox', { name: /Search by conversation/ })).toBeDefined()

    await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Recovered')).toBeDefined()
  })

  test('reads the list in the scope, says so, and searches within it', async () => {
    const fetchSpy = routedFetch([conversation('c-1', 'Brandabschnitte')])
    vi.stubGlobal('fetch', fetchSpy)

    render(<AgentProfiler scope={{ ...SEPTEMBER, organizationIds: ['org_1', 'org_2'] }} />)
    await screen.findByText('Brandabschnitte')
    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/platform/profiler/conversations?${SEPTEMBER_QUERY}&org=org_1&org=org_2`,
      expect.anything()
    )
    expect(
      screen.getByText(
        'Counts turns in Sep 1 – 30, 2026 · 2 organizations. Most recently active first.'
      )
    ).toBeDefined()

    await userEvent.type(screen.getByRole('textbox', { name: /Search by conversation/ }), 'Wien')
    await vi.waitFor(() => expect(listQueries(fetchSpy).at(-1)?.get('q')).toBe('Wien'))
    expect(listQueries(fetchSpy).at(-1)?.getAll('org')).toEqual(['org_1', 'org_2'])
  })

  test('refetches when the scope changes, and not for an equal scope object', async () => {
    const fetchSpy = routedFetch([conversation('c-1', 'Brandabschnitte')])
    vi.stubGlobal('fetch', fetchSpy)

    const { rerender } = render(<AgentProfiler scope={SEPTEMBER} />)
    await screen.findByText('Brandabschnitte')
    rerender(<AgentProfiler scope={{ ...SEPTEMBER }} />)
    expect(listQueries(fetchSpy)).toHaveLength(1)

    rerender(<AgentProfiler scope={OCTOBER} />)
    await vi.waitFor(() => expect(listQueries(fetchSpy)).toHaveLength(2))
    expect(listQueries(fetchSpy)[1].get('from')).toBe('2026-10-01')
  })

  test('keeps the list on screen, dimmed, while a new scope loads', async () => {
    const pending: ((value: unknown) => void)[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise((resolve) => pending.push(resolve)))
    )

    const { rerender } = render(<AgentProfiler scope={SEPTEMBER} />)
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    await act(async () =>
      pending[0](json({ conversations: [conversation('c-1', 'September')], capped: false }))
    )
    rerender(<AgentProfiler scope={OCTOBER} />)
    await vi.waitFor(() => expect(pending).toHaveLength(2))

    // No skeleton: the old list stays, dimmed, until the new one lands.
    expect(screen.getByText('September')).toBeDefined()
    expect(screen.getByText('September').closest('.opacity-60')).not.toBeNull()

    // A slow September answer cannot land over October's: the stale-response
    // guard keeps whichever was asked for last.
    await act(async () =>
      pending[1](json({ conversations: [conversation('c-2', 'October')], capped: false }))
    )
    expect(await screen.findByText('October')).toBeDefined()
    expect(screen.queryByText('September')).toBeNull()
  })

  test('drops a selection the new scope no longer contains, and says why', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.startsWith('/api/platform/profiler/conversations/')) return json(timeline('c-1'))
      const params = new URLSearchParams(url.split('?')[1])
      const september = params.get('from') === '2026-09-01'
      const row = conversation('c-1', 'Brandabschnitte')
      return json({
        conversations: september ? [row] : [],
        capped: false,
        ...(params.get('conversation') ? { selected: september ? row : null } : {}),
      })
    })
    vi.stubGlobal('fetch', fetchSpy)

    const { rerender } = render(<AgentProfiler scope={SEPTEMBER} />)
    await userEvent.click(await screen.findByRole('button', { name: /Brandabschnitte/ }))
    const card = screen.getByTestId('agent-profiler-timeline')
    expect(await within(card).findByText('web_search')).toBeDefined()

    rerender(<AgentProfiler scope={OCTOBER} />)
    expect(
      await within(card).findByText(
        'The conversation you had selected has no turns in this period.'
      )
    ).toBeDefined()
    // It asked about exactly that conversation, in the new scope.
    expect(listQueries(fetchSpy).at(-1)?.get('conversation')).toBe('c-1')
  })

  test('keeps a selection the new scope still contains, even below the list or outside the search', async () => {
    const outside = conversation('c-9', 'Weit unten')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('/api/platform/profiler/conversations/')) return json(timeline('c-9'))
        const params = new URLSearchParams(url.split('?')[1])
        return json({
          conversations: [conversation('c-1', 'Oben')],
          capped: true,
          ...(params.get('conversation') ? { selected: outside } : {}),
        })
      })
    )

    const { rerender } = render(<AgentProfiler scope={SEPTEMBER} initialConversationId="c-9" />)
    const card = screen.getByTestId('agent-profiler-timeline')
    expect(await within(card).findByText('web_search')).toBeDefined()
    rerender(<AgentProfiler scope={OCTOBER} />)

    // The header names it from the server's answer, though the list does not carry it.
    expect(await within(card).findByText('Weit unten')).toBeDefined()
    expect(within(card).getByText('web_search')).toBeDefined()
  })

  test('opens a linked conversation even when it is outside the scope the page opens with', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.startsWith('/api/platform/profiler/conversations/')
          ? json(timeline('c-old'))
          : json({ conversations: [], capped: false, selected: null })
      )
    )

    render(<AgentProfiler scope={SEPTEMBER} initialConversationId="c-old" />)
    const card = screen.getByTestId('agent-profiler-timeline')
    expect(await within(card).findByText('web_search')).toBeDefined()
  })
})
