/**
 * Text document content — returns a bounded UTF-8 string for the formats the
 * pane renders itself (plain text, Markdown, CSV). 415 for anything else.
 * Thin handler; all logic lives in `@/lib/documents/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { getDocumentTextPreview } from '@/lib/documents/service'

type Params = { id: string }

export const GET = apiRoute<Params>(
  async ({ session, params }) => getDocumentTextPreview(session, params.id),
  { authz: { enforcedBy: 'getDocumentTextPreview -> getAccessibleDocument (project:view)' } }
)
