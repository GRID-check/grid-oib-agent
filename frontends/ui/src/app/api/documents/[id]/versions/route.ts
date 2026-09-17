/**
 * A document's version list, and the gesture that starts a new draft.
 *
 * Under the existing `/api/documents/[id]` path so both shelves resolve their
 * own permission FROM THE ROW: `getAccessibleDocument` inside the service
 * decides whether this is a project document, an org-wide Archiv document or a
 * chat attachment, and the route never has to know.
 *
 * Thin adapters. Every rule — who may act, what the body must carry, what else
 * happens — is one row of the transition table in
 * `@/lib/documents/lifecycle-types`.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { forkDraftVersion, listDocumentVersionViews, toDocumentVersionView } from '@/lib/documents/lifecycle'
import { forkDraftRequestSchema } from '@/lib/documents/lifecycle-types'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => listDocumentVersionViews(session, params.id),
  { authz: { enforcedBy: 'listDocumentVersionViews -> getAccessibleDocument (project:view | org membership | conversation viewer)' } }
)

export const POST = apiRoute<Params>(
  async ({ session, params, request }) => {
    await parseJsonBody(request, forkDraftRequestSchema)
    const version = await forkDraftVersion(session, params.id, request)
    return { version: toDocumentVersionView(version) }
  },
  {
    authz: {
      enforcedBy:
        'forkDraftVersion -> getAccessibleDocument + requireProjectAccess (project:documents:write | project:edit, AND project:documents:generate)',
    },
    status: 201,
  }
)
