/**
 * INTERNAL — search documents across the projects in reach of the
 * conversation's whole audience, from any chat (ADR-0094). The agent's
 * `project_lookup` tool (`action: search`) is the caller.
 *
 * The acting person is the one the turn's signed envelope names, as a pinned
 * session (ADR-0054 §4): the tool echoes the envelope, never signs one. Scope,
 * project access and folder access are decided in `lib/cross-project/service.ts`
 * by the rules the projects grid and the project's own search use; this route
 * only adapts. A conversation whose audience changed while the lookup ran is
 * refused with a typed 409 (`CROSS_PROJECT_AUDIENCE_CHANGED`) whose message the
 * agent relays.
 *
 * `POST` `CrossProjectSearchRequest` → `CrossProjectSearchResponse`
 * (`lib/cross-project/types.ts`).
 */

import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { requirePinnedSession, requireVerifiedContext } from '@/lib/api/internal-envelope'
import { crossProjectCaller, searchAcrossProjects } from '@/lib/cross-project/service'
import { crossProjectSearchRequestSchema } from '@/lib/cross-project/types'
import { withTenant } from '@/lib/db/tenant-context'

export const POST = internalApiRoute(
  'cross-project-search',
  async ({ request }) => {
    const context = requireVerifiedContext(request)
    const body = await parseJsonBody(request, crossProjectSearchRequestSchema)
    const session = await requirePinnedSession(context)
    const caller = crossProjectCaller(context, session, body.answerMessageId)
    return withTenant({ organizationId: context.organizationId }, () => searchAcrossProjects(caller, body))
  },
  { tenancy: { fromPayload: 'the signed request-context envelope' } }
)
