import 'server-only'
/**
 * SQL for reading the E-Mail-Verläufe of a project (ADR-0134): the thread
 * list, one thread with its entries, follows and attachments. No
 * authorization here (`./service.ts` decides who may ask; row-level security
 * is the backstop), and every list is bounded.
 *
 * A thread is only as visible as its document: every read joins the thread's
 * document under `documentVisibleTo(SCREENED_ONLY)` (a thread whose document
 * has not passed its screening is nobody's to list, D9) and leaves out a
 * document in the bin or in a folder the reader may not open (`hiddenFolders`,
 * the caller's `getHiddenFolderIds`).
 */

import { and, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  documents,
  documentVersions,
  inboundMailParts,
  inboundMails,
  mailThreadEntries,
  mailThreadEntryAttachments,
  mailThreadFollows,
  mailThreads,
  projectFolders,
  type MailThreadEntryRow,
  type MailThreadFollowRow,
} from '@/lib/db/schema'
import { documentDisplayName } from '@/lib/documents/display-name'
import { CURSOR_TIMESTAMP_FORMAT } from '@/lib/documents/list-cursor'
import { documentVisibleTo, SCREENED_ONLY } from '@/lib/documents/visibility'
import type { MailThreadAttachmentDisposition, MailThreadAttachmentNotFiledReason } from './mail-thread-wire'
import { MAIL_THREAD_MAX_ENTRIES } from './mail-thread-vocabulary'

/** A thread as a list shows it, with its document's name and where it sits. */
export interface ThreadRow {
  id: string
  documentId: string
  name: string
  folderId: string | null
  entryCount: number
  lastEntryAt: Date | null
  participantDomains: string[]
  continuesThreadId: string | null
  /** `created_at` as `to_char(… 'US')` wrote it: the list's keyset position. */
  createdAtText: string
}

/** A position in the thread list's `created_at DESC, id ASC` order. */
export interface ThreadListPosition {
  createdAt: string
  id: string
}

/** The threads of the project whose live, screened document sits outside `hiddenFolders`. */
function visibleThreads(projectId: string, hiddenFolders: readonly string[]) {
  return and(
    eq(mailThreads.projectId, projectId),
    documentVisibleTo(SCREENED_ONLY),
    or(isNull(documents.folderId), isNull(projectFolders.deletedAt)),
    hiddenFolders.length > 0 ? or(isNull(documents.folderId), notInArray(documents.folderId, [...hiddenFolders])) : undefined,
  )
}

const threadColumns = {
  id: mailThreads.id,
  documentId: documents.id,
  filename: documents.filename,
  displayName: documents.displayName,
  folderId: documents.folderId,
  entryCount: mailThreads.entryCount,
  lastEntryAt: mailThreads.lastEntryAt,
  participantDomains: mailThreads.participantDomains,
  continuesThreadId: mailThreads.continuesThreadId,
  createdAtText: sql<string>`to_char(${mailThreads.createdAt} AT TIME ZONE 'UTC', ${CURSOR_TIMESTAMP_FORMAT})`,
}

type ThreadColumns = {
  id: string
  documentId: string
  filename: string
  displayName: string | null
  folderId: string | null
  entryCount: number
  lastEntryAt: Date | string | null
  participantDomains: string[]
  continuesThreadId: string | null
  createdAtText: string
}

const toThreadRow = (row: ThreadColumns): ThreadRow => ({
  id: row.id,
  documentId: row.documentId,
  name: documentDisplayName({ filename: row.filename, displayName: row.displayName }),
  folderId: row.folderId,
  entryCount: row.entryCount,
  lastEntryAt: row.lastEntryAt ? new Date(row.lastEntryAt) : null,
  participantDomains: row.participantDomains,
  continuesThreadId: row.continuesThreadId,
  createdAtText: String(row.createdAtText),
})

/**
 * One page of the project's threads the reader may see, newest first; one row
 * more than `limit`, so the caller knows a page follows. `documentId` narrows
 * it to the thread of one document (the „E-Mails“ tab of a preview).
 */
export async function listVisibleThreads(
  projectId: string,
  hiddenFolders: readonly string[],
  query: { documentId?: string; limit: number },
  after: ThreadListPosition | null,
): Promise<ThreadRow[]> {
  const position = after
    ? sql`(${mailThreads.createdAt} < (${after.createdAt})::timestamp AT TIME ZONE 'UTC'
         OR (${mailThreads.createdAt} = (${after.createdAt})::timestamp AT TIME ZONE 'UTC' AND ${mailThreads.id} > ${after.id}))`
    : undefined
  const rows = await getDb()
    .select(threadColumns)
    .from(mailThreads)
    .innerJoin(documents, and(eq(documents.id, mailThreads.documentId), eq(documents.projectId, mailThreads.projectId)))
    .leftJoin(projectFolders, eq(projectFolders.id, documents.folderId))
    .where(
      and(
        visibleThreads(projectId, hiddenFolders),
        query.documentId ? eq(mailThreads.documentId, query.documentId) : undefined,
        position,
      ),
    )
    .orderBy(desc(mailThreads.createdAt), mailThreads.id)
    .limit(query.limit + 1)
  return rows.map(toThreadRow)
}

/** One thread of the project, if the reader may see its document; null otherwise (and for a thread with no document yet). */
export async function findVisibleThread(projectId: string, threadId: string, hiddenFolders: readonly string[]): Promise<ThreadRow | null> {
  const [row] = await getDb()
    .select(threadColumns)
    .from(mailThreads)
    .innerJoin(documents, and(eq(documents.id, mailThreads.documentId), eq(documents.projectId, mailThreads.projectId)))
    .leftJoin(projectFolders, eq(projectFolders.id, documents.folderId))
    .where(and(visibleThreads(projectId, hiddenFolders), eq(mailThreads.id, threadId)))
    .limit(1)
  return row ? toThreadRow(row) : null
}

/** A filed message, and the number of the Fassung it first appeared in. */
export interface EntryRow {
  entry: MailThreadEntryRow
  firstVersion: { id: string; number: number } | null
}

/**
 * A thread's entries in the order its document renders them (sent time),
 * at most {@link MAIL_THREAD_MAX_ENTRIES}, each with its first Fassung's number,
 * read through the thread document, which the caller already let through.
 */
export async function findThreadEntries(threadId: string): Promise<EntryRow[]> {
  const rows = await getDb()
    .select({ entry: mailThreadEntries, versionId: documentVersions.id, versionNumber: documentVersions.versionNumber })
    .from(mailThreadEntries)
    .innerJoin(mailThreads, eq(mailThreads.id, mailThreadEntries.threadId))
    .leftJoin(documents, eq(documents.id, mailThreads.documentId))
    .leftJoin(
      documentVersions,
      and(eq(documentVersions.id, mailThreadEntries.firstVersionId), eq(documentVersions.documentId, documents.id)),
    )
    .where(and(eq(mailThreadEntries.threadId, threadId), or(isNull(documents.id), documentVisibleTo(SCREENED_ONLY))))
    .orderBy(mailThreadEntries.sentAt, mailThreadEntries.id)
    .limit(MAIL_THREAD_MAX_ENTRIES)
  return rows.map((row) => ({
    entry: row.entry,
    firstVersion: row.versionId && row.versionNumber !== null ? { id: row.versionId, number: row.versionNumber } : null,
  }))
}

/** One attachment of an entry, before the reader's folder rule is applied (D36). */
export interface EntryAttachment {
  entryId: string
  position: number
  filename: string | null
  disposition: MailThreadAttachmentDisposition
  notFiledReason: MailThreadAttachmentNotFiledReason | null
  documentId: string | null
  documentVersionId: string | null
  /** Where the document is filed now, when it is screened and live; null when it is not (or there is none). */
  document: { folderId: string | null } | null
}

/**
 * Every attachment of these entries, by entry and position, with where each
 * filed document is now: the one door to an entry's attachments
 * (`mail_thread_entry_attachments`, D36), so the thread view asks nothing else.
 * A document that is held, binned or gone answers `document: null`, which the
 * view shows as not visible.
 */
export async function entryAttachments(entries: readonly MailThreadEntryRow[]): Promise<EntryAttachment[]> {
  if (entries.length === 0) return []
  const rows = await getDb()
    .select({
      entryId: mailThreadEntryAttachments.entryId,
      position: mailThreadEntryAttachments.position,
      filename: mailThreadEntryAttachments.filename,
      disposition: mailThreadEntryAttachments.disposition,
      notFiledReason: mailThreadEntryAttachments.notFiledReason,
      documentId: mailThreadEntryAttachments.documentId,
      documentVersionId: mailThreadEntryAttachments.documentVersionId,
      liveDocumentId: documents.id,
      folderId: documents.folderId,
    })
    .from(mailThreadEntryAttachments)
    .leftJoin(
      documents,
      and(
        eq(documents.id, mailThreadEntryAttachments.documentId),
        documentVisibleTo(SCREENED_ONLY),
        sql`(${documents.folderId} IS NULL OR NOT EXISTS (
              SELECT 1 FROM ${projectFolders} f WHERE f.id = ${documents.folderId} AND f.deleted_at IS NOT NULL))`,
      ),
    )
    .where(inArray(mailThreadEntryAttachments.entryId, entries.map((entry) => entry.id)))
    .orderBy(mailThreadEntryAttachments.entryId, mailThreadEntryAttachments.position)
    // An entry carries at most as many attachments as its mail had parts (100) and unstaged files (100).
    .limit(entries.length * 200)
  return rows.map((row) => ({
    entryId: row.entryId,
    position: row.position,
    filename: row.filename,
    disposition: row.disposition,
    notFiledReason: row.notFiledReason,
    documentId: row.documentId,
    documentVersionId: row.documentVersionId,
    document: row.liveDocumentId ? { folderId: row.folderId } : null,
  }))
}

/** One mail that brought (a Fassung of) a document, through a thread the reader may read (D36). */
export interface MailOriginRow {
  documentVersionId: string | null
  threadId: string
  entryId: string
  sentAt: Date
  receivedAt: Date
  senderName: string | null
  signerDomain: string | null
  senderTrust: MailThreadEntryRow['senderTrust']
}

/** The most mails one document names as its origins: far beyond any real Fassung history. */
export const MAIL_ORIGINS_LIMIT = 100

/**
 * The mails that brought this document, one row per filed or already present
 * attachment, oldest first: only through a thread whose document the reader
 * may read (screened, live, outside `hiddenFolders`), so a restricted Verlauf
 * names nothing. The caller already let the reader through to the document.
 */
export async function findMailOrigins(
  projectId: string,
  documentId: string,
  hiddenFolders: readonly string[],
): Promise<MailOriginRow[]> {
  const rows = await getDb()
    .select({
      documentVersionId: mailThreadEntryAttachments.documentVersionId,
      threadId: mailThreads.id,
      entryId: mailThreadEntries.id,
      sentAt: mailThreadEntries.sentAt,
      receivedAt: mailThreadEntries.receivedAt,
      senderName: mailThreadEntries.senderName,
      signerDomain: mailThreadEntries.signerDomain,
      senderTrust: mailThreadEntries.senderTrust,
    })
    .from(mailThreadEntryAttachments)
    .innerJoin(mailThreadEntries, eq(mailThreadEntries.id, mailThreadEntryAttachments.entryId))
    .innerJoin(mailThreads, eq(mailThreads.id, mailThreadEntries.threadId))
    .innerJoin(documents, and(eq(documents.id, mailThreads.documentId), eq(documents.projectId, mailThreads.projectId)))
    .leftJoin(projectFolders, eq(projectFolders.id, documents.folderId))
    .where(
      and(
        eq(mailThreadEntryAttachments.projectId, projectId),
        eq(mailThreadEntryAttachments.documentId, documentId),
        inArray(mailThreadEntryAttachments.disposition, ['filed', 'already_present']),
        visibleThreads(projectId, hiddenFolders),
      ),
    )
    .orderBy(mailThreadEntries.sentAt, mailThreadEntries.id)
    .limit(MAIL_ORIGINS_LIMIT)
  return rows.map((row) => ({ ...row, sentAt: new Date(row.sentAt), receivedAt: new Date(row.receivedAt) }))
}

/** The running follows of a thread (D31), oldest first. */
export async function findActiveFollows(threadIds: readonly string[]): Promise<MailThreadFollowRow[]> {
  if (threadIds.length === 0) return []
  return getDb()
    .select()
    .from(mailThreadFollows)
    .where(and(inArray(mailThreadFollows.threadId, [...threadIds]), isNull(mailThreadFollows.endedAt)))
    .orderBy(mailThreadFollows.createdAt)
    .limit(threadIds.length * 50)
}

/** How many mails waiting in the E-Mail-Eingang matched this thread (`thread_match`), for a writer's „3 neue E-Mails“. */
export async function countWaitingForThread(projectId: string, threadId: string): Promise<number> {
  const [row] = await getDb()
    .select({ count: sql<string>`count(*)` })
    .from(inboundMails)
    .where(
      and(
        eq(inboundMails.projectId, projectId),
        eq(inboundMails.status, 'waiting'),
        sql`${inboundMails.threadMatch} @> ${JSON.stringify([{ threadId }])}::jsonb`,
        sql`EXISTS (SELECT 1 FROM ${inboundMailParts} p WHERE p.mail_id = ${inboundMails.id} AND p.state = 'waiting')`,
      ),
    )
  return Number(row?.count ?? 0)
}
