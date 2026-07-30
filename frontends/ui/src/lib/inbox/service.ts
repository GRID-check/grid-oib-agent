/**
 * Inbox service — emission, reading, and the revocation hooks (ADR-0035).
 *
 * Owns authorization for the recipient-facing operations (a caller may only ever
 * touch their OWN inbox) and the read-time re-authorization that keeps a
 * notification from outliving the access it describes.
 *
 * Emission is called from inside the operation that CAUSED the notification, so
 * "if the mention was stored, the item exists" (spec IB-16). It is therefore
 * written to be cheap and to never surprise its caller with an exception it
 * cannot handle — see {@link emitInboxItems}.
 */

import 'server-only'
import { publishToUser } from '@/lib/events/bus'
import type { InboxItemType, NewInboxItem, ShareableResourceType } from '@/lib/db/schema'
import {
  countPendingInboxItems,
  markItemsInertForResource,
  markItemsInertForSubjectRow,
  resolveInboxItemsByGroupKeys,
  upsertInboxItems,
} from './repository'
import { inboxItemIsActionable } from './registry'

/**
 * One notification to create. `groupKey` decides grouping/dedup/idempotency —
 * build it with the registry's helper rather than by hand.
 */
export interface InboxEmission {
  organizationId: string
  recipientUserId: string
  type: InboxItemType
  resourceType: ShareableResourceType
  resourceId: string
  anchorId?: string | null
  actorUserId?: string | null
  groupKey: string
  payload?: Record<string, unknown>
}

/**
 * Create (or fold) notifications and nudge each recipient's badge.
 *
 * A recipient equal to the actor is dropped: nobody needs to be told about their
 * own action, and self-notification is the most common cause of an inbox that
 * feels like noise.
 */
export async function emitInboxItems(emissions: InboxEmission[]): Promise<number> {
  const rows: NewInboxItem[] = emissions
    .filter((emission) => emission.recipientUserId !== emission.actorUserId)
    .map((emission) => ({
      organizationId: emission.organizationId,
      recipientUserId: emission.recipientUserId,
      type: emission.type,
      resourceType: emission.resourceType,
      resourceId: emission.resourceId,
      anchorId: emission.anchorId ?? null,
      actorUserId: emission.actorUserId ?? null,
      groupKey: emission.groupKey,
      actionable: inboxItemIsActionable(emission.type),
      payload: emission.payload ?? {},
    }))

  if (rows.length === 0) return 0

  const inserted = await upsertInboxItems(rows)

  // Badge nudge per recipient. Publishing is fail-open by construction, and the
  // badge is re-read from Postgres anyway, so a miss costs latency only.
  await Promise.all(
    [...new Set(rows.map((row) => row.recipientUserId))].map(async (recipientUserId) => {
      const emission = rows.find((row) => row.recipientUserId === recipientUserId)
      if (!emission) return
      const pending = await countPendingInboxItems(emission.organizationId, recipientUserId)
      await publishToUser(recipientUserId, { kind: 'inbox.changed', pending, itemType: emission.type })
    }),
  )

  return inserted.length
}

/**
 * Resolve the actionable items belonging to settled requests (spec MN-16).
 *
 * Called by the mentions service when a request is answered, released or voided —
 * the recipient never has to tidy up manually for the inbox to stay accurate.
 */
export async function resolveInboxItemsFor(groupKeys: string[], recipientUserIds: string[]): Promise<number> {
  const resolved = await resolveInboxItemsByGroupKeys(groupKeys)
  await Promise.all(
    [...new Set(recipientUserIds)].map((userId) => publishToUser(userId, { kind: 'inbox.changed', pending: -1 })),
  )
  return resolved
}

/**
 * Neutralise one person's items for a resource, in the SAME operation that
 * revokes their access (spec IB-14).
 *
 * Session-less: the caller (`@/lib/sharing/service`) has already authorized the
 * revocation. Wipes the stored payload, so a quoted snippet cannot survive the
 * access it was quoted from.
 */
export async function markItemsInertForSubject(
  resourceType: ShareableResourceType,
  resourceId: string,
  subjectUserId: string,
): Promise<number> {
  const affected = await markItemsInertForSubjectRow(resourceType, resourceId, subjectUserId)
  if (affected > 0) {
    await publishToUser(subjectUserId, { kind: 'inbox.changed', pending: -1 })
  }
  return affected
}

/**
 * Neutralise EVERY item pointing at a resource — for a soft-delete, where nobody
 * should be left with a working link.
 */
export async function markItemsInertForDeletedResource(
  resourceType: ShareableResourceType,
  resourceId: string,
): Promise<number> {
  return markItemsInertForResource(resourceType, resourceId)
}
