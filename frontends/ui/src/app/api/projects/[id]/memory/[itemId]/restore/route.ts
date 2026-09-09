/**
 * Undo a supersession on one project memory item (ADR-0055).
 *
 * A correction retires the note it replaces and records `supersedes_id`. Until
 * this route existed, nothing read that link and nothing could reverse it: the
 * replaced note vanished from the panel, so a wrong correction was the
 * quietest event in the system. This reinstates the retired note and retires
 * the replacement, in one transaction, so the store is never left holding both
 * or neither.
 *
 * Same permission as editing memory, because it is one. Organization-scoped
 * items are NOT restorable here — they go through the organization memory
 * routes as every other org-scoped mutation does, and a project-addressed
 * mutation of an org-wide note would be a second place org memory is
 * authorized.
 *
 * Thin handler; authz, the conflict cases and the audit event live in
 * `@/lib/projects/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { restoreProjectMemoryItem } from '@/lib/projects/service'

type Params = { id: string; itemId: string }

export const POST = apiRoute<Params>(
  async ({ session, params, request }) =>
    restoreProjectMemoryItem(session, params.id, params.itemId, request),
  { authz: { enforcedBy: 'restoreProjectMemoryItem (requireProjectAccess project:memory:write)' } }
)
