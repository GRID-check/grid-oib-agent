/**
 * INTERNAL — list and find the projects the asker may open, from a solo chat
 * (ADR-0094): name, status, address, created. The agent's `find_projects` tool
 * is the caller; the acting person is the envelope's, as a pinned session.
 *
 * `POST` `CrossProjectListRequest` → `CrossProjectListResponse`
 * (`lib/cross-project/types.ts`). A conversation that is not the asker's alone
 * is refused (409 `CROSS_PROJECT_SHARED_CHAT`).
 */

import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { requirePinnedSession, requireVerifiedContext } from '@/lib/api/internal-envelope'
import { crossProjectCaller, listLookupProjects } from '@/lib/cross-project/service'
import { crossProjectListRequestSchema } from '@/lib/cross-project/types'
import { withTenant } from '@/lib/db/tenant-context'

export const POST = internalApiRoute(
  'cross-project-projects',
  async ({ request }) => {
    const context = requireVerifiedContext(request)
    const body = await parseJsonBody(request, crossProjectListRequestSchema)
    const session = await requirePinnedSession(context)
    const caller = crossProjectCaller(context, session, body.answerMessageId)
    return withTenant({ organizationId: context.organizationId }, () => listLookupProjects(caller, body))
  },
  { tenancy: { fromPayload: 'the signed request-context envelope' } }
)
