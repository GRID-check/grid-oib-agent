import 'server-only'
/**
 * The acting person behind an internal call: verify the envelope, pin the
 * session (ADR-0054 §4).
 *
 * ## Why this is a module and not two functions in a route
 *
 * Every internal route carries the same static service token and no user, and
 * the agent's principal is WIDER than any human's — so a route that took
 * `userId` from its own body would let anything holding `GRID_INTERNAL_API_TOKEN`
 * write into any tenant as anybody. `POST /api/internal/document-versions` was
 * the first route to close that, with the two helpers below written inside it;
 * `POST /api/internal/tasks` is the second, and a second copy of an identity
 * check is exactly the shape this repo has already paid for twice at one level
 * down (`AUDIT_ACTIONS` and the provisioning `SCHEMAS` array, drifted by nine
 * actions with nothing to notice).
 *
 * So it is lifted here, unchanged, on its second caller rather than on its
 * first — and it is deliberately NOT a wrapper around `internalApiRoute`. What
 * each route does with the verified identity differs (one opens a tenant slot
 * and files a document, the other queues work), and a helper that owned the
 * whole handler would have to grow an option per route until it was a framework.
 *
 * ## The threat model, unchanged from ADR-0054 §4
 *
 * | An attacker holding | Gets |
 * |---|---|
 * | the internal token alone | nothing — no envelope, no acting identity, 401 |
 * | a captured envelope, inside its window | what that user's own turn had, for at most six hours |
 * | a captured envelope, outside its window | nothing — `issuedAt` is inside the signed bytes |
 * | the signing secret | what the internal token already grants; the two are one secret |
 * | an envelope naming somebody who has left | a 403 — the pinned session is resolved from WorkOS TODAY |
 */

import { BadRequestError, ForbiddenError, UnauthorizedError } from '@/lib/api/errors'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  GRID_HEADER_NAMES,
  verifyGridRequestContextEnvelope,
  type VerifiedGridRequestContext,
} from '@/lib/request-context'

/** The verified envelope, or a 401. Never says which check failed. */
export function requireVerifiedContext(request: Request): VerifiedGridRequestContext {
  const context = verifyGridRequestContextEnvelope(
    request.headers.get(GRID_HEADER_NAMES.REQUEST_CONTEXT),
    request.headers.get(GRID_HEADER_NAMES.REQUEST_CONTEXT_SIG),
    process.env.GRID_INTERNAL_API_TOKEN,
  )
  if (!context) throw new UnauthorizedError('Missing or invalid request context envelope')
  return context
}

/**
 * Refuse a body that names a different project than the signed envelope does.
 *
 * The envelope is the only thing on an internal request that anybody VERIFIED,
 * and it already carries the project the turn is running in. The body's
 * `projectId` is the caller's — it decides which project the work lands in, and
 * it was being taken on trust while a signed contradiction of it sat one field
 * away. A captured envelope could therefore be replayed against any project in
 * the same organization the requester can write to, which is more than the turn
 * it was minted for ever had.
 *
 * An envelope with NO project is a turn that is not in one (the org-wide Archiv,
 * a projectless chat); it constrains nothing, and the body's own project is
 * then gated by `requireProjectAccess` in the service exactly as before. A
 * mismatch is a 400 and not a 403: the request is self-contradictory, and
 * saying so does not tell the caller anything about the project it named.
 */
export function requireEnvelopeProject(
  context: VerifiedGridRequestContext,
  projectId: string,
): void {
  if (!context.projectId) return
  if (context.projectId === projectId) return
  throw new BadRequestError('projectId does not match the request context envelope', {
    projectId,
  })
}

/**
 * The person the envelope names, as a real role-bearing session, or a 403.
 *
 * `resolvePinnedRequesterSession` reads that person's WorkOS membership as it is
 * NOW — no token is minted — so a requester who has left the organization, or
 * holds no role in it today, is refused exactly as they would be in their own
 * browser. The agent never borrows a permission its user has lost.
 */
export async function requirePinnedSession(
  context: VerifiedGridRequestContext,
): Promise<AuthorizedSession> {
  const session = await resolvePinnedRequesterSession({
    userId: context.userId,
    email: null,
    organizationId: context.organizationId,
  })
  if (!session) throw new ForbiddenError('The requesting user is no longer a member here')
  return session
}
