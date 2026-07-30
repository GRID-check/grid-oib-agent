/**
 * Inbox retention (spec IB-15).
 *
 * Inbox items are **derivative data**: every one of them can be re-derived from,
 * or is simply a pointer to, something else that is authoritative. They therefore
 * get a retention period per type rather than living forever.
 *
 * Two independent mechanisms keep the table honest, and both are needed:
 *   1. **Cascade** — items die with their target (`@/lib/collaboration/cleanup`).
 *      This is what handles deletion.
 *   2. **Age** — this module. It handles the long tail nothing ever deletes: a
 *      conversation that stays alive for years still accumulates read activity
 *      notifications that nobody will look at again.
 *
 * Per-type retention comes from the inbox registry, so a new item type declares
 * its own lifetime alongside everything else about it — no second place to update.
 */

import 'server-only'
import { INBOX_TYPE_DEFINITIONS } from '@/lib/inbox/registry'
import { pruneInboxItemsOlderThan } from '@/lib/inbox/repository'
import type { InboxItemType } from '@/lib/db/schema'

/** Cap per invocation so a large backlog is worked off across calls, not in one lock. */
const PRUNE_BATCH = 1000

export interface RetentionResult {
  deleted: number
  /** The oldest retention window applied, for the log line. */
  cutoff: string
}

/**
 * Delete inbox items past their type's retention window.
 *
 * Uses the **longest** retention of any registered type as the cutoff, which is
 * deliberately conservative: it never deletes something a type still wants, at the
 * cost of keeping shorter-lived types a little longer than their nominal window.
 * Per-type precision would mean one delete statement per type, and the value of
 * that precision (a few thousand rows) does not justify the extra statements —
 * revisit if the table ever gets big enough to care.
 */
export async function pruneExpiredInboxItems(now = new Date()): Promise<RetentionResult> {
  const longestDays = Math.max(
    ...Object.values(INBOX_TYPE_DEFINITIONS).map((definition) => definition.retentionDays),
  )
  const cutoff = new Date(now.getTime() - longestDays * 24 * 60 * 60 * 1000)
  const deleted = await pruneInboxItemsOlderThan(cutoff, PRUNE_BATCH)
  if (deleted > 0) {
    console.info(`[retention] pruned ${deleted} inbox items older than ${cutoff.toISOString()}`)
  }
  return { deleted, cutoff: cutoff.toISOString() }
}

/** Retention window of one type, in days — exposed for tests and diagnostics. */
export function retentionDaysFor(type: InboxItemType): number {
  return INBOX_TYPE_DEFINITIONS[type].retentionDays
}
