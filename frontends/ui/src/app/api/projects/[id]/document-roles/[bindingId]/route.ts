/**
 * Clear one document-role binding.
 * Thin handler; authz lives in `@/lib/document-roles/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { revokeDocumentRole } from '@/lib/document-roles/service'

type Params = { id: string; bindingId: string }

export const DELETE = apiRoute<Params>(
  async ({ session, params }) => {
    await revokeDocumentRole(params.id, params.bindingId, session)
    return { ok: true }
  },
  { authz: { enforcedBy: 'revokeDocumentRole (requireProjectAccess project:documents:write)' } }
)
