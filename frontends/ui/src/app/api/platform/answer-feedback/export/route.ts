/**
 * Answer-feedback export — the filtered drill-in as CSV, for the analysis that
 * does not fit on a page (pivoting by org, joining against a release date, handing
 * a quarter's worth to somebody without a login).
 *
 * Streams out with `Content-Disposition` rather than being assembled in the
 * browser, so the download costs the bundle nothing and is reachable as a plain
 * link — the same shape as the citation-health export beside it.
 *
 * It reads through `getAnswerFeedbackHealth` with the SAME parser as the page, so
 * it carries the same gate and the same filters. An export that quietly disagreed
 * with the view it was taken from would be worse than no export.
 */

import { NextResponse } from 'next/server'
import { ForbiddenError } from '@/lib/api/errors'
import { apiRoute } from '@/lib/api/handler'
import { PlatformAccessDeniedError } from '@/lib/authz/platform'
import { getAnswerFeedbackHealth, getAnswerFeedbackWeeklySummary } from '@/lib/feedback/service'
import { parseFeedbackFilters } from '@/lib/feedback/query'
// Quoted per RFC 4180 AND formula-neutralised: questions, comments and answers
// are user and model text, and a spreadsheet evaluates `=...` even inside quotes.
import { csvCell } from '@/lib/text/csv-cell'

const COLUMNS = [
  'created_at',
  'organization_id',
  'conversation_id',
  'message_id',
  // The export follows the drill-in in BOTH directions now, so the verdict has
  // to be a column: a praise export and a defect export are otherwise
  // indistinguishable once the file leaves the browser.
  'verdict',
  'reason',
  'topics',
  'question',
  'answer',
  // The voter's own words on a down-vote. The reason chip says which bucket;
  // this says what was actually wrong, and was stored but never exported.
  'comment',
  // What the voter says a good answer would have contained. The column name is
  // a contract: the answer-suite converter reads it by name.
  'expected_answer',
] as const

/** The weekly summary's columns: the numerator and denominator of a failure rate. */
const WEEKLY_COLUMNS = ['organization_id', 'iso_week', 'week_start', 'answers', 'up', 'down'] as const

function csvResponse(rows: string[], columns: readonly string[], filename: string): NextResponse {
  // A BOM so Excel opens UTF-8 correctly. These answers are German and full of
  // umlauts; a mojibake export is one nobody trusts a second time.
  const body = `\uFEFF${columns.join(',')}\n${rows.join('\n')}\n`
  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}

export const GET = apiRoute(
  async ({ request, session }) => {
    const searchParams = new URL(request.url).searchParams
    const filters = parseFeedbackFilters(searchParams)
    try {
      // `?summary=weekly`: the denominator. The drill-in lists votes only, so it
      // cannot say how often an answer fails; this is answers/up/down per
      // organization and ISO week, behind the same gate and `days`/`org` filters.
      if (searchParams.get('summary') === 'weekly') {
        const weeks = await getAnswerFeedbackWeeklySummary(session, filters)
        const stamp = new Date().toISOString().slice(0, 10)
        return csvResponse(
          weeks.map((w) =>
            [w.organizationId, w.isoWeek, w.weekStart, w.answers, w.up, w.down]
              .map(csvCell)
              .join(',')
          ),
          WEEKLY_COLUMNS,
          `answer-feedback-weekly-${stamp}.csv`
        )
      }
      const health = await getAnswerFeedbackHealth(session, filters)

      const rows = health.turns.map((turn) =>
        [
          turn.createdAt instanceof Date ? turn.createdAt.toISOString() : turn.createdAt,
          turn.organizationId,
          turn.conversationId,
          turn.messageId,
          turn.verdict,
          turn.reason,
          turn.topics.join(' '),
          turn.question,
          turn.answer,
          turn.comment,
          turn.expectedAnswer,
        ]
          .map(csvCell)
          .join(',')
      )

      const stamp = new Date().toISOString().slice(0, 10)

      // The verdict is in the FILENAME as well as the column, because the two
      // exports are otherwise one download folder away from being the same file.
      return csvResponse(
        rows,
        COLUMNS,
        `answer-feedback-${filters.verdict ?? 'down'}-${stamp}.csv`
      )
    } catch (error) {
      if (error instanceof PlatformAccessDeniedError) throw new ForbiddenError()
      throw error
    }
  },
  {
    authz: {
      enforcedBy: 'getAnswerFeedbackHealth (requirePlatformPermission platform:organizations:view)',
    },
  }
)
