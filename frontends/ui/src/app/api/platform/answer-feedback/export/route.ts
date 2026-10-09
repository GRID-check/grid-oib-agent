/**
 * Answer-feedback export — every vote in the window, as an Excel workbook for a
 * person or a CSV for a script.
 *
 *   ?days=7|30|90          the window (UTC calendar days, as on the page)
 *   ?scope=all|selection   `all` (default): every vote in the window, both
 *                          directions. `selection`: the page's own filters —
 *                          `org`, `topic`, `verdict`, `reason`, `q` — read with
 *                          the page's parser, so the file matches the screen.
 *   ?format=xlsx|csv       `csv` (default, what scripts have always fetched) or
 *                          `xlsx`, the four-sheet workbook the page links to.
 *   ?summary=weekly        instead: per organization and ISO week, as CSV.
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
import { parseFeedbackFilters } from '@/lib/feedback/query'
import { EXPORT_TRUNCATED_HEADER } from '@/lib/feedback/types'
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
  truncatedAt: number | null
): NextResponse {
  return new NextResponse(body as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
      ...(truncatedAt === null ? {} : { [EXPORT_TRUNCATED_HEADER]: String(truncatedAt) }),
    },
  })
}

export const GET = apiRoute(
  async ({ request, session }) => {
    const searchParams = new URL(request.url).searchParams
    const filters = parseFeedbackFilters(searchParams)
    const dictionary = getDictionary(await getLocale())
    try {
      if (searchParams.get('summary') === 'weekly') {
        const weekly = await getAnswerFeedbackWeeklyExport(session, filters)
        return download(
          renderCsv(FEEDBACK_WEEKLY_COLUMNS, weekly.weeks, dictionary),
          'text/csv; charset=utf-8',
          feedbackWeeklyFileName(weekly),
          weekly.truncated ? weekly.cap : null
        )
      }

      const format = searchParams.get('format') === 'xlsx' ? 'xlsx' : 'csv'
      const scope = searchParams.get('scope') === 'selection' ? 'selection' : 'all'
      const exported = await getAnswerFeedbackExport(session, {
        scope,
        filters,
        withSummary: format === 'xlsx',
      })
      const body =
        format === 'xlsx'
          ? await renderFeedbackWorkbook(exported, dictionary)
          : renderCsv(FEEDBACK_EXPORT_COLUMNS, exported.records, dictionary)
      return download(
        body,
        format === 'xlsx' ? XLSX_TYPE : 'text/csv; charset=utf-8',
        feedbackExportFileName(exported, format),
        exported.truncated ? exported.cap : null
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
