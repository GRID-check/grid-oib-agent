/**
 * „Ausmisten" before a project closes (ADR-0088): the person's decision, which
 * puts what they chose into the Papierkorb, all or nothing. The proposal is
 * `./proposal`. Thin handler; the rules live in `cleanup-service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { CLEANUP_MAX_DOCUMENTS, confirmCleanup } from '@/lib/projects/cleanup-service'

type Params = { id: string }

const ids = z.array(z.string().uuid()).max(CLEANUP_MAX_DOCUMENTS)
const confirmSchema = z.object({ documentIds: ids, proposedIds: ids, aiUsed: z.boolean() }).strict()

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const input = await parseJsonBody(request, confirmSchema)
    return confirmCleanup(session, params.id, input, request)
  },
  { authz: { enforcedBy: 'confirmCleanup (requireProjectAccess project:documents:write; requireFolderWrite per folder)' } }
)
