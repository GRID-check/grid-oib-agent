import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { requirePinnedSession, requireVerifiedContext } from '@/lib/api/internal-envelope'
import { withTenant } from '@/lib/db/tenant-context'
import { loadTurnContext } from '@/lib/turn-context/service'
import { turnContextRequestSchema } from '@/lib/turn-context/wire'

export const POST = internalApiRoute(
  'Internal Turn Context',
  async ({ request }) => {
    const context = requireVerifiedContext(request)
    const input = await parseJsonBody(request, turnContextRequestSchema)
    const session = await requirePinnedSession(context)
    const data = await withTenant({ organizationId: context.organizationId, userId: context.userId }, () =>
      loadTurnContext(session, context, input),
    )
    return { data }
  },
  {
    tenancy: { fromPayload: 'verified X-Grid-Request-Context envelope, never the body' },
  },
)
