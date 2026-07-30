/**
 * Mentions service — addressee resolution, the hand-off lifecycle, and the
 * revocation hook (ADR-0034).
 *
 * The rule this module exists to enforce (spec MN-1):
 *   - no mentions            → the agent answers (today's behaviour, unchanged);
 *   - a human is mentioned   → the agent stays SILENT and the thread waits;
 *   - the agent is mentioned → the agent answers, alongside any humans.
 *
 * The addressee set is computed HERE, once, at persist time, and stored on the
 * message. It is never re-derived from the message text later, and never taken on
 * trust from the client.
 */

import 'server-only'
import type { ShareableResourceType } from '@/lib/db/schema'
import { resolveInboxItemsFor } from '@/lib/inbox/service'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { voidOpenRequestsForResource, voidOpenRequestsForSubject } from './repository'

/**
 * Void every open request against one person on one resource, in the SAME
 * operation that revokes their access (spec MN-9.4).
 *
 * Two things must happen together: the request stops holding the thread hostage
 * (it can never be answered by someone who cannot read it), and the recipient's
 * corresponding inbox item is resolved so it does not sit in their list forever
 * pointing at something they can no longer open.
 *
 * Session-less: the caller (`@/lib/sharing/service`) has already authorized the
 * revocation.
 */
export async function voidRequestsForSubject(
  resourceType: ShareableResourceType,
  resourceId: string,
  subjectUserId: string,
): Promise<number> {
  const voided = await voidOpenRequestsForSubject(resourceType, resourceId, subjectUserId)
  if (voided.length === 0) return 0

  await resolveInboxItemsFor(
    voided.map((request) =>
      inboxGroupKey('mention.requested', resourceType, resourceId, request.anchorId),
    ),
    voided.map((request) => request.requestedOf),
  )
  return voided.length
}

/**
 * Void every open request on a resource — for a soft-delete, where no request can
 * still be meaningfully answered.
 */
export async function voidRequestsForResource(
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<number> {
  const voided = await voidOpenRequestsForResource(resourceType, resourceId)
  if (voided.length === 0) return 0

  await resolveInboxItemsFor(
    voided.map((request) =>
      inboxGroupKey('mention.requested', resourceType, resourceId, request.anchorId),
    ),
    voided.map((request) => request.requestedOf),
  )
  return voided.length
}
