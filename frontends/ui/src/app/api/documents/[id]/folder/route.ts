/**
 * Which folder a project document is filed in.
 *
 * Its own route rather than a field on `PATCH /api/documents/{id}`: that one is
 * scope-aware and renames Archiv documents too, and folders are project-only.
 * The logic and the authz live in `@/lib/documents/move-to-folder`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { moveDocumentToFolder } from '@/lib/documents/move-to-folder'

type Params = { id: string }

const moveSchema = z.object({
  // Explicit `null` files the document at the project root, which is a real
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
      enforcedBy: 'moveDocumentToFolder (org scope + requireProjectAccess project:documents:write)',
    },
  }
)
