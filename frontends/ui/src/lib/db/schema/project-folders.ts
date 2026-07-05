import { pgTable, text, timestamp, uuid, varchar, index } from 'drizzle-orm/pg-core'
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
}))

export const projectFoldersRelations = relations(projectFolders, ({ one, many }) => ({
  project: one(projects, { fields: [projectFolders.projectId], references: [projects.id] }),
  parent: one(projectFolders, { fields: [projectFolders.parentId], references: [projectFolders.id] }),
  children: many(projectFolders),
  documents: many(documents),
}))

export type ProjectFolder = typeof projectFolders.$inferSelect
export type NewProjectFolder = typeof projectFolders.$inferInsert
