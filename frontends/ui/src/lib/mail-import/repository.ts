/**
 * Mail-import repository: the only module that queries `mail_imports` (ADR-0017).
 *
 * Every function but the sweep's read names its organization and runs inside
 * it (`withTenant`), because two of its callers carry no request session: the
 * filing job and the sweep. Progress writes are conditional on the position
 * they advance from, so a slice that lost its claim and kept going cannot move
 * the cursor under the slice that took over.
 */

import 'server-only'
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import {
  mailImports,
  type MailImport,
  type MailImportSkippedSample,
  type MailImportStatus,
  type NewMailImport,
} from '@/lib/db/schema'

/** One project's imports shown at once. Newest first; older ones are history. */
export const MAIL_IMPORT_LIST_LIMIT = 20

const ENDED_STATUSES: MailImportStatus[] = ['completed', 'failed', 'cancelled']

/** Insert the row, or null when the person already has an open import in the project (the unique index). */
export async function insertMailImport(values: NewMailImport): Promise<MailImport | null> {
  const rows = await withTenant({ organizationId: values.organizationId }, () =>
    getDb().insert(mailImports).values(values).onConflictDoNothing().returning(),
  )
  return rows[0] ?? null
}

export async function findMailImport(organizationId: string, projectId: string, id: string): Promise<MailImport | null> {
  const [row] = await withTenant({ organizationId }, () =>
    getDb()
      .select()
      .from(mailImports)
      .where(and(eq(mailImports.id, id), eq(mailImports.projectId, projectId)))
      .limit(1),
  )
  return row ?? null
}

export function listProjectMailImports(organizationId: string, projectId: string): Promise<MailImport[]> {
  return withTenant({ organizationId }, () =>
    getDb()
      .select()
      .from(mailImports)
      .where(eq(mailImports.projectId, projectId))
      .orderBy(desc(mailImports.createdAt))
      .limit(MAIL_IMPORT_LIST_LIMIT),
  )
}

export type MailImportPatch = Partial<
  Pick<
    MailImport,
    | 'status'
    | 'uploadId'
    | 'stagingDeletedAt'
    | 'rootFolderId'
    | 'totalItems'
    | 'errorCode'
    | 'lastError'
    | 'failureStreak'
    | 'completedAt'
    | 'inflightPosition'
    | 'inflightFolderId'
  >
>

/**
 * Write `patch` while the import is in one of `from`; the row as written, or
 * null when it had already moved on (a cancel raced the write, say).
 */
export async function updateMailImport(
  organizationId: string,
  id: string,
  from: readonly MailImportStatus[],
  patch: MailImportPatch,
): Promise<MailImport | null> {
  const [row] = await withTenant({ organizationId }, () =>
    getDb()
      .update(mailImports)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(mailImports.id, id), inArray(mailImports.status, [...from])))
      .returning(),
  )
  return row ?? null
}

/** Record the mail being filed at `position`, so a retry resumes into its folder. */
export async function markInflight(
  organizationId: string,
  id: string,
  position: number,
  folderId: string,
): Promise<boolean> {
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .update(mailImports)
      .set({ inflightPosition: position, inflightFolderId: folderId, updatedAt: new Date() })
      .where(and(eq(mailImports.id, id), eq(mailImports.status, 'importing'), eq(mailImports.nextPosition, position)))
      .returning({ id: mailImports.id }),
  )
  return rows.length > 0
}

export interface MailImportAdvance {
  to: number
  mailsFiled: number
  filesFiled: number
  itemsSkipped: number
  filesSkipped: number
  skippedSamples: MailImportSkippedSample[]
}

/**
 * Move the cursor from `from` to `advance.to`, adding the counts. False when the
 * cursor was not at `from` or the import is no longer running: the caller stops.
 */
export async function advanceMailImport(
  organizationId: string,
  id: string,
  from: number,
  advance: MailImportAdvance,
): Promise<boolean> {
  const rows = await withTenant({ organizationId }, () =>
    getDb()
      .update(mailImports)
      .set({
        nextPosition: advance.to,
        mailsFiled: sql`${mailImports.mailsFiled} + ${advance.mailsFiled}`,
        filesFiled: sql`${mailImports.filesFiled} + ${advance.filesFiled}`,
        itemsSkipped: sql`${mailImports.itemsSkipped} + ${advance.itemsSkipped}`,
        filesSkipped: sql`${mailImports.filesSkipped} + ${advance.filesSkipped}`,
        skippedSamples: advance.skippedSamples,
        // A mail filed: whatever failed before it has passed.
        failureStreak: 0,
        inflightPosition: null,
        inflightFolderId: null,
        updatedAt: new Date(),
      })
      .where(and(eq(mailImports.id, id), eq(mailImports.status, 'importing'), eq(mailImports.nextPosition, from)))
      .returning({ id: mailImports.id }),
  )
  return rows.length > 0
}

/**
 * Imports the sweep should look at: uploads left open past `uploadsBefore`,
 * queued or running imports with no progress since `stalledBefore`, and ended
 * imports whose staged archive is still there. Run under the platform bypass by
 * the caller; bounded.
 */
export async function listStaleOpenImports(
  uploadsBefore: Date,
  stalledBefore: Date,
  limit: number,
): Promise<MailImport[]> {
  const db = getDb()
  const open = await db
    .select()
    .from(mailImports)
    .where(
      or(
        and(eq(mailImports.status, 'uploading'), lt(mailImports.updatedAt, uploadsBefore)),
        and(inArray(mailImports.status, ['queued', 'importing']), lt(mailImports.updatedAt, stalledBefore)),
      ),
    )
    .orderBy(mailImports.updatedAt)
    .limit(limit)
  // A batch of its own, so archives whose deletion keeps failing cannot crowd
  // out the open imports, nor the other way round.
  const undeleted = await db
    .select()
    .from(mailImports)
    .where(
      and(
        inArray(mailImports.status, ENDED_STATUSES),
        isNull(mailImports.stagingDeletedAt),
        lt(mailImports.updatedAt, stalledBefore),
      ),
    )
    .orderBy(mailImports.updatedAt)
    .limit(limit)
  return [...open, ...undeleted]
}
