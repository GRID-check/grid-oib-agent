/**
 * Piloti at work on a mark, as the server knows it: read off the mark's newest
 * wake (`piloti_wakes`, ADR-0106), never off a tab's own guess.
 *
 * The thread used to show „Piloti antwortet …" from the asking tab's memory:
 * it counted Piloti's replies when the question went and waited for one more,
 * or for two minutes. Nobody else in the room saw it, a reload forgot it, and
 * a wake that failed read „antwortet später" until the inbox said otherwise.
 * The wake row already holds the truth (queued, started, how it ended, why),
 * so each mark's view carries it, and every transition of a wake tells the
 * room to re-read (`announcePilotiWork`).
 *
 * | Newest wake | Shown as | For how long |
 * |---|---|---|
 * | `queued` | `queued` | until it starts or settles |
 * | `started` | `working` | until its turn ends, at most {@link WORKING_SHOWN_MS} |
 * | `failed`, `refused` | `failed`, with the class of why | {@link FAILED_SHOWN_MS} after it ended |
 * | `suppressed` | `held` | {@link HELD_SHOWN_MS} after it was recorded |
 * | `answered`, `stopped` | nothing: the answer is in the thread, or a person stopped it | |
 */

import 'server-only'
import type { PilotiWakeRow } from '@/lib/db/schema'
import { publishToDocumentRoom } from '@/lib/realtime/document-channel'
import type { PilotiWorkView } from './types'
import { wakeEndReasonKind } from './wake-end-reason'
import { listLatestWakes } from './wake-repository'

/** How long a wake that ended without an answer stays on its mark: long enough to be read after a meeting. */
export const FAILED_SHOWN_MS = 6 * 60 * 60 * 1000
/** How long a wake a cap held says so: the person who asked is still looking. */
export const HELD_SHOWN_MS = 10 * 60 * 1000
/**
 * How long a started wake may say Piloti is working. A turn whose process died
 * before it reported its end leaves the wake `started`; past this the line goes
 * rather than claiming work forever. Far above any turn's own deadline.
 */
export const WORKING_SHOWN_MS = 30 * 60 * 1000

type WakeFields = Pick<
  PilotiWakeRow,
  'status' | 'reason' | 'triggerKind' | 'actorUserId' | 'createdAt' | 'settledAt' | 'endedAt'
>

/** What a mark's newest wake says of Piloti's work on it now; null when nothing is to be shown. Pure. */
export function pilotiWorkOf(
  wake: WakeFields,
  forName: string | null,
  now: number = Date.now()
): PilotiWorkView | null {
  const base = { trigger: wake.triggerKind, forUserId: wake.actorUserId, forName, reasonKind: null }
  switch (wake.status) {
    case 'queued':
      return { ...base, state: 'queued', since: wake.createdAt.toISOString() }
    case 'started': {
      const since = wake.settledAt ?? wake.createdAt
      if (now - since.getTime() > WORKING_SHOWN_MS) return null
      return { ...base, state: 'working', since: since.toISOString() }
    }
    case 'failed':
    case 'refused': {
      const endedAt = wake.endedAt ?? wake.settledAt ?? wake.createdAt
      if (now - endedAt.getTime() > FAILED_SHOWN_MS) return null
      return {
        ...base,
        state: 'failed',
        reasonKind: wakeEndReasonKind(wake.status, wake.reason) ?? 'error',
        since: endedAt.toISOString(),
      }
    }
    case 'suppressed':
      if (now - wake.createdAt.getTime() > HELD_SHOWN_MS) return null
      return { ...base, state: 'held', since: wake.createdAt.toISOString() }
    default:
      return null
  }
}

/**
 * The newest wake of each mark of one document, by mark; of `annotationId`
 * alone when one is named (a read of one mark). Empty, never failing the read
 * it is part of, when the wakes cannot be read: the marks still show, only
 * without Piloti's line.
 */
export async function latestWakesFor(
  organizationId: string,
  documentId: string,
  annotationId?: string
): Promise<ReadonlyMap<string, PilotiWakeRow>> {
  const rows = await listLatestWakes(organizationId, documentId, annotationId).catch((error: unknown) => {
    console.error('[annotations] the wakes of a document could not be read:', error)
    return []
  })
  return new Map(rows.map((row) => [row.annotationId, row]))
}

/**
 * A wake moved (it started, ended, or was held): the room re-reads the mark,
 * so everyone's thread shows the same line. Never throws.
 */
export async function announcePilotiWork(
  wake: Pick<PilotiWakeRow, 'documentId' | 'annotationId' | 'actorUserId'>
): Promise<void> {
  await publishToDocumentRoom(wake.documentId, {
    kind: 'annotations.changed',
    annotationIds: [wake.annotationId],
    change: 'updated',
    actor: { peerId: null, userId: wake.actorUserId, name: 'Piloti', kind: 'piloti' },
  }).catch(() => undefined)
}
