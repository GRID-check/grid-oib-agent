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
import { getAnswerFeedbackHealth } from '@/lib/feedback/service'
import { parseFeedbackFilters } from '@/lib/feedback/query'

/** RFC 4180: quote every cell, double embedded quotes. Answers contain commas. */
function csvCell(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`
}

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
] as const

export const GET = apiRoute(
  async ({ request, session }) => {
    const filters = parseFeedbackFilters(new URL(request.url).searchParams)
    try {
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
        ]
          .map(csvCell)
          .join(',')
      )

      // A BOM so Excel opens UTF-8 correctly. These answers are German and full of
      // umlauts; a mojibake export is one nobody trusts a second time.
      const body = `﻿${COLUMNS.join(',')}\n${rows.join('\n')}\n`
      const stamp = new Date().toISOString().slice(0, 10)

      // The verdict is in the FILENAME as well as the column, because the two
      // exports are otherwise one download folder away from being the same file.
      const filename = `answer-feedback-${filters.verdict ?? 'down'}-${stamp}.csv`

      return new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        },
      })
    } catch (error) {
      if (error instanceof PlatformAccessDeniedError) throw new ForbiddenError()
      throw error
    }
  },
  { authz: { enforcedBy: 'getAnswerFeedbackHealth (requirePlatformOwner)' } }
)
