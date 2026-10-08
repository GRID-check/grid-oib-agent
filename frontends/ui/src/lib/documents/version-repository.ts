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
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  documentVersions,
  documents,
  type DocumentVersion,
  type NewDocumentVersion,
} from '@/lib/db/schema'
import {
  lockStorageQuota,
  readStorageUsage,
  type DbTransaction,
} from '@/lib/storage/repository'
import type { DocumentVersionState } from './lifecycle-types'
import { DOCUMENT_VERSION_STATES, OPEN_DOCUMENT_VERSION_STATES } from './lifecycle-types'
import { mapVersionInsertError } from './unique-conflicts'
import { documentVisibleTo, SCREENED_ONLY } from './visibility'

/**
 * A document's version list is a page, like every other list in this tier.
 *
 * 500, matching `DOCUMENT_LIST_LIMIT`: version rows are light display rows,
 * and the page no longer feeds any logic — the diff base is a direct
 * `findPreviousVersion` query, never a scan of this page — so the cap is a
 * render bound only. It is still a cap, not a promise: past it the list keeps
 * the oldest rows (`ORDER BY version_number ASC` below), and a true
 * newest-first page (offset/desc) is the follow-up when a history that long
 * stops being theoretical. The delete cascade ({@link listDocumentVersionObjects})
 * uses it as a PAGE size and reads every page, because an object it misses is
 * an object nobody deletes.
 */
export const DOCUMENT_VERSION_LIST_LIMIT = 500

/**
 * What an insert is handed: everything but the number, which it allocates.
 *
 * `versionNumber` is not optional-and-ignored but ABSENT from the type, so a
 * caller cannot compute one outside the transaction and have it believed.
 */
export type NewDocumentVersionValues = Omit<NewDocumentVersion, 'versionNumber'>

/** The handle a `db.transaction` callback receives. */
type Transaction = DbTransaction

/**
 * The next number for a document, allocated INSIDE the inserting transaction.
 *
 * ## Why this is not `nextVersionNumber` followed by an insert
 *
 * It was. `max + 1` read in one statement and inserted in another is a
 * check-then-act: two overlapping re-uploads of one filename read the same N
 * and both recorded „Version N" — and before migration 0092 nothing refused the
 * second. The per-document advisory lock makes the read and the insert one step
 * for every writer of this document: the second transaction blocks here until
 * the first commits, then reads the number the first one wrote.
 *
 * Keyed by the DOCUMENT, not the organization, so versions of different files
 * never queue behind each other, and namespaced (`document_versions:`) so it
 * can never share a key with the quota lock (`storage_quota:`). Held for one
 * `max()` and one insert; never across an object write.
 *
 * `UNIQUE (document_id, version_number)` (migration 0092) is the ratchet under
 * it: a path that inserts without this lock gets a 23505, not a duplicate.
 */
export async function allocateVersionNumber(
  tx: Transaction,
  documentId: string,
  organizationId: string,
): Promise<number> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`document_versions:${documentId}`}, 0))`,
  )
  const [row] = await tx
    .select({ highest: sql<number | string | null>`max(${documentVersions.versionNumber})` })
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.organizationId, organizationId),
      ),
    )
  // Coerced: a raw fragment is decoded by the driver, which may answer a string.
  return row?.highest === null || row?.highest === undefined ? 1 : Number(row.highest) + 1
}

/**
 * Insert one version, its number allocated under the per-document lock.
 *
 * An open version refused by `uniq_document_versions_open_per_document` is
 * thrown as `OpenVersionExistsError`: a concurrent fork of this document opened
 * its one draft first. The per-document lock serializes the two inserts, so the
 * loser meets the winner's COMMITTED row and is refused at once. No other 23505
 * is mapped — one on the version-number key means a path skipped the lock, and
 * that must stay a 500. A version for a document deleted first is refused by
 * its foreign key and thrown as `DocumentDeletedError`.
 */
export async function insertDocumentVersion(
  values: NewDocumentVersionValues,
): Promise<DocumentVersion> {
  const db = getDb()
  return db
    .transaction(async (tx) => {
      const versionNumber = await allocateVersionNumber(tx, values.documentId, values.organizationId)
      const [row] = await tx
        .insert(documentVersions)
        .values({ ...values, versionNumber })
        .returning()
      return row
    })
    .catch((error: unknown) => {
      throw mapVersionInsertError(error, values.documentId)
    })
}

/**
 * Insert a version that is born `published` — supersede, insert, move the
 * pointer, in ONE transaction.
 *
 * ## Why this is not an insert followed by {@link promoteVersionToPublished}
 *
 * It was, and a re-upload could not work. `uniq_document_versions_published_per_document`
 * is a plain partial unique index and therefore NOT deferrable: it is checked
 * per statement, so the INSERT of version N+1 as `published` is refused while
 * version N is still `published`. The supersede has to come FIRST, and it has
 * to be in the same transaction as the insert — a supersede that committed on
 * its own and then hit a failing insert would leave a document with no
 * published version at all.
 *
 * The previous version's BYTES ARE NOT TOUCHED. A superseded version is
 * history; objects go when the document is deleted.
 */
export async function insertPublishedVersion(
  values: NewDocumentVersionValues,
): Promise<{ version: DocumentVersion; superseded: DocumentVersion[] }> {
  const db = getDb()
  return db.transaction(async (tx) => {
    // First, so the supersede below and the insert run for one writer of this
    // document at a time: the second of two overlapping re-uploads supersedes
    // the FIRST one's new version, rather than racing it for number N.
    const versionNumber = await allocateVersionNumber(tx, values.documentId, values.organizationId)
    const superseded = await tx
      .update(documentVersions)
      .set({ state: 'superseded', updatedAt: new Date() })
      .where(
        and(
          eq(documentVersions.documentId, values.documentId),
          eq(documentVersions.organizationId, values.organizationId),
          eq(documentVersions.state, 'published'),
        ),
      )
      .returning()

    const [version] = await tx
      .insert(documentVersions)
      .values({ ...values, versionNumber })
      .returning()

    await tx
      .update(documents)
      .set({
        publishedVersionId: version.id,
        storageKey: version.storageKey,
        storageBucket: version.storageBucket,
        contentType: version.contentType,
        fileSize: version.fileSize,
        contentHash: version.contentHash,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(documents.id, values.documentId),
          eq(documents.organizationId, values.organizationId),
        ),
      )

    return { version, superseded }
  }).catch((error: unknown) => {
    // A document deleted before this insert is refused by the version's
    // foreign key and reads as `DocumentDeletedError`; nothing else is mapped.
    throw mapVersionInsertError(error, values.documentId)
  })
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

/**
 * The version a diff compares against: the highest version number below the
 * given one, or `null` for a first version.
 *
 * A DIRECT `version_number < $n ORDER BY version_number DESC LIMIT 1` — never
 * the asc-limited-200 page scanned in memory. Past 200 versions the page no
 * longer contains the predecessor at all, and the scan then names the wrong
 * row (the highest inside the window) as the diff base.
 */
export async function findPreviousVersion(
  documentId: string,
  organizationId: string,
  versionNumber: number,
): Promise<DocumentVersion | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.organizationId, organizationId),
        lt(documentVersions.versionNumber, versionNumber),
      ),
    )
    .orderBy(desc(documentVersions.versionNumber))
    .limit(1)
  return row ?? null
}

/**
 * One version addressed by its OWN id, inside one organization.
 *
 * The twin of {@link findDocumentVersion} for a caller that holds the version
 * id and nothing else — the internal content route, whose Python caller was
 * TOLD which version the turn's subject is and has no document id to pair with
 * it. The organization is still in the predicate, so a version id from another
 * tenant reads as absent rather than as a row.
 */
export async function findDocumentVersionInOrg(
  versionId: string,
  organizationId: string,
): Promise<DocumentVersion | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.id, versionId),
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
 * How many versions a set of documents has, and what the newest one's state is.
 *
 * The Files listing's badge reads this. It is a GROUPED read over the ids a
 * caller has already listed rather than one query per card, because the badge
 * appears on every tile of a corpus that routinely runs to hundreds — and it is
 * the NEWEST version's state, not the published one's: the news about a
 * document is the draft somebody filed on Friday, not the version that was live
 * before it.
 *
 * `count(*)` and the `array_agg` pick come back through raw fragments, so both
 * are coerced here (`Number`, and a membership check against the state tuple)
 * rather than trusted: drizzle decodes only direct column references.
 */
export interface DocumentVersionSummary {
  documentId: string
  versionCount: number
  /** The newest version's state — what the badge shows. */
  state: DocumentVersionState
}

export async function listDocumentVersionSummaries(
  documentIds: readonly string[],
  organizationId: string,
): Promise<DocumentVersionSummary[]> {
  if (documentIds.length === 0) return []
  const db = getDb()
  const rows = await db
    .select({
      documentId: documentVersions.documentId,
      versionCount: sql<number>`count(*)`,
      newestState: sql<string>`(array_agg(${documentVersions.state} order by ${documentVersions.versionNumber} desc))[1]`,
    })
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.organizationId, organizationId),
        inArray(documentVersions.documentId, [...documentIds]),
      ),
    )
    .groupBy(documentVersions.documentId)
    .limit(DOCUMENT_VERSION_LIST_LIMIT)

  const known: readonly string[] = DOCUMENT_VERSION_STATES
  return rows.flatMap((row) =>
    known.includes(row.newestState)
      ? [
          {
            documentId: row.documentId,
            versionCount: Number(row.versionCount),
            state: row.newestState as DocumentVersionState,
          },
        ]
      : // A state this build has never heard of (a newer deploy, a rollback) is
        // no badge at all, which is what an unknown editorial state honestly is.
        [],
  )
}

/**
 * The number the next version of a document will PROBABLY get — a hint.
 *
 * The upload paths read it before the bytes move, to put `v<n>/` in the object
 * key where a person browsing the bucket can read it. It is not an allocation:
 * two overlapping uploads read the same value. The row's real number is
 * allocated at insert ({@link allocateVersionNumber}), and the key stays unique
 * because it also carries a per-write id (`versionWriteKey`). Never write
 * this value into a row.
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
 * A compare-and-swap inside a transaction matched nothing.
 *
 * Thrown to roll the transaction back and caught OUTSIDE it, where it becomes
 * the `null` the caller reads as a 409.
 *
 * ## Why not `tx.rollback()`
 *
 * {@link promoteVersionToPublished} used to call it and then `return null`. On
 * drizzle 0.45 with postgres-js, `rollback()` does not mark the transaction and
 * return: it THROWS `TransactionRollbackError`, and `db.transaction` re-throws
 * it. The `return null` after it was unreachable, so the loser of two people
 * pressing „Veröffentlichen" at once got a 500 instead of the promised 409.
 * Throwing a class of our own keeps the rollback and makes the outcome
 * something this module decides, not whatever the driver's error type is in the
 * next release. `version-repository.spec.ts` pins it.
 */
export class LostCompareAndSwap extends Error {
  constructor() {
    super('compare-and-swap matched no row')
    this.name = 'LostCompareAndSwap'
  }
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
 * A version that is born published — a human upload — does not come through
 * here at all: there is no state to swap from, and the INSERT itself has to be
 * inside the transaction that supersedes its predecessor. That is
 * {@link insertPublishedVersion}.
 *
 * Returns `null` when the compare-and-swap matched nothing — the caller turns
 * that into a `ConflictError`.
 */
export async function promoteVersionToPublished(
  versionId: string,
  documentId: string,
  organizationId: string,
  expected: DocumentVersionState,
  patch: Partial<Omit<NewDocumentVersion, 'id' | 'organizationId' | 'documentId'>> = {},
): Promise<{ version: DocumentVersion; superseded: DocumentVersion[] } | null> {
  const db = getDb()
  try {
    return await db.transaction(async (tx) => {
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

      const [swapped] = await tx
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

      // Roll the supersede back with the failed swap: a document that lost its
      // published version because somebody else won the race is worse than the
      // 409 the caller is about to get. Thrown and caught below, never
      // `tx.rollback()` — see {@link LostCompareAndSwap}.
      if (!swapped) throw new LostCompareAndSwap()

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
  } catch (error) {
    if (error instanceof LostCompareAndSwap) return null
    throw error
  }
}

/** A version's storage columns — what a content swap replaces. */
export type VersionStorageColumns = Pick<
  DocumentVersion,
  'storageKey' | 'storageBucket' | 'contentType' | 'fileSize' | 'contentHash'
>

/** What a content swap has to find still true of the row, or it loses. */
export interface ExpectedVersionContent {
  state: DocumentVersionState
  storageKey: string
  contentHash: string | null
}

export interface SwapVersionContentInput {
  versionId: string
  documentId: string
  organizationId: string
  expected: ExpectedVersionContent
  /** The transition's stamp plus the new storage columns. */
  patch: Partial<Omit<NewDocumentVersion, 'id' | 'organizationId' | 'documentId'>> &
    VersionStorageColumns
  /**
   * Whether this version's bytes are the ITEM's (`versionMirrorsItem`). The
   * item's columns are what the download path serves and what the hot half of
   * the quota ledger sums, so a version that IS the item's bytes writes them
   * back in the same transaction — never a forked draft, whose bytes nobody has
   * published.
   */
  mirrorsItem: boolean
  /** The organization's quota in bytes, or `null` for none. */
  quotaBytes: number | null
}

export type SwapVersionContentOutcome =
  | {
      ok: true
      version: DocumentVersion
      /** No row names the key the version had before — its object may go. */
      previousKeyOrphaned: boolean
    }
  | { ok: false; reason: 'conflict' }
  | { ok: false; reason: 'quota'; usedBytes: number }

/** The swap would leave the organization over its quota — roll it back. */
class OverQuota extends Error {
  constructor(readonly usedBytes: number) {
    super('storage quota exceeded')
    this.name = 'OverQuota'
  }
}

/**
 * Point a version at new bytes, but only if it is still what the caller read.
 *
 * ## Why state alone was not enough
 *
 * {@link compareAndSwapVersionState} filters on `state = $expected`, which is
 * the whole question for a transition that MOVES the state. `update` does not:
 * it goes draft → draft, so two writers holding the same `If-Match` both
 * matched, both won, and the second silently replaced the first. The predicate
 * here also carries the `content_hash` and the `storage_key` the caller read,
 * which is what `If-Match` means: the loser of two writers who read the same
 * version matches no row and is told so.
 *
 * `content_hash IS NULL` is matched as such, not as `= NULL` (which matches
 * nothing): a row backfilled from a document that predates `content_hash`
 * carries NULL, and `assertGuards` already lets such a version be replaced.
 *
 * ## One transaction, on the locked admission path
 *
 * The swap, the item mirror, the quota and the orphan check are one step: a
 * mirror that committed separately could copy a loser's columns onto the item,
 * and an orphan check outside it could see a row that is about to change. The
 * object for `patch.storageKey` must already be stored in full when this runs —
 * the caller writes it first, under a key no other writer shares.
 *
 * The quota is admitted HERE, under the same per-organization lock as every
 * upload, by measuring the usage before the swap and again after it inside the
 * transaction, and rolling back when the after-state crosses the ceiling. That
 * replaced a delta computed outside any lock (`incoming − version.fileSize`),
 * which was wrong exactly where it mattered: a draft freshly forked from the
 * published version shares the published object, so its "old size" was the
 * published file's and the delta was ≈ 0 — and fork, write, reject, fork again
 * grew the bucket without ever being checked. Measuring the after-state with the
 * ledger's own predicate (`readStorageUsage`) charges what the commit really
 * adds: the full size when the old bytes stay (a fork's shared key), the
 * difference when they go (a draft's own previous object). A shrinking write is
 * always admitted, even over a quota someone lowered.
 */
export async function swapVersionContent(
  input: SwapVersionContentInput,
): Promise<SwapVersionContentOutcome> {
  const db = getDb()
  const { versionId, documentId, organizationId, expected, patch, quotaBytes } = input
  try {
    return await db.transaction(async (tx) => {
      // The lock first, and only then the swap: the same order as the upload
      // paths, so two writers of one organization never hold each other's locks.
      await lockStorageQuota(tx, organizationId)
      const usedBefore = quotaBytes === null ? 0 : await readStorageUsage(tx, organizationId)

      const [version] = await tx
        .update(documentVersions)
        .set({ ...patch, updatedAt: new Date() })
        .where(
          and(
            eq(documentVersions.id, versionId),
            eq(documentVersions.documentId, documentId),
            eq(documentVersions.organizationId, organizationId),
            eq(documentVersions.state, expected.state),
            eq(documentVersions.storageKey, expected.storageKey),
            expected.contentHash === null
              ? isNull(documentVersions.contentHash)
              : eq(documentVersions.contentHash, expected.contentHash),
          ),
        )
        .returning()
      if (!version) throw new LostCompareAndSwap()

      if (input.mirrorsItem) {
        await tx
          .update(documents)
          .set({
            storageKey: version.storageKey,
            storageBucket: version.storageBucket,
            contentType: version.contentType,
            fileSize: version.fileSize,
            contentHash: version.contentHash,
            updatedAt: new Date(),
          })
          .where(and(eq(documents.id, documentId), eq(documents.organizationId, organizationId)))
      }

      if (quotaBytes !== null) {
        const usedAfter = await readStorageUsage(tx, organizationId)
        if (usedAfter > quotaBytes && usedAfter > usedBefore) throw new OverQuota(usedBefore)
      }

      const previousKeyOrphaned = await keyIsUnnamed(
        tx,
        documentId,
        organizationId,
        expected.storageKey,
      )
      return { ok: true as const, version, previousKeyOrphaned }
    })
  } catch (error) {
    if (error instanceof LostCompareAndSwap) return { ok: false, reason: 'conflict' }
    if (error instanceof OverQuota) {
      return { ok: false, reason: 'quota', usedBytes: error.usedBytes }
    }
    throw error
  }
}

/**
 * Whether neither the item nor any of its versions still names `storageKey`.
 *
 * A forked draft shares the published version's key, and a superseded version
 * can share a key with a draft forked from it before a re-upload; deleting the
 * object on the strength of "this version moved off it" would destroy history
 * another row still opens.
 */
async function keyIsUnnamed(
  tx: Transaction,
  documentId: string,
  organizationId: string,
  storageKey: string,
): Promise<boolean> {
  const rows = await tx.execute<{ named: boolean | string }>(sql`
    SELECT (
      EXISTS (
        SELECT 1 FROM document_versions v
        WHERE v.document_id = ${documentId}
          AND v.organization_id = ${organizationId}
          AND v.storage_key = ${storageKey}
      )
      OR EXISTS (
        SELECT 1 FROM documents d
        WHERE d.id = ${documentId}
          AND d.organization_id = ${organizationId}
          AND d.storage_key = ${storageKey}
      )
    ) AS named
  `)
  // Coerced at the boundary: a raw boolean can come back as 't'/'f'.
  const named = Array.from(rows)[0]?.named
  return !(named === true || named === 't')
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
 *
 * ## Every version, not the first page
 *
 * This read the same 500-row page as the version list, so a document with a
 * longer history left every object past row 500 in the bucket when it was
 * deleted — the leak the paragraph above exists to prevent, one weekly
 * re-upload at a time. It pages through ALL of them now, by `version_number`
 * (unique per document since migration 0092, so the cursor never skips or
 * repeats a row), one bounded page per query. Two rows over one object (a
 * fork) come back once.
 */
export async function listDocumentVersionObjects(
  documentId: string,
  organizationId: string,
): Promise<Array<Pick<DocumentVersion, 'storageKey' | 'storageBucket'>>> {
  const db = getDb()
  const objects = new Map<string, Pick<DocumentVersion, 'storageKey' | 'storageBucket'>>()
  for (let after = 0; ; ) {
    const page = await db
      .select({
        versionNumber: documentVersions.versionNumber,
        storageKey: documentVersions.storageKey,
        storageBucket: documentVersions.storageBucket,
      })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.documentId, documentId),
          eq(documentVersions.organizationId, organizationId),
          isNotNull(documentVersions.storageKey),
          gt(documentVersions.versionNumber, after),
        ),
      )
      .orderBy(asc(documentVersions.versionNumber))
      .limit(DOCUMENT_VERSION_LIST_LIMIT)
    for (const row of page) {
      objects.set(`${row.storageBucket ?? ''}\u0000${row.storageKey}`, {
        storageKey: row.storageKey,
        storageBucket: row.storageBucket,
      })
    }
    if (page.length < DOCUMENT_VERSION_LIST_LIMIT) return [...objects.values()]
    after = Number(page[page.length - 1].versionNumber)
  }
}

/**
 * The versions of a conversation's own drafts that a reviewer sent back.
 *
 * Bounded and newest-decision-first, because the block it feeds
 * (`REVIEW_DECISIONS v1`, `./review-decisions.ts`) rides the memory channel and
 * shares that channel's character budget. Only the two refusing states, and
 * only rows that carry words: `document_versions_refusal_has_comment` makes a
 * commentless refusal unrepresentable, so a null here would be a row written
 * before that CHECK existed rather than a decision anybody can act on.
 *
 * Joined to `documents` for the display name, because the block names the
 * document a person will look for in the Files pane and a version id is not a
 * name.
 */
export async function listRefusedVersionsForConversation(
  conversationId: string,
  organizationId: string,
  limit: number,
): Promise<
  Array<{
    versionId: string
    documentId: string
    versionNumber: number
    state: DocumentVersionState
    reviewComment: string
    reviewedBy: string | null
    reviewedAt: Date | null
    displayName: string | null
    filename: string
  }>
> {
  const db = getDb()
  const rows = await db
    .select({
      versionId: documentVersions.id,
      documentId: documentVersions.documentId,
      versionNumber: documentVersions.versionNumber,
      state: documentVersions.state,
      reviewComment: documentVersions.reviewComment,
      reviewedBy: documentVersions.reviewedBy,
      reviewedAt: documentVersions.reviewedAt,
      displayName: documents.displayName,
      filename: documents.filename,
    })
    .from(documentVersions)
    .innerJoin(documents, eq(documents.id, documentVersions.documentId))
    .where(
      and(
        eq(documentVersions.originConversationId, conversationId),
        eq(documentVersions.organizationId, organizationId),
        inArray(documentVersions.state, ['changes_requested', 'rejected']),
        isNotNull(documentVersions.reviewComment),
        // This block rides into a model's conversation: a held document is
        // named to none (ADR-0085).
        documentVisibleTo(SCREENED_ONLY),
      ),
    )
    .orderBy(desc(documentVersions.reviewedAt))
    .limit(limit)
  return rows.map((row) => ({
    ...row,
    // `sql<T>` coercion at the boundary, the house rule: a raw driver row hands
    // back a string where the annotation promises a Date.
    reviewedAt: row.reviewedAt ? new Date(row.reviewedAt) : null,
    reviewComment: row.reviewComment ?? '',
  }))
}
