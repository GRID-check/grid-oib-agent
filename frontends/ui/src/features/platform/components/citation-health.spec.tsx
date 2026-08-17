import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { CitationHealth } from './citation-health'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}))

// The chart is exercised by its own preview/screenshot; here the behaviour
// under test is the load/window/error lifecycle and the copy.
vi.mock('@/components/charts/citation-defect-chart', () => ({
  CitationDefectChart: () => <div data-testid="citation-defect-chart" />,
}))

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
    {
      id: 'answers_ungrounded',
      severity: 'error',
      subject: { type: 'organization', label: 'Bauwerk' },
      metrics: { turns: 5, share: 2.5 },
    },
    { id: 'quotes_fabricated', severity: 'warn', subject: null, metrics: { turns: 4, quotes: 7, share: 2 } },
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
    { kind: 'citations_removed', reason: 'brand_new_reason', occurrences: 4, share: 0.06 },
  ],
  sourceMix: [{ dimension: 'tool', label: 'ris_search_tool', turns: 12 }],
  organizations: [
    { organizationId: 'org_1', name: 'Bauwerk', turns: 120, defectTurns: 18, errorTurns: 2, defectRate: 0.15 },
    { organizationId: null, name: null, turns: 80, defectTurns: 6, errorTurns: 0, defectRate: 0.075 },
  ],
  recent: [
    {
      id: 'evt-1',
      createdAt: '2026-07-28T13:41:00Z',
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

const okFetch = (body: unknown = snapshot) => vi.fn().mockResolvedValue({ ok: true, json: async () => body })

describe('CitationHealth', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  test('leads with the clean rate and the defect headline numbers', async () => {
    vi.stubGlobal('fetch', okFetch())

    render(<CitationHealth />)

    expect(await screen.findByText('88%')).toBeDefined()
    expect(screen.getByText('176 of 200 turns without a finding')).toBeDefined()
    // Also the badge on the recent finding below, hence getAllByText.
    expect(screen.getAllByText('Without source citation').length).toBeGreaterThan(0)
    expect(screen.getByText('61')).toBeDefined()
    expect(screen.getByText('7')).toBeDefined()
  })

  test('requests the 30-day window by default and switches on demand', async () => {
    const fetchSpy = okFetch()
    vi.stubGlobal('fetch', fetchSpy)

    render(<CitationHealth />)
    await screen.findByText('88%')
    expect(fetchSpy).toHaveBeenCalledWith('/api/platform/citation-health?days=30')

    await userEvent.click(screen.getByRole('radio', { name: 'Last 7 days' }))
    expect(fetchSpy).toHaveBeenLastCalledWith('/api/platform/citation-health?days=7')
  })

  test('translates known removal reasons and falls back to the raw key for new ones', async () => {
    vi.stubGlobal('fetch', okFetch())

    render(<CitationHealth />)

    expect(await screen.findByText('URL not among the retrieved sources')).toBeDefined()
    // A reason the backend added before the dictionary caught up must show the
    // bare key, never `platform.citations.reasons.brand_new_reason`.
    expect(screen.getByText('brand_new_reason')).toBeDefined()
  })

  test('names organizations and labels the unattributed bucket', async () => {
    vi.stubGlobal('fetch', okFetch())

    render(<CitationHealth />)

    expect(await screen.findByText('Bauwerk')).toBeDefined()
    expect(screen.getByText('Unattributed')).toBeDefined()
    expect(screen.getByText('15%')).toBeDefined()
  })

  test('lists recent findings with the profiler turn id', async () => {
    vi.stubGlobal('fetch', okFetch())

    render(<CitationHealth />)

    const recent = await screen.findByText(/turn-abc-123/)
    expect(recent).toBeDefined()
    expect(screen.getAllByText('Without source citation').length).toBeGreaterThan(1)
  })

  test('shows a reassuring empty state when no turns were observed', async () => {
    vi.stubGlobal('fetch', okFetch(emptySnapshot))

    render(<CitationHealth />)

    expect(await screen.findByText('No research turns recorded yet')).toBeDefined()
    expect(screen.queryByTestId('citation-defect-chart')).toBeNull()
  })

  test('shows a retryable inline error instead of a permanent skeleton on failure', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) })
      .mockResolvedValueOnce({ ok: true, json: async () => snapshot })
    vi.stubGlobal('fetch', fetchSpy)

    render(<CitationHealth />)

    const error = await screen.findByText('Could not load citation health.')
    expect(error).toBeDefined()

    await userEvent.click(screen.getByRole('button', { name: /Retry/i }))
    expect(await screen.findByText('88%')).toBeDefined()
  })

  test('renders the defect trend chart once data is present', async () => {
    vi.stubGlobal('fetch', okFetch())

    render(<CitationHealth />)

    const card = await screen.findByTestId('citation-health')
    expect(within(card).getByTestId('citation-defect-chart')).toBeDefined()
  })
})
