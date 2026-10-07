/**
 * Project re-index API — rebuild the chunks of every document in one project.
 *
 * Thin handler; the access check and the enqueue live in
 * `@/lib/documents/service`. The walk itself is a `bff-jobs` job (ADR-0079), so
 * this answers 202 with the job's id as soon as it is queued, and the job
 * carries on when the pod that took the request is gone.
 */

import { apiRoute } from '@/lib/api/handler'
import { reindexProject } from '@/lib/documents/service'

type Params = { id: string }

export const POST = apiRoute<Params>(
  async ({ session, params }) => reindexProject(session, params.id),
  { status: 202, authz: { enforcedBy: 'reindexProject -> requireProjectAccess (project:documents:write)' } }
)
