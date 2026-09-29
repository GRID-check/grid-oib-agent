/**
 * One product-feedback report (Platform → Feedback). Thin adapters (ADR-0017).
 *
 * GET   — the report, for the deep link a `feedback.submitted` inbox row lands on.
 * PATCH — move it through triage (`new` → `in_progress` → `resolved` /
 *         `dismissed`), attributed to the caller on the row itself.
 */

import { z } from 'zod'
import { NotFoundError } from '@/lib/api/errors'
import { parseJsonBody } from '@/lib/api/handler'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import {
  getProductFeedbackForPlatform,
  triageProductFeedback,
} from '@/lib/product-feedback/service'
import { triageProductFeedbackSchema } from '@/lib/product-feedback/types'

type Params = { reportId?: string | string[] }

/** A path segment that is not a uuid names nothing — 404, not a 500. */
function parseReportId(params: Params): string {
  const parsed = z.string().uuid().safeParse(params.reportId)
  if (!parsed.success) throw new NotFoundError('Unknown feedback report.')
  return parsed.data
}

export const GET = platformApiRoute<Params>(
  async ({ session, params }) => {
    return getProductFeedbackForPlatform(session, parseReportId(params))
  },
  { permission: PLATFORM_PERMISSIONS.settingsView }
)

export const PATCH = platformApiRoute<Params>(
  async ({ session, request, params }) => {
    const { status } = await parseJsonBody(request, triageProductFeedbackSchema)
    return triageProductFeedback(session, parseReportId(params), status)
  },
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)
