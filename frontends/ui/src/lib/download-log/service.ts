/**
 * The download log: recording a hand-over of a document's bytes, and the admin
 * view of what was recorded (ADR-0087, plan 2026-10-06-folder-access-lifecycle).
 *
 * ## What is recorded
 *
 * Every DOWNLOAD (`kind: 'download'`), wherever the document is filed. An OPEN
 * (preview, PDF stream, text preview, a version, the 3D model) only when the
 * document sits under a folder with its own access list: an office that gave a
 * folder its own list is saying it matters who looks at it.
 *
 * ## The one choke point
 *
 * {@link recordDocumentAccess} is the only writer. Every service function that
 * hands a document's bytes to a person calls it, and
 * `coverage.spec.ts` reads the source to keep it so: a new function that reads
 * or presigns an object has to be classified there as logged or exempt, or the
 * suite fails. The write is awaited inside the request that hands the bytes over.
 *
 * ## When the log fails
 *
 * A download out of a folder that is NOT under its own list is not blocked by a
 * log failure: the failure is a warning, the person gets the file. A hand-over
 * from a folder WITH its own list is refused (503) when it cannot be recorded.
 * There the log is the control, not a convenience: "nothing left the personnel
 * folder unrecorded" is the claim an office makes to its works council, and a
 * log that fails open makes that claim false exactly when the database is
 * unwell. The cost is availability of those folders during a fault that, since
 * the access decision reads the same database, would be felt there anyway.
 *
 * ## Who reads it
 *
 * Holders of `org:downloads:view` (organization admins), and every read is
 * recorded in the audit trail BEFORE the rows are read, with the emitter that
 * throws: no record, no data.
 */

import 'server-only'
import type { ProjectStatus } from '@/lib/projects/project-status'
import { BadRequestError, ForbiddenError, ServiceUnavailableError } from '@/lib/api/errors'
import { recordAuditEvent, recordAuditEventOrThrow } from '@/lib/audit/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import { folderTree, isUnderOwnList, loadCustomFolderTree } from '@/lib/authz/folder-access'
import { hasPermission, ORG_PERMISSIONS } from '@/lib/authz/permissions'
import type { Document } from '@/lib/db/schema'
import { documentDisplayName } from '@/lib/documents/display-name'
import { getOrgSettings, writeDedicatedOrgSetting } from '@/lib/organizations/service'
import { resolvePeople } from '@/lib/sharing/directory'
import {
  ACCESS_LOG_DEFAULT_LIMIT,
  ACCESS_LOG_MAX_LIMIT,
  DOWNLOAD_LOG_KINDS,
  DOWNLOAD_LOG_MAX_RETENTION_DAYS,
  DOWNLOAD_LOG_MIN_RETENTION_DAYS,
  DOWNLOAD_LOG_RETENTION_SETTING,
  isOpenKind,
  isValidRetentionDays,
  retentionDaysFromSettings,
  type DownloadLogKind,
} from './kinds'
import {
  insertAccessLogEntry,
  listAccessLog,
  type AccessLogCursor,
  type AccessLogFilter,
  type AccessLogRow,
} from './repository'

/** What the log needs of a document row. */
export type LoggedDocument = Pick<
  Document,
  'id' | 'scope' | 'projectId' | 'folderId' | 'filename' | 'displayName' | 'publishedVersionId'
>

export interface RecordAccessOptions {
  /** The version the bytes belong to, when the route names one; else the document's published version. */
  versionId?: string | null
}

const NAME_LIMIT = 500

/**
 * Whether the document's folder, or an ancestor, has its own access list. Only
 * a project document has folders; the probe is one indexed query for a project
 * with none (`loadCustomFolderTree`).
 */
async function isUnderOwnListNow(organizationId: string, doc: LoggedDocument): Promise<boolean> {
  if (doc.scope !== 'project' || !doc.projectId || !doc.folderId) return false
  const folders = await loadCustomFolderTree(organizationId, doc.projectId)
  if (!folders) return false
  return isUnderOwnList(folderTree(folders), doc.folderId)
}

/**
 * Record that the session's person is being handed `doc`'s bytes. Call it after
 * every check that can refuse the request and before the bytes (or the URL that
 * fetches them) leave: a refused request is not a download.
 *
 * Resolves when nothing needs to be recorded or the entry is written. A failure
 * is swallowed with a warning, except for a document under a folder with its own
 * list, where it throws a 503 (see the module note).
 */
export async function recordDocumentAccess(
  session: AuthorizedSession,
  doc: LoggedDocument,
  kind: DownloadLogKind,
  options: RecordAccessOptions = {}
): Promise<void> {
  let ownList = false
  // Whether the question "is it under an own list?" was answered. When it was
  // not (the folder read failed), the document may be under one, so a failure
  // is treated as the stricter case.
  let decided = false
  try {
    ownList = await isUnderOwnListNow(session.organizationId, doc)
    decided = true
    if (isOpenKind(kind) && !ownList) return
    await insertAccessLogEntry({
      organizationId: session.organizationId,
      userId: session.userId,
      kind,
      scope: doc.scope,
      projectId: doc.scope === 'project' ? doc.projectId : null,
      documentId: doc.id,
      documentName: documentDisplayName(doc).slice(0, NAME_LIMIT),
      versionId: options.versionId ?? doc.publishedVersionId ?? null,
      folderId: doc.scope === 'project' ? doc.folderId : null,
      ownList,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (decided && !ownList) {
      console.warn(`[download-log] could not record a ${kind} of document ${doc.id}: ${detail}`)
      return
    }
    console.error(
      `[download-log] could not record a ${kind} of document ${doc.id} that is or may be under an own list: ${detail}`
    )
    throw new ServiceUnavailableError(
      'This file is in a folder whose access is recorded, and the record could not be written, so it was not released. Try again.',
      { reason: 'download-log-unavailable' }
    )
  }
}

// ---------------------------------------------------------------------------
// The admin view
// ---------------------------------------------------------------------------

export interface DownloadLogQuery {
  /** A WorkOS user id. */
  userId?: string
  /** A document id, or part of a document's name. */
  document?: string
  /** First day shown, inclusive. */
  from?: Date
  /** Last instant shown, exclusive. */
  to?: Date
  kind?: DownloadLogKind
  /** The `nextCursor` of the previous page. */
  cursor?: string
  limit?: number
}

export interface DownloadLogEntry {
  id: string
  occurredAt: string
  userId: string
  /** Name and email from WorkOS; null for someone no longer in the organization. */
  person: { name: string; email: string | null } | null
  kind: DownloadLogKind
  /** `download` or `open`: what the person did, in the two words the page uses. */
  access: 'download' | 'open'
  scope: AccessLogRow['scope']
  projectId: string | null
  projectName: string | null
  /** `closed`: the file's project is closed (ADR-0086), said beside its name. */
  projectStatus: ProjectStatus | null
  documentId: string
  documentName: string
  versionId: string | null
  folderId: string | null
  folderPath: string | null
  ownList: boolean
}

export interface DownloadLogPage {
  entries: DownloadLogEntry[]
  nextCursor: string | null
  retentionDays: number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

export function encodeCursor(cursor: AccessLogCursor): string {
  return Buffer.from(JSON.stringify([cursor.occurredAt, cursor.id])).toString('base64url')
}

export function decodeCursor(raw: string): AccessLogCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      const [occurredAt, id] = parsed
      if (CURSOR_TIME.test(occurredAt) && UUID.test(id)) return { occurredAt, id }
    }
  } catch {
    // Falls through to the refusal below: a cursor is opaque, and a damaged one is a bad request.
  }
  throw new BadRequestError('Invalid cursor')
}

function toFilter(organizationId: string, query: DownloadLogQuery): AccessLogFilter {
  const filter: AccessLogFilter = { organizationId }
  if (query.userId) filter.userId = query.userId
  const document = query.document?.trim()
  if (document) {
    if (UUID.test(document)) filter.documentId = document.toLowerCase()
    else filter.documentName = document
  }
  if (query.from) filter.from = query.from
  if (query.to) filter.to = query.to
  if (query.kind) filter.kind = query.kind
  return filter
}

/**
 * The audit event's description of a read: which filters were set and their
 * values, never what the read found. `continued` marks every page after the
 * first.
 */
function auditMetadata(filter: AccessLogFilter, continued: boolean) {
  return {
    userId: filter.userId,
    documentId: filter.documentId,
    documentName: filter.documentName,
    kind: filter.kind,
    from: filter.from?.toISOString(),
    to: filter.to?.toISOString(),
    continued,
  }
}

/** One page of the organization's download log, newest first, for a holder of `org:downloads:view`. */
export async function listDownloadLog(
  session: AuthorizedSession,
  query: DownloadLogQuery,
  request: Request
): Promise<DownloadLogPage> {
  if (!hasPermission(session, ORG_PERMISSIONS.downloadLogView)) throw new ForbiddenError()
  if (query.kind && !DOWNLOAD_LOG_KINDS.includes(query.kind)) throw new BadRequestError('Unknown kind')
  const filter = toFilter(session.organizationId, query)
  const cursor = query.cursor ? decodeCursor(query.cursor) : null
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? ACCESS_LOG_DEFAULT_LIMIT)), ACCESS_LOG_MAX_LIMIT)

  // Recorded first, and refused if it cannot be: reading staff records leaves a
  // trace even when the read then fails, and never the other way round.
  await recordAuditEventOrThrow({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'download_log.viewed',
    targetType: 'organization',
    targetId: session.organizationId,
    metadata: auditMetadata(filter, cursor !== null),
    request,
  })

  const [rows, settings] = await Promise.all([
    listAccessLog(filter, cursor, limit + 1),
    getOrgSettings(session.organizationId),
  ])
  const page = rows.slice(0, limit)
  const people = await resolvePeople(session.organizationId, [...new Set(page.map((row) => row.userId))])

  return {
    entries: page.map((row) => {
      const person = people.get(row.userId)
      return {
        id: row.id,
        occurredAt: row.occurredAt.toISOString(),
        userId: row.userId,
        person: person ? { name: person.name, email: person.email } : null,
        kind: row.kind,
        access: isOpenKind(row.kind) ? 'open' : 'download',
        scope: row.scope,
        projectId: row.projectId,
        projectName: row.projectName,
        projectStatus: row.projectStatus,
        documentId: row.documentId,
        documentName: row.documentName,
        versionId: row.versionId,
        folderId: row.folderId,
        folderPath: row.folderPath,
        ownList: row.ownList,
      }
    }),
    nextCursor: rows.length > limit ? encodeCursor(page[page.length - 1].cursor) : null,
    retentionDays: retentionDaysFromSettings(settings.settings),
  }
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** How long this organization keeps the log, in days. */
export async function getDownloadLogRetentionDays(organizationId: string): Promise<number> {
  return retentionDaysFromSettings((await getOrgSettings(organizationId)).settings)
}

/**
 * Set how long the log is kept: whole days from 30 to 365, no more. The only
 * writer of the setting (the generic save refuses the key), audited with the
 * value before and after. Shortening it takes effect at the next daily sweep.
 */
export async function setDownloadLogRetentionDays(
  session: AuthorizedSession,
  days: number,
  request: Request
): Promise<{ days: number; previous: number }> {
  if (!hasPermission(session, ORG_PERMISSIONS.settingsManage)) throw new ForbiddenError()
  if (!isValidRetentionDays(days)) {
    throw new BadRequestError(
      `Retention must be a whole number of days from ${DOWNLOAD_LOG_MIN_RETENTION_DAYS} to ${DOWNLOAD_LOG_MAX_RETENTION_DAYS}`
    )
  }
  const previous = await getDownloadLogRetentionDays(session.organizationId)
  await writeDedicatedOrgSetting(session.organizationId, DOWNLOAD_LOG_RETENTION_SETTING, days)
  await recordAuditEvent({
    organizationId: session.organizationId,
    actor: { userId: session.userId, email: session.email },
    action: 'download_log.retention.updated',
    targetType: 'organization',
    targetId: session.organizationId,
    metadata: { days, previous },
    request,
  })
  return { days, previous }
}
