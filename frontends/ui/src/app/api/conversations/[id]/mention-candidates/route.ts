/**
 * Candidates for the composer's `@` picker (spec MN-4, SH-19).
 *
 * A mention is a structured reference chosen from this list, never a text match
 * on a name (spec MN-3) — which is why the list is server-resolved: it is also
 * the set the server will accept when the message arrives.
 *
 * Thin adapter (ADR-0017); logic in `@/lib/mentions/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { requireCollaborationEnabled } from '@/lib/authz/feature-flags'
import { listMentionCandidates } from '@/lib/mentions/service'

type Params = { id: string }

export const GET = apiRoute<Params>(async ({ session, params }) => {
  const gated = requireCollaborationEnabled(session)
  if (gated) return gated
  return listMentionCandidates(session, params.id)
})
