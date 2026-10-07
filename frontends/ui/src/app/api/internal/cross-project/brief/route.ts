/**
 * INTERNAL — one project's brief (confirmed facts and summary), from any chat
 * (ADR-0085). The agent's `project_lookup` tool (`action: brief`) is the
 * caller; the acting person is the envelope's, as a pinned session, and the
 * project must be in reach of the conversation's audience (404 otherwise, like
 * every project the caller cannot see).
 *
 * `POST` `CrossProjectBriefRequest` → `CrossProjectBriefResponse`
 * (`lib/cross-project/types.ts`). An audience changed mid-lookup is refused (409
 * `CROSS_PROJECT_AUDIENCE_CHANGED`).
 */

import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { requirePinnedSession, requireVerifiedContext } from '@/lib/api/internal-envelope'
import { crossProjectCaller, readProjectBrief } from '@/lib/cross-project/service'
import { crossProjectBriefRequestSchema } from '@/lib/cross-project/types'
import { withTenant } from '@/lib/db/tenant-context'

export const POST = internalApiRoute(
  'cross-project-brief',
  async ({ request }) => {
    const context = requireVerifiedContext(request)
    const body = await parseJsonBody(request, crossProjectBriefRequestSchema)
    const session = await requirePinnedSession(context)
    const caller = crossProjectCaller(context, session)
    return withTenant({ organizationId: context.organizationId }, () => readProjectBrief(caller, body))
  },
  { tenancy: { fromPayload: 'the signed request-context envelope' } }
)
