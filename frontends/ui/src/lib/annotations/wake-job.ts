/**
 * Run one wake of Piloti (ADR-0106): the `piloti_wake` job of the bff-jobs
 * pool, as the person whose act woke it.
 *
 * Everything is asked again here, because a wake can wait in the queue and
 * the person's rights are those of today, not of the moment they replied:
 *
 * 1. The person, resolved from WorkOS now (`resolvePinnedRequesterSession`);
 *    a person who left ends the wake.
 * 2. The organization's switch, from their session's flags.
 * 3. Their right to write the document, and the mark still there.
 * 4. The caps, counting the wakes recorded ahead of this one.
 * 5. Their thread about the document (`./document-thread.ts`), and the
 *    trigger written into it as a message: who, which mark, what they wrote.
 * 6. The turn context for their pinned session and that thread
 *    (`resolveTurnContext`), which refuses a spent budget.
 * 7. The chat socket, opened as an internal caller with the signed envelope
 *    (the thread inside it) and `X-AIQ-Mode: headless`
 *    (`lib/turns/headless-turn.ts`), and one `user_message` with `trigger`,
 *    `if_idle`, the mark's region and `reply_in_thread`.
 *
 * A turn already running in the thread is never superseded (`if_idle`): the
 * answer is `busy`, and the job waits (`notBefore`) without spending an
 * attempt. `duplicate_turn` is a wake already answered. Every way it ends
 * without a turn is recorded on its `piloti_wakes` row and in the audit trail;
 * a turn that started is in the trail as `piloti.wake.started` and has its
 * trace in Langfuse. A wake that was refused or gave up is then ended as a
 * turn's end is (`lib/turns/outcome.ts`): a delegated mark is handed back, the
 * trail records the end (`piloti.wake.ended`), and the person who woke Piloti
 * hears why (`piloti.work_failed`). A suppressed wake tells nobody: the
 * person's own act, a rule or a cap held it (`piloti.wake.suppressed`).
 */

import 'server-only'
import { ApiError } from '@/lib/api/errors'
import { isAuthzError } from '@/lib/auth-utils'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { insertMessages } from '@/lib/conversations/repository'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import type { Document } from '@/lib/db/schema'
import { getAccessibleDocument } from '@/lib/documents/access'
import type { JobAttempt, JobSliceResult, PilotiWakePayload } from '@/lib/jobs-queue/types'
import { publishToDocumentRoom } from '@/lib/realtime/document-channel'
import { chatSocketUrl, runHeadlessTurn, type HeadlessUserMessage } from '@/lib/turns/headless-turn'
import { resolveTurnContext, TurnBudgetExhaustedError } from '@/lib/turns/turn-context'
import { turnContextHeaders } from '@/lib/turns/turn-headers.js'
import { onWakeEnded } from './attention'
import { ensureDocumentThread } from './document-thread'
import { findDocumentAnnotation, type AnnotationRecord } from './repository'
import { regionAround } from './types'
import { auditSuppressedWake, capReached, wakesEnabled } from './wake'
import { auditWakeEnded, auditWakeStarted, type AuditedWake } from './wake-audit'
import { delegationEventId } from './wake-ids'
import { announcePilotiWork } from './piloti-work'
import { findWake, handBackDelegation, settleWake } from './wake-repository'

/** The hello entries a server must name before a wake is sent: without `if_idle` it would supersede. */
export const WAKE_REQUIRES = [
  'user_message.trigger',
  'user_message.if_idle',
  'user_message.focus_region',
  'user_message.reply_in_thread',
] as const

/** How often a wake waits (a busy thread, no server) before it gives up. ~45 minutes in all. */
export const MAX_WAKE_WAITS = 12
const FIRST_WAIT_MS = 15_000
const LONGEST_WAIT_MS = 5 * 60_000

/** How long the wake waits before it asks again, after `waits` waits. */
export const waitAfter = (waits: number): number => Math.min(FIRST_WAIT_MS * 2 ** waits, LONGEST_WAIT_MS)

type Result = JobSliceResult<PilotiWakePayload>

/** What the turn is asked: the reply that woke Piloti, or the mark handed to it. */
function questionOf(payload: PilotiWakePayload, mark: AnnotationRecord): string | null {
  if (payload.trigger === 'assigned') return mark.body
  return mark.replies.find((reply) => reply.id === payload.eventId)?.body ?? null
}

/** The line the thread keeps of the trigger: who, which mark, what they wrote. */
function triggerLine(payload: PilotiWakePayload, mark: AnnotationRecord, who: string, text: string): string {
  if (payload.trigger === 'assigned') return `${who} hat Anmerkung ${mark.number} an Piloti delegiert: „${text}“`
  return `${who} in Anmerkung ${mark.number}: „${text}“`
}

/** The question as the wire carries it (`docs/api/websocket-protocol.md`, „A turn an event woke"). */
export function wakeMessage(input: {
  payload: PilotiWakePayload
  conversationId: string
  doc: Pick<Document, 'id' | 'scope' | 'filename' | 'displayName'>
  mark: Pick<AnnotationRecord, 'id' | 'page' | 'x' | 'y' | 'w' | 'h'>
  text: string
  authorName: string | null
}): HeadlessUserMessage {
  const { payload, doc, mark } = input
  return {
    type: 'user_message',
    conversation_id: input.conversationId,
    message_id: payload.wakeId,
    text: input.text,
    author_name: input.authorName,
    focus_file_name: doc.displayName?.trim() || doc.filename,
    focus_shelf: doc.scope === 'archiv' ? 'archiv' : 'project',
    focus_document_id: doc.id,
    focus_region: { ...regionAround(mark), annotation_id: mark.id },
    reply_in_thread: true,
    trigger: { kind: payload.trigger, event_id: payload.eventId, annotation_id: payload.annotationId },
    if_idle: true,
    reasoning_effort: 'low',
  }
}

/** Write the trigger into the thread, once: its id is the turn's, so a retry writes nothing. */
async function recordTrigger(
  conversationId: string,
  payload: PilotiWakePayload,
  mark: AnnotationRecord,
  who: string,
  text: string
): Promise<void> {
  await insertMessages([
    {
      id: payload.wakeId,
      conversationId,
      role: 'user',
      authorUserId: payload.actor.userId,
      content: triggerLine(payload, mark, who, text),
      metadata: {
        messageType: 'user',
        trigger: {
          kind: payload.trigger,
          eventId: payload.eventId,
          annotationId: payload.annotationId,
          annotationNumber: mark.number,
          documentId: payload.documentId,
        },
      },
    },
  ])
}

/** The wake as the audit trail names it (`./wake-audit.ts`). */
const auditedWake = (
  organizationId: string,
  payload: PilotiWakePayload,
  doc: Document,
  mark: AnnotationRecord
): AuditedWake => ({
  organizationId,
  wakeId: payload.wakeId,
  documentId: doc.id,
  annotationId: mark.id,
  trigger: payload.trigger,
  wokenBy: payload.actor,
  projectId: doc.projectId ?? null,
  markNumber: mark.number,
})

/** Hand a delegation still this wake's back, and tell the room; whether it was handed back. Never throws. */
async function handBack(organizationId: string, payload: PilotiWakePayload, doc: Document, mark: AnnotationRecord) {
  const delegatedAt = mark.delegatedAt ? new Date(mark.delegatedAt) : null
  const ownsDelegation =
    payload.trigger === 'assigned' && delegatedAt !== null && delegationEventId(mark.id, delegatedAt) === payload.eventId
  if (!ownsDelegation || !delegatedAt) return false
  try {
    const handedBack = await withTenant({ organizationId }, () =>
      handBackDelegation(getDb(), organizationId, mark.id, delegatedAt)
    )
    if (handedBack) {
      await publishToDocumentRoom(doc.id, {
        kind: 'annotations.changed',
        annotationIds: [mark.id],
        change: 'updated',
        actor: { peerId: null, userId: payload.actor.userId, name: 'Piloti', kind: 'piloti' },
      }).catch(() => undefined)
    }
    return handedBack
  } catch (error) {
    console.error('[wake-job] the mark could not be handed back after the wake ended:', error)
    return false
  }
}

/**
 * A wake the job ended without an answer (`refused`, or `failed` after its
 * waits or a rejected message), once this call settled it: afterwards the
 * same as a turn's end (`lib/turns/outcome.ts`). A delegation still this
 * wake's is handed back, so the mark stops reading „Piloti arbeitet daran",
 * the audit trail records the end (`piloti.wake.ended`, without a turn
 * outcome), and the person who woke Piloti is told why (`onWakeEnded`).
 * Nothing here fails the job.
 */
async function afterEndWithoutAnswer(input: {
  organizationId: string
  payload: PilotiWakePayload
  doc: Document
  mark: AnnotationRecord
  status: 'refused' | 'failed'
  reason: string
}): Promise<void> {
  const { organizationId, payload, doc, mark, status, reason } = input
  const handedBack = await handBack(organizationId, payload, doc, mark)
  auditWakeEnded(auditedWake(organizationId, payload, doc, mark), {
    outcome: status,
    turnOutcome: null,
    reason,
    handedBack,
  })
  await onWakeEnded({
    organizationId,
    documentId: doc.id,
    annotationId: mark.id,
    annotationNumber: mark.number,
    projectId: doc.projectId ?? null,
    actorUserId: payload.actor.userId,
    trigger: payload.trigger,
    outcome: 'failed',
    reason,
    markText: mark.body,
  })
}

/** The person's document, for writing, today; null when they may no longer write it. */
async function writableDocument(session: AuthorizedSession, documentId: string): Promise<Document | null> {
  try {
    return await getAccessibleDocument(session, documentId, 'write')
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return null
    throw error
  }
}

export async function runPilotiWake(
  organizationId: string,
  payload: PilotiWakePayload,
  attempt: JobAttempt
): Promise<Result> {
  const done: Result = { done: true, payload }
  const wake = await findWake(organizationId, payload.wakeId)
  // Settled by an earlier run of this job, or gone with its mark.
  if (!wake || wake.status !== 'queued') return done

  // Nothing to tell: the person's own act, a rule or a cap held it.
  const end = async (status: 'suppressed', reason: string): Promise<Result> => {
    if (await settleWake(organizationId, payload.wakeId, { status, reason })) {
      void announcePilotiWork(wake)
      auditSuppressedWake({
        organizationId,
        actor: payload.actor,
        annotationId: payload.annotationId,
        documentId: payload.documentId,
        trigger: payload.trigger,
        status,
        reason,
        stage: 'claim',
      })
    }
    return done
  }

  const session = await resolvePinnedRequesterSession({
    userId: payload.actor.userId,
    email: payload.actor.email,
    organizationId,
  })
  if (!session) return end('suppressed', 'the person is no longer a member')
  if (!wakesEnabled(session)) return end('suppressed', 'piloti-wakes is off for the organization')
  const doc = await writableDocument(session, payload.documentId)
  if (!doc) return end('suppressed', 'the person may no longer write the document')
  const mark = await findDocumentAnnotation(organizationId, doc.id, payload.annotationId)
  if (!mark) return end('suppressed', 'the mark is gone')
  // Piloti was asked and did not answer: the person hears why, as from a turn's end. Only
  // the settle that moved it from `queued` goes on: a turn that already reported its end adds nothing.
  const fail = async (status: 'refused' | 'failed', reason: string): Promise<Result> => {
    if (await settleWake(organizationId, payload.wakeId, { status, reason })) {
      void announcePilotiWork(wake)
      await afterEndWithoutAnswer({ organizationId, payload, doc, mark, status, reason })
    }
    return done
  }
  const wait = (reason: string): Promise<Result> | Result => {
    if (payload.waits >= MAX_WAKE_WAITS) return fail('failed', `gave up waiting: ${reason}`)
    return {
      done: false,
      payload: { ...payload, waits: payload.waits + 1 },
      notBefore: new Date(Date.now() + waitAfter(payload.waits)),
    }
  }
  // A delegation taken back (or re-delegated) since this wake was queued must
  // not still run: the take-back suppresses the queued wake after its commit,
  // and a crash in between would otherwise leave it to run anyway.
  if (
    payload.trigger === 'assigned' &&
    (!mark.delegatedAt || delegationEventId(mark.id, mark.delegatedAt) !== payload.eventId)
  ) {
    return end('suppressed', 'taken back')
  }
  const cap = await capReached(getDb(), { organizationId, annotationId: mark.id, actor: payload.actor }, new Date(), undefined, {
    createdAt: wake.createdAt,
    id: wake.id,
  })
  if (cap) return end('suppressed', cap)
  const text = questionOf(payload, mark)?.trim()
  if (!text) return end('suppressed', 'the reply is gone')

  // The pinned session knows the person by name (`resolvePerson`), as a live one does.
  const authorName = session.name
  let conversationId: string
  try {
    conversationId = await ensureDocumentThread(session, doc)
  } catch (error) {
    if (isAuthzError(error)) return end('suppressed', 'the person may no longer chat here')
    // Their thread is being deleted: its id comes free once the erasure ran.
    if (error instanceof ApiError && error.status === 409) return wait('the thread is being deleted')
    throw error
  }
  await recordTrigger(conversationId, payload, mark, authorName || session.email || 'Jemand', text)

  let context: Awaited<ReturnType<typeof resolveTurnContext>>
  try {
    context = await resolveTurnContext(session, { projectId: doc.projectId ?? undefined, conversationId })
  } catch (error) {
    if (error instanceof TurnBudgetExhaustedError) return fail('refused', `budget: ${error.message}`)
    if (isAuthzError(error)) return end('suppressed', 'the person may no longer chat here')
    throw error
  }
  const secret = process.env.GRID_INTERNAL_API_TOKEN
  // Without it the envelope is unsigned and the backend would not trust it: a
  // deployment fault, which the queue's retries and dead row make visible.
  if (!secret) throw new Error('GRID_INTERNAL_API_TOKEN is not set: a wake cannot sign its turn')

  const outcome = await runHeadlessTurn({
    url: chatSocketUrl(conversationId),
    conversationId,
    projectId: context.projectId,
    headers: { ...turnContextHeaders(context, { issuedAt: Date.now(), secret }), 'x-aiq-mode': 'headless' },
    message: wakeMessage({ payload, conversationId, doc, mark, text, authorName }),
    requires: WAKE_REQUIRES,
  })
  switch (outcome.kind) {
    case 'started':
    case 'duplicate':
      // Only the settle that moved it from `queued`: a second run of the job, or
      // a turn that already reported its end, adds no line.
      if (await settleWake(organizationId, payload.wakeId, { status: 'started' })) {
        void announcePilotiWork(wake)
        auditWakeStarted(auditedWake(organizationId, payload, doc, mark), payload.waits)
      }
      return done
    case 'busy':
      return wait('another turn of the thread ran')
    case 'unavailable':
      return wait(outcome.reason)
    case 'refused':
      return fail('refused', outcome.reason)
    case 'rejected':
      // The session or the envelope was wrong: a fresh one may not be, so the
      // queue retries it, and the last attempt records why it gave up.
      if ((outcome.code === 'auth_expired' || outcome.code === 'conversation_mismatch') && !attempt.last) {
        throw new Error(`the chat socket refused the wake: ${outcome.code}`)
      }
      return fail('failed', `rejected: ${outcome.code}${outcome.message ? ` (${outcome.message})` : ''}`)
  }
}
