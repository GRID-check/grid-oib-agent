/**
 * `document_access_log` repository: SQL only (ADR-0017). Every list is bounded.
 *
 * The table is append-only for the application: the only writer is
 * {@link insertAccessLogEntry}, and the retention sweep deletes from the
 * scheduler (`scheduler/db.js`), not from here.
 */

import 'server-only'
import { and, desc, eq, gte, ilike, lt, sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { withTenant } from '@/lib/db/tenant-context'
import { ACCESS_LOG_MAX_LIMIT } from './kinds'
import {
  documentAccessLog,
  projectFolders,
  projects,
  type DownloadLogKind,
  type DownloadLogScope,
  type NewDocumentAccessLogRow,
} from '@/lib/db/schema'

/** What one hand-over of bytes writes. `occurredAt` is the database's clock. */
export type NewAccessLogEntry = Omit<NewDocumentAccessLogRow, 'id' | 'occurredAt'>

export async function insertAccessLogEntry(entry: NewAccessLogEntry): Promise<void> {
  const db = getDb()
  await withTenant({ organizationId: entry.organizationId, userId: entry.userId }, () =>
    db.insert(documentAccessLog).values(entry)
  )
}

export interface AccessLogFilter {
  organizationId: string
  userId?: string
  /** Exactly one document, by id. */
  documentId?: string
  /** A document, by part of the name it had when it was taken. */
  documentName?: string
  /** Inclusive lower bound on when it happened. */
  from?: Date
  /** Exclusive upper bound. */
  to?: Date
  kind?: DownloadLogKind
}

/**
 * Where the previous page ended. `occurredAt` is the database's own text for
 * the timestamp, microseconds included: a JavaScript `Date` keeps milliseconds,
 * and a cursor rounded to them would skip the rows of the same millisecond
 * that sort after the one it names.
 */
export interface AccessLogCursor {
  occurredAt: string
  id: string
}

export interface AccessLogRow {
  id: string
  occurredAt: Date
  /** The cursor that continues the list after this row. */
  cursor: AccessLogCursor
  userId: string
  kind: DownloadLogKind
  scope: DownloadLogScope
  projectId: string | null
  projectName: string | null
  documentId: string
  documentName: string
  versionId: string | null
  folderId: string | null
  folderPath: string | null
  ownList: boolean
}

/** `%` and `_` in a typed name are the characters, not wildcards. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}

function conditions(filter: AccessLogFilter, cursor: AccessLogCursor | null): SQL[] {
  const found: SQL[] = [eq(documentAccessLog.organizationId, filter.organizationId)]
  if (filter.userId) found.push(eq(documentAccessLog.userId, filter.userId))
  if (filter.documentId) found.push(eq(documentAccessLog.documentId, filter.documentId))
  if (filter.documentName) found.push(ilike(documentAccessLog.documentName, likePattern(filter.documentName)))
  if (filter.from) found.push(gte(documentAccessLog.occurredAt, filter.from))
  if (filter.to) found.push(lt(documentAccessLog.occurredAt, filter.to))
  if (filter.kind) found.push(eq(documentAccessLog.kind, filter.kind))
  if (cursor) {
    found.push(sql`(${documentAccessLog.occurredAt}, ${documentAccessLog.id}) < (${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)`)
  }
  return found
}

/**
 * One page of the log, newest first, `limit` rows at most (the caller asks for
 * one more than it shows, to know whether another page exists). Project and
 * folder names are read from today's rows: a deleted project or folder leaves
 * its id and its null name, which the page shows as such.
 */
export async function listAccessLog(
  filter: AccessLogFilter,
  cursor: AccessLogCursor | null,
  limit: number
): Promise<AccessLogRow[]> {
  const db = getDb()
  const bounded = Math.min(Math.max(1, Math.floor(limit)), ACCESS_LOG_MAX_LIMIT + 1)
  const rows = await withTenant({ organizationId: filter.organizationId }, () =>
    db
      .select({
        id: documentAccessLog.id,
        occurredAt: documentAccessLog.occurredAt,
        cursorAt: sql<string>`to_char(${documentAccessLog.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        userId: documentAccessLog.userId,
        kind: documentAccessLog.kind,
        scope: documentAccessLog.scope,
        projectId: documentAccessLog.projectId,
        projectName: projects.name,
        documentId: documentAccessLog.documentId,
        documentName: documentAccessLog.documentName,
        versionId: documentAccessLog.versionId,
        folderId: documentAccessLog.folderId,
        folderPath: projectFolders.path,
        ownList: documentAccessLog.ownList,
      })
      .from(documentAccessLog)
      .leftJoin(
        projects,
        and(eq(projects.id, documentAccessLog.projectId), eq(projects.organizationId, documentAccessLog.organizationId))
      )
      .leftJoin(
        projectFolders,
        and(eq(projectFolders.id, documentAccessLog.folderId), eq(projectFolders.projectId, documentAccessLog.projectId))
      )
      .where(and(...conditions(filter, cursor)))
      .orderBy(desc(documentAccessLog.occurredAt), desc(documentAccessLog.id))
      .limit(bounded)
  )
  return rows.map((row) => ({
    id: row.id,
    // Coerced at the boundary: a raw `sql<T>` is not validated, and `occurredAt`
    // is a Date only because drizzle maps the column itself.
    occurredAt: new Date(row.occurredAt),
    cursor: { occurredAt: String(row.cursorAt), id: row.id },
    userId: row.userId,
    kind: row.kind,
    scope: row.scope,
    projectId: row.projectId,
    projectName: row.projectName,
    documentId: row.documentId,
    documentName: row.documentName,
    versionId: row.versionId,
    folderId: row.folderId,
    folderPath: row.folderPath,
    ownList: row.ownList,
  }))
}
