/**
 * `POST /api/feedback/reports` — a member sends product feedback (a bug, an
 * idea, praise or a question) to the platform owners.
 *
 * Not `/api/feedback/answers`, which is the thumbs on one answer. Thin adapter
 * (ADR-0017): validation here, everything else in `submitProductFeedback`.
 *
 * Open to every signed-in member with no feature flag: reporting a bug must not
 * depend on what the tenant bought. Bounded per person by
 * `FEEDBACK_REPORT_LIMIT` instead, because each report pages every platform
 * owner.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { FEEDBACK_REPORT_LIMIT } from '@/lib/limits/catalog'
import { submitProductFeedback } from '@/lib/product-feedback/service'
import { submitProductFeedbackSchema } from '@/lib/product-feedback/types'

export const POST = apiRoute(
  async ({ session, request }) => {
    const input = await parseJsonBody(request, submitProductFeedbackSchema)
    return submitProductFeedback(session, input)
  },
  {
    authz: { enforcedBy: 'submitProductFeedback (any member; the row is keyed to session.userId)' },
    limits: { rule: FEEDBACK_REPORT_LIMIT },
    status: 201,
  }
)
