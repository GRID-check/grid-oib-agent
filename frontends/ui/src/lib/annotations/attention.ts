import 'server-only'
/**
 * What on a mark needs a person's attention, as inbox items (ADR-0035, ADR-0109).
 *
 * The call sites name the EVENT; this module decides which person gets which
 * item, and resolves items whose cause is gone. Every function is best-effort:
 * it never throws into the write that called it.
 *
 * | Event | Item | For |
 * |---|---|---|
 * | A woken turn on a delegated mark ended `answered` | `piloti.work_done` | who delegated it |
 * | … ended `failed` | `piloti.work_failed` | who delegated it |
 * | A woken turn on a mention or an answer ended `answered` | `piloti.work_done` | who mentioned or answered |
 * | … ended `failed` | `piloti.work_failed` | who mentioned or answered |
 * | The wake job was refused, or gave up, before a turn answered | `piloti.work_failed` | whoever woke Piloti |
 * | Any woken turn ended `stopped` | none: the person stopped it | |
 * | Piloti set a Rückfrage, or replied on its own open Rückfrage | `piloti.asks_you` | the mark's Zuständige, else the person its turn acted for |
 * | Piloti set another mark, or replied on another | none: ordinary work | |
 * | A person answered in the thread | resolves their `piloti.asks_you` | |
 * | The mark was resolved, dismissed or deleted | resolves everyone's `piloti.asks_you` | |
 *
 * The items belong to a Piloti turn, so they carry no actor: Piloti did it, and
 * an actor equal to the recipient would make `emitInboxItems` drop the row.
 * They point at the document, anchored on the mark, and `lib/inbox/targets`
 * builds the link that opens the Prüfansicht at it. Access is the document's,
 * re-derived when the row is read. They carry the document's name and the
 * mark's number, so the row says which mark in which document; as the excerpt,
 * a Rückfrage carries Piloti's question and a finished or failed wake what the
 * mark says. A failed wake carries the class of its reason as the row's
 * `variant` (`./wake-end-reason.ts`), so the notice says why in words the
 * person can act on, never the stored reason itself.
 */

import { findDocumentAnnotation, type AnnotationRecord } from './repository'
import { isLive } from './types'
import { wakeEndReasonKind } from './wake-end-reason'
import { bestEffortInbox } from '@/lib/inbox/best-effort'
import { inboxGroupKey } from '@/lib/inbox/registry'
import { emitInboxItems, resolveInboxItemsAnchoredOn, type InboxTypeWithoutParams } from '@/lib/inbox/service'
import { describeResource } from '@/lib/sharing/registry'

/** The mark an event is about. */
export interface MarkRef {
  organizationId: string
  documentId: string
  annotationId: string
  /** The mark's running number („Anmerkung 4“). */
  annotationNumber: number
  /** The document's project; null on the Büroablage. */
  projectId: string | null
}

/** Longest question quoted in a row. */
const EXCERPT_LENGTH = 160

function excerptOf(text: string | null | undefined): string | null {
  const trimmed = text?.replace(/\s+/g, ' ').trim()
  if (!trimmed) return null
  return trimmed.length > EXCERPT_LENGTH ? `${trimmed.slice(0, EXCERPT_LENGTH - 1)}…` : trimmed
}

/** The document's name for the row, or null when it cannot be read (the row then names no file). */
async function documentName(ref: MarkRef): Promise<string | null> {
  try {
    const found = await describeResource('document').describeRef(ref.documentId, ref.organizationId)
    return found?.title ?? null
  } catch {
    return null
  }
}

/** One item about a mark, addressed to one person. `variant` picks the row's wording, where its type has more than one. */
async function emitAboutMark(
  type: InboxTypeWithoutParams,
  ref: MarkRef,
  recipientUserId: string,
  excerpt: string | null,
  variant: string | null = null
): Promise<void> {
  const subject = await documentName(ref)
  await emitInboxItems([
    {
      organizationId: ref.organizationId,
      recipientUserId,
      type,
      resourceType: 'document',
      resourceId: ref.documentId,
      anchorId: ref.annotationId,
      actorUserId: null,
      groupKey: inboxGroupKey(type, 'document', ref.documentId, ref.annotationId),
      payload: {
        ...(subject ? { subject } : {}),
        related: String(ref.annotationNumber),
        ...(excerpt ? { excerpt } : {}),
        ...(variant ? { variant } : {}),
      },
    },
  ])
}

/**
 * A wake on a mark ended: its turn's outcome (`lib/turns/outcome.ts`), or the
 * wake job giving up or being refused before a turn answered
 * (`./wake-job.ts`). `actorUserId` is the person whose act woke Piloti: who
 * mentioned it, answered it, or delegated the mark. Called once per wake, with
 * its final word. `reason` is the wake's stored reason for a failure;
 * `markText` what the mark says, quoted so the person knows which one it was.
 */
export async function onWakeEnded(
  input: MarkRef & {
    actorUserId: string
    trigger: 'thread_mention' | 'thread_reply' | 'assigned'
    outcome: 'answered' | 'stopped' | 'failed'
    reason?: string | null
    markText?: string | null
  }
): Promise<void> {
  // A person stopped it, or took the mark back: they know.
  if (input.outcome === 'stopped') return
  // A mention or an answer that got nothing back would otherwise vanish: the
  // person asked Piloti something and waits in a thread that never says it
  // failed. The copy (`pilotiWorkFailed`) is the same for all three triggers;
  // what differs is why, and that is the variant.
  const type = input.outcome === 'answered' ? 'piloti.work_done' : 'piloti.work_failed'
  // Always named on a failure: rows fold per mark and their payloads merge, so
  // an absent variant would keep an earlier failure's cause.
  const variant = input.outcome === 'failed' ? (wakeEndReasonKind('failed', input.reason ?? null) ?? 'error') : null
  await bestEffortInbox(`${type} for mark ${input.annotationId}`, input.organizationId, () =>
    emitAboutMark(type, input, input.actorUserId, excerptOf(input.markText), variant)
  )
}

/**
 * Whether Piloti's write waits on a person: its own Rückfrage, still live. An
 * answer to a person's question, or a reply on an ordinary mark, is work that
 * is shown in the thread and tells nobody to do anything.
 */
function waitsOnPerson(mark: AnnotationRecord): boolean {
  return mark.kind === 'question' && mark.authorKind === 'piloti' && isLive(mark)
}

/**
 * Piloti wrote on a mark in a turn (`lib/annotations/agent.ts`): set a mark
 * (`question` when it is a question), or replied in its thread. `onBehalfOf`
 * is the person the turn acted for; `assigneeUserId` the mark's responsible
 * person, if any.
 */
export async function onPilotiWrote(
  input: MarkRef & {
    onBehalfOf: string
    assigneeUserId: string | null
    what: 'mark' | 'question' | 'reply'
    replyId: string | null
  }
): Promise<void> {
  if (input.what === 'mark') return
  await bestEffortInbox(`piloti.asks_you for mark ${input.annotationId}`, input.organizationId, async () => {
    const mark = await findDocumentAnnotation(input.organizationId, input.documentId, input.annotationId)
    // Gone since: nobody can answer it.
    if (!mark) return
    if (!waitsOnPerson(mark)) return
    const written =
      input.what === 'reply' ? mark.replies.find((reply) => reply.id === input.replyId)?.body : mark.body
    await emitAboutMark('piloti.asks_you', input, input.assigneeUserId ?? input.onBehalfOf, excerptOf(written))
  })
}

/**
 * A person answered in a mark's thread, or the mark was resolved, dismissed
 * or deleted (`lib/annotations/service.ts`): whatever Piloti asked there is no
 * longer waiting on them.
 */
export async function onMarkSettledByPerson(
  input: Pick<MarkRef, 'organizationId' | 'annotationId'> & { userId: string; closed: boolean }
): Promise<void> {
  await bestEffortInbox(`settling mark ${input.annotationId}`, input.organizationId, () =>
    resolveInboxItemsAnchoredOn({
      organizationId: input.organizationId,
      types: ['piloti.asks_you'],
      anchorId: input.annotationId,
      // An answer settles it for the person who gave it; a closed mark no longer
      // asks anybody.
      ...(input.closed ? {} : { recipientUserId: input.userId }),
    })
  )
}
