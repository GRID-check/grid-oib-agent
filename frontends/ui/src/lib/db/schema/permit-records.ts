import { sql } from 'drizzle-orm'
import { check, date, foreignKey, index, integer, pgTable, real, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'

import { documents } from './documents'
import { projects } from './projects'

/**
 * Permitting memory (migration 0117, ADR-0086, docs/design/permitting-memory.md):
 * what a Bescheid says, read once at ingest by a model with a strict schema and
 * kept as rows, so „Fragt die Behörde das wieder nach?" is answered from what
 * the office's own past procedures went through.
 *
 * Derived index data, like chunks and embeddings: a person never edits a row,
 * a re-extraction replaces it, and deleting the document deletes it. No
 * closed-project guard, because the archive import extracts from closed
 * projects.
 */

/** What kind of notice the document is. */
export const PERMIT_RECORD_KINDS = ['bewilligung', 'nachforderung', 'ablehnung', 'sonstiges'] as const
export type PermitRecordKind = (typeof PERMIT_RECORD_KINDS)[number]

/** What one item of a notice is: an Auflage of a granted permit, or what a Nachforderung demands. */
export const PERMIT_REQUIREMENT_KINDS = ['auflage', 'nachforderung', 'hinweis'] as const
export type PermitRequirementKind = (typeof PERMIT_REQUIREMENT_KINDS)[number]

/** At most this many source folders restrict one row: the 0117 CHECK, as 0111 for memory (ADR-0081). */
export const PERMIT_MAX_RESTRICTED_FOLDERS = 20

/** The longest requirement text a row holds: the 0117 CHECK. */
export const PERMIT_REQUIREMENT_MAX_CHARS = 1000

/** One row per source document; the unique `document_id` is what makes re-extraction a replacement. */
export const permitRecords = pgTable(
  'permit_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    documentId: uuid('document_id').notNull(),
    /** The document's collection; a restricted folder has its own. */
    collectionName: text('collection_name').notNull(),
    /** As indexed, for the citation. */
    fileName: text('file_name').notNull(),
    /**
     * The document's restricting folders, canonical (sorted, de-duplicated);
     * NULL when open. Served only to a reader who may read all of them now,
     * as restricted memory is (`memoryVisibleTo`).
     */
    restrictedFolderIds: uuid('restricted_folder_ids').array(),
    kind: text('kind').$type<PermitRecordKind>().notNull(),
    /** As the document names it („Magistratsabteilung 37", „Stadtgemeinde Mödling"); NULL when it does not name the issuer. */
    authority: text('authority'),
    /** The Gemeinde the procedure is in, as written. */
    municipality: text('municipality'),
    /** Intake token (`wien`, `niederoesterreich`, …) when the document makes it clear. */
    bundesland: text('bundesland'),
    /** The notice's date. */
    issuedOn: date('issued_on', { mode: 'string' }),
    /** Geschäftszahl / Aktenzahl. */
    reference: text('reference'),
    /** The model that extracted it. */
    model: text('model').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentKey: unique('permit_records_document_key').on(table.documentId),
    projectFk: foreignKey({
      name: 'permit_records_project_fkey',
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete('cascade'),
    documentFk: foreignKey({
      name: 'permit_records_document_fkey',
      columns: [table.documentId],
      foreignColumns: [documents.id],
    }).onDelete('cascade'),
    projectIdx: index('permit_records_project_idx').on(table.projectId),
    organizationIdx: index('permit_records_organization_idx').on(table.organizationId),
    kindCheck: check('permit_records_kind_check', sql`${table.kind} IN ('bewilligung', 'nachforderung', 'ablehnung', 'sonstiges')`),
    restrictedFoldersCheck: check(
      'permit_records_restricted_folders_check',
      sql`${table.restrictedFolderIds} IS NULL OR cardinality(${table.restrictedFolderIds}) BETWEEN 1 AND 20`
    ),
  })
)

/** The record's items, one row each. `projectId` and `restrictedFolderIds` are copied from it so the search needs no join. */
export const permitRequirements = pgTable(
  'permit_requirements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    recordId: uuid('record_id').notNull(),
    projectId: uuid('project_id').notNull(),
    restrictedFolderIds: uuid('restricted_folder_ids').array(),
    /** Order in the document. */
    position: integer('position').notNull(),
    kind: text('kind').$type<PermitRequirementKind>().notNull(),
    /** The requirement, close to the document's words. */
    content: text('content').notNull(),
    /** What is demanded as proof (a Gutachten, a Nachweis, a plan). */
    evidence: text('evidence'),
    /** As cited (§ 13 Abs. 3 AVG, § 70 BO Wien). */
    legalBasis: text('legal_basis'),
    /** Page in the document. */
    page: integer('page'),
    /** Vector of content + evidence, comparable only within the model named beside it; NULL ranks by the token channel alone. */
    embedding: real('embedding').array(),
    embeddingModel: text('embedding_model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    recordFk: foreignKey({
      name: 'permit_requirements_record_fkey',
      columns: [table.recordId],
      foreignColumns: [permitRecords.id],
    }).onDelete('cascade'),
    projectIdx: index('permit_requirements_project_idx').on(table.projectId),
    recordIdx: index('permit_requirements_record_idx').on(table.recordId),
    organizationIdx: index('permit_requirements_organization_idx').on(table.organizationId),
    kindCheck: check('permit_requirements_kind_check', sql`${table.kind} IN ('auflage', 'nachforderung', 'hinweis')`),
    contentLength: check('permit_requirements_content_length', sql`char_length(${table.content}) <= 1000`),
    restrictedFoldersCheck: check(
      'permit_requirements_restricted_folders_check',
      sql`${table.restrictedFolderIds} IS NULL OR cardinality(${table.restrictedFolderIds}) BETWEEN 1 AND 20`
    ),
  })
)

export type PermitRecordRow = typeof permitRecords.$inferSelect
export type NewPermitRecordRow = typeof permitRecords.$inferInsert
export type PermitRequirementRow = typeof permitRequirements.$inferSelect
export type NewPermitRequirementRow = typeof permitRequirements.$inferInsert
