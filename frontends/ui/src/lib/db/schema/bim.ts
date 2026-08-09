import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  bigserial,
  index,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { projects } from './projects'
import { documents } from './documents'
import type { BimClassification, BimModelStatus, BimModelSummary, BimPropertySets, BimQuantitySets } from '@/lib/bim/types'

/**
 * One parsed IFC model. Exactly one per `documents` row — a model is not a
 * separate upload, it is what an uploaded `.ifc` document turned out to be, and
 * keeping the two joined by a unique document id means deleting the document
 * deletes the model without a second cleanup path to forget.
 *
 * The row carries the SUMMARY (spatial tree, storeys, type counts, totals). The
 * per-element records live in `bim_elements`, and the untruncated index —
 * everything, including elements the row cap dropped — is written to object
 * storage under `indexStorageKey`.
 */
export const bimModels = pgTable(
  'bim_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    /** NULL for org-wide Archiv models, mirroring `documents.project_id`. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    status: text('status').$type<BimModelStatus>().notNull().default('pending'),
    /** IFC schema the file declares: `IFC4`, `IFC2X3`, `IFC4X3`. */
    schemaVersion: text('schema_version'),
    /** Object-storage key of the full JSON index. NULL until extraction ends. */
    indexStorageKey: text('index_storage_key'),
    /** Bucket for {@link indexStorageKey}; NULL means the shared bucket (ADR-0043). */
    indexStorageBucket: text('index_storage_bucket'),
    /**
     * {@link BimModelSummary} — everything except the element list. Read on
     * every model page load, so it lives here rather than behind an object-store
     * round trip.
     */
    summary: jsonb('summary').$type<BimModelSummary>(),
    /** Number of `bim_elements` rows written (post-cap). */
    elementCount: integer('element_count').notNull().default(0),
    errorMessage: text('error_message'),
    extractedAt: timestamp('extracted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentIdx: uniqueIndex('bim_models_document_idx').on(table.documentId),
    projectIdx: index('bim_models_project_idx').on(table.projectId),
    orgStatusIdx: index('bim_models_org_status_idx').on(table.organizationId, table.status),
  })
)

/**
 * One element of one model — a wall, a door, a room.
 *
 * This is the table the agent's `ifc_query` tool reads, so it is shaped for
 * aggregation rather than for round-tripping IFC: the identifying attributes
 * are columns (indexable, groupable) and the open-ended parts — property sets,
 * quantities, materials, classifications — are `jsonb` with a GIN index, since
 * their keys are chosen by whichever tool exported the model and cannot be
 * columns.
 *
 * No `organization_id`: the parent model's column is the truth, and the RLS
 * policy joins it. Denormalising a copy would create a second source of the
 * tenant that can silently disagree with the first.
 */
export const bimElements = pgTable(
  'bim_elements',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    modelId: uuid('model_id')
      .notNull()
      .references(() => bimModels.id, { onDelete: 'cascade' }),
    /** IFC GlobalId — stable across exports, and what the viewer highlights by. */
    globalId: text('global_id').notNull(),
    /** STEP express id: unique within the file, meaningless outside it. */
    expressId: integer('express_id').notNull(),
    /** Canonical PascalCase entity name, e.g. `IfcWall`. */
    ifcType: text('ifc_type').notNull(),
    name: text('name'),
    predefinedType: text('predefined_type'),
    objectType: text('object_type'),
    tag: text('tag'),
    typeName: text('type_name'),
    storeyGlobalId: text('storey_global_id'),
    storeyName: text('storey_name'),
    containerKind: text('container_kind'),
    containerName: text('container_name'),
    materials: jsonb('materials').$type<string[]>().notNull().default([]),
    classifications: jsonb('classifications').$type<BimClassification[]>().notNull().default([]),
    properties: jsonb('properties').$type<BimPropertySets>().notNull().default({}),
    quantities: jsonb('quantities').$type<BimQuantitySets>().notNull().default({}),
  },
  (table) => ({
    modelExpressIdx: uniqueIndex('bim_elements_model_express_idx').on(table.modelId, table.expressId),
    modelTypeIdx: index('bim_elements_model_type_idx').on(table.modelId, table.ifcType),
    modelStoreyIdx: index('bim_elements_model_storey_idx').on(table.modelId, table.storeyName),
    globalIdIdx: index('bim_elements_global_id_idx').on(table.modelId, table.globalId),
  })
)

export type BimModelRow = typeof bimModels.$inferSelect
export type NewBimModelRow = typeof bimModels.$inferInsert
export type BimElementRow = typeof bimElements.$inferSelect
export type NewBimElementRow = typeof bimElements.$inferInsert

/**
 * A human verdict on a rule the catalogue could not settle.
 *
 * Recorded against a model REVISION so a later revision makes it visibly
 * stale — see `0035_bim_check_confirmations.sql` for why that matters more
 * than it looks.
 */
export const bimCheckConfirmations = pgTable(
  'bim_check_confirmations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    /** Rule id from `lib/bim/rules.ts`; deliberately not a foreign key. */
    ruleId: text('rule_id').notNull(),
    /** The revision the person actually looked at. */
    modelId: uuid('model_id').notNull(),
    confirmedBy: text('confirmed_by').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('bim_check_confirmations_unique').on(table.organizationId, table.projectId, table.ruleId),
    index('bim_check_confirmations_project_idx').on(table.organizationId, table.projectId),
  ]
)
