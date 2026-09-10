/**
 * `document_versions` repository — SQL only (ADR-0017). Every list is bounded.
 *
 * The one thing here that is not a plain query is
 * {@link compareAndSwapVersionState}: the lifecycle's authority is Postgres, so
 * a transition is an `UPDATE … WHERE state = $expected` and the caller reads
 * "no row came back" as a conflict. Read it before adding a read-then-write
 * anywhere near this table.
 */

import 'server-only'
import { and, asc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  documentVersions,
  documents,
  type DocumentVersion,
  type NewDocumentVersion,
} from '@/lib/db/schema'
import type { DocumentVersionState } from './lifecycle-types'
import { OPEN_DOCUMENT_VERSION_STATES } from './lifecycle-types'

/** A document's version list is a page, like every other list in this tier. */
export const DOCUMENT_VERSION_LIST_LIMIT = 200

export async function insertDocumentVersion(values: NewDocumentVersion): Promise<DocumentVersion> {
  const db = getDb()
  const [row] = await db.insert(documentVersions).values(values).returning()
  return row
}

export async function listDocumentVersions(
  documentId: string,
  organizationId: string,
): Promise<DocumentVersion[]> {
  const db = getDb()
  return db
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.organizationId, organizationId),
      ),
    )
    .orderBy(asc(documentVersions.versionNumber))
    .limit(DOCUMENT_VERSION_LIST_LIMIT)
}

export async function findDocumentVersion(
  versionId: string,
  documentId: string,
  organizationId: string,
): Promise<DocumentVersion | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.id, versionId),
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.organizationId, organizationId),
      ),
    )
    .limit(1)
  return row ?? null
}

/** The version whose bytes the item's storage columns mirror, if any. */
export async function findPublishedVersion(
  documentId: string,
  organizationId: string,
): Promise<DocumentVersion | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.organizationId, organizationId),
        eq(documentVersions.state, 'published'),
      ),
    )
    .limit(1)
  return row ?? null
}

/** The one version still being worked on, if any — see the partial unique index. */
export async function findOpenVersion(
  documentId: string,
  organizationId: string,
): Promise<DocumentVersion | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.organizationId, organizationId),
        inArray(documentVersions.state, [...OPEN_DOCUMENT_VERSION_STATES]),
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * The next `version_number` for a document.
 *
 * `max(...) + 1` read through a raw fragment, so the value is COERCED on the
 * way out (`Number(...)`): drizzle decodes only direct column references, and a
 * raw `sql<number>` is a compile-time assertion the driver is free to answer
 * with a string. `'1' + 1` is `'11'`, and the version after the eleventh would
 * be version 111.
 */
export async function nextVersionNumber(
  documentId: string,
  organizationId: string,
): Promise<number> {
  const db = getDb()
  const [row] = await db
    .select({ highest: sql<number | null>`max(${documentVersions.versionNumber})` })
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.organizationId, organizationId),
      ),
    )
  return row?.highest === null || row?.highest === undefined ? 1 : Number(row.highest) + 1
}

/**
 * Move a version from one state to another, or report that somebody else did.
 *
 * **The compare-and-swap.** `WHERE state = $expected` is what makes two
 * reviewers pressing Freigeben at the same instant produce one approval and one
 * 409, rather than two approvals or a lost update. It is also why the service
 * never reads the row, decides, and then writes: between those two statements
 * the state is whatever another request made it.
 *
 * Returns the updated row, or `null` when no row matched — which the caller
 * turns into `ConflictError`, because "the version is no longer in the state
 * you acted on" is exactly what the person needs to be told.
 */
export async function compareAndSwapVersionState(
  versionId: string,
  organizationId: string,
  expected: DocumentVersionState,
  patch: Partial<Omit<NewDocumentVersion, 'id' | 'organizationId' | 'documentId'>>,
): Promise<DocumentVersion | null> {
  const db = getDb()
  const [row] = await db
    .update(documentVersions)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(documentVersions.id, versionId),
        eq(documentVersions.organizationId, organizationId),
        eq(documentVersions.state, expected),
      ),
    )
    .returning()
  return row ?? null
}

/**
 * Publish a version: supersede whatever was published, swap this one in, and
 * point the item at it — in ONE transaction.
 *
 * ## Why the three statements cannot be three steps
 *
 * `uniq_document_versions_published_per_document` makes "two published versions
 * of one document" unrepresentable. So the moment the new version becomes
 * `published` the old one must ALREADY have stopped being — the supersede has to
 * run first, and a supersede that ran first and then lost the compare-and-swap
 * race would leave a document with no published version at all. One transaction
 * makes both impossible: the swap's `WHERE state = $expected` still decides who
 * wins, and the loser's supersede rolls back with it.
 *
 * The previous version's BYTES ARE NOT TOUCHED. A superseded version is history;
 * objects go when the document is deleted.
 *
 * `expected === null` is a version that was INSERTED as published a moment ago
 * (a human upload): there is no state to swap from, only the supersede and the
 * pointer move.
 *
 * Returns `null` when the compare-and-swap matched nothing — the caller turns
 * that into a `ConflictError`.
 */
export async function promoteVersionToPublished(
  versionId: string,
  documentId: string,
  organizationId: string,
  expected: DocumentVersionState | null,
  patch: Partial<Omit<NewDocumentVersion, 'id' | 'organizationId' | 'documentId'>> = {},
): Promise<{ version: DocumentVersion; superseded: DocumentVersion[] } | null> {
  const db = getDb()
  const outcome = await db.transaction(async (tx) => {
    const superseded = await tx
      .update(documentVersions)
      .set({ state: 'superseded', updatedAt: new Date() })
      .where(
        and(
          eq(documentVersions.documentId, documentId),
          eq(documentVersions.organizationId, organizationId),
          eq(documentVersions.state, 'published'),
          ne(documentVersions.id, versionId),
        ),
      )
      .returning()

    const [swapped] = expected
      ? await tx
          .update(documentVersions)
          .set({ ...patch, updatedAt: new Date() })
          .where(
            and(
              eq(documentVersions.id, versionId),
              eq(documentVersions.organizationId, organizationId),
              eq(documentVersions.state, expected),
            ),
          )
          .returning()
      : await tx
          .select()
          .from(documentVersions)
          .where(
            and(
              eq(documentVersions.id, versionId),
              eq(documentVersions.organizationId, organizationId),
            ),
          )
          .limit(1)

    if (!swapped) {
      // Roll the supersede back with the failed swap: a document that lost its
      // published version because somebody else won the race is worse than the
      // 409 the caller is about to get.
      tx.rollback()
      return null
    }

    await tx
      .update(documents)
      .set({
        publishedVersionId: swapped.id,
        storageKey: swapped.storageKey,
        storageBucket: swapped.storageBucket,
        contentType: swapped.contentType,
        fileSize: swapped.fileSize,
        contentHash: swapped.contentHash,
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId)))

    return { version: swapped, superseded }
  })
  return outcome ?? null
}

/** Move an item into or out of the working set. */
export async function setDocumentLifecycle(
  documentId: string,
  organizationId: string,
  lifecycle: 'active' | 'archived',
): Promise<void> {
  const db = getDb()
  await db
    .update(documents)
    .set({ lifecycle, updatedAt: new Date() })
    .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId)))
}

/**
 * Every stored object a document's versions own, for the delete cascade.
 *
 * `deleteDocument` used to erase one object because a document had one set of
 * bytes. With history it has several, and a delete that removed only the live
 * one would leave every superseded version's object in the bucket: invisible to
 * the UI, still charged to the organization, and readable by anyone who can
 * presign a key.
 */
export async function listDocumentVersionObjects(
  documentId: string,
  organizationId: string,
): Promise<Array<Pick<DocumentVersion, 'storageKey' | 'storageBucket'>>> {
  const db = getDb()
  return db
    .select({
      storageKey: documentVersions.storageKey,
      storageBucket: documentVersions.storageBucket,
    })
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.organizationId, organizationId),
        isNotNull(documentVersions.storageKey),
      ),
    )
    .limit(DOCUMENT_VERSION_LIST_LIMIT)
}
