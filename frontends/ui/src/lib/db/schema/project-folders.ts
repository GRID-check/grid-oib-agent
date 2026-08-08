import { foreignKey, index, pgTable, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { projects } from './projects'
import { documents } from './documents'

export const projectFolders = pgTable('project_folders', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id'),
  name: varchar('name', { length: 255 }).notNull(),
  path: varchar('path', { length: 1024 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  projectIdx: index('idx_project_folders_project_id').on(table.projectId),
  parentIdx: index('idx_project_folders_parent_id').on(table.parentId),
  /**
   * Redundant on its own — `id` is already the primary key — and required all
   * the same: a composite foreign key can only reference a uniquely-constrained
   * column set, and both the self-reference below and `documents.folder_id`
   * reference exactly this pair (migration 0030).
   */
  idProjectKey: unique('project_folders_id_project_id_key').on(table.id, table.projectId),
  /**
   * A folder's parent must live in the same project. This replaced a
   * row-level-security policy that referenced `project_folders` from its own
   * predicate: Postgres answers that with "infinite recursion detected in
   * policy", and because `documents`' policy joined this table, both became
   * completely unreadable for the runtime role. The rule belongs in the schema,
   * where it is cheaper, non-recursive, and checked on every write.
   *
   * MATCH SIMPLE is correct here: `projectId` is NOT NULL, so the only
   * partially-null key is `(NULL parent, project)` — a root folder, which has
   * no parent to validate.
   */
  parentProjectFk: foreignKey({
    name: 'project_folders_parent_id_project_id_fkey',
    columns: [table.parentId, table.projectId],
    foreignColumns: [table.id, table.projectId],
  }),
}))

export const projectFoldersRelations = relations(projectFolders, ({ one, many }) => ({
  project: one(projects, { fields: [projectFolders.projectId], references: [projects.id] }),
  parent: one(projectFolders, { fields: [projectFolders.parentId], references: [projectFolders.id] }),
  children: many(projectFolders),
  documents: many(documents),
}))

export type ProjectFolder = typeof projectFolders.$inferSelect
export type NewProjectFolder = typeof projectFolders.$inferInsert
