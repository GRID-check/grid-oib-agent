/**
 * „Ausmisten" before a project closes (ADR-0091): Piloti's proposal. A POST,
 * not a GET: it starts a paid model call, which a prefetch, a crawler or a
 * retried navigation must never trigger. Thin handler; the rules live in
 * `cleanup-service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { proposeCleanup } from '@/lib/projects/cleanup-service'

type Params = { id: string }

const proposalSchema = z.object({ locale: z.enum(['de', 'en']) }).strict()

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { locale } = await parseJsonBody(request, proposalSchema)
    return proposeCleanup(session, params.id, locale)
  },
  { authz: { enforcedBy: 'proposeCleanup (requireProjectAccess project:documents:write; read and write per folder)' } }
)
