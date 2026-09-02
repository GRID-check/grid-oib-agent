/**
 * Storage repository — object-storage consumption per organization.
 *
 * Repository rules (see docs/architecture/bff-service-architecture.md):
 *   - drizzle only; no HTTP, no auth, no WorkOS.
 *   - Every query that serves tenant data takes `organizationId` and scopes the
 *     WHERE clause with it — tenancy is enforced in SQL, not in JS.
 *
 * The `documents` row is the ledger, not the bucket. Summing `file_size` is
 * cheap (it rides `documents_org_scope_idx`) and it is the same number the UI
 * already shows per project, whereas a ListObjectsV2 sweep over the org prefix
 * is O(objects) and would also count thumbnails and any orphan the purger has
 * not reached. The two can drift — bytes written outside the document service
 * have no row — which is exactly why writes go through the service.
 */

import 'server-only'
import { and, eq, ne, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withPlatformAccess } from '@/lib/db/tenant-context'
import { documents, DOCUMENT_SCOPES, type DocumentScope, type NewDocument } from '@/lib/db/schema'

/** Bytes and document count for one scope. */
export interface StorageScopeUsage {
  bytes: number
  documents: number
}

/**
 * Per-shelf breakdown plus the total. One key per `DocumentScope` member, built
 * from `DOCUMENT_SCOPES` rather than written out, so a shelf added to the enum
 * appears here as a key that has to be handled instead of silently landing in
 * somebody else's bucket.
 */
export type StorageUsageByScope = Record<DocumentScope | 'total', StorageScopeUsage>

const emptyScope = (): StorageScopeUsage => ({ bytes: 0, documents: 0 })

/** `true` for a scope the schema declares — the coercion for a raw `text` column. */
function isDocumentScope(value: string): value is DocumentScope {
  return (DOCUMENT_SCOPES as readonly string[]).includes(value)
}

/**
 * Stored bytes per scope for one organization.
 *
 * `file_size` is a nullable integer, so `sum()` yields NULL for an org with no
 * documents and postgres-js hands back `bigint` as a STRING — both are coerced
 * here rather than at the call site, per the raw-`sql` rule in AGENTS.md.
 * Soft-deleted rows are excluded so a restore does not double-count.
 */
export async function aggregateStorageUsage(
  organizationId: string
): Promise<StorageUsageByScope> {
  const db = getDb()

  const rows = await db
    .select({
      scope: documents.scope,
      bytes: sql<string>`coalesce(sum(${documents.fileSize}), 0)::bigint`,
      documents: sql<string>`count(*)::bigint`,
    })
    .from(documents)
    .where(eq(documents.organizationId, organizationId))
    .groupBy(documents.scope)

  const usage = Object.fromEntries(
    [...DOCUMENT_SCOPES, 'total' as const].map((scope) => [scope, emptyScope()]),
  ) as StorageUsageByScope

  for (const row of rows) {
    const bytes = Number(row.bytes) || 0
    const count = Number(row.documents) || 0
    // Always counted toward the total, whatever the scope reads. It used to
    // FOLD an unrecognised scope into `project` — which for `session` would
    // have reported a chat attachment as project storage, and for a genuinely
    // unknown value would attribute bytes to a shelf that does not hold them.
    // The quota itself never had this problem (`sumStorageBytes` and the
    // admitting insert sum every row regardless of scope), so this is about the
    // breakdown telling the truth, not about the ceiling.
    usage.total = {
      bytes: usage.total.bytes + bytes,
      documents: usage.total.documents + count,
    }
    if (!isDocumentScope(row.scope)) continue
    usage[row.scope] = { bytes, documents: count }
  }

  return usage
}

/**
 * Total stored bytes only — the hot path for quota enforcement on upload.
 *
 * Deliberately a separate, narrower query than {@link aggregateStorageUsage}:
 * the upload path runs this on every file and does not need the per-scope
 * breakdown or the document counts.
 */
export async function sumStorageBytes(organizationId: string): Promise<number> {
  const db = getDb()

  const [row] = await db
    .select({ bytes: sql<string>`coalesce(sum(${documents.fileSize}), 0)::bigint` })
    .from(documents)
    .where(eq(documents.organizationId, organizationId))

  return Number(row?.bytes) || 0
}

/**
 * Stored bytes per organization, across every tenant — the platform-owner read.
 *
 * Wrapped in `withPlatformAccess` because it deliberately crosses the RLS
 * boundary (ADR-0041): every other query here is pinned to one tenant, and a
 * cross-org aggregate has to say out loud that it is not. The reason string ends
 * up in the audit trail for the escalation.
 *
 * One grouped query rather than N per-org ones: the platform overview already
 * lists every organization, and a per-org round trip would make that page
 * O(tenants).
 */
export async function aggregateStorageUsageByOrganization(): Promise<
  Map<string, StorageScopeUsage>
> {
  const db = getDb()

  const rows = await withPlatformAccess(
    'platform storage: stored bytes for every organization',
    () =>
      db
        .select({
          organizationId: documents.organizationId,
          bytes: sql<string>`coalesce(sum(${documents.fileSize}), 0)::bigint`,
          documents: sql<string>`count(*)::bigint`,
        })
        .from(documents)
        .groupBy(documents.organizationId),
  )

  return new Map(
    rows.map((row) => [
      row.organizationId,
      { bytes: Number(row.bytes) || 0, documents: Number(row.documents) || 0 },
    ]),
  )
}

/**
 * Insert a document row only if it keeps the organization within its quota,
 * atomically.
 *
 * ## What was wrong with checking first
 *
 * `assertWithinStorageQuota` reads the sum, compares, and returns; the bytes go
 * to SeaweedFS afterwards and the row that carries `file_size` is inserted after
 * that. Two uploads that start together read the same sum, both pass, and the
 * organization ends up over its quota by up to the per-file limit times the
 * concurrency. Nothing reserved the capacity the check had approved, so the
 * approval was stale the moment it was given — which makes "quota" the wrong word
 * for what was implemented.
 *
 * ## How this is atomic
 *
 * One transaction, holding a per-organization advisory lock, re-reads the sum and
 * inserts inside it. Concurrent admissions for the same organization serialize on
 * that lock, so after any commit `SUM(file_size) <= quota` holds — the ceiling is
 * hard rather than statistical. `SUM` stays the only source of truth: no counter
 * to drift, nothing to reconcile.
 *
 * The lock is per ORGANIZATION, keyed by `hashtextextended`, so tenants never
 * queue behind each other. It is held for the duration of a sum and an insert —
 * microseconds — and NOT across the upload, which is the whole reason the object
 * write stays outside this function.
 *
 * ## Why the row is still written after the bytes
 *
 * The tempting alternative is to insert first (reserving with the row itself) and
 * upload after. That would mean a row exists whose object does not, so every read
 * path in the application would have to learn to exclude a new in-flight state —
 * a wide change for a narrow problem, and a new way to show a user a document
 * that cannot be opened.
 *
 * Instead the caller uploads first and calls this; if admission is refused, the
 * caller deletes the object it just wrote. That keeps the existing invariant (a
 * row implies its bytes) and pays for the rare refusal with a wasted transfer
 * rather than paying for the common case with a new document state. The
 * pre-upload check remains as a courtesy so an obviously-over-quota upload is
 * refused before the bytes move.
 */
/**
 * Point an existing document row at new bytes, under the same quota lock.
 *
 * The sibling of {@link insertDocumentWithinQuota}, for a re-upload of a
 * filename this collection already holds. Usage is `sum(file_size)` over live
 * rows, so the row being replaced is ALREADY counted — charging the full new
 * size against a total that includes the old one would refuse a corrected plan
 * for space the correction itself frees. The row is excluded from the sum and
 * the new size charged in its place, which is the real delta.
 *
 * Same advisory lock as the insert path, and deliberately so: a replace and an
 * insert racing for the last megabyte must serialize against each other, not
 * only against their own kind.
 */
export async function replaceDocumentWithinQuota(
  organizationId: string,
  documentId: string,
  next: {
    storageKey: string
    storageBucket: string | null
    fileSize: number
    contentType: string | null
    folderId: string | null
    createdBy: string
  },
  quotaBytes: number | null,
): Promise<{ ok: true } | { ok: false; usedBytes: number }> {
  const db = getDb()

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`storage_quota:${organizationId}`}, 0))`,
    )

    if (quotaBytes !== null) {
      const [row] = await tx
        .select({ bytes: sql<string>`coalesce(sum(${documents.fileSize}), 0)::bigint` })
        .from(documents)
        .where(
          and(eq(documents.organizationId, organizationId), ne(documents.id, documentId)),
        )

      const usedBytes = Number(row?.bytes) || 0
      if (usedBytes + next.fileSize > quotaBytes) {
        return { ok: false as const, usedBytes }
      }
    }

    await tx
      .update(documents)
      .set({
        storageKey: next.storageKey,
        storageBucket: next.storageBucket,
        fileSize: next.fileSize,
        contentType: next.contentType,
        folderId: next.folderId,
        createdBy: next.createdBy,
        status: 'uploaded',
        errorMessage: null,
        updatedAt: new Date(),
      })
      .where(and(eq(documents.organizationId, organizationId), eq(documents.id, documentId)))
    return { ok: true as const }
  })
}

export async function insertDocumentWithinQuota(
  values: NewDocument,
  quotaBytes: number | null,
): Promise<{ ok: true } | { ok: false; usedBytes: number }> {
  const db = getDb()
  const incoming = values.fileSize ?? 0

  return db.transaction(async (tx) => {
    // Serialize admissions for THIS organization. `pg_advisory_xact_lock`
    // releases at commit or rollback, so there is no path that leaks it.
    // `hashtextextended` gives the bigint the lock function wants and is stable
    // across sessions, unlike `hashtext`'s 32-bit output which would collide
    // often enough at fleet scale to make two tenants share a lock.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`storage_quota:${values.organizationId}`}, 0))`,
    )

    if (quotaBytes !== null) {
      const [row] = await tx
        .select({ bytes: sql<string>`coalesce(sum(${documents.fileSize}), 0)::bigint` })
        .from(documents)
        .where(eq(documents.organizationId, values.organizationId))

      const usedBytes = Number(row?.bytes) || 0
      if (usedBytes + incoming > quotaBytes) {
        // Returned rather than thrown: the caller has an object to clean up, and
        // a refusal is an expected outcome here, not an error condition. The
        // transaction commits having done nothing but take and release a lock.
        return { ok: false as const, usedBytes }
      }
    }

    await tx.insert(documents).values(values)
    return { ok: true as const }
  })
}
