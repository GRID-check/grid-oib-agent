/**
 * Project re-index API — rebuild the chunks of every document in one project.
 *
 * Thin handler; the access check, the chunk delete that must succeed before any
 * re-dispatch, and the bounded fan-out all live in `@/lib/documents/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { reindexProject } from '@/lib/documents/service'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params }) => reindexProject(session, params.id),
  { authz: { enforcedBy: 'reindexProject -> requireProjectAccess (project:documents:write)' } },
)
