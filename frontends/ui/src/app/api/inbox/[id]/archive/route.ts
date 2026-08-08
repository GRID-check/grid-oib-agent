/**
 * `POST /api/inbox/[id]/archive` — archive one item (spec IB-20).
 *
 * A POST rather than a DELETE: archiving is a lifecycle transition on a row that
 * survives it (retention still owns the row's death, spec IB-15), not a deletion.
 * An id belonging to somebody else answers 404, exactly as a missing one does.
 *
 * Gated per ITEM TYPE rather than per route (see `/api/inbox`). No extra check
 * is needed for a hidden type: an id the caller was never shown is one they do
 * not have, and the repository scopes the update to their own rows regardless.
 */

import { apiRoute } from '@/lib/api/handler'
import { archiveItem } from '@/lib/inbox/service'

export const POST = apiRoute<{ id: string }>(
  async ({ session, params }) => {
    return archiveItem(session, params.id)
  },
  { authz: { enforcedBy: 'archiveItem (rows are keyed to session.userId)' } }
)
