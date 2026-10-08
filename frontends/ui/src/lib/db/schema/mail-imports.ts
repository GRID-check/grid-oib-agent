import { sql } from 'drizzle-orm'
import { bigint, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects'

export const MAIL_IMPORT_STATUSES = ['uploading', 'queued', 'importing', 'completed', 'failed', 'cancelled'] as const
export type MailImportStatus = (typeof MAIL_IMPORT_STATUSES)[number]

/** Why a mail or one of its files was not filed. */
export type MailImportSkipReason =
  | 'not_mail'
  | 'inline'
  | 'embedded_message'
  | 'type'
  | 'size'
  | 'quota'
  | 'unreadable'

/** Why an import ended without filing everything (migration 0108 holds the list). */
export type MailImportErrorCode =
  | 'unreadable'
  | 'quota'
  | 'access'
  | 'requester_left'
  | 'stopped'
  | 'stalled'
  | 'upload_expired'

export interface MailImportSkippedSample {
  /** The mail's folder name (`<date time> – <sender>`), or the item's class for a non-mail. */
  mail: string
  /** The file, when one file of a mail was skipped. */
  file: string | null
  reason: MailImportSkipReason
}

/**
 * An Outlook archive a member is filing into a project (ADR-0085). Migration
 * 0108 holds the bounds and says why each column exists.
 */
export const mailImports = pgTable(
  'mail_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    userEmail: text('user_email'),
    filename: text('filename').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    status: text('status').$type<MailImportStatus>().notNull().default('uploading'),
    stagingBucket: text('staging_bucket').notNull(),
    stagingKey: text('staging_key').notNull(),
    uploadId: text('upload_id'),
    stagingDeletedAt: timestamp('staging_deleted_at', { withTimezone: true }),
    rootFolderId: uuid('root_folder_id'),
    totalItems: integer('total_items'),
    nextPosition: integer('next_position').notNull().default(0),
    inflightPosition: integer('inflight_position'),
    inflightFolderId: uuid('inflight_folder_id'),
    mailsFiled: integer('mails_filed').notNull().default(0),
    filesFiled: integer('files_filed').notNull().default(0),
    itemsSkipped: integer('items_skipped').notNull().default(0),
    filesSkipped: integer('files_skipped').notNull().default(0),
    skippedSamples: jsonb('skipped_samples').$type<MailImportSkippedSample[]>().notNull().default([]),
    errorCode: text('error_code').$type<MailImportErrorCode>(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('mail_imports_org_project_created_idx').on(table.organizationId, table.projectId, table.createdAt),
    index('mail_imports_open_updated_idx')
      .on(table.updatedAt)
      .where(sql`${table.status} IN ('uploading', 'queued', 'importing')`),
  ],
)

export type MailImport = typeof mailImports.$inferSelect
export type NewMailImport = typeof mailImports.$inferInsert
