/**
 * SQL for upload batches (migration 0110). Every function names its
 * organization and runs inside `withTenant`, except the sweep's discovery,
 * which is cross-tenant by design and says so where it is called.
 */

import 'server-only'
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import {
  documents,
  uploadBatches,
  type Document,
  type NewUploadBatch,
  type UploadBatch,
} from '@/lib/db/schema'
import { IN_FLIGHT_DOCUMENT_STATUSES } from '@/lib/documents/document-status'
import { CURSOR_TIMESTAMP_FORMAT, type DocumentListCursor } from '@/lib/documents/list-cursor'
import { outsideHiddenFolders } from '@/lib/documents/repository'
import { documentVisibleTo, type DocumentReader } from '@/lib/documents/visibility'

/** Uploads per page of a project's history; the rest is behind the page's cursor. */
export const UPLOAD_HISTORY_LIMIT = 50
/** Bound on the documents a summary lists. A batch above it is summarised by counts. */
export const UPLOAD_SUMMARY_DOCUMENT_LIMIT = 500

/** Open a batch. An id the browser already used in this organization is a no-op (a retried request). */
export async function insertUploadBatch(values: NewUploadBatch): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId: values.organizationId }, () =>
    db.insert(uploadBatches).values(values).onConflictDoNothing({ target: uploadBatches.id })
  )
}

export async function findUploadBatch(organizationId: string, batchId: string): Promise<UploadBatch | null> {
  const db = getDb()
  const [row] = await withTenant({ organizationId }, () =>
    db
      .select()
      .from(uploadBatches)
      .where(and(eq(uploadBatches.id, batchId), eq(uploadBatches.organizationId, organizationId)))
      .limit(1)
  )
  return row ?? null
}

/** Seal a batch its creator finished sending. Only the creator, and only once. */
export async function sealUploadBatch(
  organizationId: string,
  batchId: string,
  createdBy: string,
  counts: { unchanged: number; failed: number },
  sealedAt: Date
): Promise<boolean> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .update(uploadBatches)
      .set({ unchangedCount: counts.unchanged, failedCount: counts.failed, sealedAt })
      .where(
        and(
          eq(uploadBatches.id, batchId),
          eq(uploadBatches.organizationId, organizationId),
          eq(uploadBatches.createdBy, createdBy),
          isNull(uploadBatches.sealedAt)
        )
      )
      .returning({ id: uploadBatches.id })
  )
  return rows.length > 0
}

/**
 * Complete every given batch that is sealed and has no document left in
 * flight. Guarded on `completed_at IS NULL`, so each batch completes once
 * however many readers settle its last document at the same time; the rows
 * returned are exactly the ones this call completed.
 */
export async function completeSettledBatches(
  organizationId: string,
  batchIds: readonly string[],
  completedAt: Date
): Promise<UploadBatch[]> {
  if (batchIds.length === 0) return []
  const db = getDb()
  const inFlight = [...IN_FLIGHT_DOCUMENT_STATUSES]
  return withTenant({ organizationId }, () =>
    db
      .update(uploadBatches)
      .set({ completedAt })
      .where(
        and(
          inArray(uploadBatches.id, [...batchIds]),
          eq(uploadBatches.organizationId, organizationId),
          isNull(uploadBatches.completedAt),
          isNotNull(uploadBatches.sealedAt),
          sql`NOT EXISTS (
            SELECT 1 FROM ${documents}
            WHERE ${documents.uploadBatchId} = ${uploadBatches.id}
              AND ${documents.organizationId} = ${organizationId}
              AND ${documents.status} IN (${sql.join(
                inFlight.map((status) => sql`${status}`),
                sql`, `
              )})
          )`
        )
      )
      .returning()
  )
}

/**
 * Undo a completion whose uploader could not be told (`settleUploadBatches`),
 * so the batch is open again and the next settle, or the sweep, completes it
 * and tells them. Guarded on the completion time that call wrote: it reopens
 * only what it completed itself.
 */
export async function reopenCompletedBatches(
  organizationId: string,
  batchIds: readonly string[],
  completedAt: Date
): Promise<void> {
  if (batchIds.length === 0) return
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(uploadBatches)
      .set({ completedAt: null })
      .where(
        and(
          inArray(uploadBatches.id, [...batchIds]),
          eq(uploadBatches.organizationId, organizationId),
          eq(uploadBatches.completedAt, completedAt)
        )
      )
  )
}

/** The batch ids the given documents carry, for settling after their status moved. */
export async function batchIdsOfDocuments(organizationId: string, documentIds: readonly string[]): Promise<string[]> {
  if (documentIds.length === 0) return []
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .selectDistinct({ batchId: documents.uploadBatchId })
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          inArray(documents.id, [...documentIds]),
          isNotNull(documents.uploadBatchId)
        )
      )
  )
  return rows.map((row) => row.batchId).filter((id): id is string => id !== null)
}

/**
 * The documents a batch wrote, bounded, as `reader` may see them (ADR-0085).
 * A batch's rows are its uploader's own (a re-upload moves a row into the new
 * uploader's batch), so its uploader reads every one.
 */
export async function listBatchDocuments(
  organizationId: string,
  batchId: string,
  reader: DocumentReader
): Promise<Document[]> {
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select()
      .from(documents)
      .where(
        and(eq(documents.organizationId, organizationId), eq(documents.uploadBatchId, batchId), documentVisibleTo(reader))
      )
      .orderBy(documents.filename)
      .limit(UPLOAD_SUMMARY_DOCUMENT_LIMIT)
  )
}

/**
 * Per-status counts of a set of batches' documents, for the history list,
 * leaving out what is filed in a folder hidden from this reader
 * (`getHiddenFolderIds`) with the document listing's own predicate
 * (`outsideHiddenFolders`), so "hidden" has one SQL spelling, and a held file
 * the reader neither uploaded nor reviews (ADR-0085): somebody else's upload
 * counts for the team once it is screened.
 */
export async function countBatchDocumentsByStatus(
  organizationId: string,
  batchIds: readonly string[],
  { hiddenFolderIds, reader }: { hiddenFolderIds?: readonly string[]; reader: DocumentReader }
): Promise<Array<{ batchId: string; status: string; count: number }>> {
  if (batchIds.length === 0) return []
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({ batchId: documents.uploadBatchId, status: documents.status, count: sql<number>`count(*)` })
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          inArray(documents.uploadBatchId, [...batchIds]),
          ...outsideHiddenFolders(hiddenFolderIds),
          documentVisibleTo(reader)
        )
      )
      .groupBy(documents.uploadBatchId, documents.status)
  )
  return rows
    .filter((row): row is typeof row & { batchId: string } => row.batchId !== null)
    .map((row) => ({ batchId: row.batchId, status: row.status, count: Number(row.count) }))
}

/** One page of a project's upload history, and where the next one starts. */
export interface UploadBatchPage {
  batches: UploadBatch[]
  /** The position after the last batch, or `null` when this page is the last. */
  nextCursor: DocumentListCursor | null
}

/**
 * One keyset page of a project's upload history, newest first, the id
 * breaking ties: the document listing's order and cursor (`list-cursor.ts`),
 * so a page neither skips nor repeats an upload that lands between two reads.
 * Each query stays bounded; the whole history comes from following
 * `nextCursor`. `limit + 1` rows are read so the last page says so without a
 * COUNT.
 */
export async function listProjectUploadBatchPage(
  organizationId: string,
  projectId: string,
  { cursor }: { cursor?: DocumentListCursor } = {}
): Promise<UploadBatchPage> {
  const db = getDb()
  const at = cursor ? sql`(${cursor.createdAt}::timestamp AT TIME ZONE 'UTC')` : null
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({
        batch: uploadBatches,
        cursorCreatedAt: sql<string>`to_char(${uploadBatches.createdAt} AT TIME ZONE 'UTC', ${CURSOR_TIMESTAMP_FORMAT})`,
      })
      .from(uploadBatches)
      .where(
        and(
          eq(uploadBatches.organizationId, organizationId),
          eq(uploadBatches.projectId, projectId),
          ...(cursor && at
            ? [
                sql`(${uploadBatches.createdAt} < ${at} OR (${uploadBatches.createdAt} = ${at} AND ${uploadBatches.id} > ${cursor.id}::uuid))`,
              ]
            : [])
        )
      )
      .orderBy(desc(uploadBatches.createdAt), asc(uploadBatches.id))
      .limit(UPLOAD_HISTORY_LIMIT + 1)
  )
  const page = rows.slice(0, UPLOAD_HISTORY_LIMIT)
  const last = page.at(-1)
  return {
    batches: page.map((row) => row.batch),
    nextCursor: rows.length > UPLOAD_HISTORY_LIMIT && last ? { createdAt: last.cursorCreatedAt, id: last.batch.id } : null,
  }
}

/**
 * Open batches created inside a window, across every organization: the
 * sweep's discovery. The caller runs it under `withPlatformAccess` and settles
 * each batch inside its own tenant.
 */
export async function listOpenBatchesBetween(
  createdAfter: Date,
  createdBefore: Date,
  limit: number
): Promise<UploadBatch[]> {
  const db = getDb()
  // Newest first: a batch whose document is stuck in flight for good must not
  // starve the ones behind it, and the window drops it after a week.
  return db
    .select()
    .from(uploadBatches)
    .where(
      and(
        isNull(uploadBatches.completedAt),
        lt(uploadBatches.createdAt, createdBefore),
        gt(uploadBatches.createdAt, createdAfter)
      )
    )
    .orderBy(desc(uploadBatches.createdAt))
    .limit(limit)
}

/** Seal, on the sweep's authority, a batch whose browser never came back to seal it. */
export async function sealAbandonedBatch(organizationId: string, batchId: string, sealedAt: Date): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId }, () =>
    db
      .update(uploadBatches)
      .set({ sealedAt })
      .where(
        and(
          eq(uploadBatches.id, batchId),
          eq(uploadBatches.organizationId, organizationId),
          isNull(uploadBatches.sealedAt)
        )
      )
  )
}

/** A batch's documents still in flight, as reconcilable rows. */
export async function listInFlightBatchDocuments(organizationId: string, batchId: string): Promise<Document[]> {
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db
      .select()
      .from(documents)
      .where(
        and(
          eq(documents.organizationId, organizationId),
          eq(documents.uploadBatchId, batchId),
          inArray(documents.status, [...IN_FLIGHT_DOCUMENT_STATUSES])
        )
      )
      .limit(UPLOAD_SUMMARY_DOCUMENT_LIMIT)
  )
}
