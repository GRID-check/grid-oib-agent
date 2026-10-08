import { boolean, check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { DOWNLOAD_LOG_KINDS, DOWNLOAD_LOG_SCOPES } from '@/lib/download-log/kinds'

export { DOWNLOAD_LOG_KINDS, DOWNLOAD_LOG_SCOPES }
export type { DownloadLogKind, DownloadLogScope } from '@/lib/download-log/kinds'

/** The values as a SQL list, so the CHECK and the tuple cannot drift. */
const list = (values: readonly string[]) => sql.raw(values.map((value) => `'${value}'`).join(', '))

/**
 * `document_access_log` — who took a document's bytes, and who opened one in a
 * folder with its own access list (migration 0114, ADR-0088, the plan's
 * "download log").
 *
 * Personal data about staff, kept for a purpose: security and accountability.
 * One row per hand-over of bytes, written in the request that hands them over
 * (`lib/download-log/service.ts`, `recordDocumentAccess`), never aggregated by
 * person. Kept twelve months at most (`DOWNLOAD_LOG_MAX_RETENTION_DAYS`), less
 * when the organization chose a shorter time; the scheduler purges it daily.
 *
 * ## What the rows keep, and why they point at nothing
 *
 * No foreign keys, on purpose, like `conversation_restricted_folders`: the log
 * must outlive the document, the version, the folder and the project it names,
 * because "who downloaded the contract that was deleted last week" is the
 * question it exists to answer. A row therefore carries what it needs to be
 * read alone: the document's name at the time, the shelf, and whether the
 * folder (or an ancestor) had its own list.
 *
 * ## The CHECKs are the ratchet
 *
 * `document_access_log_open_needs_own_list`: only `download` is logged
 * everywhere; every other kind is an OPEN, logged only under a folder with its
 * own list (product decision), so a path that logs every preview is refused by
 * the database instead of quietly filling it with who looked at what.
 * `document_access_log_scope_project`: the project column and the shelf agree,
 * as on `documents`.
 *
 * The rows are immutable, and only the platform role may delete (the retention
 * sweep): a trigger in the migration, which no schema declaration can express.
 */
export const documentAccessLog = pgTable(
  'document_access_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** The WorkOS user id of the person the bytes went to. */
    userId: text('user_id').notNull(),
    kind: text('kind', { enum: DOWNLOAD_LOG_KINDS }).notNull(),
    scope: text('scope', { enum: DOWNLOAD_LOG_SCOPES }).notNull(),
    /** NULL for the Archiv and a chat's attachments, exactly as on `documents`. */
    projectId: uuid('project_id'),
    documentId: uuid('document_id').notNull(),
    /** The name the document was shown under when it was taken: the row outlives a rename and a delete. */
    documentName: text('document_name').notNull(),
    /** The version taken, when the route names one (the version list) or the document has a published one. */
    versionId: uuid('version_id'),
    /** The folder the document was filed in at that time; NULL at the project root and off the project shelf. */
    folderId: uuid('folder_id'),
    /** Whether that folder, or an ancestor, had its own access list then. */
    ownList: boolean('own_list').notNull().default(false),
  },
  (table) => ({
    kindCheck: check('document_access_log_kind_check', sql`${table.kind} IN (${list(DOWNLOAD_LOG_KINDS)})`),
    scopeCheck: check('document_access_log_scope_check', sql`${table.scope} IN (${list(DOWNLOAD_LOG_SCOPES)})`),
    scopeProject: check(
      'document_access_log_scope_project',
      sql`(${table.scope} = 'project') = (${table.projectId} IS NOT NULL)`
    ),
    folderNeedsProject: check(
      'document_access_log_folder_needs_project',
      sql`${table.folderId} IS NULL OR ${table.projectId} IS NOT NULL`
    ),
    openNeedsOwnList: check(
      'document_access_log_open_needs_own_list',
      sql`${table.kind} = 'download' OR ${table.ownList}`
    ),
    nameLength: check('document_access_log_name_length', sql`char_length(${table.documentName}) BETWEEN 1 AND 500`),
    byTime: index('document_access_log_org_time_idx').on(
      table.organizationId,
      table.occurredAt.desc(),
      table.id.desc()
    ),
    byPerson: index('document_access_log_org_user_idx').on(
      table.organizationId,
      table.userId,
      table.occurredAt.desc(),
      table.id.desc()
    ),
    byDocument: index('document_access_log_org_document_idx').on(
      table.organizationId,
      table.documentId,
      table.occurredAt.desc(),
      table.id.desc()
    ),
    purge: index('document_access_log_occurred_idx').on(table.occurredAt),
  })
)

export type DocumentAccessLogRow = typeof documentAccessLog.$inferSelect
export type NewDocumentAccessLogRow = typeof documentAccessLog.$inferInsert
