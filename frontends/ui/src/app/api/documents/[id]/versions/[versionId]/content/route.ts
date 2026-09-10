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
import {
  readVersionContent,
  replaceVersionContent,
  toDocumentVersionView,
} from '@/lib/documents/lifecycle'
import { replaceContentRequestSchema } from '@/lib/documents/lifecycle-types'

type Params = { id: string; versionId: string }

/**
 * One version's bytes, as text — what „Öffnen" in the version list opens.
 *
 * A version list whose entries cannot be opened is a list of dates (ADR-0054),
 * and until this existed only the PUBLISHED version's bytes were reachable, via
 * the document's own file route. Text, because the versioned documents this
 * lifecycle exists for are Markdown: the same `readVersionContent` the diff
 * route already serves both sides of a comparison with. A binary version is
 * opened through the document's file route, which knows its content type.
 */
export const GET = apiRoute<Params>(
  async ({ session, params }) =>
    new Response(await readVersionContent(session, params.id, params.versionId), {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        // Rendered in a tab, never downloaded as an attachment: the reader
        // pressed „Öffnen" to read what this version says.
        'Content-Disposition': 'inline',
      },
    }),
  {
    authz: {
      enforcedBy:
        'readVersionContent -> getAccessibleDocument (project:view | org membership | conversation viewer)',
    },
  }
)

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
