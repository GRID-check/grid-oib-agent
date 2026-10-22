/**
 * SQL for the E-Mail-Eingang (ADR-0134, migration 0186). No authorization
 * here: the service decides who may ask, and row-level security is the
 * backstop. Every list is bounded.
 *
 * Every function runs in the tenant scope its caller opened, with one exception
 * that says so: {@link findActiveAddressByToken} is the lookup that happens
 * BEFORE any organization is known, and its caller wraps it in
 * `withPlatformAccess`. A function that may run inside a caller's transaction
 * takes its executor rather than calling `getDb()` (`transaction-shape.spec.ts`).
 *
 * The rules a row must keep (a waiting mail was scanned, a member is named
 * exactly when the From address is one, a settled or dropped mail names no
 * third party, every object key is the row's own) are CHECKs in the migration.
 * The functions here write rows that keep them, and a row that does not is a
 * refused statement rather than a quiet inconsistency.
 *
 * This module is shared by the packages that build the feature: the webhook
 * and the receive job (below) first; the review service, the filing and follow
 * jobs and the sweeps add their own sections.
 */

import 'server-only'
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { isUniqueViolation } from '@/lib/db/errors'
import type { DbExecutor, DbTransaction } from '@/lib/db/executor'
import {
  documents,
  inboundMailAddresses,
  inboundMailDecisions,
  inboundMailParts,
  inboundMails,
  mailThreadEntries,
  mailThreadFollows,
  mailThreadMessageIds,
  mailThreads,
  projectFolders,
  projects,
  type InboundMailAddressRow,
  type InboundMailDecisionRow,
  type InboundMailPartRow,
  type InboundMailRow,
  type NewInboundMailDecisionRow,
  type NewInboundMailPartRow,
  type NewInboundMailRow,
} from '@/lib/db/schema'
import { documentDisplayName } from '@/lib/documents/display-name'
import { CURSOR_TIMESTAMP_FORMAT } from '@/lib/documents/list-cursor'
import { documentVisibleTo, internalRead, SCREENED_ONLY } from '@/lib/documents/visibility'
import { insertJobIfAbsent } from '@/lib/jobs-queue/repository'
import { BFF_JOB_PRIORITY } from '@/lib/jobs-queue/types'
import type { FollowRow } from '@/lib/mail-thread/follow-eligibility'
import type { ThreadCandidate } from '@/lib/mail-thread/mail-threading'
import type { MalwareScanStatus } from './inbound-mail-vocabulary'

// ---------------------------------------------------------------------------
// The webhook
// ---------------------------------------------------------------------------

/** What the webhook learns from a token, and nothing more. */
export interface ResolvedInboundAddress {
  addressId: string
  organizationId: string
  projectId: string
}

/**
 * The active address a token names, in whichever organization owns it.
 *
 * Cross-tenant by nature, the token being all the webhook has, so the caller
 * runs it under the platform bypass, and it returns ONLY the ids the rest of
 * the request needs to open a tenant scope. A revoked token and a token whose
 * project is deleted resolve to nothing: the same answer as a token nobody
 * ever minted. A closed project resolves: it holds its mail (RT-X13).
 */
export async function findActiveAddressByToken(token: string): Promise<ResolvedInboundAddress | null> {
  const [row] = await getDb()
    .select({
      addressId: inboundMailAddresses.id,
      organizationId: inboundMailAddresses.organizationId,
      projectId: inboundMailAddresses.projectId,
    })
    .from(inboundMailAddresses)
    .innerJoin(
      projects,
      and(eq(projects.id, inboundMailAddresses.projectId), eq(projects.organizationId, inboundMailAddresses.organizationId)),
    )
    .where(and(eq(inboundMailAddresses.token, token), isNull(inboundMailAddresses.revokedAt), isNull(projects.deletedAt)))
    .limit(1)
  return row ?? null
}

/** The statuses whose raw message is staged: arriving, read by no job yet, or waiting for a person. */
const STAGED_STATUSES = ['receiving', 'received', 'waiting'] as const

/** Raw bytes staged now, for one address and for its whole organization (D18's byte caps). */
export interface StagedBytes {
  address: number
  organization: number
}

/**
 * The raw message bytes staged for this address and for its organization: the
 * sum of `raw_size_bytes` over mail that is arriving, received or waiting. A
 * reception is counted from its insert (the size is its signed length), so a
 * burst of large mails cannot all pass the cap before any of them is written.
 * Attachment parts are copies of bytes inside the raw message and are not
 * counted twice.
 */
export async function stagedBytes(organizationId: string, addressId: string): Promise<StagedBytes> {
  const [row] = await getDb()
    .select({
      address: sql<string>`coalesce(sum(${inboundMails.rawSizeBytes}) filter (where ${inboundMails.addressId} = ${addressId}), 0)`,
      organization: sql<string>`coalesce(sum(${inboundMails.rawSizeBytes}), 0)`,
    })
    .from(inboundMails)
    .where(
      and(
        eq(inboundMails.organizationId, organizationId),
        inArray(inboundMails.status, [...STAGED_STATUSES]),
        isNotNull(inboundMails.rawStorageKey),
      ),
    )
  return { address: Number(row?.address ?? 0), organization: Number(row?.organization ?? 0) }
}

/** A delivery the webhook is about to stream to staging. */
export type NewReception = Pick<
  NewInboundMailRow,
  | 'id'
  | 'organizationId'
  | 'projectId'
  | 'addressId'
  | 'envelopeFrom'
  | 'rawSizeBytes'
  | 'stagingBucket'
  | 'rawStorageKey'
  | 'receivedAt'
  | 'expiresAt'
>

/**
 * Insert the `receiving` row before a byte is written (ADR-0043): the bucket
 * and the key are on the row first, so a reception that dies half way leaves a
 * row the sweep can erase by its exact key (sweep 1), never an object nothing
 * names.
 */
export async function insertReception(reception: NewReception): Promise<void> {
  await getDb()
    .insert(inboundMails)
    .values({ ...reception, status: 'receiving' })
}

/** The mail this address already holds under `deliveryKey`, if any, whatever became of it. */
export async function findMailIdByDeliveryKey(addressId: string, deliveryKey: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ id: inboundMails.id })
    .from(inboundMails)
    .where(and(eq(inboundMails.addressId, addressId), eq(inboundMails.deliveryKey, deliveryKey)))
    .limit(1)
  return row?.id ?? null
}

/** Whether the reception became a mail for the receive job, or was a second delivery of one already held. */
export type ReceptionOutcome = 'received' | 'duplicate'

/**
 * Turn a reception into a received mail AND queue the job that reads it, in
 * one transaction: a mail is never `received` without its job, and a job never
 * names a mail that is not. The job id is the mail's id, so the sweep that
 * re-queues a `received` mail without a live job (sweep 2) names the same job.
 *
 * A second delivery of a mail already held loses the race to
 * `uniq_inbound_mails_address_delivery`: that is `duplicate`, and nothing was
 * written.
 */
export async function completeReception(input: {
  mailId: string
  organizationId: string
  projectId: string
  deliveryKey: string
  rawSizeBytes: number
}): Promise<ReceptionOutcome> {
  try {
    return await getDb().transaction(async (tx) => {
      const updated = await tx
        .update(inboundMails)
        .set({ status: 'received', deliveryKey: input.deliveryKey, rawSizeBytes: input.rawSizeBytes, updatedAt: new Date() })
        .where(and(eq(inboundMails.id, input.mailId), eq(inboundMails.status, 'receiving')))
        .returning({ id: inboundMails.id })
      if (updated.length === 0) throw new Error(`inbound mail ${input.mailId} is not receiving`)
      await queueReceiveJob(input, tx)
      return 'received' as const
    })
  } catch (error) {
    if (isUniqueViolation(error, 'uniq_inbound_mails_address_delivery')) return 'duplicate'
    throw error
  }
}

/** Queue (or find queued) the receive job of a received mail. */
export async function queueReceiveJob(
  mail: { mailId: string; organizationId: string; projectId: string },
  executor: DbExecutor = getDb(),
): Promise<boolean> {
  return insertJobIfAbsent(
    {
      kind: 'inbound_mail_receive',
      organizationId: mail.organizationId,
      priority: BFF_JOB_PRIORITY.bulk,
      jobId: mail.mailId,
      payload: { mailId: mail.mailId, projectId: mail.projectId },
    },
    executor,
  )
}

/**
 * A reception that turned out to be a second delivery, or failed half way:
 * its object was erased (or never written), so the row stops naming it. The
 * row stays `receiving`; DELETE is not the app's (migration 0186), and sweep 1
 * deletes it once it is fifteen minutes old.
 */
export async function forgetReceptionObject(mailId: string): Promise<void> {
  await getDb()
    .update(inboundMails)
    .set({ rawStorageKey: null, updatedAt: new Date() })
    .where(and(eq(inboundMails.id, mailId), eq(inboundMails.status, 'receiving')))
}

// ---------------------------------------------------------------------------
// The receive job
// ---------------------------------------------------------------------------

/** The mail the receive job reads, in any status: a job that finds it past `received` has nothing to do. */
export async function findMailForReceive(mailId: string): Promise<InboundMailRow | null> {
  const [row] = await getDb().select().from(inboundMails).where(eq(inboundMails.id, mailId)).limit(1)
  return row ?? null
}

/** A scan's outcome as the columns store it. */
export interface StoredScan {
  status: Exclude<MalwareScanStatus, 'pending'>
  /** Engine and signature-database version (`ClamAV 1.5.4/28157`); null when no engine answered. */
  engine: string | null
  /** The malware's name, for `infected` only. */
  signature: string | null
  scannedAt: Date
}

/**
 * The whole raw message's scan (D16). Recorded while the mail is still
 * `received`, so a job that dies after it does not scan again, and a mail is
 * never `waiting` without one (`inbound_mails_waiting_is_scanned`).
 */
export async function recordRawScan(mailId: string, scan: StoredScan): Promise<void> {
  await getDb()
    .update(inboundMails)
    .set({
      rawScanStatus: scan.status,
      rawScanEngine: scan.engine,
      rawScanSignature: scan.status === 'infected' ? scan.signature : null,
      rawScannedAt: scan.scannedAt,
      rawScanAttempts: sql`least(${inboundMails.rawScanAttempts} + 1, 100)`,
      updatedAt: new Date(),
    })
    .where(and(eq(inboundMails.id, mailId), eq(inboundMails.status, 'received')))
}

/**
 * Drop an automatic mail nobody needs to see: an auto-reply, a delivery
 * report, a loop (`dropped_reason`). Scrubbed in the same statement
 * (`inbound_mails_ended_is_scrubbed`): the envelope sender goes, and the raw
 * message's key goes once its object is erased, unless a legal hold deferred
 * that (`erasureDeferred`). Whether this call dropped it.
 */
export async function dropMail(
  mailId: string,
  input: { reason: NonNullable<InboundMailRow['droppedReason']>; erasureDeferred: boolean },
): Promise<boolean> {
  const now = new Date()
  const rows = await getDb()
    .update(inboundMails)
    .set({
      status: 'dropped',
      droppedReason: input.reason,
      envelopeFrom: null,
      rawStorageKey: input.erasureDeferred ? inboundMails.rawStorageKey : null,
      erasureDeferredAt: input.erasureDeferred ? now : null,
      updatedAt: now,
    })
    .where(and(eq(inboundMails.id, mailId), eq(inboundMails.status, 'received')))
    .returning({ id: inboundMails.id })
  return rows.length > 0
}

/** The mail's identifiers a thread can be found by. */
export interface ThreadKeys {
  /** The mail's own Message-ID, In-Reply-To and References, normalized. */
  messageIds: readonly string[]
  threadIndexGuid: string | null
  baseSubject: string
  /** The mail's participant addresses, lower-cased, the project's own taken out. */
  participants: readonly string[]
}

/** Threads looked at per mail; a project with more matching threads than this is past what a person picks from. */
const MAX_THREAD_CANDIDATES = 50

/**
 * The project's threads this mail could belong to, in the shape the matching
 * ladder reads (`matchThread`): any thread that received or was referred to by
 * one of the mail's ids, shares its Outlook conversation GUID, or has its base
 * subject. Only threads with a live document: a thread being written for the
 * first time, or whose document is gone, is nothing to file into.
 *
 * The id and participant lists hold only what the mail shares with each
 * thread, which is all the ladder asks of them; a 200-entry thread's whole
 * history is never loaded for one mail.
 */
export async function findThreadCandidates(projectId: string, keys: ThreadKeys): Promise<ThreadCandidate[]> {
  const db = getDb()
  const ids = [...new Set(keys.messageIds)].slice(0, 64)
  const byIds =
    ids.length > 0
      ? db
          .selectDistinct({ threadId: mailThreadMessageIds.threadId })
          .from(mailThreadMessageIds)
          .where(and(eq(mailThreadMessageIds.projectId, projectId), inArray(mailThreadMessageIds.messageId, ids)))
      : null
  const threads = await db
    .select({
      threadId: mailThreads.id,
      baseSubject: mailThreads.baseSubject,
      threadIndexGuid: mailThreads.threadIndexGuid,
      lastEntryAt: mailThreads.lastEntryAt,
    })
    .from(mailThreads)
    .where(
      and(
        eq(mailThreads.projectId, projectId),
        isNotNull(mailThreads.documentId),
        or(
          byIds ? inArray(mailThreads.id, byIds) : undefined,
          keys.threadIndexGuid ? eq(mailThreads.threadIndexGuid, keys.threadIndexGuid) : undefined,
          keys.baseSubject ? eq(mailThreads.baseSubject, keys.baseSubject) : undefined,
          sql`false`,
        ),
      ),
    )
    .orderBy(desc(mailThreads.lastEntryAt))
    .limit(MAX_THREAD_CANDIDATES)
  if (threads.length === 0) return []
  const threadIds = threads.map((thread) => thread.threadId)
  const [knownIds, shared] = await Promise.all([
    ids.length > 0
      ? db
          .select({ threadId: mailThreadMessageIds.threadId, messageId: mailThreadMessageIds.messageId, state: mailThreadMessageIds.state })
          .from(mailThreadMessageIds)
          .where(and(inArray(mailThreadMessageIds.threadId, threadIds), inArray(mailThreadMessageIds.messageId, ids)))
          .limit(MAX_THREAD_CANDIDATES * 64)
      : Promise.resolve([]),
    sharedParticipants(threadIds, keys.participants),
  ])
  return threads.map((thread) => ({
    threadId: thread.threadId,
    baseSubject: thread.baseSubject,
    threadIndexGuid: thread.threadIndexGuid,
    receivedIds: knownIds.filter((row) => row.threadId === thread.threadId && row.state === 'received').map((row) => row.messageId),
    referencedIds: knownIds
      .filter((row) => row.threadId === thread.threadId && row.state === 'referenced')
      .map((row) => row.messageId),
    participants: shared.get(thread.threadId) ?? [],
    lastEntryAt: thread.lastEntryAt ? new Date(thread.lastEntryAt) : null,
  }))
}

/** Which of `addresses` took part in each thread, as a sender or a recipient of a filed entry. */
async function sharedParticipants(threadIds: readonly string[], addresses: readonly string[]): Promise<Map<string, string[]>> {
  const wanted = [...new Set(addresses.map((address) => address.toLowerCase()))].slice(0, 200)
  if (threadIds.length === 0 || wanted.length === 0) return new Map()
  const rows = await getDb().execute<{ thread_id: string; address: string }>(sql`
    SELECT DISTINCT e.thread_id, lower(p.address) AS address
    FROM ${mailThreadEntries} e
    CROSS JOIN LATERAL (
      SELECT e.sender_address AS address
      UNION ALL
      SELECT value ->> 'address' FROM jsonb_array_elements(e.participants)
    ) p
    WHERE e.thread_id IN (${sql.join(threadIds.map((id) => sql`${id}::uuid`), sql`, `)})
      AND lower(p.address) IN (${sql.join(wanted.map((address) => sql`${address}`), sql`, `)})
    LIMIT 2000
  `)
  const shared = new Map<string, string[]>()
  for (const row of Array.from(rows)) {
    const threadId = String(row.thread_id)
    shared.set(threadId, [...(shared.get(threadId) ?? []), String(row.address)])
  }
  return shared
}

/** A filed message of the project with a given Message-ID (D11, D33). */
export interface FiledMessage {
  entryId: string
  threadId: string
  source: 'inbound' | 'archive'
  /** SHA-256 hex of the entry's own text, compared with the held mail's. */
  ownTextSha256: string
}

/**
 * The project's filed messages that received this Message-ID: what decides
 * `message_id_reused` (an id the project already has, perhaps a forger's) and
 * `already_filed` (the same message is in a Verlauf already). Received ids are
 * keyed per entry, so a forger who took a genuine id first is one row of
 * several and never blocks the genuine message (RT-S1).
 */
export async function findFiledMessages(projectId: string, messageId: string): Promise<FiledMessage[]> {
  const rows = await getDb()
    .select({
      entryId: mailThreadEntries.id,
      threadId: mailThreadEntries.threadId,
      source: mailThreadEntries.source,
      ownTextSha256: sql<string>`encode(sha256(convert_to(${mailThreadEntries.ownText}, 'UTF8')), 'hex')`,
    })
    .from(mailThreadMessageIds)
    .innerJoin(mailThreadEntries, eq(mailThreadEntries.id, mailThreadMessageIds.entryId))
    .where(
      and(
        eq(mailThreadMessageIds.projectId, projectId),
        eq(mailThreadMessageIds.messageId, messageId),
        eq(mailThreadMessageIds.state, 'received'),
      ),
    )
    .limit(20)
  return rows.map((row) => ({ ...row, ownTextSha256: String(row.ownTextSha256) }))
}

/**
 * Screened documents of the project that hold exactly these bytes, by content
 * hash: the `duplicate_of` candidate of an attachment. Ids only, stored on the
 * part; whether the viewer may see the document is decided when the mail is
 * read (RT-S13). A held document is never a candidate (`SCREENED_ONLY`): its
 * existence is not the project's yet.
 */
export async function findScreenedDuplicates(projectId: string, sha256s: readonly string[]): Promise<Map<string, string>> {
  const hashes = [...new Set(sha256s)].slice(0, 100)
  if (hashes.length === 0) return new Map()
  const rows = await getDb()
    .select({ id: documents.id, contentHash: documents.contentHash })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), inArray(documents.contentHash, hashes), documentVisibleTo(SCREENED_ONLY)))
    .orderBy(desc(documents.createdAt))
    .limit(500)
  return firstByKey(rows.map((row) => [row.contentHash ?? '', row.id]))
}

/**
 * Screened documents of the project under exactly these names (their stored,
 * composed form): the attachment that would become their next Fassung
 * (`revision_candidate_document_id`). Ids only, judged for the viewer at read
 * time, like {@link findScreenedDuplicates}.
 */
export async function findScreenedNamesakes(projectId: string, filenames: readonly string[]): Promise<Map<string, string>> {
  const names = [...new Set(filenames)].slice(0, 100)
  if (names.length === 0) return new Map()
  const rows = await getDb()
    .select({ id: documents.id, filename: documents.filename })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), inArray(documents.filename, names), documentVisibleTo(SCREENED_ONLY)))
    .orderBy(desc(documents.createdAt))
    .limit(500)
  return firstByKey(rows.map((row) => [row.filename, row.id]))
}

/** The first value per key, in row order (newest first). */
function firstByKey(entries: ReadonlyArray<readonly [string, string]>): Map<string, string> {
  const found = new Map<string, string>()
  for (const [key, value] of entries) if (key && !found.has(key)) found.set(key, value)
  return found
}

/** What following needs of one thread (D31): its participant domains and its follows that have not ended. */
export interface ThreadFollowContext {
  threadId: string
  participantDomains: string[]
  follows: FollowRow[]
}

/** {@link ThreadFollowContext} of one thread of the project, or null when it has no live document. */
export async function findThreadFollowContext(projectId: string, threadId: string): Promise<ThreadFollowContext | null> {
  const db = getDb()
  const [thread] = await db
    .select({ id: mailThreads.id, participantDomains: mailThreads.participantDomains })
    .from(mailThreads)
    .where(and(eq(mailThreads.id, threadId), eq(mailThreads.projectId, projectId), isNotNull(mailThreads.documentId)))
    .limit(1)
  if (!thread) return null
  const follows = await db
    .select({
      id: mailThreadFollows.id,
      userId: mailThreadFollows.userId,
      createdAt: mailThreadFollows.createdAt,
      expiresAt: mailThreadFollows.expiresAt,
      endedAt: mailThreadFollows.endedAt,
    })
    .from(mailThreadFollows)
    .where(and(eq(mailThreadFollows.threadId, threadId), isNull(mailThreadFollows.endedAt)))
    .orderBy(mailThreadFollows.createdAt)
    .limit(50)
  return {
    threadId: thread.id,
    participantDomains: thread.participantDomains,
    follows: follows.map((follow) => ({
      ...follow,
      createdAt: new Date(follow.createdAt),
      expiresAt: new Date(follow.expiresAt),
      endedAt: follow.endedAt ? new Date(follow.endedAt) : null,
    })),
  }
}

/** What the receive job writes onto the mail when it is held. */
export type HeldMailFields = Pick<
  NewInboundMailRow,
  | 'readStorageKey'
  | 'messageId'
  | 'inReplyTo'
  | 'referenceIds'
  | 'threadIndexGuid'
  | 'baseSubject'
  | 'threadMatch'
  | 'senderAddress'
  | 'senderName'
  | 'subject'
  | 'participants'
  | 'participantDomains'
  | 'recipientCount'
  | 'senderTrust'
  | 'senderUserId'
  | 'senderReason'
  | 'signerDomain'
  | 'signedHeaders'
  | 'senderFlags'
  | 'authenticationResults'
  | 'automatic'
  | 'sentAt'
  | 'sentAtHeader'
  | 'notStaged'
  | 'ignored'
>

/**
 * Hold the mail for a person: insert its parts and move it to `waiting`, in one
 * transaction, so a person never sees a mail without its parts. Only from
 * `received`: whether this call held it (a second run of the job finds it held
 * and does nothing). The database refuses a `waiting` mail whose raw message
 * was not scanned, and a part that breaks any of its rules.
 */
export async function holdMail(
  mailId: string,
  fields: HeldMailFields,
  parts: readonly NewInboundMailPartRow[],
): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const now = new Date()
    const held = await tx
      .update(inboundMails)
      .set({ ...fields, status: 'waiting', updatedAt: now })
      .where(and(eq(inboundMails.id, mailId), eq(inboundMails.status, 'received')))
      .returning({ id: inboundMails.id })
    if (held.length === 0) return false
    if (parts.length > 0) await tx.insert(inboundMailParts).values([...parts])
    return true
  })
}

/** The token of the address a mail arrived at: what its signed recipients must name (D4), and the one B8 keeps. */
export async function findAddressToken(addressId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ token: inboundMailAddresses.token })
    .from(inboundMailAddresses)
    .where(eq(inboundMailAddresses.id, addressId))
    .limit(1)
  return row?.token ?? null
}

/** One part of a held mail, as its announcement and audit read it: kind and flags, no name. */
export interface PartSummary {
  kind: 'message' | 'attachment'
  riskFlags: string[]
  contentFindings: string[]
}

/** The parts of a held mail, in position order (at most 101: the text and 100 attachments). */
export async function findPartSummaries(mailId: string): Promise<PartSummary[]> {
  return getDb()
    .select({ kind: inboundMailParts.kind, riskFlags: inboundMailParts.riskFlags, contentFindings: inboundMailParts.contentFindings })
    .from(inboundMailParts)
    .where(eq(inboundMailParts.mailId, mailId))
    .orderBy(inboundMailParts.position)
    .limit(200)
}

/**
 * The held mail was announced (`notified_at`): its job's last step, so a job
 * that died between holding the mail and telling anyone finishes the telling
 * when it runs again, and a job that finished never tells twice.
 */
export async function markNotified(mailId: string, at: Date = new Date()): Promise<void> {
  await getDb()
    .update(inboundMails)
    .set({ notifiedAt: at, updatedAt: at })
    .where(and(eq(inboundMails.id, mailId), isNull(inboundMails.notifiedAt)))
}

// ---------------------------------------------------------------------------
// The review service: the address, the E-Mail-Eingang's lists, decisions
// ---------------------------------------------------------------------------

/** A project's active address, or null. */
export async function findActiveAddress(projectId: string): Promise<InboundMailAddressRow | null> {
  const [row] = await getDb()
    .select()
    .from(inboundMailAddresses)
    .where(and(eq(inboundMailAddresses.projectId, projectId), isNull(inboundMailAddresses.revokedAt)))
    .limit(1)
  return row ?? null
}

/** A new address, as the service mints it. */
export interface NewAddress {
  organizationId: string
  projectId: string
  token: string
  slug: string
  createdBy: string
}

/** Why an address could not be written: its token was taken (mint again), or the project has an active one already. */
export type AddressConflict = 'token' | 'active'

export type AddressWrite<T> = { ok: true; value: T } | { ok: false; conflict: AddressConflict }

function addressConflictOf(error: unknown): AddressConflict | null {
  if (isUniqueViolation(error, 'uniq_inbound_mail_addresses_token')) return 'token'
  if (isUniqueViolation(error, 'uniq_inbound_mail_addresses_active_project')) return 'active'
  return null
}

/** Give a project its first (or next, after a switch-off) address. The partial unique index decides a race. */
export async function insertAddress(input: NewAddress): Promise<AddressWrite<InboundMailAddressRow>> {
  try {
    const [row] = await getDb().insert(inboundMailAddresses).values(input).returning()
    if (!row) throw new Error('inserting an inbound mail address returned no row')
    return { ok: true, value: row }
  } catch (error) {
    const conflict = addressConflictOf(error)
    if (conflict) return { ok: false, conflict }
    throw error
  }
}

/** A follow the address change ended (D31: rotation ends every follow on the project). */
export interface EndedFollow {
  id: string
  threadId: string
  userId: string
}

/** End every running follow of a project, as `endedBy`, for `reason`. */
async function endProjectFollows(
  executor: DbExecutor,
  projectId: string,
  endedBy: string,
  at: Date,
): Promise<EndedFollow[]> {
  return executor
    .update(mailThreadFollows)
    .set({ endedAt: at, endedBy, endedReason: 'address_rotated' })
    .where(and(eq(mailThreadFollows.projectId, projectId), isNull(mailThreadFollows.endedAt)))
    .returning({ id: mailThreadFollows.id, threadId: mailThreadFollows.threadId, userId: mailThreadFollows.userId })
}

/** What replacing or switching off an address did. */
export interface AddressChange {
  previousAddressId: string | null
  followsEnded: EndedFollow[]
}

/**
 * Replace the project's address with `next` in one transaction: the old one is
 * revoked (`rotated`, it stops resolving at once), the new one inserted, and
 * every follow on the project ended (`address_rotated`): whoever learned the
 * old address could otherwise keep writing into a followed thread.
 */
export async function replaceAddress(
  next: NewAddress,
): Promise<AddressWrite<{ row: InboundMailAddressRow } & AddressChange>> {
  try {
    const value = await getDb().transaction(async (tx) => {
      const now = new Date()
      const revoked = await tx
        .update(inboundMailAddresses)
        .set({ revokedAt: now, revokedBy: next.createdBy, revokedReason: 'rotated' })
        .where(and(eq(inboundMailAddresses.projectId, next.projectId), isNull(inboundMailAddresses.revokedAt)))
        .returning({ id: inboundMailAddresses.id })
      const [row] = await tx.insert(inboundMailAddresses).values(next).returning()
      if (!row) throw new Error('inserting an inbound mail address returned no row')
      const followsEnded = await endProjectFollows(tx, next.projectId, next.createdBy, now)
      return { row, previousAddressId: revoked[0]?.id ?? null, followsEnded }
    })
    return { ok: true, value }
  } catch (error) {
    const conflict = addressConflictOf(error)
    if (conflict) return { ok: false, conflict }
    throw error
  }
}

/**
 * Switch the project's address off (`switched_off`): it stops resolving, the
 * row stays as history (DELETE is not the app's), and the project's follows
 * end with it. Null when the project had no active address.
 */
export async function switchOffAddress(projectId: string, revokedBy: string): Promise<AddressChange | null> {
  return getDb().transaction(async (tx) => {
    const now = new Date()
    const [revoked] = await tx
      .update(inboundMailAddresses)
      .set({ revokedAt: now, revokedBy, revokedReason: 'switched_off' })
      .where(and(eq(inboundMailAddresses.projectId, projectId), isNull(inboundMailAddresses.revokedAt)))
      .returning({ id: inboundMailAddresses.id })
    if (!revoked) return null
    return { previousAddressId: revoked.id, followsEnded: await endProjectFollows(tx, projectId, revokedBy, now) }
  })
}

/** What the address dialog says about the project's mail: when it last arrived, and what was dropped unseen. */
export async function addressActivity(projectId: string): Promise<{ lastReceivedAt: Date | null; droppedLast30Days: number }> {
  const [row] = await getDb()
    .select({
      lastReceivedAt: sql<string | null>`max(${inboundMails.receivedAt})`,
      dropped: sql<string>`count(*) filter (where ${inboundMails.status} = 'dropped' and ${inboundMails.receivedAt} > now() - interval '30 days')`,
    })
    .from(inboundMails)
    .where(and(eq(inboundMails.projectId, projectId), sql`${inboundMails.status} <> 'receiving'`))
  return {
    lastReceivedAt: row?.lastReceivedAt ? new Date(row.lastReceivedAt) : null,
    droppedLast30Days: Number(row?.dropped ?? 0),
  }
}

/**
 * Of the mail the office's own members sent to any of its projects in the last
 * 30 days, the share their domain signed; null when there was none (RT-X6).
 * The trust survives the scrub of a settled mail, so settled mail counts too.
 */
export async function ownDomainVerifiedShare(organizationId: string): Promise<number | null> {
  const [row] = await getDb()
    .select({
      members: sql<string>`count(*)`,
      verified: sql<string>`count(*) filter (where ${inboundMails.senderTrust} = 'member_verified')`,
    })
    .from(inboundMails)
    .where(
      and(
        eq(inboundMails.organizationId, organizationId),
        inArray(inboundMails.senderTrust, ['member_verified', 'member_unverified']),
        sql`${inboundMails.receivedAt} > now() - interval '30 days'`,
      ),
    )
  const members = Number(row?.members ?? 0)
  return members === 0 ? null : Number(row?.verified ?? 0) / members
}

/** The part states a person still has to decide, or the filing job is working on. */
const OPEN_PART_STATES = ['waiting', 'filing'] as const

const partInState = (states: readonly string[]) =>
  sql`EXISTS (SELECT 1 FROM ${inboundMailParts} p WHERE p.mail_id = ${inboundMails.id}
      AND p.state IN (${sql.join(states.map((state) => sql`${state}`), sql`, `)}))`

/** A position in the list's `received_at DESC, id ASC` order (`lib/documents/list-cursor.ts` encodes it). */
export interface MailListPosition {
  /** `received_at` as `to_char(… 'US')` wrote it, UTC, microseconds. */
  receivedAt: string
  id: string
}

/** One mail of a list page: the row, its part counts, and its position for the next cursor. */
export interface MailListRow {
  mail: InboundMailRow
  position: MailListPosition
}

/**
 * One page of a project's E-Mail-Eingang, newest first. `waiting`: mail with a
 * part a person still has to decide or that is being filed. `handled`: mail
 * where nothing is open any more, settled or within the seven days its
 * dismissed or expired parts can be restored; `outcome` narrows it to mail
 * with a part filed, dismissed or expired. Receiving and dropped mail is never
 * listed. Reads one row more than `limit`, so the caller knows a page follows.
 */
export async function listProjectMails(
  projectId: string,
  query: { status: 'waiting' | 'handled'; outcome?: 'filed' | 'dismissed' | 'expired'; limit: number },
  after: MailListPosition | null,
): Promise<MailListRow[]> {
  const facet =
    query.status === 'waiting'
      ? and(eq(inboundMails.status, 'waiting'), partInState(OPEN_PART_STATES))
      : and(
          inArray(inboundMails.status, ['waiting', 'settled']),
          sql`NOT ${partInState(OPEN_PART_STATES)}`,
          query.outcome ? partInState([query.outcome]) : undefined,
        )
  const position = after
    ? sql`(${inboundMails.receivedAt} < (${after.receivedAt})::timestamp AT TIME ZONE 'UTC'
         OR (${inboundMails.receivedAt} = (${after.receivedAt})::timestamp AT TIME ZONE 'UTC' AND ${inboundMails.id} > ${after.id}))`
    : undefined
  const rows = await getDb()
    .select({
      mail: inboundMails,
      receivedAtText: sql<string>`to_char(${inboundMails.receivedAt} AT TIME ZONE 'UTC', ${CURSOR_TIMESTAMP_FORMAT})`,
    })
    .from(inboundMails)
    .where(and(eq(inboundMails.projectId, projectId), facet, position))
    .orderBy(desc(inboundMails.receivedAt), inboundMails.id)
    .limit(query.limit + 1)
  return rows.map((row) => ({ mail: row.mail, position: { receivedAt: String(row.receivedAtText), id: row.mail.id } }))
}

/** A held or settled mail of the project, or null (receiving and dropped mail is nobody's to read). */
export async function findProjectMail(projectId: string, mailId: string, executor: DbExecutor = getDb()): Promise<InboundMailRow | null> {
  const [row] = await executor
    .select()
    .from(inboundMails)
    .where(and(eq(inboundMails.id, mailId), eq(inboundMails.projectId, projectId), inArray(inboundMails.status, ['waiting', 'settled'])))
    .limit(1)
  return row ?? null
}

/** The parts of these mails, in mail and position order (at most 101 per mail). */
export async function findMailParts(mailIds: readonly string[], executor: DbExecutor = getDb()): Promise<InboundMailPartRow[]> {
  if (mailIds.length === 0) return []
  return executor
    .select()
    .from(inboundMailParts)
    .where(inArray(inboundMailParts.mailId, [...mailIds]))
    .orderBy(inboundMailParts.mailId, inboundMailParts.position)
    .limit(mailIds.length * 101)
}

/** Whose follow appended a mail's text (D31), per mail; mails no follow touched are absent. */
export async function findFollowDeciders(mailIds: readonly string[]): Promise<Map<string, string>> {
  if (mailIds.length === 0) return new Map()
  const rows = await getDb()
    .select({ mailId: inboundMailDecisions.mailId, decidedBy: inboundMailDecisions.decidedBy })
    .from(inboundMailDecisions)
    .where(and(inArray(inboundMailDecisions.mailId, [...mailIds]), eq(inboundMailDecisions.via, 'follow')))
    .limit(mailIds.length * 4)
  return new Map(rows.map((row) => [row.mailId, row.decidedBy]))
}

/** A thread of the project with its live document, as a candidate is shown (D9, D11). */
export interface ThreadDocument {
  threadId: string
  documentId: string
  name: string
  folderId: string | null
  folderPath: string | null
  nextVersion: number
  entryCount: number
  renderedBytes: number
}

/**
 * These threads of the project whose document has passed its screening and is
 * not in the bin, with the document's name, folder and next Fassung. A thread
 * whose document is held, gone or binned is no candidate for anyone. Whether
 * the VIEWER may read the folder is the caller's question (`candidates.ts`).
 */
export async function findThreadDocuments(projectId: string, threadIds: readonly string[]): Promise<ThreadDocument[]> {
  const ids = [...new Set(threadIds)].slice(0, 100)
  if (ids.length === 0) return []
  const rows = await getDb()
    .select({
      threadId: mailThreads.id,
      documentId: documents.id,
      filename: documents.filename,
      displayName: documents.displayName,
      folderId: documents.folderId,
      folderPath: projectFolders.path,
      // The next Fassung's number, read beside the document this query lets through.
      nextVersion: sql<string>`(SELECT coalesce(max(v.version_number), 0) + 1 FROM document_versions v WHERE v.document_id = ${documents.id})`,
      entryCount: mailThreads.entryCount,
      renderedBytes: mailThreads.renderedBytes,
    })
    .from(mailThreads)
    .innerJoin(documents, and(eq(documents.id, mailThreads.documentId), eq(documents.projectId, mailThreads.projectId)))
    .leftJoin(projectFolders, eq(projectFolders.id, documents.folderId))
    .where(
      and(
        eq(mailThreads.projectId, projectId),
        inArray(mailThreads.id, ids),
        documentVisibleTo(SCREENED_ONLY),
        or(isNull(documents.folderId), isNull(projectFolders.deletedAt)),
      ),
    )
    .limit(ids.length)
  return rows.map((row) => ({
    threadId: row.threadId,
    documentId: row.documentId,
    name: documentDisplayName({ filename: row.filename, displayName: row.displayName }),
    folderId: row.folderId,
    folderPath: row.folderPath ?? null,
    nextVersion: Number(row.nextVersion),
    entryCount: row.entryCount,
    renderedBytes: row.renderedBytes,
  }))
}

/** A document of the project a part matched, as a candidate is shown. */
export interface CandidateDocument {
  documentId: string
  name: string
  folderId: string | null
  folderPath: string | null
  nextVersion: number
}

/**
 * These documents of the project, screened and not in the bin: the documents
 * the parts' stored ids name (`duplicate_of`, `revision_candidate`). Whether
 * the viewer may read each folder is the caller's question.
 */
export async function findCandidateDocuments(projectId: string, documentIds: readonly string[]): Promise<CandidateDocument[]> {
  const ids = [...new Set(documentIds)].slice(0, 200)
  if (ids.length === 0) return []
  const rows = await getDb()
    .select({
      documentId: documents.id,
      filename: documents.filename,
      displayName: documents.displayName,
      folderId: documents.folderId,
      folderPath: projectFolders.path,
      nextVersion: sql<string>`(SELECT coalesce(max(v.version_number), 0) + 1 FROM document_versions v WHERE v.document_id = ${documents.id})`,
    })
    .from(documents)
    .leftJoin(projectFolders, eq(projectFolders.id, documents.folderId))
    .where(
      and(
        eq(documents.projectId, projectId),
        inArray(documents.id, ids),
        documentVisibleTo(SCREENED_ONLY),
        or(isNull(documents.folderId), isNull(projectFolders.deletedAt)),
      ),
    )
    .limit(ids.length)
  return rows.map((row) => ({
    documentId: row.documentId,
    name: documentDisplayName({ filename: row.filename, displayName: row.displayName }),
    folderId: row.folderId,
    folderPath: row.folderPath ?? null,
    nextVersion: Number(row.nextVersion),
  }))
}

/**
 * The document of the project already stored under this name (its stored,
 * composed form, `documentNameKey`), held ones included: a name is taken by
 * every row, which a unique index answers for all of them (`identity`). A
 * filing under a taken name would silently become that document's next
 * Fassung, so the decision asks for `revisionOf` instead (C2).
 */
export async function findDocumentIdByStoredName(projectId: string, storedName: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.projectId, projectId), eq(documents.filename, storedName), documentVisibleTo(internalRead('identity'))))
    .limit(1)
  return row?.id ?? null
}

/** The project's live folders among these ids, each with its path. */
export async function findLiveFolders(projectId: string, folderIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(folderIds)].slice(0, 200)
  if (ids.length === 0) return new Map()
  const rows = await getDb()
    .select({ id: projectFolders.id, path: projectFolders.path })
    .from(projectFolders)
    .where(
      and(
        eq(projectFolders.projectId, projectId),
        eq(projectFolders.scope, 'project'),
        inArray(projectFolders.id, ids),
        isNull(projectFolders.deletedAt),
      ),
    )
    .limit(ids.length)
  return new Map(rows.map((row) => [row.id, row.path]))
}

/** The mail changed since the person read it: their `ifMatch` no longer names it (C3). */
export class MailChangedError extends Error {
  constructor(readonly mailId: string) {
    super(`inbound mail ${mailId} changed since it was read`)
    this.name = 'MailChangedError'
  }
}

/** A part a decision named is no longer waiting: someone else decided first (C3). */
export class PartNotWaitingError extends Error {
  constructor(readonly mailId: string) {
    super(`a part of inbound mail ${mailId} is no longer waiting`)
    this.name = 'PartNotWaitingError'
  }
}

/** One mail's decision as the transaction writes it. */
export interface MailDecisionWrite {
  mailId: string
  /** The token the person read the mail at; checked against the rows under the lock. */
  ifMatch: string
  /** The `file` decisions, one per part filed, ids assigned by the caller. */
  files: NewInboundMailDecisionRow[]
}

/** Who decided and how, the same for every row of one request. */
export interface DecisionActor {
  decidedBy: string
  via: 'app' | 'agent' | 'piloti_proposal'
  proposalId: string | null
}

/** A filing job to queue in the same transaction as the decisions it reads. */
export interface FilingJob {
  jobId: string
  organizationId: string
  payload: Record<string, unknown>
}

/** What the transaction wrote, per mail: every decision row (file and dismiss). */
export interface DecisionsWritten {
  decisions: InboundMailDecisionRow[]
}

/**
 * Write one request's decisions (D26), all or nothing:
 *
 * 1. Lock each mail (`FOR UPDATE`) and refuse one whose `ifMatch`, recomputed
 *    from the rows under the lock by `ifMatchOf`, is not the one the person
 *    read ({@link MailChangedError}).
 * 2. Insert the `file` decisions, then claim each filed part `waiting →
 *    filing` with its own decision (compare-and-set: a part another request
 *    claimed first is {@link PartNotWaitingError}).
 * 3. Dismiss every other waiting part of the mail, each with a `dismiss`
 *    decision: a request decides the whole mail.
 * 4. Queue the filing job, in the same transaction, so a claimed part always
 *    has the job that files it and a job never reads a decision that is not there.
 *
 * The database holds the rest: a claim needs a `file` decision about that very
 * part, a clean scan, a person's id (migration 0186).
 */
export async function writeMailDecisions(
  writes: readonly MailDecisionWrite[],
  actor: DecisionActor,
  ifMatchOf: (mail: InboundMailRow, parts: readonly InboundMailPartRow[]) => string,
  claimExpiresAt: Date,
  job: FilingJob | null,
): Promise<DecisionsWritten> {
  return getDb().transaction(async (tx) => {
    const now = new Date()
    const decisions: InboundMailDecisionRow[] = []
    for (const write of writes) {
      const [mail] = await tx.select().from(inboundMails).where(eq(inboundMails.id, write.mailId)).for('update').limit(1)
      if (!mail || mail.status !== 'waiting') throw new MailChangedError(write.mailId)
      const parts = await findMailParts([write.mailId], tx)
      if (ifMatchOf(mail, parts) !== write.ifMatch) throw new MailChangedError(write.mailId)

      if (write.files.length > 0) decisions.push(...(await tx.insert(inboundMailDecisions).values([...write.files]).returning()))
      for (const decision of write.files) {
        const claimed = await tx
          .update(inboundMailParts)
          .set({ state: 'filing', decisionId: decision.id, claimExpiresAt, lastFailure: null, updatedAt: now })
          .where(and(eq(inboundMailParts.id, decision.partId), eq(inboundMailParts.mailId, write.mailId), eq(inboundMailParts.state, 'waiting')))
          .returning({ id: inboundMailParts.id })
        if (claimed.length !== 1) throw new PartNotWaitingError(write.mailId)
      }

      const filed = new Set(write.files.map((decision) => decision.partId))
      const others = parts.filter((part) => part.state === 'waiting' && !filed.has(part.id))
      decisions.push(...(await dismissParts(tx, mail, others, actor, now)))
      await tx.update(inboundMails).set({ updatedAt: now }).where(eq(inboundMails.id, write.mailId))
    }
    if (job) {
      await insertJobIfAbsent(
        { kind: 'inbound_mail_file', organizationId: job.organizationId, priority: BFF_JOB_PRIORITY.interactive, jobId: job.jobId, payload: job.payload },
        tx,
      )
    }
    return { decisions }
  })
}

/** Dismiss these waiting parts of `mail`, each with its `dismiss` decision. */
async function dismissParts(
  tx: DbTransaction,
  mail: InboundMailRow,
  parts: readonly InboundMailPartRow[],
  actor: DecisionActor,
  now: Date,
): Promise<InboundMailDecisionRow[]> {
  if (parts.length === 0) return []
  const rows = await tx
    .insert(inboundMailDecisions)
    .values(parts.map((part) => decisionRow(mail, part.id, 'dismiss', actor, now)))
    .returning()
  const dismissed = await tx
    .update(inboundMailParts)
    .set({ state: 'dismissed', endedAt: now, updatedAt: now })
    .where(and(inArray(inboundMailParts.id, parts.map((part) => part.id)), eq(inboundMailParts.state, 'waiting')))
    .returning({ id: inboundMailParts.id })
  if (dismissed.length !== parts.length) throw new PartNotWaitingError(mail.id)
  return rows
}

function decisionRow(
  mail: Pick<InboundMailRow, 'id' | 'organizationId' | 'projectId'>,
  partId: string,
  action: 'dismiss' | 'restore',
  actor: DecisionActor,
  now: Date,
): NewInboundMailDecisionRow {
  return {
    organizationId: mail.organizationId,
    projectId: mail.projectId,
    mailId: mail.id,
    partId,
    action,
    decidedBy: actor.decidedBy,
    via: actor.via,
    proposalId: actor.proposalId,
    decidedAt: now,
  }
}

/**
 * Dismiss every waiting part of these mails (`inbound-mail-dismiss`), each with
 * its decision. A mail that is not waiting, or has nothing waiting, is skipped:
 * dismissing twice changes nothing. Parts being filed are left to their job.
 */
export async function dismissMails(projectId: string, mailIds: readonly string[], actor: DecisionActor): Promise<DecisionsWritten> {
  return getDb().transaction(async (tx) => {
    const now = new Date()
    const decisions: InboundMailDecisionRow[] = []
    for (const mailId of mailIds) {
      const [mail] = await tx
        .select()
        .from(inboundMails)
        .where(and(eq(inboundMails.id, mailId), eq(inboundMails.projectId, projectId)))
        .for('update')
        .limit(1)
      if (!mail || mail.status !== 'waiting') continue
      const waiting = (await findMailParts([mailId], tx)).filter((part) => part.state === 'waiting')
      if (waiting.length === 0) continue
      decisions.push(...(await dismissParts(tx, mail, waiting, actor, now)))
      await tx.update(inboundMails).set({ updatedAt: now }).where(eq(inboundMails.id, mailId))
    }
    return { decisions }
  })
}

/**
 * Restore a mail's dismissed and expired parts that are still within their
 * seven days (D8): each waits again, with a `restore` decision. Only while the
 * mail itself is held (a settled mail is scrubbed and cannot be shown again);
 * an attachment only while its bytes are there. A restored expired mail waits
 * at least seven more days. Empty when there was nothing to restore, which
 * makes a repeated call a no-op.
 */
export async function restoreMailParts(
  projectId: string,
  mailId: string,
  actor: DecisionActor,
  restorableAfter: Date,
  waitsUntilAtLeast: Date,
): Promise<DecisionsWritten> {
  return getDb().transaction(async (tx) => {
    const now = new Date()
    const [mail] = await tx
      .select()
      .from(inboundMails)
      .where(and(eq(inboundMails.id, mailId), eq(inboundMails.projectId, projectId)))
      .for('update')
      .limit(1)
    if (!mail || mail.status !== 'waiting') return { decisions: [] }
    const restorable = (await findMailParts([mailId], tx)).filter(
      (part) =>
        (part.state === 'dismissed' || part.state === 'expired') &&
        part.endedAt !== null &&
        new Date(part.endedAt) > restorableAfter &&
        (part.kind === 'message' || part.storageKey !== null),
    )
    if (restorable.length === 0) return { decisions: [] }
    const decisions = await tx
      .insert(inboundMailDecisions)
      .values(restorable.map((part) => decisionRow(mail, part.id, 'restore', actor, now)))
      .returning()
    await tx
      .update(inboundMailParts)
      .set({ state: 'waiting', endedAt: null, updatedAt: now })
      .where(and(inArray(inboundMailParts.id, restorable.map((part) => part.id)), inArray(inboundMailParts.state, ['dismissed', 'expired'])))
    const expiresAt = new Date(Math.max(new Date(mail.expiresAt).getTime(), waitsUntilAtLeast.getTime()))
    await tx.update(inboundMails).set({ expiresAt, updatedAt: now }).where(eq(inboundMails.id, mailId))
    return { decisions }
  })
}

/** These decisions reached the audit trail (`audited_at`, once); sweep 11 sends the rest. */
export async function markDecisionsAudited(decisionIds: readonly string[], at: Date = new Date()): Promise<void> {
  if (decisionIds.length === 0) return
  await getDb()
    .update(inboundMailDecisions)
    .set({ auditedAt: at })
    .where(and(inArray(inboundMailDecisions.id, [...decisionIds]), isNull(inboundMailDecisions.auditedAt)))
}

/** The parts' kinds, for the audit lines of their decisions. */
export async function findPartKinds(partIds: readonly string[]): Promise<Map<string, 'message' | 'attachment'>> {
  if (partIds.length === 0) return new Map()
  const rows = await getDb()
    .select({ id: inboundMailParts.id, kind: inboundMailParts.kind })
    .from(inboundMailParts)
    .where(inArray(inboundMailParts.id, [...partIds]))
    .limit(partIds.length)
  return new Map(rows.map((row) => [row.id, row.kind]))
}

/** Whether any part of the mail still waits for a person (or is being filed). */
export async function hasOpenParts(mailId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: inboundMailParts.id })
    .from(inboundMailParts)
    .where(and(eq(inboundMailParts.mailId, mailId), inArray(inboundMailParts.state, [...OPEN_PART_STATES])))
    .limit(1)
  return Boolean(row)
}

// ---------------------------------------------------------------------------
// The suggest job (Piloti's suggestion, D21)
// ---------------------------------------------------------------------------

/**
 * Store Piloti's suggestion on the parts it placed, with the generation's
 * trace. Only a part that still waits takes one: a person who decided in the
 * meantime decided without it, and the suggestion would name a file whose
 * bytes may be gone (`inbound_mail_parts_suggestion_with_bytes`). The number
 * of parts that took one.
 *
 * `updated_at` is left alone on purpose: it is part of the mail's `ifMatch`
 * (`mailIfMatch`), and a suggestion arriving while a person reads the mail must
 * not make their decision stale. It advises; it changes nothing they decide on.
 */
export async function storePartSuggestions(
  mailId: string,
  suggestions: ReadonlyMap<string, Record<string, unknown>>,
  traceId: string | null,
): Promise<number> {
  let stored = 0
  for (const [partId, suggestion] of suggestions) {
    const rows = await getDb()
      .update(inboundMailParts)
      .set({ suggestion, suggestionTraceId: traceId })
      .where(and(eq(inboundMailParts.id, partId), eq(inboundMailParts.mailId, mailId), eq(inboundMailParts.state, 'waiting')))
      .returning({ id: inboundMailParts.id })
    stored += rows.length
  }
  return stored
}
