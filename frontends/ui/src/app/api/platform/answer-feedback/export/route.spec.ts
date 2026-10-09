/**
 * @vitest-environment node
 */
import { Workbook } from 'exceljs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { feedbackExport, feedbackWeeklyRecord } from '@/test-utils/feedback-export-fixtures'

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
    getAnswerFeedbackExport: vi.fn().mockImplementation(async (session: unknown, request: { scope: 'all' | 'selection' }) => {
      await gate(session)
      return feedbackExport({ scope: request.scope })
    }),
    getAnswerFeedbackWeeklyExport: vi.fn().mockImplementation(async (session: unknown) => {
      await gate(session)
      return {
        windowFrom: new Date('2026-08-31T00:00:00.000Z'),
        windowTo: new Date('2026-10-09T09:30:00.000Z'),
        weeks: [feedbackWeeklyRecord()],
        truncated: false,
        cap: 5000,
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

  /**
   * The export used to follow the drill-in, which defaults to the failures, and
   * named the file `answer-feedback-down-…`: "give me the feedback" got half of it.
   */
  it('exports every vote in the window by default, whatever the page was filtered to', async () => {
    isOwner.value = true
    const res = await GET(request('?days=7&verdict=down&reason=inaccurate&org=org_2&topic=brandschutz&q=GK'))

    expect(getAnswerFeedbackExport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: 'all', filters: expect.objectContaining({ windowDays: 7 }) })
    )
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="piloti-bewertungen_2026-09-10_2026-10-09.csv"'
    )
    const text = new TextDecoder().decode(await bytesOf(res))
    expect(text).toContain('"down"')
    expect(text).toContain('"up"')
  })

  it('applies the page’s filters only for an explicit selection, and says so in the name', async () => {
    isOwner.value = true
    const res = await GET(request('?scope=selection&days=7&verdict=up&topic=brandschutz&org=org_2&q=GK'))

    expect(getAnswerFeedbackExport).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: 'selection',
        filters: expect.objectContaining({ windowDays: 7, verdict: 'up', topic: 'brandschutz', organizationId: 'org_2', query: 'GK' }),
      })
    )
    expect(res.headers.get('Content-Disposition')).toContain('_auswahl.csv"')
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
      const res = await GET(request('?summary=weekly&days=90&org=org_2'))
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
        expect.objectContaining({ windowDays: 90, organizationId: 'org_2' })
      )
      expect(getAnswerFeedbackExport).not.toHaveBeenCalled()
    })

    it('says so when the cap cut the oldest weeks', async () => {
      isOwner.value = true
      vi.mocked(getAnswerFeedbackWeeklyExport).mockResolvedValueOnce({
        windowFrom: new Date('2026-08-31T00:00:00.000Z'),
        windowTo: new Date('2026-10-09T00:00:00.000Z'),
        weeks: [],
        truncated: true,
        cap: 5000,
      })
      const res = await GET(request('?summary=weekly'))

      expect(res.headers.get('X-Grid-Export-Truncated')).toBe('5000')
      expect(res.headers.get('Content-Disposition')).toMatch(/_erste-5000\.csv"$/)
    })
  })
})
