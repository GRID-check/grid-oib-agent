/**
 * Platform → Answer quality → Bewertungen: the live numbers behind the ratings
 * filters and the export dialog.
 *
 * Takes exactly the parameters of the page and the export (the scope `from`,
 * `to`, `org`, `project`, and the ratings filters `verdict`, `reason`, `topic`,
 * `mode`, `confidence`, `has_comment`, `has_expected`, `q`), read by the same
 * strict parser, and answers:
 *
 *   { total, scopeTotal, cap, overCap,           how many votes the export would hold
 *     verdicts, reasons, topics, modes,          per-value counts over the scope,
 *     confidences, withComment, withExpectedAnswer }   for the pickers' "Name · 42"
 *
 * `total` is counted no further than the export's cap; `overCap` says it was
 * reached. Same gate as the export (`platform:organizations:view`, in the
 * service), and `no-store`, because it is a live count.
 */

import { NextResponse } from 'next/server'
import { ForbiddenError } from '@/lib/api/errors'
import { apiRoute } from '@/lib/api/handler'
import { PlatformAccessDeniedError } from '@/lib/authz/platform'
import { requireFeedbackQuery } from '@/lib/feedback/query'
import { getAnswerFeedbackFilterOptions } from '@/lib/feedback/export-service'

export const GET = apiRoute(
  async ({ request, session }) => {
    const query = requireFeedbackQuery(new URL(request.url).searchParams)
    try {
      const options = await getAnswerFeedbackFilterOptions(session, query)
      return NextResponse.json(options, { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
      if (error instanceof PlatformAccessDeniedError) throw new ForbiddenError()
      throw error
    }
  },
  {
    authz: {
      enforcedBy: 'getAnswerFeedbackFilterOptions (requirePlatformPermission platform:organizations:view)',
    },
  }
)
