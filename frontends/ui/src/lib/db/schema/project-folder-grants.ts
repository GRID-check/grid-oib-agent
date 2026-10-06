import { check, foreignKey, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { projectFolders } from './project-folders'
import { projects } from './projects'

/** What a grant lets a role do in a folder (ADR-0081). */
export const FOLDER_GRANT_LEVELS = ['read', 'write'] as const
export type FolderGrantLevel = (typeof FOLDER_GRANT_LEVELS)[number]

/**
 * `project_folder_grants` — one role's access to a folder that has its own
 * access list (`project_folders.access_mode = 'custom'`, migration 0110,
 * ADR-0081). `read`: see, open, download, search and use in answers. `write`:
 * read plus everything that changes the folder or what is in it. A role not
 * listed gets nothing; `*` is every member of the project.
 *
 * `lib/authz/folder-access.ts` is the one place that reads these: the level on
 * a folder is the minimum over it and every ancestor with its own list, and the
 * project permission caps write. A deferred constraint trigger keeps a custom
 * list between 1 and 20 entries.
 */
export const projectFolderGrants = pgTable(
  'project_folder_grants',
  {
    organizationId: text('organization_id').notNull(),
    projectId: uuid('project_id').notNull(),
    folderId: uuid('folder_id').notNull(),
    roleSlug: text('role_slug').notNull(),
    level: text('level', { enum: FOLDER_GRANT_LEVELS }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ name: 'project_folder_grants_pk', columns: [table.folderId, table.roleSlug] }),
    levelCheck: check('project_folder_grants_level_check', sql`${table.level} IN ('read', 'write')`),
    projectIdx: index('project_folder_grants_project_idx').on(table.projectId),
    folderFk: foreignKey({
      name: 'project_folder_grants_folder_fkey',
      columns: [table.folderId, table.projectId],
      foreignColumns: [projectFolders.id, projectFolders.projectId],
    }).onDelete('cascade'),
    projectFk: foreignKey({
      name: 'project_folder_grants_project_fkey',
      columns: [table.projectId, table.organizationId],
      foreignColumns: [projects.id, projects.organizationId],
    }).onDelete('cascade'),
  })
)

export type ProjectFolderGrant = typeof projectFolderGrants.$inferSelect
export type NewProjectFolderGrant = typeof projectFolderGrants.$inferInsert
