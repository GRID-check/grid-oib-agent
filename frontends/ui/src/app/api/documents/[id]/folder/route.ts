/**
 * Which folder a document is filed in — a project document's or an Archiv
 * document's (ADR-0078).
 *
 * Its own route rather than a field on `PATCH /api/documents/{id}`: that one
 * renames and tags, and a filing move needs the destination check (a folder of
 * the document's OWN shelf and tenant) and the backend path mirror. The logic and
 * the authz live in `@/lib/documents/move-to-folder`: the document's row says
 * which shelf it is on, and that shelf says who may move it.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { moveDocumentToFolder } from '@/lib/documents/move-to-folder'

type Params = { id: string }

const moveSchema = z.object({
  // Explicit `null` files the document at its shelf's root, which is a real
  // destination — so this is nullable, not optional.
  folderId: z.string().uuid().nullable(),
})

export const PATCH = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { folderId } = await parseJsonBody(request, moveSchema)
    const result = await moveDocumentToFolder({ documentId: params.id, folderId }, session)
    if (!result.ok) throw new BadRequestError(result.error)
    return result.document
  },
  {
    authz: {
      enforcedBy:
        'moveDocumentToFolder (org scope; requireProjectAccess project:documents:write for a project document, canManageArchiv for an Archiv document)',
    },
  }
)
