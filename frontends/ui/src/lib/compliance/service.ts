/**
 * Compliance service — legal holds (GDPR Art. 18 restriction) and the
 * deletion queue for the current organization.
 *
 * The coarse gate (`org:compliance:manage`) is enforced at the route via
 * `apiRoute`'s `options.permission`; this layer owns tenancy scoping, the
 * audit trail for every mutating action, and typed failures.
 */

import 'server-only'
import { recordAuditEvent } from '@/lib/audit/service'
import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { DeletionEntityType, LegalHold } from '@/lib/db/schema'
import {
  insertHold,
  listOpenHoldsInOrg,
  listPendingDeletionsInOrg,
  releaseHoldInOrg,
  type DeletionQueueSummary,
} from './repository'

export interface CreateHoldInput {
  entityType: DeletionEntityType
  entityId: string
  reason: string
}

/** Open (unreleased) legal holds for the session's organization. */
export async function listOpenHolds(session: AuthorizedSession): Promise<LegalHold[]> {
  return listOpenHoldsInOrg(session.organizationId)
}

/** Place a legal hold on an entity; preserves data and blocks purge. */
export async function createHold(
  session: AuthorizedSession,
  input: CreateHoldInput,
  request: Request,
): Promise<LegalHold> {
  const hold = await insertHold({
    ...input,
    organizationId: session.organizationId,
    createdBy: session.userId,
  })

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'compliance.hold.created',
    targetType: 'legal_hold',
    targetId: hold.id,
    metadata: { entityType: input.entityType, entityId: input.entityId },
    request,
  })

  return hold
}

/**
 * Release an open hold. Missing, cross-tenant, and already-released holds
 * all surface as 404 — existence is never confirmed to unauthorized callers.
 */
export async function releaseHold(
  session: AuthorizedSession,
  holdId: string,
  request: Request,
): Promise<LegalHold> {
  const hold = await releaseHoldInOrg(holdId, session.organizationId)
  if (!hold) throw new NotFoundError()

  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'compliance.hold.released',
    targetType: 'legal_hold',
    targetId: hold.id,
    metadata: { entityType: hold.entityType, entityId: hold.entityId },
    request,
  })

  return hold
}

/** Pending/failed deletion-queue entries for the session's organization. */
export async function listPendingDeletions(session: AuthorizedSession): Promise<DeletionQueueSummary[]> {
  return listPendingDeletionsInOrg(session.organizationId)
}
