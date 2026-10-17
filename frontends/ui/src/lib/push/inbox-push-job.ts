/**
 * The `inbox_push` job: tell one person's devices about one inbox item
 * (ADR-0112). Queued by `./enqueue.ts` at the inbox's write path, run by the
 * `bff-jobs` pool, so the request that wrote the item never waits on a push
 * service.
 *
 * ## It decides again, at the moment it sends
 *
 * The payload is three ids and a stamp; everything that decides whether and what
 * to send is read when the job runs, because a job can wait, and a notification
 * cannot be taken back once it is on a lock screen:
 *
 *   1. the person is still a member of the organization (today's role, from the
 *      identity provider). If the identity provider says not, their devices
 *      here are removed; if it could not be asked, the job throws and retries;
 *   2. the item is still theirs, unread and not resolved, archived or inert;
 *   3. nothing newer superseded it: a burst of occurrences folds into one row,
 *      and only the job carrying the row's latest stamp sends, so twenty
 *      messages are one notification;
 *   4. the person's categories include its type;
 *   5. the person could see it in the inbox right now (`viewInboxItemAs`), the
 *      same re-authorization the list does. Not visible, nothing is sent: never
 *      a vaguer notification in its place;
 *   6. the payload says what the person's lock-screen choice allows.
 *
 * ## Failure
 *
 * A subscription the push service has forgotten (404, 410) is removed. A final
 * refusal counts against the device and removes it past
 * {@link MAX_CONSECUTIVE_FAILURES}. A transient failure throws so the queue tries
 * again with its backoff; sends are safe to repeat, because the tag and the Topic
 * replace an earlier message for the same group. On the last attempt the failure
 * is counted and the job ends quietly: the item is in the inbox either way.
 */

import 'server-only'
import { captureServer } from '@/lib/analytics/posthog-server'
import { resolvePinnedRequesterSessionStrict } from '@/lib/auth/pinned-session'
import type { Locale } from '@/i18n/config'
import { resolvePushPreferences } from '@/lib/inbox/push-categories'
import { isPushStillDue, isPushWanted, pushCategoryOf, pushPolicyFor, PUSH_TTL_SECONDS } from '@/lib/inbox/push-policy'
import { findInboxItemForRecipient } from '@/lib/inbox/repository'
import { viewInboxItemAs } from '@/lib/inbox/service'
import type { JobAttempt } from '@/lib/jobs-queue/types'
import { findUserPreferences } from '@/lib/user-preferences/repository'
import { webPushConfig } from './config'
import { buildPushMessage, pushTagFor } from './payload'
import {
  deleteAllSubscriptionsOf,
  deleteSubscriptionById,
  listSubscriptions,
  recordDelivered,
  recordFailure,
} from './repository'
import { createWebPushSender, type PushSender, type PushSendOutcome } from './sender'

/** Consecutive refused or failed sends after which a device is dropped. */
export const MAX_CONSECUTIVE_FAILURES = 5

export interface InboxPushPayload {
  itemId: string
  recipientUserId: string
  /** The row's `updated_at` when the job was queued; a newer row has its own job. */
  stamp: string
}

export type InboxPushResult =
  | { sent: false; reason: string }
  | { sent: true; delivered: number; gone: number; rejected: number; transient: number }

function localeOf(prefs: Record<string, unknown> | null): Locale {
  return prefs?.locale === 'en' ? 'en' : 'de'
}

interface Tally {
  delivered: number
  gone: number
  rejected: number
  transient: number
}

/** Apply one device's outcome to its row. */
async function settle(
  id: string,
  outcome: PushSendOutcome,
  attempt: JobAttempt,
  tally: Tally
): Promise<void> {
  if (outcome.kind === 'delivered') {
    tally.delivered += 1
    await recordDelivered(id)
    return
  }
  if (outcome.kind === 'gone') {
    tally.gone += 1
    await deleteSubscriptionById(id)
    return
  }
  if (outcome.kind === 'transient') tally.transient += 1
  else tally.rejected += 1
  // A transient failure that will be retried is not yet the device's fault.
  if (outcome.kind === 'transient' && !attempt.last) return
  const failures = await recordFailure(id)
  if (failures !== null && failures >= MAX_CONSECUTIVE_FAILURES) await deleteSubscriptionById(id)
}

export async function runInboxPush(
  organizationId: string,
  payload: InboxPushPayload,
  attempt: JobAttempt,
  sender?: PushSender
): Promise<InboxPushResult> {
  const config = webPushConfig()
  if (!config) return { sent: false, reason: 'off' }
  const { recipientUserId: userId } = payload

  // Strict: a WorkOS lookup that fails throws (the queue retries) instead of
  // reading as "left the organization", which would remove every device.
  const session = await resolvePinnedRequesterSessionStrict({ userId, email: null, organizationId })
  if (!session) {
    await deleteAllSubscriptionsOf(organizationId, userId)
    return { sent: false, reason: 'not-a-member' }
  }

  const row = await findInboxItemForRecipient(organizationId, userId, payload.itemId)
  if (!row || !isPushStillDue(row)) return { sent: false, reason: 'no-longer-news' }
  if (row.updatedAt.toISOString() !== payload.stamp) return { sent: false, reason: 'superseded' }

  const prefs = await findUserPreferences(userId, organizationId)
  const preferences = resolvePushPreferences(prefs?.pushNotifications)
  if (!isPushWanted(row.type, preferences, row.payload)) return { sent: false, reason: 'category-off' }

  const view = await viewInboxItemAs(session, row)
  if (!view) return { sent: false, reason: 'not-visible' }
  const message = buildPushMessage(view, row.groupKey, preferences, localeOf(prefs))
  if (!message) return { sent: false, reason: 'no-address' }

  const devices = await listSubscriptions(organizationId, userId)
  if (devices.length === 0) return { sent: false, reason: 'no-devices' }

  const policy = pushPolicyFor(row.type)
  const urgency = policy?.urgency ?? 'normal'
  const body = JSON.stringify(message)
  const send = sender ?? createWebPushSender(config)
  const tally: Tally = { delivered: 0, gone: 0, rejected: 0, transient: 0 }
  await Promise.all(
    devices.map(async (device) => {
      const outcome = await send.send(device, body, {
        ttlSeconds: PUSH_TTL_SECONDS[urgency],
        urgency,
        topic: pushTagFor(row.groupKey),
      })
      await settle(device.id, outcome, attempt, tally)
    })
  )

  if (tally.gone + tally.rejected + tally.transient > 0) {
    console.warn('[push] some devices were not reached', { type: row.type, devices: devices.length, ...tally })
  }
  captureServer({
    event: 'push_notification_sent',
    distinctId: null,
    organizationId,
    properties: { item_type: row.type, category: pushCategoryOf(row.type, row.payload), urgency, devices: devices.length, ...tally },
  })
  if (tally.transient > 0 && !attempt.last) {
    throw new Error(`[push] ${tally.transient} of ${devices.length} devices could not be reached; trying again`)
  }
  return { sent: true, ...tally }
}
