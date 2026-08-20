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
  /**
   * NOTE: the database also has `uniq_project_folders_parent_name`, UNIQUE on
   * `(project_id, COALESCE(parent_id, '000…0'::uuid), name)` — one folder per
   * name per parent (migration 0063). It is not declared here because it is an
   * EXPRESSION index and drizzle's index builder cannot express one, the same
   * arrangement `documents_conversation_idx` has for being partial.
   *
   * The COALESCE is the whole reason it works. `parent_id` is NULL for a root
   * folder and NULL is never equal to NULL in a unique index, so a plain
   * `(project_id, parent_id, name)` index would police every nested folder and
   * leave root folders — one per project, which is exactly where a fixed,
   * created-on-first-use destination like `Berichte` lands — uncontrolled. The
   * sentinel is the nil UUID, which `gen_random_uuid()` (v4) never produces.
   *
   * It exists because get-or-create is not a transaction: before 0063 the only
   * uniqueness on this table was `(id, project_id)`, which is here to satisfy
   * the composite foreign keys and constrains nothing a human can see. Two runs
   * finishing at once both found no `Berichte`, both created one, and the
   * project was left with two folders of the same name and no way to say which
   * one is real. Case- and whitespace-sensitive on purpose: it is here to stop
   * a race between two identical writes, not to decide whether `Berichte` and
   * `berichte` may be siblings — that is a product question, and answering it
   * in a unique index would reject folder names people already have.
   */
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
