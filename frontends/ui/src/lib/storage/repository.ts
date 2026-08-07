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
import { and, eq, isNull, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withPlatformAccess } from '@/lib/db/tenant-context'
import { documents, type DocumentScope } from '@/lib/db/schema'

/** Bytes and document count for one scope. */
export interface StorageScopeUsage {
  bytes: number
  documents: number
}

export interface StorageUsageByScope {
  project: StorageScopeUsage
  archiv: StorageScopeUsage
  total: StorageScopeUsage
}

const emptyScope = (): StorageScopeUsage => ({ bytes: 0, documents: 0 })

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
    .where(and(eq(documents.organizationId, organizationId), isNull(documents.deletedAt)))
    .groupBy(documents.scope)

  const usage: StorageUsageByScope = {
    project: emptyScope(),
    archiv: emptyScope(),
    total: emptyScope(),
  }

  for (const row of rows) {
    const scope: DocumentScope = row.scope === 'archiv' ? 'archiv' : 'project'
    const bytes = Number(row.bytes) || 0
    const count = Number(row.documents) || 0
    usage[scope] = { bytes, documents: count }
    usage.total = {
      bytes: usage.total.bytes + bytes,
      documents: usage.total.documents + count,
    }
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
    .where(and(eq(documents.organizationId, organizationId), isNull(documents.deletedAt)))

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
        .where(isNull(documents.deletedAt))
        .groupBy(documents.organizationId),
  )

  return new Map(
    rows.map((row) => [
      row.organizationId,
      { bytes: Number(row.bytes) || 0, documents: Number(row.documents) || 0 },
    ]),
  )
}
