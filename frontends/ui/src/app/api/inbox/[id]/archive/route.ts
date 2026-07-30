/**
 * `POST /api/inbox/[id]/archive` — archive one item (spec IB-20).
 *
 * A POST rather than a DELETE: archiving is a lifecycle transition on a row that
 * survives it (retention still owns the row's death, spec IB-15), not a deletion.
 * An id belonging to somebody else answers 404, exactly as a missing one does.
 */

import { apiRoute } from '@/lib/api/handler'
import { requireCollaborationEnabled } from '@/lib/authz/feature-flags'
import { archiveItem } from '@/lib/inbox/service'

export const POST = apiRoute<{ id: string }>(async ({ session, params }) => {
  const gated = requireCollaborationEnabled(session)
  if (gated) return gated
  return archiveItem(session, params.id)
})
