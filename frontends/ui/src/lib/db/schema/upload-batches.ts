import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects'

/**
 * One upload gesture — a picked set of files or a dropped folder — and when
 * every document it brought in had been read (migration 0110).
 *
 * The browser opens the row before it sends the first file, stamps each upload
 * with its id (`documents.upload_batch_id`), and seals it when it has sent the
 * last one. Reconciliation completes it once every document carrying the id is
 * at rest, which is what emits `upload.completed` to the uploader.
 *
 * `excluded` holds the screening terms that kept files on the uploader's
 * machine and how many files each kept (ADR-0086) — never their names, which
 * did not reach the server as files and may themselves be personal data.
 *
 * The five effect columns (migration 0185) say what settling the batch sets
 * off. A person's upload sets off all five; a server-side caller filing on a
 * person's decision (an E-Mail-Verlauf's next Fassung) opens it quieter. See
 * {@link UploadBatchEffects}.
 */

export const UPLOAD_BATCH_SCOPES = ['project', 'office_shelf', 'session'] as const
export type UploadBatchScope = (typeof UPLOAD_BATCH_SCOPES)[number]

/** One term of the office's screening and how many files it kept back. */
export interface UploadBatchExclusion {
  term: string
  count: number
}

/**
 * Who hears about a new Fassung a batch's document makes (`lib/documents/revision-notify.ts`):
 * `all` is the older document's assignees and uploaders and everyone working
 * on an open mark it leaves behind; `marks_only` is those mark participants alone.
 */
export const UPLOAD_BATCH_REVISION_NOTICES = ['all', 'marks_only'] as const
export type UploadBatchRevisionNotice = (typeof UPLOAD_BATCH_REVISION_NOTICES)[number]

/**
 * What settling a batch sets off (migration 0185). Each switch off suppresses
 * exactly its own effect and nothing else:
 *
 * - `announcesCompletion`: the uploader's `upload.completed` item (`./settle`);
 * - `reviewsFiling`: both filing reviews, the name review at the seal and the
 *   content review at the settle (`lib/filing/trigger.ts`), each a model call;
 * - `startsIntake`: the reading of a project whose intake is open
 *   (`lib/project-intake/trigger.ts`, ADR-0111);
 * - `revisionNotice`: who `document.new_revision` reaches;
 * - `runsDocumentCheck`: Piloti's check of each settled project document
 *   against the project's others, where the office switched it on
 *   (`lib/documents/revision-notify.ts`, ADR-0130), a model call each.
 */
export interface UploadBatchEffects {
  announcesCompletion: boolean
  reviewsFiling: boolean
  startsIntake: boolean
  revisionNotice: UploadBatchRevisionNotice
  runsDocumentCheck: boolean
}

/** Today's upload: everything on, everyone told. The columns' defaults. */
export const DEFAULT_UPLOAD_BATCH_EFFECTS: Readonly<UploadBatchEffects> = Object.freeze({
  announcesCompletion: true,
  reviewsFiling: true,
  startsIntake: true,
  revisionNotice: 'all',
  runsDocumentCheck: true,
})

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
    announcesCompletion: boolean('announces_completion').notNull().default(true),
    reviewsFiling: boolean('reviews_filing').notNull().default(true),
    startsIntake: boolean('starts_intake').notNull().default(true),
    revisionNotice: text('revision_notice').$type<UploadBatchRevisionNotice>().notNull().default('all'),
    runsDocumentCheck: boolean('runs_document_check').notNull().default(true),
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
