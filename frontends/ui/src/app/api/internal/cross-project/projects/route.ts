/**
 * INTERNAL — list and find the projects in reach of the conversation's audience
 * (ADR-0085): name, status, address, period. The agent's `project_lookup` tool
 * (`action: find`) is the caller; the acting person is the envelope's, as a
 * pinned session.
 *
 * `POST` `CrossProjectListRequest` → `CrossProjectListResponse`
 * (`lib/cross-project/types.ts`). An audience changed mid-lookup is refused (409
 * `CROSS_PROJECT_AUDIENCE_CHANGED`).
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
    const caller = crossProjectCaller(context, session)
    return withTenant({ organizationId: context.organizationId }, () => listLookupProjects(caller, body))
  },
  { tenancy: { fromPayload: 'the signed request-context envelope' } }
)
