/**
 * Anmerkungen repository — the SQL over `document_annotations` and
 * `document_annotation_replies` (migration 0138).
 *
 * No authorization here; the service owns that. Every read is keyed by a
 * document the service already loaded through its reader
 * (`getAccessibleDocument`), or joins `documents` behind the reader's
 * `documentVisibleTo` ({@link tallyLiveMarks}), which is what
 * `documents/document-visibility.spec.ts` holds each function here to.
 */

import 'server-only'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import type { DbTransaction } from '@/lib/db/executor'
import {
  documentAnnotationReplies,
  documentAnnotations,
  documents,
  documentVersions,
  type DocumentAnnotationReplyRow,
  type DocumentAnnotationRow,
} from '@/lib/db/schema'
import { withTenant } from '@/lib/db/tenant-context'
import { documentVisibleTo, type DocumentReader } from '@/lib/documents/visibility'
import {
  LIVE_ANNOTATION_STATUSES,
  MAX_ANNOTATIONS_PER_DOCUMENT,
  MAX_REPLIES_PER_ANNOTATION,
  type AnnotationAuthor,
  type AnnotationKind,
  type AnnotationShape,
  type AnnotationStatus,
  type MarkTally,
} from './types'

/** A row with the number of the Fassung it was set on, and its thread. */
export interface AnnotationRecord extends DocumentAnnotationRow {
  fassungNumber: number | null
  replies: DocumentAnnotationReplyRow[]
}

const selection = { row: documentAnnotations, fassungNumber: documentVersions.versionNumber }

/** The threads of these marks, oldest reply first, each bounded. */
async function listReplies(organizationId: string, annotationIds: readonly string[]) {
  if (annotationIds.length === 0) return new Map<string, DocumentAnnotationReplyRow[]>()
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select()
      .from(documentAnnotationReplies)
      .where(
        and(
          eq(documentAnnotationReplies.organizationId, organizationId),
          inArray(documentAnnotationReplies.annotationId, [...annotationIds])
        )
      )
      .orderBy(asc(documentAnnotationReplies.createdAt))
      .limit(annotationIds.length * MAX_REPLIES_PER_ANNOTATION)
  )
  const byAnnotation = new Map<string, DocumentAnnotationReplyRow[]>()
  for (const reply of rows) {
    const thread = byAnnotation.get(reply.annotationId) ?? []
    if (thread.length < MAX_REPLIES_PER_ANNOTATION) thread.push(reply)
    byAnnotation.set(reply.annotationId, thread)
  }
  return byAnnotation
}

async function withThreads(
  organizationId: string,
  rows: { row: DocumentAnnotationRow; fassungNumber: number | null }[]
): Promise<AnnotationRecord[]> {
  const threads = await listReplies(
    organizationId,
    rows.map(({ row }) => row.id)
  )
  return rows.map(({ row, fassungNumber }) => ({
    ...row,
    fassungNumber: fassungNumber === null ? null : Number(fassungNumber),
    replies: threads.get(row.id) ?? [],
  }))
}

/** Every Anmerkung on one document with its thread, by number. Bounded by {@link MAX_ANNOTATIONS_PER_DOCUMENT}. */
export async function listDocumentAnnotations(
  organizationId: string,
  documentId: string
): Promise<AnnotationRecord[]> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select(selection)
      .from(documentAnnotations)
      .leftJoin(documentVersions, eq(documentVersions.id, documentAnnotations.versionId))
      .where(
        and(
          eq(documentAnnotations.organizationId, organizationId),
          eq(documentAnnotations.documentId, documentId)
        )
      )
      .orderBy(asc(documentAnnotations.number))
      .limit(MAX_ANNOTATIONS_PER_DOCUMENT)
  )
  return withThreads(organizationId, rows)
}

/**
 * The live Anmerkungen of each of these documents, counted in ONE grouped
 * query for a listing page: how many are open or proposed, and how many of
 * those are open with `readerUserId` as Zuständige. Every Fassung counts: a
 * mark set on an earlier one is still work until somebody closes it.
 *
 * The documents are joined and narrowed by the reader the listing was read
 * with (`documentVisibleTo`), so a held upload's marks are not counted for
 * anyone the upload is held from. A document without a live mark is absent.
 */
export async function tallyLiveMarks(
  organizationId: string,
  documentIds: readonly string[],
  reader: DocumentReader,
  readerUserId: string
): Promise<Map<string, MarkTally>> {
  if (documentIds.length === 0) return new Map()
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select({
        documentId: documentAnnotations.documentId,
        live: sql<number | string>`count(*)`,
        forYou: sql<number | string>`count(*) filter (where ${documentAnnotations.status} = 'open' and ${documentAnnotations.assigneeUserId} = ${readerUserId})`,
      })
      .from(documentAnnotations)
      .innerJoin(documents, eq(documents.id, documentAnnotations.documentId))
      .where(
        and(
          eq(documentAnnotations.organizationId, organizationId),
          eq(documents.organizationId, organizationId),
          inArray(documentAnnotations.documentId, [...documentIds]),
          inArray(documentAnnotations.status, [...LIVE_ANNOTATION_STATUSES]),
          documentVisibleTo(reader)
        )
      )
      .groupBy(documentAnnotations.documentId)
      .limit(documentIds.length)
  )
  // `count(*)` is a bigint, which the driver hands over as a string.
  return new Map(rows.map((row) => [row.documentId, { live: Number(row.live), forYou: Number(row.forYou) }]))
}

/** One Anmerkung of one document with its thread, or null. */
export async function findDocumentAnnotation(
  organizationId: string,
  documentId: string,
  annotationId: string
): Promise<AnnotationRecord | null> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .select(selection)
      .from(documentAnnotations)
      .leftJoin(documentVersions, eq(documentVersions.id, documentAnnotations.versionId))
      .where(
        and(
          eq(documentAnnotations.organizationId, organizationId),
          eq(documentAnnotations.documentId, documentId),
          eq(documentAnnotations.id, annotationId)
        )
      )
      .limit(1)
  )
  const [record] = await withThreads(organizationId, rows)
  return record ?? null
}

export interface NewAnnotationValues {
  page: number
  shape: AnnotationShape
  x: number
  y: number
  w: number | null
  h: number | null
  kind: AnnotationKind
  body: string
  basis: string | null
  assigneeUserId: string | null
  dueOn: string | null
}

export interface NewAnnotationsInput {
  organizationId: string
  documentId: string
  versionId: string | null
  authorKind: AnnotationAuthor
  createdBy: string
  /**
   * Piloti only: the person who asked for exactly these marks, so they are born
   * `open`, taken over by that person in the same move. Absent, Piloti's marks
   * are born `proposed`.
   */
  acceptedBy?: string | null
  marks: readonly NewAnnotationValues[]
}

/** Thrown when the marks would take a document past {@link MAX_ANNOTATIONS_PER_DOCUMENT}. */
export class AnnotationLimitReachedError extends Error {}

/**
 * Insert one or more Anmerkungen in ONE transaction, their numbers allocated
 * as max + 1 under a per-document advisory lock, so two people setting a mark
 * on one sheet at the same moment get 4 and 5 rather than one of them a 23505.
 * A person's mark is born `open`; Piloti's is born `proposed`, or `open` with
 * `accepted_by` when the asker asked for it (the CHECK
 * `…_piloti_needs_a_person` refuses Piloti's open mark without one). The count
 * is checked under the same lock, so the cap holds against a burst of
 * proposals too.
 */
export async function insertDocumentAnnotations(input: NewAnnotationsInput): Promise<DocumentAnnotationRow[]> {
  const db = getDb()
  const acceptedBy = input.authorKind === 'piloti' ? (input.acceptedBy ?? null) : null
  const status: AnnotationStatus = input.authorKind === 'piloti' && !acceptedBy ? 'proposed' : 'open'
  const acceptance = acceptedBy ? { acceptedBy, acceptedAt: new Date() } : {}
  return withTenant({ organizationId: input.organizationId }, () =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`document_annotations:${input.documentId}`}, 0))`
      )
      const [current] = await tx
        .select({
          highest: sql<number | string | null>`max(${documentAnnotations.number})`,
          count: sql<number | string>`count(*)`,
        })
        .from(documentAnnotations)
        .where(
          and(
            eq(documentAnnotations.organizationId, input.organizationId),
            eq(documentAnnotations.documentId, input.documentId)
          )
        )
      if (Number(current?.count ?? 0) + input.marks.length > MAX_ANNOTATIONS_PER_DOCUMENT) {
        throw new AnnotationLimitReachedError()
      }
      const highest = current?.highest
      const first = highest === null || highest === undefined ? 1 : Number(highest) + 1
      return tx
        .insert(documentAnnotations)
        .values(
          input.marks.map((mark, index) => ({
            ...mark,
            organizationId: input.organizationId,
            documentId: input.documentId,
            versionId: input.versionId,
            authorKind: input.authorKind,
            createdBy: input.createdBy,
            status,
            ...acceptance,
            number: first + index,
          }))
        )
        .returning()
    })
  )
}

export interface AnnotationChanges {
  kind?: AnnotationKind
  body?: string
  basis?: string | null
  assigneeUserId?: string | null
  dueOn?: string | null
  /** A move of status carries its bookkeeping, so the CHECK's columns move together. */
  transition?: {
    status: AnnotationStatus
    acceptedBy?: string
    acceptedAt?: Date
    closedBy: string | null
    closedAt: Date | null
  }
  /** Piloti as the delegate (migration 0139): both set, or both cleared, as the CHECK holds. */
  delegation?: { delegatedBy: string; delegatedAt: Date } | { delegatedBy: null; delegatedAt: null }
}

/**
 * Work that must commit or roll back with a write: the wake of Piloti the
 * write is the event of (`./wake.ts`), enqueued in the write's transaction.
 */
export type InTransaction<T> = (tx: DbTransaction, row: T) => Promise<void>

/**
 * Apply a change to one Anmerkung; null when it is gone, or when its status
 * is no longer `expectedStatus` (a colleague moved it first: compare and swap,
 * the way `document_versions` transitions are).
 */
export async function updateDocumentAnnotation(
  organizationId: string,
  documentId: string,
  annotationId: string,
  expectedStatus: AnnotationStatus,
  changes: AnnotationChanges,
  /** Runs in the update's transaction when a row was changed. */
  afterUpdate?: InTransaction<DocumentAnnotationRow>
): Promise<DocumentAnnotationRow | null> {
  const { transition, delegation, ...fields } = changes
  const db = getDb()
  return withTenant({ organizationId }, () =>
    db.transaction(async (tx) => {
      const [row] = await tx
        .update(documentAnnotations)
        .set({ ...fields, ...(transition ?? {}), ...(delegation ?? {}), updatedAt: new Date() })
        .where(
          and(
            eq(documentAnnotations.organizationId, organizationId),
            eq(documentAnnotations.documentId, documentId),
            eq(documentAnnotations.id, annotationId),
            eq(documentAnnotations.status, expectedStatus)
          )
        )
        .returning()
      if (row && afterUpdate) await afterUpdate(tx, row)
      return row ?? null
    })
  )
}

/**
 * Delete one Anmerkung and its thread; whether a row went. Its number is not
 * reused while a higher one exists. `beforeDelete` runs in the delete's
 * transaction, before the row and its wakes go: the one moment the wake of a
 * delegation can still be read.
 */
export async function deleteDocumentAnnotation(
  organizationId: string,
  documentId: string,
  annotationId: string,
  beforeDelete?: (tx: DbTransaction) => Promise<void>
): Promise<boolean> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db.transaction(async (tx) => {
      await beforeDelete?.(tx)
      return tx
        .delete(documentAnnotations)
        .where(
          and(
            eq(documentAnnotations.organizationId, organizationId),
            eq(documentAnnotations.documentId, documentId),
            eq(documentAnnotations.id, annotationId)
          )
        )
        .returning({ id: documentAnnotations.id })
    })
  )
  return rows.length > 0
}

/** Thrown when a thread already carries {@link MAX_REPLIES_PER_ANNOTATION}. */
export class ReplyLimitReachedError extends Error {}

/**
 * Append one reply to an Anmerkung the service read for writing, and touch the
 * mark's `updated_at`, so „zuletzt aktiv" moves with its thread.
 *
 * A reply never touches the mark's delegation: Piloti hands a mark back when
 * the turn the delegation woke ends (`lib/turns/outcome.ts`), not when it
 * writes in the thread. `afterInsert` runs in the same transaction, so a wake
 * the reply is the event of exists exactly when the reply does.
 */
export async function insertAnnotationReply(
  input: {
    organizationId: string
    annotationId: string
    authorKind: AnnotationAuthor
    body: string
    createdBy: string
    addressesAgent?: boolean
  },
  afterInsert?: InTransaction<DocumentAnnotationReplyRow>
): Promise<DocumentAnnotationReplyRow> {
  const db = getDb()
  return withTenant({ organizationId: input.organizationId }, () =>
    db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`document_annotation_replies:${input.annotationId}`}, 0))`
      )
      const [current] = await tx
        .select({ count: sql<number | string>`count(*)` })
        .from(documentAnnotationReplies)
        .where(
          and(
            eq(documentAnnotationReplies.organizationId, input.organizationId),
            eq(documentAnnotationReplies.annotationId, input.annotationId)
          )
        )
      if (Number(current?.count ?? 0) >= MAX_REPLIES_PER_ANNOTATION) throw new ReplyLimitReachedError()
      const [reply] = await tx.insert(documentAnnotationReplies).values(input).returning()
      await tx
        .update(documentAnnotations)
        .set({ updatedAt: new Date() })
        .where(
          and(
            eq(documentAnnotations.organizationId, input.organizationId),
            eq(documentAnnotations.id, input.annotationId)
          )
        )
      if (afterInsert) await afterInsert(tx, reply)
      return reply
    })
  )
}

/**
 * Delete one reply of an Anmerkung; whether a row went. With `expectedBody` the
 * delete is a compare-and-swap on what the reply says, so a reply changed
 * since the caller read it stays. The service read the Anmerkung's document
 * first.
 */
export async function deleteAnnotationReply(
  organizationId: string,
  annotationId: string,
  replyId: string,
  expectedBody?: string
): Promise<boolean> {
  const db = getDb()
  const rows = await withTenant({ organizationId }, () =>
    db
      .delete(documentAnnotationReplies)
      .where(
        and(
          eq(documentAnnotationReplies.organizationId, organizationId),
          eq(documentAnnotationReplies.annotationId, annotationId),
          eq(documentAnnotationReplies.id, replyId),
          ...(expectedBody === undefined ? [] : [eq(documentAnnotationReplies.body, expectedBody)])
        )
      )
      .returning({ id: documentAnnotationReplies.id })
  )
  return rows.length > 0
}
