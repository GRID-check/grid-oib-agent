/**
 * Platform → answer feedback: the cross-organization view of the thumbs users
 * leave on answers. Platform owners only; tenant admins get 403.
 *
 * Declared through `apiRoute` (ADR-0017): session authentication, JSON
 * serialization and error mapping all live in the factory, so this file is only
 * the filter parse and the call. The parameters are the page's: the scope every
 * quality view shares and the ratings tab's filters, read by the one parser the
 * digest, the options and the export use too.
 *
 * The owner gate itself lives in `getAnswerFeedbackHealth`, not here, so it
 * cannot be lost by a second caller — the only translation left is the typed
 * denial into the factory's 403.
 */

import { ForbiddenError } from '@/lib/api/errors'
import { apiRoute } from '@/lib/api/handler'
import { PlatformAccessDeniedError } from '@/lib/authz/platform'
import { getAnswerFeedbackHealth } from '@/lib/feedback/service'
import { requireFeedbackQuery } from '@/lib/feedback/query'

export const GET = apiRoute(
  async ({ request, session }) => {
    // The page's scope (`from`, `to`, `org`, `project`) and the ratings filters;
    // an unknown value is a 400 naming the parameter (`lib/feedback/query.ts`).
    const query = requireFeedbackQuery(new URL(request.url).searchParams)
    try {
      return await getAnswerFeedbackHealth(session, query)
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
