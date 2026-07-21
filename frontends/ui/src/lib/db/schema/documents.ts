import { pgTable, uuid, text, timestamp, jsonb, integer, index } from 'drizzle-orm/pg-core'
import { projects } from './projects'
import { projectFolders } from './project-folders'

/**
 * The scope a document belongs to. `project` documents hang off a single
 * project (the default, and every legacy row). `archiv` documents are the
 * org-wide "Archiv": they have a NULL `projectId` and live in the per-org
 * `archiv_<orgId>` collection, shared across every project in the org.
 */
export type DocumentScope = 'project' | 'archiv'

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  // NULL for org-wide `archiv` documents, which belong to the organization
  // rather than any single project.
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  scope: text('scope').$type<DocumentScope>().notNull().default('project'),
  createdBy: text('created_by').notNull(),
  filename: text('filename').notNull(),
  storageKey: text('storage_key').notNull(),
  collectionName: text('collection_name').notNull(),
  fileSize: integer('file_size'),
  contentType: text('content_type'),
  status: text('status').notNull().default('pending'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  errorMessage: text('error_message'),
  metadata: jsonb('metadata'),
  folderId: uuid('folder_id').references(() => projectFolders.id, { onDelete: 'cascade' }),
}, (table) => ({
  projectIdx: index('documents_project_idx').on(table.projectId),
  collectionIdx: index('documents_collection_idx').on(table.collectionName),
  statusIdx: index('documents_status_idx').on(table.status),
  orgScopeIdx: index('documents_org_scope_idx').on(table.organizationId, table.scope),
}))

export type Document = typeof documents.$inferSelect
export type NewDocument = typeof documents.$inferInsert
