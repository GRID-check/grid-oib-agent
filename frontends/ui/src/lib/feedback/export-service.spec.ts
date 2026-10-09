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
}))

vi.mock('./repository', () => ({
  FEEDBACK_EXPORT_ROW_CAP: 2,
  FEEDBACK_HEALTH_WINDOW_DAYS: 30,
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
import { getFeedbackExportTotals, listFeedbackExportRows, type FeedbackExportRow } from './export-repository'
import { getFeedbackWeeklySummary } from './repository'
import {
  exportFilters,
  feedbackExportFileName,
  getAnswerFeedbackExport,
  getAnswerFeedbackWeeklyExport,
} from './export-service'

/** A repository row: the record fixture without what the service adds. */
function row(overrides: Partial<FeedbackExportRow> = {}): FeedbackExportRow {
  const { organizationName: _name, appUrl: _url, langfuseTraceUrl: _trace, ...rest } = feedbackExportRecord({
    organizationId: 'org_1',
  })
  return { ...rest, ...overrides }
}

const NOW = new Date('2026-10-09T09:30:00.000Z')
const pageFilters = {
  windowDays: 7,
  verdict: 'down' as const,
  reason: 'inaccurate' as const,
  organizationId: 'org_1',
  topic: 'brandschutz' as const,
  query: 'GK',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(requirePlatformPermission).mockResolvedValue(undefined)
})

describe('getAnswerFeedbackExport', () => {
  it('refuses anyone who is not a platform owner, before it reads anything', async () => {
    vi.mocked(requirePlatformPermission).mockRejectedValueOnce(new PlatformAccessDeniedError())

    await expect(
      getAnswerFeedbackExport(null, { scope: 'all', filters: {}, withSummary: true })
    ).rejects.toBeInstanceOf(PlatformAccessDeniedError)
    expect(listFeedbackExportRows).not.toHaveBeenCalled()
    expect(getFeedbackWeeklySummary).not.toHaveBeenCalled()
  })

  it('exports every vote in the window by default, ignoring what the page was filtered to', async () => {
    await getAnswerFeedbackExport(null, { scope: 'all', filters: pageFilters, withSummary: true }, NOW)

    const all = { windowDays: 7, verdict: null, reason: null, organizationId: null, topic: null, query: null }
    expect(listFeedbackExportRows).toHaveBeenCalledWith(all, 3)
    expect(getFeedbackExportTotals).toHaveBeenCalledWith(all)
    expect(getFeedbackWeeklySummary).toHaveBeenCalledWith({ windowDays: 7, organizationId: null })
  })

  it('applies the page’s filters for a selection, totals and weeks included', async () => {
    await getAnswerFeedbackExport(null, { scope: 'selection', filters: pageFilters, withSummary: true }, NOW)

    expect(listFeedbackExportRows).toHaveBeenCalledWith(pageFilters, 3)
    expect(getFeedbackExportTotals).toHaveBeenCalledWith(pageFilters)
    expect(getFeedbackWeeklySummary).toHaveBeenCalledWith({ windowDays: 7, organizationId: 'org_1' })
  })

  it('drops a reason on a selection of helpful votes, as the page does', () => {
    expect(exportFilters('selection', { ...pageFilters, verdict: 'up' }).reason).toBeNull()
  })

  it('reads one row past the cap, keeps the newest, and reports the cut', async () => {
    vi.mocked(listFeedbackExportRows).mockResolvedValueOnce([
      row({ feedbackId: 'a' }),
      row({ feedbackId: 'b' }),
      row({ feedbackId: 'c' }),
    ])
    const exported = await getAnswerFeedbackExport(null, { scope: 'all', filters: {}, withSummary: false }, NOW)

    expect(exported.records.map((record) => record.feedbackId)).toEqual(['a', 'b'])
    expect(exported).toMatchObject({ truncated: true, cap: 2 })
  })

  it('does not report a cut when the window fit exactly', async () => {
    vi.mocked(listFeedbackExportRows).mockResolvedValueOnce([row({ feedbackId: 'a' }), row({ feedbackId: 'b' })])
    const exported = await getAnswerFeedbackExport(null, { scope: 'all', filters: {}, withSummary: false }, NOW)
    expect(exported.truncated).toBe(false)
  })

  it('skips the totals and the weeks when only the rows are asked for', async () => {
    const exported = await getAnswerFeedbackExport(null, { scope: 'all', filters: {}, withSummary: false }, NOW)

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
    const exported = await getAnswerFeedbackExport(null, { scope: 'all', filters: {}, withSummary: false }, NOW)
    const deleted = await getAnswerFeedbackExport(null, { scope: 'all', filters: {}, withSummary: false }, NOW)

    expect(exported.records[0].organizationName).toBe('Planungsbüro Huber')
    expect(exported.records.map((record) => record.appUrl)).toEqual([
      'https://app.piloti.example/app/projects/p_1/chat?session=s_1#message-m_1',
      'https://app.piloti.example/app/chat?session=s_2#message-m_2',
    ])
    // No conversation row: a link to a deleted chat is a 404 with extra steps.
    expect(deleted.records[0].appUrl).toBeNull()
  })

  it('starts the window at UTC midnight of its first day, like the page', async () => {
    const exported = await getAnswerFeedbackExport(null, { scope: 'all', filters: { windowDays: 30 }, withSummary: false }, NOW)
    expect(exported.windowFrom.toISOString()).toBe('2026-09-10T00:00:00.000Z')
    expect(exported.windowTo).toBe(NOW)
  })
})

describe('feedbackExportFileName', () => {
  const base = {
    windowFrom: new Date('2026-09-10T00:00:00.000Z'),
    windowTo: NOW,
    scope: 'all' as const,
    truncated: false,
    cap: 5000,
  }

  it('names the window, the scope and a cut', () => {
    expect(feedbackExportFileName(base, 'xlsx')).toBe('piloti-bewertungen_2026-09-10_2026-10-09.xlsx')
    expect(feedbackExportFileName({ ...base, scope: 'selection' }, 'csv')).toBe(
      'piloti-bewertungen_2026-09-10_2026-10-09_auswahl.csv'
    )
    expect(feedbackExportFileName({ ...base, truncated: true }, 'xlsx')).toBe(
      'piloti-bewertungen_2026-09-10_2026-10-09_erste-5000.xlsx'
    )
  })
})

describe('getAnswerFeedbackWeeklyExport', () => {
  it('is gated, scoped to the organization asked for, and names the tenants', async () => {
    vi.mocked(getFeedbackWeeklySummary).mockResolvedValueOnce({
      weeks: [{ organizationId: 'org_1', isoWeek: '2026-W41', weekStart: '2026-10-05', answers: 4, ratedAnswers: 2, up: 1, down: 1 }],
      truncated: true,
      cap: 5000,
    })
    const weekly = await getAnswerFeedbackWeeklyExport(null, { windowDays: 90, organizationId: 'org_1' }, NOW)

    expect(requirePlatformPermission).toHaveBeenCalled()
    expect(getFeedbackWeeklySummary).toHaveBeenCalledWith({ windowDays: 90, organizationId: 'org_1' })
    expect(weekly.weeks[0].organizationName).toBe('Planungsbüro Huber')
    expect(weekly.truncated).toBe(true)
    expect(weekly.windowFrom.toISOString()).toBe('2026-08-31T00:00:00.000Z')
  })
})
