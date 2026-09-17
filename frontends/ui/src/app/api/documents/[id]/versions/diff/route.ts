/**
 * Two versions' contents, for the client to render.
 *
 * The server deliberately does NOT diff. A diff is a rendering decision — word
 * or line granularity, whitespace, whether a moved paragraph is a move or a
 * delete plus an insert — and baking one into the API would freeze it for every
 * later surface while buying nothing: the bytes are what both sides need.
 */

import { apiRoute } from '@/lib/api/handler'
import { BadRequestError } from '@/lib/api/errors'
import { getDocumentVersionView } from '@/lib/documents/lifecycle'
import { readVersionContent } from '@/lib/documents/version-content'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params, request }) => {
    const url = new URL(request.url)
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    if (!from || !to) throw new BadRequestError('from and to are required')

    const [fromVersion, toVersion, fromContent, toContent] = await Promise.all([
      getDocumentVersionView(session, params.id, from),
      getDocumentVersionView(session, params.id, to),
      readVersionContent(session, params.id, from),
      readVersionContent(session, params.id, to),
    ])
    return {
      from: { version: fromVersion, content: fromContent },
      to: { version: toVersion, content: toContent },
    }
  },
  { authz: { enforcedBy: 'getDocumentVersionView / readVersionContent -> getAccessibleDocument (project:view | org membership | conversation viewer)' } }
)
