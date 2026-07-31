/**
 * Platform → answer feedback: the cross-organization view of the thumbs users
 * leave on answers. Platform owners only; tenant admins get 403.
 *
 * Declared through `apiRoute` (ADR-0017): session authentication, JSON
 * serialization and error mapping all live in the factory, so this file is only
 * the filter parse and the call.
 *
 * The owner gate itself lives in `getAnswerFeedbackHealth`, not here, so it
 * cannot be lost by a second caller — the only translation left is the typed
 * denial into the factory's 403.
 */

import { ForbiddenError } from '@/lib/api/errors'
import { apiRoute } from '@/lib/api/handler'
import { PlatformAccessDeniedError } from '@/lib/authz/platform'
import { getAnswerFeedbackHealth } from '@/lib/feedback/service'
import { parseFeedbackFilters } from '@/lib/feedback/query'

export const GET = apiRoute(
  async ({ request, session }) => {
    const filters = parseFeedbackFilters(new URL(request.url).searchParams)
    try {
      return await getAnswerFeedbackHealth(session, filters)
    } catch (error) {
      if (error instanceof PlatformAccessDeniedError) throw new ForbiddenError()
      throw error
    }
  },
  { authz: { enforcedBy: 'getAnswerFeedbackHealth (requirePlatformOwner)' } }
)
