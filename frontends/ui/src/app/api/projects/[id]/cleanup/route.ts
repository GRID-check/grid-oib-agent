/**
 * „Ausmisten" before a project closes (ADR-0084): Piloti's proposal (GET) and
 * the person's decision (POST), which puts what they chose into the
 * Papierkorb. Thin handlers; the rules live in `cleanup-service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { CLEANUP_MAX_DOCUMENTS, confirmCleanup, proposeCleanup } from '@/lib/projects/cleanup-service'

type Params = { id: string }

const ids = z.array(z.string().uuid()).max(CLEANUP_MAX_DOCUMENTS)
const confirmSchema = z.object({ documentIds: ids, proposedIds: ids, aiUsed: z.boolean() }).strict()

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const locale = new URL(request.url).searchParams.get('locale') === 'en' ? 'en' : 'de'
    return proposeCleanup(session, params.id, locale)
  },
  { authz: { enforcedBy: 'proposeCleanup (requireProjectAccess project:documents:write; read and write per folder)' } }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const input = await parseJsonBody(request, confirmSchema)
    return confirmCleanup(session, params.id, input, request)
  },
  { authz: { enforcedBy: 'confirmCleanup (requireProjectAccess project:documents:write; requireFolderWrite per folder)' } }
)
