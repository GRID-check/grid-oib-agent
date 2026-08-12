import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  check,
  foreignKey,
  index,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
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
  /**
   * The document's identity, not its label — see `displayName` below.
   *
   * This is the join key to the SeaweedFS object and, through
   * `(collectionName, filename)`, to every chunk the retrieval index holds for
   * this document. It is written once at upload and never updated.
   */
  filename: text('filename').notNull(),
  /**
   * What a reader sees, when somebody has renamed the document (migration 0048).
   *
   * NULL means "never renamed": the file's own name is shown, which is what
   * every row written before renaming existed means. Resolve it with
   * `documentDisplayName` (`@/lib/documents/display-name`) rather than reading
   * the column directly, so the fallback is decided in one place.
   */
  displayName: text('display_name'),
  storageKey: text('storage_key').notNull(),
  /**
   * The S3 bucket holding this document's bytes (ADR-0043, migration 0033).
   *
   * NULL means the deployment's shared bucket — which is what every row written
   * before per-organization buckets existed means, and the meaning is fixed:
   * `resolveDocumentBucket` in `@/lib/storage/bucket` is the one place that
   * turns it back into a name. Recorded rather than derived from
   * `organizationId` so that enabling per-org buckets is not a cutover; see the
   * migration for the full reasoning.
   */
  storageBucket: text('storage_bucket'),
  collectionName: text('collection_name').notNull(),
  fileSize: integer('file_size'),
  contentType: text('content_type'),
  status: text('status').notNull().default('pending'),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  errorMessage: text('error_message'),
  metadata: jsonb('metadata'),
  // No inline `.references()`: the real constraint is composite (below).
  folderId: uuid('folder_id'),
}, (table) => ({
  projectIdx: index('documents_project_idx').on(table.projectId),
  collectionIdx: index('documents_collection_idx').on(table.collectionName),
  statusIdx: index('documents_status_idx').on(table.status),
  orgScopeIdx: index('documents_org_scope_idx').on(table.organizationId, table.scope),
  /**
   * A document's folder must belong to the document's own project (migration
   * 0030). The project is pinned to the tenant by its row-level-security
   * policy, so same-project implies same-organization — which is what stops one
   * tenant filing a document into another tenant's folder, without a recursive
   * policy and without a subquery.
   */
  folderProjectFk: foreignKey({
    name: 'documents_folder_id_project_id_fkey',
    columns: [table.folderId, table.projectId],
    foreignColumns: [projectFolders.id, projectFolders.projectId],
  }).onDelete('cascade'),
  /**
   * What makes the composite key above actually check anything. `projectId` is
   * nullable (org-wide `archiv` documents have no project) and a composite
   * foreign key is MATCH SIMPLE, so it skips the check whenever any column of
   * the key is NULL — `(someone else's folder, NULL)` passed unexamined. This
   * leaves the only unchecked case as "no folder to validate".
   *
   * MATCH FULL would be the reflex fix and is wrong: it demands all-null or
   * all-non-null, which rejects an ordinary document sitting at the root of a
   * project.
   */
  folderRequiresProject: check(
    'documents_folder_requires_project',
    sql`${table.folderId} IS NULL OR ${table.projectId} IS NOT NULL`
  ),
}))

export type Document = typeof documents.$inferSelect
export type NewDocument = typeof documents.$inferInsert
