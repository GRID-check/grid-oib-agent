/**
 * @vitest-environment node
 */
import { Workbook } from 'exceljs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { feedbackExport, feedbackWeeklyRecord } from '@/test-utils/feedback-export-fixtures'
import type { FeedbackQuery } from '@/lib/feedback/filters'

const isOwner = { value: false }
const locale = { value: 'de' as 'de' | 'en' }

vi.mock('server-only', () => ({}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    email: 'owner@grid.com',
    role: 'admin',
  }),
}))

vi.mock('@/i18n/server', () => ({ getLocale: vi.fn(async () => locale.value) }))

vi.mock('@/lib/authz/platform', () => {
  class PlatformAccessDeniedError extends Error {}
  return {
    PlatformAccessDeniedError,
    requirePlatformPermission: vi.fn().mockImplementation(async () => {
      if (!isOwner.value) throw new PlatformAccessDeniedError()
    }),
  }
})

// The reads are mocked; the file names, the columns and both renderers are real,
// so these specs see the bytes a person downloads.
vi.mock('@/lib/feedback/export-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/feedback/export-service')>()
  const gate = async (session: unknown) => {
    const { requirePlatformPermission } = await import('@/lib/authz/platform')
    await requirePlatformPermission(session as never, 'platform:organizations:view')
  }
  return {
    ...actual,
    getAnswerFeedbackExport: vi.fn().mockImplementation(async (session: unknown, request: { query: FeedbackQuery }) => {
      await gate(session)
      return feedbackExport({
        query: request.query,
        named: {
          organizations: request.query.scope.organizationIds.map((id) => ({ id, name: id === 'org_2' ? 'Ziviltechniker Gruber' : null })),
          projects: [],
        },
      })
    }),
    getAnswerFeedbackWeeklyExport: vi.fn().mockImplementation(async (session: unknown, query: FeedbackQuery) => {
      await gate(session)
      return {
        windowFrom: new Date('2026-08-31T00:00:00.000Z'),
        query,
        named: { organizations: [], projects: [] },
        weeks: [feedbackWeeklyRecord()],
        truncated: false,
        cap: 5000,
        ignored: actual.weeklyIgnoredFilters(query),
      }
    }),
  }
})

import { GET } from './route'
import { getAnswerFeedbackExport, getAnswerFeedbackWeeklyExport } from '@/lib/feedback/export-service'

const request = (query = ''): Request => new Request(`http://localhost/api/platform/answer-feedback/export${query}`)

/** `.text()` strips a leading BOM per the fetch spec; the bytes keep it. */
const bytesOf = async (res: Response): Promise<Uint8Array> => new Uint8Array(await res.arrayBuffer())

describe('GET /api/platform/answer-feedback/export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isOwner.value = false
    locale.value = 'de'
  })

  it('refuses a non-owner with 403, in every format', async () => {
    for (const query of ['', '?format=xlsx', '?scope=selection', '?summary=weekly']) {
      expect((await GET(request(query))).status, query).toBe(403)
    }
  })

  /** The file is what the page shows: the page's scope and its ratings filters, by the page's parameters. */
  it('exports the scope and the ratings filters it is given, named for the one organization', async () => {
    isOwner.value = true
    const res = await GET(
      request('?from=2026-10-01&to=2026-10-07&org=org_2&verdict=down&reason=inaccurate&topic=brandschutz&mode=deep&has_comment=1&q=GK&format=xlsx')
    )

    expect(getAnswerFeedbackExport).toHaveBeenCalledWith(expect.anything(), {
      query: {
        scope: { from: '2026-10-01', to: '2026-10-07', organizationIds: ['org_2'], projectIds: [] },
        ratings: expect.objectContaining({
          verdict: 'down',
          reasons: ['inaccurate'],
          topics: ['brandschutz'],
          modes: ['deep'],
          hasComment: true,
          query: 'GK',
        }),
      },
      withSummary: true,
    })
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="piloti-bewertungen_ziviltechniker-gruber_2026-10-01_2026-10-07_gefiltert.xlsx"'
    )
  })

  it('refuses an unknown filter value with 400, before reading anything', async () => {
    isOwner.value = true
    for (const query of ['?reason=nope', '?from=2026-10-09&to=2026-10-01', '?project=1', '?verdict=up&reason=other']) {
      expect((await GET(request(query))).status, query).toBe(400)
    }
    expect(getAnswerFeedbackExport).not.toHaveBeenCalled()
  })

  /** Older links: `scope=all` is every vote in the scope; `scope=selection` the old drill-in. */
  it('keeps the old `scope` links working', async () => {
    isOwner.value = true
    await GET(request('?scope=all&days=7&verdict=down&reason=inaccurate&org=org_2'))
    await GET(request('?scope=selection&days=7&topic=brandschutz'))

    const [all, selection] = vi.mocked(getAnswerFeedbackExport).mock.calls.map((call) => call[1].query)
    expect(all.scope.organizationIds).toEqual(['org_2'])
    expect(all.ratings).toMatchObject({ verdict: null, reasons: [] })
    expect(selection.ratings).toMatchObject({ verdict: 'down', topics: ['brandschutz'] })
  })

  it('names an unfiltered file by its range alone', async () => {
    isOwner.value = true
    const res = await GET(request('?from=2026-09-10&to=2026-10-09'))
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="piloti-bewertungen_2026-09-10_2026-10-09.csv"'
    )
    const text = new TextDecoder().decode(await bytesOf(res))
    expect(text).toContain('"down"')
    expect(text).toContain('"up"')
  })

  describe('?format=csv (the default)', () => {
    it('is UTF-8 with a BOM, headed by the stable keys, and skips the workbook’s other reads', async () => {
      isOwner.value = true
      const res = await GET(request())
      const bytes = await bytesOf(res)
      // TextDecoder drops the BOM it was just shown to carry.
      const header = new TextDecoder().decode(bytes).split('\r\n')[0]

      expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
      expect(header.startsWith('feedback_id,voted_at,first_voted_at,')).toBe(true)
      expect(header.split(',')).toEqual(expect.arrayContaining(['verdict', 'question', 'expected_answer', 'reason']))
      expect(getAnswerFeedbackExport).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ withSummary: false })
      )
    })
  })

  describe('?format=xlsx', () => {
    it('is a workbook with the four sheets, in the requester’s language', async () => {
      isOwner.value = true
      const res = await GET(request('?format=xlsx'))
      const workbook = new Workbook()
      await workbook.xlsx.load(Buffer.from(await bytesOf(res)) as unknown as ArrayBuffer)

      expect(res.headers.get('Content-Type')).toBe(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      expect(res.headers.get('Content-Disposition')).toBe(
        'attachment; filename="piloti-bewertungen_2026-09-10_2026-10-09.xlsx"'
      )
      expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Bewertungen', 'Wochen', 'Übersicht', 'Spalten'])
      expect(getAnswerFeedbackExport).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ withSummary: true })
      )
    })

    it('labels the sheets in English for an English reader', async () => {
      isOwner.value = true
      locale.value = 'en'
      const workbook = new Workbook()
      await workbook.xlsx.load(Buffer.from(await bytesOf(await GET(request('?format=xlsx')))) as unknown as ArrayBuffer)

      expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Votes', 'Weeks', 'Overview', 'Columns'])
    })
  })

  /** The page shows 50; the export used to stop there too, and said nothing. */
  it('says so, in a header and the file name, when the export hit its row cap', async () => {
    isOwner.value = true
    vi.mocked(getAnswerFeedbackExport).mockResolvedValueOnce(feedbackExport({ truncated: true }))
    const res = await GET(request('?format=xlsx'))

    expect(res.headers.get('X-Grid-Export-Truncated')).toBe('5000')
    expect(res.headers.get('Content-Disposition')).toMatch(/_erste-5000\.xlsx"$/)
  })

  it('sends no truncation header when the window fit', async () => {
    isOwner.value = true
    const res = await GET(request())

    expect(res.headers.get('X-Grid-Export-Truncated')).toBeNull()
    expect(res.headers.get('Content-Disposition')).not.toContain('erste-')
  })

  describe('?summary=weekly', () => {
    it('answers with per-org, per-week counts, the denominator and the rates, and passes the filters', async () => {
      isOwner.value = true
      const res = await GET(request('?summary=weekly&from=2026-09-01&to=2026-10-09&org=org_2&topic=statik'))
      const text = new TextDecoder().decode(await bytesOf(res))
      const [header, row] = text.split('\r\n')

      expect(res.headers.get('Content-Disposition')).toBe(
        'attachment; filename="piloti-bewertungen-wochen_2026-08-31_2026-10-09.csv"'
      )
      expect(header).toBe(
        'organization_name,organization_id,iso_week,week_start,answers,rated_answers,up,down,helpful_rate,coverage'
      )
      expect(row).toBe(
        '"Planungsbüro Huber","org_01HZXPLANUNGSBUERO","2026-W41","2026-10-05","40","8","6","3","0.6667","0.2"'
      )
      expect(getAnswerFeedbackWeeklyExport).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          scope: expect.objectContaining({ from: '2026-09-01', organizationIds: ['org_2'] }),
          ratings: expect.objectContaining({ topics: ['statik'] }),
        })
      )
      expect(res.headers.get('X-Grid-Export-Ignored-Filters')).toBeNull()
      expect(getAnswerFeedbackExport).not.toHaveBeenCalled()
    })

    it('says so when the cap cut the oldest weeks', async () => {
      isOwner.value = true
      vi.mocked(getAnswerFeedbackWeeklyExport).mockResolvedValueOnce({
        windowFrom: new Date('2026-08-31T00:00:00.000Z'),
        query: {
          scope: { from: '2026-09-01', to: '2026-10-09', organizationIds: [], projectIds: [] },
          ratings: { verdict: null, reasons: [], topics: [], modes: [], confidences: [], hasComment: false, hasExpectedAnswer: false, query: null },
        },
        named: { organizations: [], projects: [] },
        weeks: [],
        truncated: true,
        cap: 5000,
        ignored: [],
      })
      const res = await GET(request('?summary=weekly'))

      expect(res.headers.get('X-Grid-Export-Truncated')).toBe('5000')
      expect(res.headers.get('Content-Disposition')).toMatch(/_erste-5000\.csv"$/)
    })

    /** A rate cannot honour a verdict or a reason; the script that asked is told which it lost. */
    it('names the filters a rate cannot honour in a header', async () => {
      isOwner.value = true
      const res = await GET(request('?summary=weekly&verdict=down&reason=inaccurate&topic=statik'))
      expect(res.headers.get('X-Grid-Export-Ignored-Filters')).toBe('verdict,reason')
    })
  })
})
