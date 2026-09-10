/**
 * The ONE route a machine may write a document version through (ADR-0054 §4,
 * ADR-0055).
 *
 * ## The problem this route exists to solve
 *
 * Internal routes carry a static service token and no user
 * (`lib/internal-auth.ts`), and the agent's principal is WIDER than any human's
 * — it holds the shared `GRID_INTERNAL_API_TOKEN`, and the internal memory
 * route says so in its own comment: *"this service-token endpoint cannot verify
 * the human's org role"*. A route that took `userId` from its own body would let
 * anything holding that token write into any tenant as anybody. So the acting
 * identity does not come from the body. It comes from the **signed request
 * envelope** the BFF minted at the start of the turn, verified here with the
 * same secret (`verifyGridRequestContextEnvelope`), and from
 * `resolvePinnedRequesterSession`, which builds a real, role-bearing session for
 * that person out of their WorkOS membership TODAY — without minting a token.
 *
 * Every permission check, every `created_by` and every audit actor downstream is
 * that human. The agent never holds authority its user lacks.
 *
 * ## The threat model, and what each attacker gets
 *
 * 1. **The internal token alone.** Nothing. Without a valid envelope there is no
 *    acting identity, and the route answers 401 before it reads the body.
 * 2. **A captured envelope, inside its window.** The authority that user's own
 *    turn already had, for at most six hours: draft, replace a draft's bytes,
 *    submit. Not approve, not reject, not publish, not archive — those rows are
 *    `actor: 'human'`, and `actingHuman: false` refuses them before any
 *    permission is read. The op union below is closed for the same reason twice
 *    over, and `route.spec.ts` asserts every op it admits maps to a transition
 *    row whose actor is `either`.
 * 3. **A captured envelope, outside its window.** Nothing. `issuedAt` is inside
 *    the signed bytes, so the age cannot be edited without breaking the
 *    signature, and an envelope with no `issuedAt` is refused outright.
 * 4. **The signing secret.** Everything the internal token already grants; the
 *    two are the same secret today. This is not a second factor. What it buys is
 *    that a service call becomes a PERSON's call, auditable and permission-
 *    checked, instead of an unattributable write.
 * 5. **A requester who has left the organization, lost the permission, or whose
 *    organization has machine authorship switched off.** A refusal.
 *    `resolvePinnedRequesterSession` returns `null` for the first, and the
 *    filing path's own gates answer the other two — the session is real, so it
 *    is refused exactly as that person would be.
 *
 * What the caller still chooses, and what that is worth, is ADR-0047's second
 * addendum unchanged: the reference and the prose are the client's, the identity
 * and the permission are not. A forged draft is `Unvergeben`, unindexed, and
 * names a real human in `created_by` and in the trail.
 */

import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { ForbiddenError, UnauthorizedError } from '@/lib/api/errors'
import { withTenant } from '@/lib/db/tenant-context'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import {
  GRID_HEADER_NAMES,
  verifyGridRequestContextEnvelope,
  type VerifiedGridRequestContext,
} from '@/lib/request-context'
import { fileAgentDocumentDraft } from '@/lib/documents/agent-document'
import {
  replaceVersionContent,
  toDocumentVersionView,
  transitionDocumentVersion,
} from '@/lib/documents/lifecycle'
import {
  internalDocumentVersionRequestSchema,
  type InternalDocumentVersionRequest,
} from '@/lib/documents/lifecycle-types'
import type { AuthorizedSession } from '@/lib/auth/types'

/** The verified envelope, or a 401. Never says which check failed. */
function requireVerifiedContext(request: Request): VerifiedGridRequestContext {
  const context = verifyGridRequestContextEnvelope(
    request.headers.get(GRID_HEADER_NAMES.REQUEST_CONTEXT),
    request.headers.get(GRID_HEADER_NAMES.REQUEST_CONTEXT_SIG),
    process.env.GRID_INTERNAL_API_TOKEN,
  )
  if (!context) throw new UnauthorizedError('Missing or invalid request context envelope')
  return context
}

/** The person the envelope names, as a session, or a 403. */
async function requirePinnedSession(
  context: VerifiedGridRequestContext,
): Promise<AuthorizedSession> {
  const session = await resolvePinnedRequesterSession({
    userId: context.userId,
    email: null,
    organizationId: context.organizationId,
  })
  // Left the organization, or holds no role in it today. The agent must not
  // borrow a permission the person no longer has.
  if (!session) throw new ForbiddenError('The requesting user is no longer a member here')
  return session
}

async function runOp(
  session: AuthorizedSession,
  body: InternalDocumentVersionRequest,
  request: Request,
) {
  if (body.op === 'create') {
    const filed = await fileAgentDocumentDraft({
      session,
      projectId: body.projectId,
      ref: body.ref,
      title: body.title,
      content: body.content,
      request,
      actingHuman: false,
    })
    return {
      documentId: filed.documentId,
      alreadyFiled: filed.alreadyFiled,
      version: toDocumentVersionView(filed.version),
    }
  }

  if (body.op === 'update') {
    const version = await replaceVersionContent(
      session,
      body.documentId,
      body.versionId,
      body.content,
      body.ifMatch,
      request,
    )
    return { documentId: body.documentId, version: toDocumentVersionView(version) }
  }

  const version = await transitionDocumentVersion(
    session,
    body.documentId,
    body.versionId,
    'submit',
    { reviewerUserIds: body.reviewerUserIds, request, actingHuman: false },
  )
  return { documentId: body.documentId, version: toDocumentVersionView(version) }
}

export const POST = internalApiRoute(
  'document-versions',
  async ({ request }) => {
    const context = requireVerifiedContext(request)
    const body = await parseJsonBody(request, internalDocumentVersionRequestSchema)
    const session = await requirePinnedSession(context)
    // The tenant slot is opened from the VERIFIED envelope, never from the body:
    // `fromPayload` below names where it comes from so a reviewer can check the
    // claim, and the claim is a signed one.
    return withTenant({ organizationId: context.organizationId }, () =>
      runOp(session, body, request),
    )
  },
  {
    tenancy: {
      fromPayload:
        'the verified X-Grid-Request-Context envelope (organizationId), never the request body',
    },
    status: 201,
  },
)
