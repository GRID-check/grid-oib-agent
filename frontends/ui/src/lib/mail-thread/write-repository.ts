import 'server-only'
/**
 * SQL that writes an E-Mail-Verlauf (ADR-0134): the render lease, the reads a
 * new Fassung is rendered from, the one transaction that records a filed
 * message, a detach, and an entry's kept original. No authorization here: the
 * filing job, the follow job and the detach service decide who may, and
 * row-level security is the backstop. Every list is bounded.
 *
 * The rules the rows keep are the migration's (0186): an entry is a person's,
 * its heading unique in its thread, its original under exactly its own key;
 * what came with a message is frozen once written (the guard on
 * `mail_thread_entry_attachments`); DELETE is revoked, so a detach MOVES an
 * entry. A function that may run inside a caller's transaction takes its
 * executor (`transaction-shape.spec.ts`).
 */

import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import type { DbExecutor, DbTransaction } from '@/lib/db/executor'
import {
  documents,
  documentVersions,
  inboundMailParts,
  inboundMails,
  mailThreadEntries,
  mailThreadEntryAttachments,
  mailThreadFollows,
  mailThreadMessageIds,
  mailThreads,
  projectFolders,
  type MailThreadEntryAttachmentRow,
  type MailThreadEntryRow,
  type MailThreadRow,
  type NewMailThreadEntryAttachmentRow,
  type NewMailThreadEntryRow,
  type NewMailThreadRow,
} from '@/lib/db/schema'
import type { DocumentReader } from '@/lib/documents/document-reader'
import { documentVisibleTo } from '@/lib/documents/visibility'
import { MAIL_THREAD_MAX_ENTRIES } from './mail-thread-vocabulary'

// ---------------------------------------------------------------------------
// The render lease
// ---------------------------------------------------------------------------

/**
 * Take the thread's render lease for `holder` until `until`: free, run out, or
 * already this holder's (a retry). False when another writer holds it. A
 * compare-and-set in one statement, so two writers never both hold it.
 */
export async function acquireRenderLease(
  threadId: string,
  holder: string,
  until: Date
): Promise<boolean> {
  const taken = await getDb()
    .update(mailThreads)
    .set({ renderLeaseHolder: holder, renderLeaseUntil: until })
    .where(
      and(
        eq(mailThreads.id, threadId),
        or(
          isNull(mailThreads.renderLeaseUntil),
          lt(mailThreads.renderLeaseUntil, sql`now()`),
          eq(mailThreads.renderLeaseHolder, holder)
        )
      )
    )
    .returning({ id: mailThreads.id })
  return taken.length === 1
}

/** Let the lease go, if it is still `holder`'s. */
export async function releaseRenderLease(threadId: string, holder: string): Promise<void> {
  await getDb()
    .update(mailThreads)
    .set({ renderLeaseHolder: null, renderLeaseUntil: null })
    .where(and(eq(mailThreads.id, threadId), eq(mailThreads.renderLeaseHolder, holder)))
}

// ---------------------------------------------------------------------------
// What a Fassung is rendered from
// ---------------------------------------------------------------------------

/** A thread with the document its next Fassung is written to. */
export interface WritableThread {
  thread: MailThreadRow
  document: {
    id: string
    filename: string
    folderId: string | null
    contentHash: string | null
  }
}

/**
 * The thread, if its document is live for `reader`: readable by them, not
 * archived, not in a folder in the bin. Null when the thread is gone, has no
 * document, or its document is out of reach (`thread_document_gone`).
 */
export async function findWritableThread(
  projectId: string,
  threadId: string,
  reader: DocumentReader
): Promise<WritableThread | null> {
  const [row] = await getDb()
    .select({
      thread: mailThreads,
      documentId: documents.id,
      filename: documents.filename,
      folderId: documents.folderId,
      contentHash: documents.contentHash,
    })
    .from(mailThreads)
    .innerJoin(
      documents,
      and(eq(documents.id, mailThreads.documentId), eq(documents.projectId, mailThreads.projectId))
    )
    .leftJoin(projectFolders, eq(projectFolders.id, documents.folderId))
    .where(
      and(
        eq(mailThreads.projectId, projectId),
        eq(mailThreads.id, threadId),
        eq(documents.lifecycle, 'active'),
        documentVisibleTo(reader),
        or(isNull(documents.folderId), isNull(projectFolders.deletedAt))
      )
    )
    .limit(1)
  if (!row) return null
  return {
    thread: row.thread,
    document: {
      id: row.documentId,
      filename: row.filename,
      folderId: row.folderId,
      contentHash: row.contentHash,
    },
  }
}

/** A thread row by id in the project, whatever its document; null when there is none. */
export async function findThreadRow(
  projectId: string,
  threadId: string,
  executor: DbExecutor = getDb()
): Promise<MailThreadRow | null> {
  const [row] = await executor
    .select()
    .from(mailThreads)
    .where(and(eq(mailThreads.projectId, projectId), eq(mailThreads.id, threadId)))
    .limit(1)
  return row ?? null
}

/** Every entry of the thread (at most {@link MAIL_THREAD_MAX_ENTRIES}), in filing order. */
export async function findThreadEntryRows(threadId: string): Promise<MailThreadEntryRow[]> {
  return getDb()
    .select()
    .from(mailThreadEntries)
    .where(eq(mailThreadEntries.threadId, threadId))
    .orderBy(mailThreadEntries.filedAt, mailThreadEntries.id)
    .limit(MAIL_THREAD_MAX_ENTRIES + 1)
}

/** What came with these entries, by entry, in the message's order. */
export async function findEntryAttachmentRows(
  entryIds: readonly string[]
): Promise<Map<string, MailThreadEntryAttachmentRow[]>> {
  const byEntry = new Map<string, MailThreadEntryAttachmentRow[]>()
  if (entryIds.length === 0) return byEntry
  const rows = await getDb()
    .select()
    .from(mailThreadEntryAttachments)
    .where(inArray(mailThreadEntryAttachments.entryId, [...entryIds]))
    .orderBy(mailThreadEntryAttachments.entryId, mailThreadEntryAttachments.position)
    .limit(entryIds.length * 200)
  for (const row of rows) byEntry.set(row.entryId, [...(byEntry.get(row.entryId) ?? []), row])
  return byEntry
}

/** The entry a mail was filed as, in any thread of the project; null before it is. */
export async function findEntryOfMail(
  projectId: string,
  mailId: string
): Promise<MailThreadEntryRow | null> {
  const [row] = await getDb()
    .select()
    .from(mailThreadEntries)
    .where(
      and(eq(mailThreadEntries.projectId, projectId), eq(mailThreadEntries.inboundMailId, mailId))
    )
    .limit(1)
  return row ?? null
}

/** A document's newest Fassung, as `reader` may read the document. */
export interface CurrentVersion {
  documentId: string
  versionId: string
  versionCreatedAt: Date
  contentHash: string | null
  folderId: string | null
}

/** The newest Fassung of each of these documents `reader` may read. */
export async function findCurrentVersions(
  documentIds: readonly string[],
  reader: DocumentReader
): Promise<Map<string, CurrentVersion>> {
  const ids = [...new Set(documentIds)]
  if (ids.length === 0) return new Map()
  const rows = await getDb()
    .selectDistinctOn([documentVersions.documentId], {
      documentId: documentVersions.documentId,
      versionId: documentVersions.id,
      versionCreatedAt: documentVersions.createdAt,
      contentHash: documents.contentHash,
      folderId: documents.folderId,
    })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(and(inArray(documentVersions.documentId, ids), documentVisibleTo(reader)))
    .orderBy(documentVersions.documentId, desc(documentVersions.versionNumber))
    .limit(ids.length)
  return new Map(
    rows.map((row) => [
      row.documentId,
      { ...row, versionCreatedAt: new Date(row.versionCreatedAt) },
    ])
  )
}

/** When each of these Fassungen was made, of documents `reader` may read: was it this mail's, or there before? */
export async function findVersionTimes(
  versionIds: readonly string[],
  reader: DocumentReader
): Promise<Map<string, Date>> {
  const ids = [...new Set(versionIds)]
  if (ids.length === 0) return new Map()
  const rows = await getDb()
    .select({ id: documentVersions.id, createdAt: documentVersions.createdAt })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(and(inArray(documentVersions.id, ids), documentVisibleTo(reader)))
    .limit(ids.length)
  return new Map(rows.map((row) => [row.id, new Date(row.createdAt)]))
}

// ---------------------------------------------------------------------------
// Recording a filed message
// ---------------------------------------------------------------------------

/** Everything one filed message writes, in one transaction. */
export interface AppendCommit {
  /** A new thread to insert first (its first Fassung), or null to update the existing one. */
  newThread: NewMailThreadRow | null
  threadId: string
  /** What the thread row says after this Fassung. */
  threadUpdate: Pick<
    MailThreadRow,
    'documentId' | 'entryCount' | 'renderedBytes' | 'lastEntryAt' | 'participantDomains'
  >
  entry: NewMailThreadEntryRow
  messageIds: { received: string | null; referenced: readonly string[] }
  attachments: readonly NewMailThreadEntryAttachmentRow[]
  /** The message part this entry files, and the Fassung it went into. */
  part: { id: string; documentId: string; versionId: string | null }
  /** Mark the mail's raw message as moving to the entry's original (retry-safe; sweep 13 finishes it). */
  mailId: string
  movesOriginal: boolean
}

/**
 * Record a filed message, all or nothing: the thread (new, or its counters and
 * document), the entry, its Message-IDs, what came with it, the message part
 * `filed` naming its entry and Fassung, and the mail's original as moving. A
 * second commit of the same entry (a retry after a lost answer) finds it and
 * changes nothing: the entry's id is the decision's.
 */
export async function commitAppend(commit: AppendCommit): Promise<'committed' | 'already'> {
  return getDb().transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: mailThreadEntries.id })
      .from(mailThreadEntries)
      .where(eq(mailThreadEntries.id, commit.entry.id!))
      .limit(1)
    if (existing) return 'already'
    if (commit.newThread) await tx.insert(mailThreads).values(commit.newThread)
    await tx
      .update(mailThreads)
      .set({ ...commit.threadUpdate, renderPendingAt: null })
      .where(eq(mailThreads.id, commit.threadId))
    await tx.insert(mailThreadEntries).values(commit.entry)
    await insertMessageIds(tx, commit.entry, commit.messageIds)
    if (commit.attachments.length > 0)
      await tx.insert(mailThreadEntryAttachments).values([...commit.attachments])
    await tx
      .update(inboundMailParts)
      .set({
        state: 'filed',
        claimExpiresAt: null,
        filedAt: new Date(),
        documentId: commit.part.documentId,
        documentVersionId: commit.part.versionId,
        mailThreadEntryId: commit.entry.id,
        lastFailure: null,
        updatedAt: new Date(),
      })
      .where(and(eq(inboundMailParts.id, commit.part.id), eq(inboundMailParts.state, 'filing')))
    if (commit.movesOriginal) {
      await tx
        .update(inboundMails)
        .set({ originalMovePendingAt: new Date(), updatedAt: new Date() })
        .where(
          and(eq(inboundMails.id, commit.mailId), sql`${inboundMails.rawStorageKey} IS NOT NULL`)
        )
    }
    return 'committed'
  })
}

async function insertMessageIds(
  tx: DbTransaction,
  entry: NewMailThreadEntryRow,
  ids: { received: string | null; referenced: readonly string[] }
): Promise<void> {
  const base = {
    organizationId: entry.organizationId,
    projectId: entry.projectId,
    threadId: entry.threadId,
    entryId: entry.id!,
  }
  const rows = [
    ...(ids.received ? [{ ...base, messageId: ids.received, state: 'received' as const }] : []),
    ...[...new Set(ids.referenced)]
      .filter((id) => id !== ids.received)
      .map((messageId) => ({ ...base, messageId, state: 'referenced' as const })),
  ]
  if (rows.length > 0) await tx.insert(mailThreadMessageIds).values(rows).onConflictDoNothing()
}

/**
 * Link a row of what came with a message that still waited when the message was
 * filed (`pending`) to what became of it later (D36): filed as a document and
 * Fassung, or ended for good. The section's words stay as they were frozen.
 */
export async function decidePendingAttachment(
  entryId: string,
  position: number,
  outcome:
    | { disposition: 'filed' | 'already_present'; documentId: string; versionId: string | null }
    | {
        disposition: 'not_filed'
        reason: Exclude<MailThreadEntryAttachmentRow['notFiledReason'], 'pending' | null>
      }
): Promise<void> {
  await getDb()
    .update(mailThreadEntryAttachments)
    .set(
      outcome.disposition === 'not_filed'
        ? { notFiledReason: outcome.reason }
        : {
            disposition: outcome.disposition,
            notFiledReason: null,
            documentId: outcome.documentId,
            documentVersionId: outcome.versionId,
          }
    )
    .where(
      and(
        eq(mailThreadEntryAttachments.entryId, entryId),
        eq(mailThreadEntryAttachments.position, position),
        eq(mailThreadEntryAttachments.disposition, 'not_filed'),
        eq(mailThreadEntryAttachments.notFiledReason, 'pending')
      )
    )
}

// ---------------------------------------------------------------------------
// The original
// ---------------------------------------------------------------------------

/** An entry with its thread and the mail it came from, as the original's move and download need it. */
export async function findEntry(
  projectId: string,
  entryId: string
): Promise<MailThreadEntryRow | null> {
  const [row] = await getDb()
    .select()
    .from(mailThreadEntries)
    .where(and(eq(mailThreadEntries.projectId, projectId), eq(mailThreadEntries.id, entryId)))
    .limit(1)
  return row ?? null
}

/** The entry keeps its original now: bucket, key, digest, size and the raw message's scan. Only once. */
export async function recordEntryOriginal(
  entryId: string,
  original: Pick<
    MailThreadEntryRow,
    | 'originalBucket'
    | 'originalStorageKey'
    | 'originalSha256'
    | 'originalBytes'
    | 'originalScanStatus'
    | 'originalScannedAt'
  >
): Promise<void> {
  await getDb()
    .update(mailThreadEntries)
    .set(original)
    .where(and(eq(mailThreadEntries.id, entryId), isNull(mailThreadEntries.originalStorageKey)))
}

/** The mail no longer names its raw message: it moved to the entry's original (and was erased by its key). */
export async function forgetMovedRaw(mailId: string): Promise<void> {
  await getDb()
    .update(inboundMails)
    .set({ rawStorageKey: null, originalMovePendingAt: null, updatedAt: new Date() })
    .where(eq(inboundMails.id, mailId))
}

// ---------------------------------------------------------------------------
// Detach
// ---------------------------------------------------------------------------

/** What a detach writes, in one transaction. */
export interface DetachCommit {
  entryId: string
  fromThreadId: string
  toThreadId: string
  /** A new thread to insert first, or null to append to an existing one. */
  newThread: NewMailThreadRow | null
  /** The entry's heading in its new thread (the old one may be taken there). */
  heading: string
  fromThreadUpdate: Pick<MailThreadRow, 'entryCount' | 'renderedBytes' | 'lastEntryAt'>
  toThreadUpdate: Pick<
    MailThreadRow,
    'documentId' | 'entryCount' | 'renderedBytes' | 'lastEntryAt' | 'participantDomains'
  >
  /** The Fassung of the new thread the message now first appears in. */
  firstVersionId: string | null
  /**
   * When the message joined its new thread: a section there may lean only on
   * entries filed before it (`./render.ts`), so the moved entry counts as filed
   * now, after every entry already there.
   */
  movedAt: Date
}

/**
 * Move an entry to another thread (D34, D2: an UPDATE, DELETE is revoked):
 * its Message-IDs move with it (`ON UPDATE CASCADE`), its original keeps its
 * key, what came with it stays its. Every follow of the thread it left ends
 * (`detached`): a person followed the conversation as it was. Returns the
 * follows it ended.
 */
export async function commitDetach(
  commit: DetachCommit
): Promise<Array<{ id: string; userId: string }>> {
  return getDb().transaction(async (tx) => {
    if (commit.newThread) await tx.insert(mailThreads).values(commit.newThread)
    await tx
      .update(mailThreadEntries)
      .set({
        threadId: commit.toThreadId,
        heading: commit.heading,
        firstVersionId: commit.firstVersionId,
        inReplyToEntryId: null,
        filedAt: commit.movedAt,
      })
      .where(
        and(
          eq(mailThreadEntries.id, commit.entryId),
          eq(mailThreadEntries.threadId, commit.fromThreadId)
        )
      )
    // A reply in the old thread no longer answers a message that is not there.
    await tx
      .update(mailThreadEntries)
      .set({ inReplyToEntryId: null })
      .where(
        and(
          eq(mailThreadEntries.threadId, commit.fromThreadId),
          eq(mailThreadEntries.inReplyToEntryId, commit.entryId)
        )
      )
    await tx
      .update(mailThreads)
      .set(commit.fromThreadUpdate)
      .where(eq(mailThreads.id, commit.fromThreadId))
    await tx
      .update(mailThreads)
      .set(commit.toThreadUpdate)
      .where(eq(mailThreads.id, commit.toThreadId))
    return tx
      .update(mailThreadFollows)
      .set({ endedAt: commit.movedAt, endedReason: 'detached' })
      .where(
        and(eq(mailThreadFollows.threadId, commit.fromThreadId), isNull(mailThreadFollows.endedAt))
      )
      .returning({ id: mailThreadFollows.id, userId: mailThreadFollows.userId })
  })
}
