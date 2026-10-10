/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

vi.mock('@/lib/db/tenant-context', () => ({
  withPlatformAccess: vi.fn(async (_reason: string, fn: () => Promise<unknown>) => fn()),
}))

vi.mock('@/lib/authz/platform', () => ({
  requirePlatformPermission: vi.fn(),
  PlatformAccessDeniedError: class PlatformAccessDeniedError extends Error {},
}))

vi.mock('./export-repository', () => ({
  listFeedbackExportRows: vi.fn(async () => []),
  getFeedbackExportTotals: vi.fn(async () => ({ votes: 0, up: 0, down: 0, voters: 0, organizations: 0 })),
  countFeedbackVotes: vi.fn(async () => 0),
  getFeedbackFacets: vi.fn(async () => ({
    verdicts: { up: 0, down: 0 },
    reasons: [],
    topics: [],
    modes: [],
    confidences: [],
    withComment: 0,
    withExpectedAnswer: 0,
  })),
  getProjectNames: vi.fn(async () => new Map([['0b6f2a1e-5c3d-4e8f-9a7b-1c2d3e4f5a61', 'Stadthaus Lend']])),
}))

vi.mock('./repository', () => ({
  FEEDBACK_EXPORT_ROW_CAP: 2,
  WEEKLY_APPLIED_RATINGS_FILTERS: ['topics'],
  getFeedbackWeeklySummary: vi.fn(async () => ({ weeks: [], truncated: false, cap: 5000 })),
  weeklyWindowStart: vi.fn(() => '2026-08-31T00:00:00.000Z'),
}))

vi.mock('@/lib/organizations/display-names', () => ({
  getOrganizationDisplayNames: vi.fn(async () => new Map([['org_1', 'Planungsbüro Huber']])),
}))

vi.mock('@/lib/app-origin', () => ({ configuredAppOrigin: vi.fn(() => 'https://app.piloti.example') }))

vi.mock('@/lib/sharing/registry', () => ({
  describeResource: () => ({
    deepLink: (id: string, options?: { anchorId?: string; projectId?: string | null }) =>
      options?.projectId
        ? `/app/projects/${options.projectId}/chat?session=${id}#message-${options.anchorId}`
        : `/app/chat?session=${id}#message-${options?.anchorId}`,
  }),
}))

vi.mock('@/lib/langfuse/config', () => ({
  langfuseUiConfig: vi.fn(() => null),
  langfuseTraceUrl: vi.fn(() => null),
}))

import { PlatformAccessDeniedError, requirePlatformPermission } from '@/lib/authz/platform'
import { feedbackExportRecord } from '@/test-utils/feedback-export-fixtures'
import {
  countFeedbackVotes,
  getFeedbackExportTotals,
  getFeedbackFacets,
  listFeedbackExportRows,
  type FeedbackExportRow,
} from './export-repository'
import { getFeedbackWeeklySummary } from './repository'
import {
  feedbackExportFileName,
  feedbackWeeklyFileName,
  getAnswerFeedbackExport,
  getAnswerFeedbackFilterOptions,
  getAnswerFeedbackWeeklyExport,
  weeklyIgnoredFilters,
} from './export-service'
import { NO_RATINGS_FILTERS, type FeedbackQuery } from './filters'

/** A repository row: the record fixture without what the service adds. */
function row(overrides: Partial<FeedbackExportRow> = {}): FeedbackExportRow {
  const { organizationName: _name, appUrl: _url, langfuseTraceUrl: _trace, ...rest } = feedbackExportRecord({
    organizationId: 'org_1',
  })
  return { ...rest, ...overrides }
}

const NOW = new Date('2026-10-09T09:30:00.000Z')
const PROJECT = '0b6f2a1e-5c3d-4e8f-9a7b-1c2d3e4f5a61'
const ALL: FeedbackQuery = {
  scope: { from: '2026-09-10', to: '2026-10-09', organizationIds: [], projectIds: [] },
  ratings: NO_RATINGS_FILTERS,
}
/** What the page might be showing: one organization, a project and a few filters. */
const PAGE: FeedbackQuery = {
  scope: { from: '2026-10-03', to: '2026-10-09', organizationIds: ['org_1'], projectIds: [PROJECT] },
  ratings: { ...NO_RATINGS_FILTERS, verdict: 'down', reasons: ['inaccurate'], topics: ['brandschutz'], query: 'GK' },
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requirePlatformPermission).mockResolvedValue(undefined)
})

describe('getAnswerFeedbackExport', () => {
  it('refuses anyone who is not a platform owner, before it reads anything', async () => {
    vi.mocked(requirePlatformPermission).mockRejectedValueOnce(new PlatformAccessDeniedError())

    await expect(getAnswerFeedbackExport(null, { query: ALL, withSummary: true })).rejects.toBeInstanceOf(
      PlatformAccessDeniedError
    )
    expect(listFeedbackExportRows).not.toHaveBeenCalled()
    expect(getFeedbackWeeklySummary).not.toHaveBeenCalled()
  })

  /** The file is the set the page shows: one query for the rows, the totals and the weeks. */
  it('reads the rows, the totals and the weeks with the page’s query', async () => {
    const exported = await getAnswerFeedbackExport(null, { query: PAGE, withSummary: true }, NOW)

    expect(listFeedbackExportRows).toHaveBeenCalledWith(PAGE, 3)
    expect(getFeedbackExportTotals).toHaveBeenCalledWith(PAGE)
    expect(getFeedbackWeeklySummary).toHaveBeenCalledWith(PAGE)
    expect(exported.query).toBe(PAGE)
    expect(exported.named).toEqual({
      organizations: [{ id: 'org_1', name: 'Planungsbüro Huber' }],
      projects: [{ id: PROJECT, name: 'Stadthaus Lend' }],
    })
    // The weekly sheet can apply the topic, not the verdict, the reason or the search.
    expect(exported.weeksIgnored).toEqual(['verdict', 'reasons', 'query'])
  })

  it('reads one row past the cap, keeps the newest, and reports the cut', async () => {
    vi.mocked(listFeedbackExportRows).mockResolvedValueOnce([
      row({ feedbackId: 'a' }),
      row({ feedbackId: 'b' }),
      row({ feedbackId: 'c' }),
    ])
    const exported = await getAnswerFeedbackExport(null, { query: ALL, withSummary: false }, NOW)

    expect(exported.records.map((record) => record.feedbackId)).toEqual(['a', 'b'])
    expect(exported).toMatchObject({ truncated: true, cap: 2 })
  })

  it('does not report a cut when the window fit exactly', async () => {
    vi.mocked(listFeedbackExportRows).mockResolvedValueOnce([row({ feedbackId: 'a' }), row({ feedbackId: 'b' })])
    const exported = await getAnswerFeedbackExport(null, { query: ALL, withSummary: false }, NOW)
    expect(exported.truncated).toBe(false)
  })

  it('skips the totals and the weeks when only the rows are asked for', async () => {
    const exported = await getAnswerFeedbackExport(null, { query: ALL, withSummary: false }, NOW)

    expect(getFeedbackExportTotals).not.toHaveBeenCalled()
    expect(getFeedbackWeeklySummary).not.toHaveBeenCalled()
    expect(exported.totals).toBeNull()
  })

  it('names the organization and links the answer in its conversation, from the pinned origin', async () => {
    vi.mocked(listFeedbackExportRows)
      .mockResolvedValueOnce([
        row({ conversationId: 's_1', projectId: 'p_1', messageId: 'm_1' }),
        row({ conversationId: 's_2', projectId: null, messageId: 'm_2' }),
      ])
      .mockResolvedValueOnce([row({ conversationId: 's_gone', conversationFound: false })])
    const exported = await getAnswerFeedbackExport(null, { query: ALL, withSummary: false }, NOW)
    const deleted = await getAnswerFeedbackExport(null, { query: ALL, withSummary: false }, NOW)

    expect(exported.records[0].organizationName).toBe('Planungsbüro Huber')
    expect(exported.records.map((record) => record.appUrl)).toEqual([
      'https://app.piloti.example/app/projects/p_1/chat?session=s_1#message-m_1',
      'https://app.piloti.example/app/chat?session=s_2#message-m_2',
    ])
    // No conversation row: a link to a deleted chat is a 404 with extra steps.
    expect(deleted.records[0].appUrl).toBeNull()
  })
})

describe('getAnswerFeedbackFilterOptions', () => {
  it('is gated like the export', async () => {
    vi.mocked(requirePlatformPermission).mockRejectedValueOnce(new PlatformAccessDeniedError())
    await expect(getAnswerFeedbackFilterOptions(null, ALL)).rejects.toBeInstanceOf(PlatformAccessDeniedError)
    expect(countFeedbackVotes).not.toHaveBeenCalled()
  })

  it('counts up to the cap, says when it was passed, and totals the scope from the facets', async () => {
    vi.mocked(countFeedbackVotes).mockResolvedValueOnce(3)
    vi.mocked(getFeedbackFacets).mockResolvedValueOnce({
      verdicts: { up: 40, down: 2 },
      reasons: [],
      topics: [],
      modes: [],
      confidences: [],
      withComment: 1,
      withExpectedAnswer: 0,
    })
    const options = await getAnswerFeedbackFilterOptions(null, PAGE)

    expect(countFeedbackVotes).toHaveBeenCalledWith(PAGE, 2)
    expect(getFeedbackFacets).toHaveBeenCalledWith(PAGE)
    expect(options).toMatchObject({ total: 2, overCap: true, cap: 2, scopeTotal: 42, withComment: 1 })
  })
})

describe('feedbackExportFileName', () => {
  const base = { query: ALL, named: { organizations: [], projects: [] }, truncated: false, cap: 5000 }

  it('names the range, and a cut', () => {
    expect(feedbackExportFileName(base, 'xlsx')).toBe('piloti-bewertungen_2026-09-10_2026-10-09.xlsx')
    expect(feedbackExportFileName({ ...base, truncated: true }, 'csv')).toBe(
      'piloti-bewertungen_2026-09-10_2026-10-09_erste-5000.csv'
    )
  })

  it('names the organization when exactly one is chosen, spelled for a file system', () => {
    const one = {
      ...base,
      query: { ...ALL, scope: { ...ALL.scope, organizationIds: ['org_1'] } },
      named: { organizations: [{ id: 'org_1', name: 'Planungsbüro Huber & Söhne' }], projects: [] },
    }
    expect(feedbackExportFileName(one, 'xlsx')).toBe(
      'piloti-bewertungen_planungsbuero-huber-soehne_2026-09-10_2026-10-09.xlsx'
    )
  })

  it('says `_gefiltert` when the file holds less than its name promises', () => {
    const filtered = { ...base, query: { ...ALL, ratings: { ...NO_RATINGS_FILTERS, hasComment: true } } }
    const two = {
      ...base,
      query: { ...ALL, scope: { ...ALL.scope, organizationIds: ['org_1', 'org_2'] } },
      named: { organizations: [{ id: 'org_1', name: 'A' }, { id: 'org_2', name: 'B' }], projects: [] },
    }
    expect(feedbackExportFileName(filtered, 'xlsx')).toBe('piloti-bewertungen_2026-09-10_2026-10-09_gefiltert.xlsx')
    expect(feedbackExportFileName(two, 'csv')).toBe('piloti-bewertungen_2026-09-10_2026-10-09_gefiltert.csv')
  })
})

describe('getAnswerFeedbackWeeklyExport', () => {
  it('is gated, read with the query, names the tenants and says what it left out', async () => {
    vi.mocked(getFeedbackWeeklySummary).mockResolvedValueOnce({
      weeks: [{ organizationId: 'org_1', isoWeek: '2026-W41', weekStart: '2026-10-05', answers: 4, ratedAnswers: 2, up: 1, down: 1 }],
      truncated: true,
      cap: 5000,
    })
    const weekly = await getAnswerFeedbackWeeklyExport(null, PAGE)

    expect(requirePlatformPermission).toHaveBeenCalled()
    expect(getFeedbackWeeklySummary).toHaveBeenCalledWith(PAGE)
    expect(weekly.weeks[0].organizationName).toBe('Planungsbüro Huber')
    expect(weekly.truncated).toBe(true)
    expect(weekly.windowFrom.toISOString()).toBe('2026-08-31T00:00:00.000Z')
    expect(weekly.ignored).toEqual(['verdict', 'reasons', 'query'])
    expect(feedbackWeeklyFileName(weekly)).toBe(
      'piloti-bewertungen-wochen_planungsbuero-huber_2026-08-31_2026-10-09_erste-5000.csv'
    )
  })

  it('ignores nothing when only the scope and the topic are set', () => {
    expect(weeklyIgnoredFilters({ ...ALL, ratings: { ...NO_RATINGS_FILTERS, topics: ['statik'] } })).toEqual([])
  })
})
