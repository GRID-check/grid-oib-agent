/**
 * Answer-feedback export — the votes the ratings tab shows, as an Excel
 * workbook for a person or a CSV for a script.
 *
 *   scope    from, to (UTC days, inclusive; or days=7|30|90), org, project
 *            (both repeatable): the page-wide scope every quality view shares.
 *   filters  verdict, reason, topic, mode, confidence (repeatable where it
 *            makes sense), has_comment=1, has_expected=1, q: the ratings tab's
 *            filters. Read by the one strict parser the page's reads use
 *            (`lib/feedback/query.ts`), so the file is the set on screen; an
 *            unknown value is a 400.
 *   ?scope=all            every vote in the scope, ratings filters ignored.
 *                         (`scope=selection` is the old drill-in export and
 *                         still means "the filters, down-votes by default".)
 *   ?format=xlsx|csv      `csv` (default, what scripts have always fetched) or
 *                         `xlsx`, the four-sheet workbook the page links to.
 *   ?summary=weekly       instead: per organization and ISO week, as CSV. The
 *                         scope and the topic apply; the filters a rate cannot
 *                         honour are named in `X-Grid-Export-Ignored-Filters`.
 *
 * Streams out with `Content-Disposition` rather than being assembled in the
 * browser, so the download costs the bundle nothing and is reachable as a plain
 * link. A thin adapter: the gate and the reads are the service's
 * (`lib/feedback/export-service.ts`), the columns are `export-columns.ts`, and
 * the two renderers sit beside them. A cut export says so in a header for a
 * script (`X-Grid-Export-Truncated`) and in the file name for a person.
 */

import { NextResponse } from 'next/server'
import { ForbiddenError } from '@/lib/api/errors'
import { apiRoute } from '@/lib/api/handler'
import { PlatformAccessDeniedError } from '@/lib/authz/platform'
import { getLocale } from '@/i18n/server'
import { getDictionary } from '@/i18n/dictionaries'
import { requireFeedbackQuery } from '@/lib/feedback/query'
import { RATINGS_FILTER_PARAMS } from '@/lib/feedback/filters'
import { EXPORT_IGNORED_FILTERS_HEADER, EXPORT_TRUNCATED_HEADER } from '@/lib/feedback/types'
import {
  feedbackExportFileName,
  feedbackWeeklyFileName,
  getAnswerFeedbackExport,
  getAnswerFeedbackWeeklyExport,
} from '@/lib/feedback/export-service'
import { FEEDBACK_EXPORT_COLUMNS, FEEDBACK_WEEKLY_COLUMNS } from '@/lib/feedback/export-columns'
import { renderCsv } from '@/lib/feedback/export-csv'
import { renderFeedbackWorkbook } from '@/lib/feedback/export-workbook'

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

function download(
  body: string | Uint8Array,
  contentType: string,
  filename: string,
  extraHeaders: Record<string, string> = {}
): NextResponse {
  return new NextResponse(body as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  })
}

const truncatedHeader = (truncated: boolean, cap: number): Record<string, string> =>
  truncated ? { [EXPORT_TRUNCATED_HEADER]: String(cap) } : {}

export const GET = apiRoute(
  async ({ request, session }) => {
    const searchParams = new URL(request.url).searchParams
    const query = requireFeedbackQuery(searchParams)
    const dictionary = getDictionary(await getLocale())
    try {
      if (searchParams.get('summary') === 'weekly') {
        const weekly = await getAnswerFeedbackWeeklyExport(session, query)
        const ignored = weekly.ignored.map((key) => RATINGS_FILTER_PARAMS[key]).join(',')
        return download(
          renderCsv(FEEDBACK_WEEKLY_COLUMNS, weekly.weeks, dictionary),
          'text/csv; charset=utf-8',
          feedbackWeeklyFileName(weekly),
          {
            ...truncatedHeader(weekly.truncated, weekly.cap),
            ...(ignored ? { [EXPORT_IGNORED_FILTERS_HEADER]: ignored } : {}),
          }
        )
      }

      const format = searchParams.get('format') === 'xlsx' ? 'xlsx' : 'csv'
      const exported = await getAnswerFeedbackExport(session, { query, withSummary: format === 'xlsx' })
      const body =
        format === 'xlsx'
          ? await renderFeedbackWorkbook(exported, dictionary)
          : renderCsv(FEEDBACK_EXPORT_COLUMNS, exported.records, dictionary)
      return download(
        body,
        format === 'xlsx' ? XLSX_TYPE : 'text/csv; charset=utf-8',
        feedbackExportFileName(exported, format),
        truncatedHeader(exported.truncated, exported.cap)
      )
    } catch (error) {
      if (error instanceof PlatformAccessDeniedError) throw new ForbiddenError()
      throw error
    }
  },
  {
    authz: {
      enforcedBy:
        'getAnswerFeedbackExport / getAnswerFeedbackWeeklyExport (requirePlatformPermission platform:organizations:view)',
    },
  }
)
