/**
 * Replace an open version's bytes — whole body, with `If-Match`.
 *
 * PUT and not PATCH, because that is what this is: the entire document is
 * replaced. The API deliberately exposes no string replacement — editing
 * happens in the conversation's working directory, where the model can read
 * what it is changing, and filing is a whole document.
 *
 * `ifMatch` is the stored `content_hash`, and a mismatch is a 409 rather than a
 * last-write-wins overwrite: two turns of one conversation can both be holding
 * the same draft.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { replaceVersionContent, toDocumentVersionView } from '@/lib/documents/lifecycle'
import { replaceContentRequestSchema } from '@/lib/documents/lifecycle-types'

type Params = { id: string; versionId: string }

export const PUT = apiRoute<Params>(
  async ({ session, params, request }) => {
    const { content, ifMatch } = await parseJsonBody(request, replaceContentRequestSchema)
    const version = await replaceVersionContent(
      session,
      params.id,
      params.versionId,
      content,
      ifMatch,
      request
    )
    return { version: toDocumentVersionView(version) }
  },
  {
    authz: {
      enforcedBy:
        'replaceVersionContent -> getAccessibleDocument + requireProjectAccess (project:documents:write | project:edit, AND project:documents:generate)',
    },
  }
)
