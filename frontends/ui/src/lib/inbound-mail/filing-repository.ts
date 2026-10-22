import 'server-only'
/**
 * SQL of the filing job (ADR-0134, DECISION §6 "File"): the work a run reads
 * off the decision rows, the claim it renews, each part's outcome, and the
 * settle that scrubs a mail nothing of which waits any more. No authorization
 * here: the job runs as the decider, and each upload asks their rights again.
 *
 * Every write is a compare-and-set on the part's claim (`state = 'filing'` and
 * its own `decision_id`): a part the claim sweep handed back, or another run
 * finished, is left alone, so a run that lost its claim changes nothing. The
 * migration holds the rest: a filed part names a `file` decision and a clean
 * scan, its staged bytes are gone unless a hold deferred their erasure, a
 * settled mail names no third party.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  inboundMailDecisions,
  inboundMailParts,
  inboundMails,
  type InboundMailDecisionRow,
  type InboundMailPartRow,
  type InboundMailRow,
} from '@/lib/db/schema'
import type {
  InboundMailFilingFailure,
  InboundMailIgnoredCounts,
  InboundMailNotStaged,
} from './inbound-mail-vocabulary'
import type { StoredScan } from './repository'

/** One mail the run files: the row, every part of it, and each filing or filed part's decision. */
export interface FilingWork {
  mail: InboundMailRow
  parts: InboundMailPartRow[]
  /** By part id: the `file` decision a filing or filed part names. */
  decisions: Map<string, InboundMailDecisionRow>
}

/** The mails of the payload that are still held in this project, with their parts and decisions. */
export async function findFilingWork(
  projectId: string,
  mailIds: readonly string[]
): Promise<FilingWork[]> {
  const ids = [...new Set(mailIds)].slice(0, 20)
  if (ids.length === 0) return []
  const db = getDb()
  const mails = await db
    .select()
    .from(inboundMails)
    .where(
      and(
        eq(inboundMails.projectId, projectId),
        inArray(inboundMails.id, ids),
        eq(inboundMails.status, 'waiting')
      )
    )
    .limit(ids.length)
  if (mails.length === 0) return []
  const parts = await db
    .select()
    .from(inboundMailParts)
    .where(
      inArray(
        inboundMailParts.mailId,
        mails.map((mail) => mail.id)
      )
    )
    .orderBy(inboundMailParts.mailId, inboundMailParts.position)
    .limit(mails.length * 201)
  const decisionIds = parts.flatMap((part) => (part.decisionId ? [part.decisionId] : []))
  const decisions =
    decisionIds.length === 0
      ? []
      : await db
          .select()
          .from(inboundMailDecisions)
          .where(inArray(inboundMailDecisions.id, decisionIds))
          .limit(decisionIds.length)
  const byId = new Map(decisions.map((decision) => [decision.id, decision]))
  return mails.map((mail) => {
    const own = parts.filter((part) => part.mailId === mail.id)
    const decided = new Map<string, InboundMailDecisionRow>()
    for (const part of own) {
      const decision = part.decisionId ? byId.get(part.decisionId) : undefined
      if (decision) decided.set(part.id, decision)
    }
    return { mail, parts: own, decisions: decided }
  })
}

/** The claim on a part this run is filing, by its decision. */
const claimed = (partId: string, decisionId: string) =>
  and(
    eq(inboundMailParts.id, partId),
    eq(inboundMailParts.state, 'filing'),
    eq(inboundMailParts.decisionId, decisionId)
  )

/** Hold the claim a little longer; false when the part is no longer this run's to file. */
export async function renewClaim(
  partId: string,
  decisionId: string,
  until: Date
): Promise<boolean> {
  const renewed = await getDb()
    .update(inboundMailParts)
    .set({ claimExpiresAt: until, updatedAt: new Date() })
    .where(claimed(partId, decisionId))
    .returning({ id: inboundMailParts.id })
  return renewed.length === 1
}

/** A fresh clean scan of a part being filed (its verdict was older than a day). */
export async function recordFilingScan(
  partId: string,
  decisionId: string,
  scan: StoredScan
): Promise<void> {
  await getDb()
    .update(inboundMailParts)
    .set({
      scanStatus: scan.status,
      scanEngine: scan.engine,
      scanSignature: scan.signature,
      scannedAt: scan.scannedAt,
      updatedAt: new Date(),
    })
    .where(claimed(partId, decisionId))
}

/**
 * The part waits again, and says why its filing made no document. A scan that
 * is no longer clean is stored with it, in the same update: a filing part must
 * be clean (`inbound_mail_parts_filed_is_clean`), a waiting one need not.
 */
export async function returnPartToWaiting(
  partId: string,
  decisionId: string,
  failure: InboundMailFilingFailure,
  scan: StoredScan | null = null
): Promise<boolean> {
  const returned = await getDb()
    .update(inboundMailParts)
    .set({
      state: 'waiting',
      decisionId: null,
      claimExpiresAt: null,
      lastFailure: failure,
      ...(scan
        ? {
            scanStatus: scan.status,
            scanEngine: scan.engine,
            scanSignature: scan.signature,
            scannedAt: scan.scannedAt,
          }
        : {}),
      updatedAt: new Date(),
    })
    .where(claimed(partId, decisionId))
    .returning({ id: inboundMailParts.id })
  return returned.length === 1
}

/**
 * An attachment is a document now: `filed`, naming the document and the
 * Fassung. Its staged bytes were erased first (by their key), so the key and
 * the name go in this update; under a legal hold they stay, with the erasure
 * deferred for sweep 10.
 */
export async function markAttachmentFiled(
  partId: string,
  decisionId: string,
  filed: { documentId: string; versionId: string | null; erasureDeferred: boolean }
): Promise<boolean> {
  const now = new Date()
  const done = await getDb()
    .update(inboundMailParts)
    .set({
      state: 'filed',
      claimExpiresAt: null,
      filedAt: now,
      lastFailure: null,
      documentId: filed.documentId,
      documentVersionId: filed.versionId,
      ...(filed.erasureDeferred
        ? { erasureDeferredAt: now }
        : { storageKey: null, filename: null }),
      updatedAt: now,
    })
    .where(claimed(partId, decisionId))
    .returning({ id: inboundMailParts.id })
  return done.length === 1
}

/** Whether a legal hold covers the project now (the 0093 function the triggers ask). */
export async function projectIsHeld(projectId: string, organizationId: string): Promise<boolean> {
  const rows = await getDb().execute<{ held: boolean }>(
    sql`SELECT grid_legal_hold_blocks('project', ${projectId}::text, ${organizationId}) AS held`
  )
  return Boolean(Array.from(rows)[0]?.held)
}

/** What scrubbing a settled mail writes besides the status: the counts of what was never staged, by reason. */
export function ignoredCounts(
  notStaged: readonly InboundMailNotStaged[],
  ignored: InboundMailIgnoredCounts
): InboundMailIgnoredCounts {
  const counts: InboundMailIgnoredCounts = { ...ignored }
  for (const item of notStaged) counts[item.reason] = (counts[item.reason] ?? 0) + 1
  return counts
}

/**
 * Settle a mail every part of which is filed (D9 "Settle"): scrubbed to ids, its
 * staged objects forgotten (the caller erased them by key first), unless a hold
 * deferred the erasure, which keeps the keys for sweep 10. Only a mail still
 * `waiting` with no part open; false otherwise (another run settled it, or
 * something waits again).
 */
export async function settleFiledMail(
  mail: InboundMailRow,
  erasureDeferred: boolean
): Promise<boolean> {
  const now = new Date()
  const settled = await getDb()
    .update(inboundMails)
    .set({
      status: 'settled',
      settledAt: now,
      senderAddress: null,
      senderName: null,
      subject: null,
      baseSubject: null,
      envelopeFrom: null,
      participants: [],
      participantDomains: [],
      notStaged: [],
      ignored: ignoredCounts(mail.notStaged, mail.ignored),
      ...(erasureDeferred
        ? { erasureDeferredAt: now }
        : // A raw message still moving to its entry's original is the move's to forget (sweep 13).
          { readStorageKey: null, ...(mail.originalMovePendingAt ? {} : { rawStorageKey: null }) }),
      updatedAt: now,
    })
    .where(
      and(
        eq(inboundMails.id, mail.id),
        eq(inboundMails.status, 'waiting'),
        sql`NOT EXISTS (SELECT 1 FROM ${inboundMailParts} p WHERE p.mail_id = ${inboundMails.id} AND p.state <> 'filed')`
      )
    )
    .returning({ id: inboundMails.id })
  return settled.length === 1
}

/** The mail's raw message as the row names it now: moved to an entry's original, or still staged. */
export async function findMailKeys(
  mailId: string
): Promise<Pick<
  InboundMailRow,
  'rawStorageKey' | 'readStorageKey' | 'originalMovePendingAt'
> | null> {
  const [row] = await getDb()
    .select({
      rawStorageKey: inboundMails.rawStorageKey,
      readStorageKey: inboundMails.readStorageKey,
      originalMovePendingAt: inboundMails.originalMovePendingAt,
    })
    .from(inboundMails)
    .where(and(eq(inboundMails.id, mailId), isNull(inboundMails.settledAt)))
    .limit(1)
  return row ?? null
}
