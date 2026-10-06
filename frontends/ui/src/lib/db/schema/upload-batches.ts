import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects'

/**
 * One upload gesture — a picked set of files or a dropped folder — and when
 * every document it brought in had been read (migration 0104).
 *
 * The browser opens the row before it sends the first file, stamps each upload
 * with its id (`documents.upload_batch_id`), and seals it when it has sent the
 * last one. Reconciliation completes it once every document carrying the id is
 * at rest, which is what emits `upload.completed` to the uploader.
 *
 * `excluded` holds the screening terms that kept files on the uploader's
 * machine and how many files each kept (ADR-0079) — never their names, which
 * did not reach the server as files and may themselves be personal data.
 */

export const UPLOAD_BATCH_SCOPES = ['project', 'archiv', 'session'] as const
export type UploadBatchScope = (typeof UPLOAD_BATCH_SCOPES)[number]

/** One term of the office's screening and how many files it kept back. */
export interface UploadBatchExclusion {
  term: string
  count: number
}

export const uploadBatches = pgTable(
  'upload_batches',
  {
    /** Minted by the browser, so the first upload can carry it without a round trip. */
    id: uuid('id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    createdBy: text('created_by').notNull(),
    scope: text('scope').$type<UploadBatchScope>().notNull(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id'),
    /** Files the browser meant to send, after its own screening. */
    expectedCount: integer('expected_count').notNull(),
    excluded: jsonb('excluded').$type<UploadBatchExclusion[]>().notNull().default([]),
    /** Files the server answered „unchanged" for: nothing was written, so no row carries the id. */
    unchangedCount: integer('unchanged_count').notNull().default(0),
    /** Files whose transfer failed in the browser, so no row carries the id either. */
    failedCount: integer('failed_count').notNull().default(0),
    sealedAt: timestamp('sealed_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (table) => ({
    projectCreatedIdx: index('upload_batches_project_created_idx').on(
      table.organizationId,
      table.projectId,
      table.createdAt
    ),
  })
)

export type UploadBatch = typeof uploadBatches.$inferSelect
export type NewUploadBatch = typeof uploadBatches.$inferInsert
