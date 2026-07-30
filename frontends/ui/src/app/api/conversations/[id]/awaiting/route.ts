/**
 * The conversation's hand-off state — "Warten auf Anna" (spec MN-8, ADR-0034).
 *
 * Derived, never stored: the response is the set of `open` mention requests on
 * this conversation, which is why the banner and the recipient's inbox cannot
 * disagree. Server-side state rather than one browser's UI state, so every
 * participant sees the same wait and it survives a reload, a deploy and a replica
 * reshuffle.
 *
 * Thin adapter (ADR-0017); logic in `@/lib/mentions/service`.
 */

import { apiRoute } from '@/lib/api/handler'
import { requireCollaborationEnabled } from '@/lib/authz/feature-flags'
import { getAwaitingState } from '@/lib/mentions/service'

type Params = { id: string }

export const GET = apiRoute<Params>(async ({ session, params }) => {
  const gated = requireCollaborationEnabled(session)
  if (gated) return gated
  return getAwaitingState(session, params.id)
})
