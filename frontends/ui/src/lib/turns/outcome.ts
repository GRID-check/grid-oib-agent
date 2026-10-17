/**
 * How a woken turn ENDED (ADR-0106, amended by ADR-0109): the chat socket
 * posts every headless turn's outcome to `POST /api/internal/turns/outcome`,
 * and this is what the BFF does with it.
 *
 * The BFF detaches from a woken turn once it runs, so `piloti_wakes` stayed at
 * `started` for ever. The turn id is the wake id (`wakeTurnId`), so the outcome
 * names its wake. It is mapped to the wake's final word with `endWake`:
 *
 * | Outcome | Wake |
 * |---|---|
 * | `answered`, `handed_off` | `answered` |
 * | `stopped` | `stopped` |
 * | `refused`, `failed` | `failed`, with the reason |
 *
 * When the wake was a DELEGATION, its end hands the mark back, but only while
 * the mark is still delegated by THAT delegation: a person who took it back
 * and delegated it again in between must not lose the second. Then the audit
 * trail records the end (`piloti.wake.ended`, every outcome, the failure's
 * reason included) and `onWakeEnded` tells the attention slice, each once.
 *
 * Idempotent and forgiving: a turn that is not a wake (a browser's), a
 * conversation that is not the wake's thread, and a wake that already ended
 * settle nothing and say so (`{ settled: false }`), because the socket posts
 * every headless turn and has nothing to do with the answer. A wake still
 * `queued` IS ended: a turn that errors at once can report before the job has
 * marked the wake started, and that end must not be lost (`endWake`).
 */

import 'server-only'
import { onWakeEnded } from '@/lib/annotations/attention'
import { auditWakeEnded } from '@/lib/annotations/wake-audit'
import { findDocumentAnnotation } from '@/lib/annotations/repository'
import { delegationEventId, documentThreadConversationId } from '@/lib/annotations/wake-ids'
import {
  endWake,
  findWakeById,
  handBackDelegation,
  type WakeEnd,
} from '@/lib/annotations/wake-repository'
import { getDb } from '@/lib/db'
import type { PilotiWakeRow } from '@/lib/db/schema'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { memberReader } from '@/lib/documents/document-reader'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { announcePilotiWork } from '@/lib/annotations/piloti-work'
import type { TurnOutcomeRequest, TurnOutcomeResponse } from './outcome-types'

/** What the wake records when a turn failed or was refused without saying why. */
export const DEFAULT_FAILURE_REASON = 'the turn ended without an answer'

/** The wake's final word for a turn's outcome. */
export function wakeEndOf(request: Pick<TurnOutcomeRequest, 'outcome' | 'reason'>): WakeEnd {
  switch (request.outcome) {
    case 'answered':
    case 'handed_off':
      return { status: 'answered' }
    case 'stopped':
      return { status: 'stopped' }
    case 'refused':
    case 'failed':
      return { status: 'failed', reason: request.reason?.trim() || DEFAULT_FAILURE_REASON }
  }
}

const NOT_SETTLED: TurnOutcomeResponse = { settled: false }

/**
 * The wake in one transaction: its end, and the mark handed back when its
 * delegation is still the mark's. The delegation is read first and handed back
 * with a compare-and-swap on its timestamp, so a re-delegation in between
 * (which reads as a different moment) is never cleared.
 */
async function endInTransaction(
  wake: PilotiWakeRow,
  end: WakeEnd
): Promise<{ ended: PilotiWakeRow; markNumber: number | null; markText: string | null; handedBack: boolean } | null> {
  const mark = await findDocumentAnnotation(wake.organizationId, wake.documentId, wake.annotationId)
  const delegatedAt = mark?.delegatedAt ? new Date(mark.delegatedAt) : null
  const ownsDelegation =
    wake.triggerKind === 'assigned' &&
    delegatedAt !== null &&
    delegationEventId(wake.annotationId, delegatedAt) === wake.eventId
  const db = getDb()
  return withTenant({ organizationId: wake.organizationId }, () =>
    db.transaction(async (tx) => {
      const ended = await endWake(tx, wake.organizationId, wake.id, end)
      if (!ended) return null
      const handedBack =
        ownsDelegation && delegatedAt
          ? await handBackDelegation(tx, wake.organizationId, wake.annotationId, delegatedAt)
          : false
      return { ended, markNumber: mark?.number ?? null, markText: mark?.body ?? null, handedBack }
    })
  )
}

/** The wake's document as the person whose act woke Piloti reads it: theirs to write, so theirs to read. */
async function wakeDocument(wake: PilotiWakeRow) {
  try {
    return await findDocumentInOrg(wake.documentId, wake.organizationId, memberReader(wake.actorUserId))
  } catch (error) {
    console.error('[turns/outcome] could not read the document of a wake that ended:', error)
    return null
  }
}

/**
 * After the commit, never failing the outcome: the room re-reads the mark, the
 * audit trail records how the turn ended (`piloti.wake.ended`), attention
 * hears the end.
 */
async function afterEnd(
  wake: PilotiWakeRow,
  end: WakeEnd,
  done: { markNumber: number | null; markText: string | null; handedBack: boolean },
  turnOutcome: TurnOutcomeRequest['outcome']
): Promise<void> {
  // Every end moves the mark's „Piloti arbeitet" line (`piloti-work.ts`), handed back or not.
  await announcePilotiWork(wake)
  const doc = await wakeDocument(wake)
  auditWakeEnded(
    {
      organizationId: wake.organizationId,
      wakeId: wake.id,
      documentId: wake.documentId,
      annotationId: wake.annotationId,
      trigger: wake.triggerKind,
      wokenBy: { userId: wake.actorUserId, email: null },
      projectId: doc?.projectId ?? null,
      markNumber: done.markNumber,
    },
    {
      outcome: end.status,
      turnOutcome,
      reason: end.status === 'failed' ? end.reason : null,
      handedBack: done.handedBack,
    }
  )
  if (done.markNumber === null || !doc) return
  try {
    await onWakeEnded({
      organizationId: wake.organizationId,
      documentId: wake.documentId,
      annotationId: wake.annotationId,
      annotationNumber: done.markNumber,
      projectId: doc.projectId ?? null,
      actorUserId: wake.actorUserId,
      trigger: wake.triggerKind,
      outcome: end.status,
      reason: end.status === 'failed' ? end.reason : null,
      markText: done.markText,
    })
  } catch (error) {
    console.error('[turns/outcome] attention failed after a wake ended:', error)
  }
}

/**
 * Record how a turn ended. `{ settled: true }` only for the call that closed a
 * `queued` or `started` wake; every other case is `{ settled: false }`.
 */
export async function recordTurnOutcome(request: TurnOutcomeRequest): Promise<TurnOutcomeResponse> {
  // The turn names its wake and the wake names the organization, so this one
  // lookup has no tenant yet; everything after it is that organization's.
  const wake = await withPlatformAccess(
    'turn outcome: the chat socket names a turn by id, before any organization is known',
    () => findWakeById(request.turnId)
  )
  if (!wake || (wake.status !== 'started' && wake.status !== 'queued')) return NOT_SETTLED
  // The thread the wake ran in is derived, never stored; a mismatch is a turn that is not this wake's.
  if (request.conversationId !== documentThreadConversationId(wake.documentId, wake.actorUserId)) return NOT_SETTLED

  const end = wakeEndOf(request)
  const done = await endInTransaction(wake, end)
  if (!done) return NOT_SETTLED
  await afterEnd(done.ended, end, done, request.outcome)
  return { settled: true }
}
