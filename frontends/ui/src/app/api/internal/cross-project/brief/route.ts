/**
 * INTERNAL — one project's brief (confirmed facts and summary), from a solo
 * chat (ADR-0093). The agent's `read_project_brief` tool is the caller; the
 * acting person is the envelope's, as a pinned session, and must be able to
 * open the project (404 otherwise, like every project the caller cannot see).
 *
 * `POST` `CrossProjectBriefRequest` → `CrossProjectBriefResponse`
 * (`lib/cross-project/types.ts`). A conversation that is not the asker's alone
 * is refused (409 `CROSS_PROJECT_SHARED_CHAT`).
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
    const caller = crossProjectCaller(context, session, body.answerMessageId)
    return withTenant({ organizationId: context.organizationId }, () => readProjectBrief(caller, body))
  },
  { tenancy: { fromPayload: 'the signed request-context envelope' } }
)
