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
import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import {
  mailImports,
  type MailImport,
  type MailImportSkippedSample,
  type MailImportStatus,
  type NewMailImport,
} from '@/lib/db/schema'
import { CURSOR_TIMESTAMP_FORMAT, type DocumentListCursor } from '@/lib/documents/list-cursor'
import { isUuid } from '@/lib/ids'

const OPEN_STATUSES: MailImportStatus[] = ['uploading', 'queued', 'importing']
const ENDED_STATUSES: MailImportStatus[] = ['completed', 'failed', 'cancelled']

/** Insert the row, or null when the person already has an open import in the project (the unique index). */
export async function insertMailImport(values: NewMailImport): Promise<MailImport | null> {
  const rows = await withTenant({ organizationId: values.organizationId }, () =>
    getDb().insert(mailImports).values(values).onConflictDoNothing().returning(),
  )
  return rows[0] ?? null
}

export async function findMailImport(organizationId: string, projectId: string, id: string): Promise<MailImport | null> {
  // A malformed id names no import; asked as is, Postgres refuses the cast and the route answers 500.
  if (!isUuid(id)) return null
  const [row] = await withTenant({ organizationId }, () =>
    getDb()
      .select()
      .from(mailImports)
      .where(and(eq(mailImports.id, id), eq(mailImports.projectId, projectId)))
      .limit(1),
  )
  return row ?? null
}

/** One page of a project's imports, and the position of its last one when another page follows. */
export interface MailImportPage {
  rows: MailImport[]
  next: DocumentListCursor | null
}

/**
 * One page of the project's imports, newest first (`created_at DESC, id DESC`,
 * the order `mail_imports_org_project_created_idx` serves). The position is
 * compared as the column's microsecond UTC text, as every keyset list here is
 * (`lib/documents/list-cursor.ts` says why a JS `Date` would skip rows).
 */
export async function listProjectMailImports(
  organizationId: string,
  projectId: string,
  page: { limit: number; cursor: DocumentListCursor | null },
): Promise<MailImportPage> {
  const fetched = await withTenant({ organizationId }, () =>
    getDb()
      .select({
        row: mailImports,
        cursorAt: sql<string>`to_char(${mailImports.createdAt} AT TIME ZONE 'UTC', ${CURSOR_TIMESTAMP_FORMAT})`,
      })
      .from(mailImports)
      .where(
        and(
          eq(mailImports.organizationId, organizationId),
          eq(mailImports.projectId, projectId),
          afterCursor(page.cursor),
        ),
      )
      .orderBy(desc(mailImports.createdAt), desc(mailImports.id))
      .limit(page.limit + 1),
  )
  const kept = fetched.slice(0, page.limit)
  const last = kept.at(-1)
  return {
    rows: kept.map((entry) => entry.row),
    next: fetched.length > page.limit && last ? { createdAt: String(last.cursorAt), id: last.row.id } : null,
  }
}

function afterCursor(cursor: DocumentListCursor | null): SQL | undefined {
  if (!cursor) return undefined
  return sql`(${mailImports.createdAt}, ${mailImports.id}) < ((${cursor.createdAt})::timestamp AT TIME ZONE 'UTC', ${cursor.id}::uuid)`
}

/**
 * The import this person still has open in the project, if any: the one the
 * unique index lets them have. Asked on its own, not read off a list page, so
 * an open import older than a page of finished ones still answers a second
 * start with its id.
 */
export async function findOpenMailImportOf(
  organizationId: string,
  projectId: string,
  userId: string,
): Promise<MailImport | null> {
  const [row] = await withTenant({ organizationId }, () =>
    getDb()
      .select()
      .from(mailImports)
      .where(
        and(
          eq(mailImports.organizationId, organizationId),
          eq(mailImports.projectId, projectId),
          eq(mailImports.userId, userId),
          inArray(mailImports.status, OPEN_STATUSES),
        ),
      )
      .limit(1),
  )
  return row ?? null
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
