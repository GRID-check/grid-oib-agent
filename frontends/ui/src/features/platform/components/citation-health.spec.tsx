import { act, render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { PlatformAccessProvider } from '@/features/platform/platform-access'
import { CitationHealth } from './citation-health'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

// The chart is exercised by its own spec and preview; here the behaviour under
// test is the load/window/error lifecycle and the copy.
vi.mock('@/components/charts/citation-defect-chart', () => ({
  CitationDefectChart: () => <div data-testid="citation-defect-chart" />,
}))

const finding = (
  id: string,
  severity: 'error' | 'warn' | 'info',
  metrics: Record<string, number> = { turns: 3, share: 0.02 }
) => ({
  id,
  severity,
  subject: null,
  metrics,
})

const snapshot = {
  windowDays: 30,
  totals: {
    turns: 200,
    defectTurns: 24,
    cleanTurns: 176,
    cleanRate: 0.88,
    citationsRemoved: 61,
    unverifiedQuotes: 7,
    ungroundedAnswers: 5,
    emptyRegistries: 1,
  },
  findings: [
    // Deliberately out of severity order: the card ranks them.
    finding('quotes_fabricated', 'warn', { turns: 4, quotes: 7, share: 0.02 }),
    {
      id: 'answers_ungrounded',
      severity: 'error',
      subject: { type: 'organization', label: 'Bauwerk' },
      metrics: { turns: 5, share: 0.025 },
    },
    finding('duplicates_only', 'info', { share: 0.55 }),
    finding('citation_format_unparsed', 'warn'),
  ],
  unavailableTools: [],
  missingSources: [
    {
      target: 'OIB-RL6-2023.pdf, p.12',
      kind: 'document',
      reason: 'citation_key_not_in_registry',
      turns: 9,
      organizations: 2,
      lastSeenAt: '2026-07-27T10:00:00Z',
      present: false,
      action: 'upload_to_base_knowledge',
      fileName: 'OIB-RL6-2023.pdf',
      documentNumber: null,
    },
    {
      target: 'https://ris.bka.gv.at/Dokument.wxe?Dokumentnummer=NOR40021234',
      kind: 'ris',
      reason: 'url_not_in_registry',
      turns: 4,
      organizations: 1,
      lastSeenAt: '2026-07-26T10:00:00Z',
      present: true,
      action: 'investigate_retrieval',
      fileName: null,
      documentNumber: 'NOR40021234',
    },
  ],
  byKind: [{ kind: 'citations_removed', turns: 18, items: 61, share: 0.09 }],
  dailyTrend: [{ day: '2026-07-28', turns: 20, defectTurns: 3, byKind: { citations_removed: 3 } }],
  reasons: [
    { kind: 'citations_removed', reason: 'url_not_in_registry', occurrences: 41, share: 0.67 },
    { kind: 'citations_removed', reason: 'digest_line_not_citable', occurrences: 6, share: 0.1 },
    { kind: 'citations_removed', reason: 'brand_new_reason', occurrences: 4, share: 0.06 },
  ],
  sourceMix: [{ dimension: 'tool', label: 'ris_search_tool', turns: 12 }],
  organizations: [
    {
      organizationId: 'org_1',
      name: 'Bauwerk',
      turns: 120,
      defectTurns: 18,
      errorTurns: 2,
      defectRate: 0.15,
    },
    {
      organizationId: 'org_2',
      name: 'Statik Nord',
      turns: 10,
      defectTurns: 3,
      errorTurns: 0,
      defectRate: 0.3,
    },
    {
      organizationId: null,
      name: null,
      turns: 80,
      defectTurns: 6,
      errorTurns: 0,
      defectRate: 0.075,
    },
  ],
  recent: [
    {
      id: 'evt-1',
      createdAt: '2026-07-28T23:41:00Z',
      kind: 'answer_ungrounded',
      severity: 'error',
      agent: 'shallow',
      count: 1,
      reasons: null,
      organizationId: 'org_1',
      conversationId: 'conv-1',
      turnId: 'turn-abc-123',
    },
  ],
}

const emptySnapshot = {
  ...snapshot,
  findings: [],
  totals: { ...snapshot.totals, turns: 0, defectTurns: 0, cleanTurns: 0, cleanRate: 1 },
}

const json = (body: unknown) => ({ ok: true, json: async () => body })
const okFetch = (body: unknown = snapshot) => vi.fn().mockResolvedValue(json(body))

/** A fetch whose responses resolve only when the test says so, in any order. */
function deferredFetch() {
  const pending: { url: string; resolve: (value: unknown) => void }[] = []
  const fn = vi.fn(
    (url: string) =>
      new Promise((resolve) => {
        pending.push({ url, resolve })
      })
  )
  return { fn, pending }
}

describe('CitationHealth', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  test('leads with the clean rate and the defect headline numbers', async () => {
    vi.stubGlobal('fetch', okFetch())

    render(<CitationHealth days={30} />)

    expect(await screen.findByText('88%')).toBeDefined()
    expect(screen.getByText('176 of 200 turns without a finding')).toBeDefined()
    expect(screen.getAllByText('Without source citation').length).toBeGreaterThan(0)
    expect(screen.getByText('61')).toBeDefined()
  })

  test('requests the window it is given and refetches when the page changes it', async () => {
    const fetchSpy = okFetch()
    vi.stubGlobal('fetch', fetchSpy)

    const { rerender } = render(<CitationHealth days={30} />)
    await screen.findByText('88%')
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/platform/citation-health?days=30',
      expect.anything()
    )

    rerender(<CitationHealth days={7} />)
    expect(fetchSpy).toHaveBeenLastCalledWith(
      '/api/platform/citation-health?days=7',
      expect.anything()
    )
    expect(screen.getByRole('link', { name: /Export diagnostics/ }).getAttribute('href')).toBe(
      '/api/platform/citation-health/export?days=7'
    )
  })

  test('keeps the loaded content on a refetch instead of collapsing it into skeletons', async () => {
    const { fn, pending } = deferredFetch()
    vi.stubGlobal('fetch', fn)

    render(<CitationHealth days={30} />)
    expect(screen.getByTestId('citation-health-loading')).toBeDefined()
    await act(async () => pending[0].resolve(json(snapshot)))
    expect(await screen.findByText('88%')).toBeDefined()

    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(screen.queryByTestId('citation-health-loading')).toBeNull()
    expect(screen.getByText('88%')).toBeDefined()
  })

  test('ignores a slow response for a window the user already left', async () => {
    const { fn, pending } = deferredFetch()
    vi.stubGlobal('fetch', fn)

    const { rerender } = render(<CitationHealth days={90} />)
    rerender(<CitationHealth days={7} />)
    expect(pending.map((request) => request.url)).toEqual([
      '/api/platform/citation-health?days=90',
      '/api/platform/citation-health?days=7',
    ])

    await act(async () =>
      pending[1].resolve(
        json({ ...snapshot, windowDays: 7, totals: { ...snapshot.totals, cleanRate: 0.5 } })
      )
    )
    expect(await screen.findByText('50%')).toBeDefined()
    // The 90-day answer lands last; it must not replace the 7-day one.
    await act(async () => pending[0].resolve(json(snapshot)))
    expect(screen.getByText('50%')).toBeDefined()
    expect(screen.queryByText('88%')).toBeNull()
  })

  test('says so when a window switch fails, instead of passing the old window off as the new one', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(json(snapshot))
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchSpy)

    const { rerender } = render(<CitationHealth days={30} />)
    await screen.findByText('88%')
    rerender(<CitationHealth days={7} />)

    expect(
      await screen.findByText('Could not load the last 7 days. Still showing the last 30 days.')
    ).toBeDefined()
    expect(screen.getByText('88%')).toBeDefined()
  })

  test('ranks findings by severity, shows three, and reveals the rest and the next step on demand', async () => {
    vi.stubGlobal('fetch', okFetch())

    render(<CitationHealth days={30} />)
    const card = await screen.findByTestId('citation-findings')
    const rows = within(card).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows[0].textContent).toContain('Answers are shipping without a source')
    expect(within(card).queryByText('Most removals are only duplicates')).toBeNull()
    // The remedy is behind the row, not stacked under every title.
    expect(within(card).queryByText(/Open the flagged turns below/)).toBeNull()

    await userEvent.click(
      within(card).getByRole('button', { name: /Answers are shipping without a source/ })
    )
    expect(within(card).getByText(/Open the flagged turns below/)).toBeDefined()

    await userEvent.click(within(card).getByRole('button', { name: 'Show 1 more' }))
    expect(within(card).getByText('Most removals are only duplicates')).toBeDefined()
  })

  test('renders all-clear as a success state', async () => {
    vi.stubGlobal(
      'fetch',
      okFetch({
        ...snapshot,
        findings: [finding('all_clear', 'info', { turns: 200, share: 0.88 })],
      })
    )

    render(<CitationHealth days={30} />)

    const card = await screen.findByTestId('citation-findings')
    expect(within(card).getByRole('status').textContent).toContain('Nothing needs your attention')
  })

  test('renders fractional shares as locale percentages and counts with grouping', async () => {
    // The server sends shares as fractions; the copy carries no "%" of its own.
    vi.stubGlobal(
      'fetch',
      okFetch({
        ...snapshot,
        findings: [
          {
            id: 'organization_outlier',
            severity: 'warn',
            subject: { type: 'organization', label: 'Bauwerk' },
            metrics: { share: 0.157, platformShare: 0.128, turns: 1234 },
          },
        ],
      })
    )

    render(<CitationHealth days={30} />)

    expect(
      await screen.findByText(
        'Bauwerk has a 15.7% finding rate against a platform average of 12.8% (1,234 flagged turns).'
      )
    ).toBeDefined()
  })

  test('says how many sources and organizations exist when the lists are cut short', async () => {
    vi.stubGlobal(
      'fetch',
      okFetch({ ...snapshot, missingSourcesTotal: 31, organizationsTotal: 70 })
    )

    render(<CitationHealth days={30} />)

    expect(
      await within(await screen.findByTestId('citation-missing-sources')).findByText(
        /Showing 2 of 31\./
      )
    ).toBeDefined()
    expect(
      within(screen.getByTestId('citation-organizations')).getByText('Showing 3 of 70.')
    ).toBeDefined()
  })

  test('translates known removal reasons and falls back to the raw key for new ones', async () => {
    vi.stubGlobal('fetch', okFetch())

    render(<CitationHealth days={30} />)

    expect(await screen.findByText('URL not among the retrieved sources')).toBeDefined()
    expect(screen.getByText('Summary line, not a citable source')).toBeDefined()
    expect(screen.getByText('brand_new_reason')).toBeDefined()
  })

  test('tabulates organizations with their urgent turns, sortable by rate', async () => {
    vi.stubGlobal('fetch', okFetch())

    render(<CitationHealth days={30} />)

    const card = await screen.findByTestId('citation-organizations')
    expect(within(card).getByText('Unattributed')).toBeDefined()
    expect(within(card).getByText('15%')).toBeDefined()
    expect(within(card).getByRole('columnheader', { name: /Urgent/ })).toBeDefined()

    const firstRow = () => within(card).getAllByRole('row')[1]
    expect(firstRow().textContent).toContain('Bauwerk')
    await userEvent.click(within(card).getByRole('button', { name: 'Sort by Rate' }))
    expect(firstRow().textContent).toContain('Statik Nord')
  })

  test('lists recent findings with a copyable turn id and a link into the timing view', async () => {
    vi.stubGlobal('fetch', okFetch())

    render(<CitationHealth days={30} />)

    const card = await screen.findByTestId('citation-recent')
    expect(within(card).getByRole('button', { name: 'Copy turn id turn-abc-123' })).toBeDefined()
    expect(
      within(card)
        .getByRole('link', { name: 'Open conversation in the timing view' })
        .getAttribute('href')
    ).toBe('/app/platform/quality?view=timing&conversation=conv-1')
    // The buckets are UTC days, so the exact moment is stated in UTC.
    const times = within(card).getAllByText((_, node) => node?.tagName === 'TIME')
    expect(times[0].getAttribute('title')).toBe('Jul 28, 2026, 11:41 PM UTC')
  })

  test('offers the add actions to a viewer who may manage settings', async () => {
    vi.stubGlobal('fetch', okFetch())

    render(<CitationHealth days={30} />)

    const card = await screen.findByTestId('citation-missing-sources')
    expect(
      within(card).getByRole('link', { name: 'Add to base knowledge' }).getAttribute('href')
    ).toBe('/app/platform/knowledge')
  })

  test('disables the add actions for read-only platform staff and says why', async () => {
    vi.stubGlobal('fetch', okFetch())

    render(
      <PlatformAccessProvider
        permissions={['platform:organizations:view', 'platform:settings:view']}
      >
        <CitationHealth days={30} />
      </PlatformAccessProvider>
    )

    const card = await screen.findByTestId('citation-missing-sources')
    expect(within(card).queryByRole('link', { name: 'Add to base knowledge' })).toBeNull()
    expect(
      (within(card).getByRole('button', { name: 'Add to base knowledge' }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
    expect(
      within(card).getByText('Adding sources needs permission to manage platform settings.')
    ).toBeDefined()
  })

  test('claims nothing about held sources when the inventory could not be checked', async () => {
    vi.stubGlobal(
      'fetch',
      okFetch({
        ...snapshot,
        inventoryKnown: false,
        missingSources: snapshot.missingSources.map((row) => ({
          ...row,
          present: null,
          action: 'inventory_unknown',
        })),
      })
    )

    render(<CitationHealth days={30} />)

    const card = await screen.findByTestId('citation-missing-sources')
    expect(within(card).getByText(/platform inventory could not be checked/)).toBeDefined()
    expect(within(card).queryByRole('link', { name: 'Add to base knowledge' })).toBeNull()
    expect(within(card).queryByText('Not held')).toBeNull()
    expect(within(card).getAllByText('Not checked').length).toBeGreaterThan(0)
  })

  test('shows an empty state when no turns were observed', async () => {
    vi.stubGlobal('fetch', okFetch(emptySnapshot))

    render(<CitationHealth days={30} />)

    expect(await screen.findByText('No research turns recorded yet')).toBeDefined()
    expect(screen.queryByTestId('citation-defect-chart')).toBeNull()
  })

  test('shows a destructive alert with a retry instead of a permanent skeleton on failure', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce(json(snapshot))
    vi.stubGlobal('fetch', fetchSpy)

    render(<CitationHealth days={30} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Could not load citation health.')

    await userEvent.click(within(alert).getByRole('button', { name: /Retry/i }))
    expect(await screen.findByText('88%')).toBeDefined()
  })

  test('renders the defect trend chart once data is present', async () => {
    vi.stubGlobal('fetch', okFetch())

    render(<CitationHealth days={30} />)

    const root = await screen.findByTestId('citation-health')
    expect(await within(root).findByTestId('citation-defect-chart')).toBeDefined()
  })
})
