/**
 * Document roles for a project — list the bindings, declare a new one.
 * Thin handlers; authz and the vocabulary rules live in
 * `@/lib/document-roles/service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { declareDocumentRole, listDocumentRoles } from '@/lib/document-roles/service'
import { DOCUMENT_ROLES, ROLE_CONFIDENCES, ROLE_SOURCES } from '@/lib/project-profile/document-roles'

type Params = { id: string }

const declareSchema = z.object({
  documentId: z.string().uuid(),
  // Enumerated from the vocabulary rather than restated, so a role added there
  // is accepted here without a second edit — and one removed is rejected.
  role: z.enum(DOCUMENT_ROLES),
  scopeInstanceId: z.string().min(1).max(64).nullable().optional(),
  confidence: z.enum(ROLE_CONFIDENCES).optional(),
  source: z.enum(ROLE_SOURCES).optional(),
})

export const GET = apiRoute<Params>(
  async ({ session, params }) => ({
    roles: await listDocumentRoles(params.id, session),
  }),
  { authz: { enforcedBy: 'listDocumentRoles (requireProjectAccess project:view)' } }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    const body = await parseJsonBody(request, declareSchema)
    return declareDocumentRole({ projectId: params.id, ...body }, session)
  },
  {
    status: 201,
    authz: {
      enforcedBy: 'declareDocumentRole (requireProjectAccess project:documents:write)',
    },
  }
)
