/**
 * Document item API — rename a document (PATCH) and delete a project document
 * (DELETE). Thin handlers; authorization and all logic live in
 * `@/lib/documents/service`.
 *
 * PATCH is SCOPE-AWARE, like the sibling item routes (download/preview/status/
 * reingest/tags) under this `[id]` folder: it renames a project document and an
 * org-wide Archiv document alike, because `renameDocument` resolves which
 * permission applies from the row itself.
 *
 * DELETE is not, and stays project-only: deleting an Archiv document goes
 * through `/api/archiv/documents/[id]`, where the org-level `org:archiv:manage`
 * gate and the dark-launch feature flag live.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { deleteDocument, renameDocument } from '@/lib/documents/service'
import { MAX_DOCUMENT_NAME_LENGTH } from '@/lib/documents/display-name'

type Params = { id: string }

/**
 * `null` is a real value here, not an omission: it CLEARS the rename and
 * restores the file's own name, which is what the preview's "restore original
 * name" action sends. The bounds only guard request shape — the service
 * re-validates with `validateDocumentName`, which is also what the dialog uses,
 * so the rule is stated once and enforced on both sides.
 */
const renameSchema = z.object({
  displayName: z.string().max(MAX_DOCUMENT_NAME_LENGTH).nullable(),
})

export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { displayName } = await parseJsonBody(request, renameSchema)
    return renameDocument(session, params.id, displayName, request)
  },
  { authz: { enforcedBy: 'renameDocument -> getAccessibleDocument (project:documents:write | org:archiv:manage)' } }
)

export const DELETE = apiRoute<Params>(
  async ({ session, params, request }) => {
    await deleteDocument(session, params.id, request)
    return null
  },
  { authz: { enforcedBy: 'deleteDocument (requireProjectAccess project:documents:write)' } }
)
