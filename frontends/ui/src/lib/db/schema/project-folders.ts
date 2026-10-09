import { boolean, check, foreignKey, index, pgTable, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'
import { projects } from './projects'
import { documents } from './documents'

/**
 * The shelves a folder can live on — the folder-carrying subset of
 * `DOCUMENT_SCOPES` (`session` documents are never filed).
 */
export const FOLDER_SCOPES = ['project', 'archiv'] as const
export type FolderScope = (typeof FOLDER_SCOPES)[number]

/**
 * Folders of a SHELF: a project's Dateien or the org-wide Archiv (migration
 * 0102, ADR-0078).
 *
 * THE NAME IS A DELIBERATE DEFERRAL. `project_folders` is a misnomer for the
 * Archiv half of its rows; renaming the table touches the Python mirror and ten
 * earlier migrations and turns a column change into a table swap, so it waits
 * for something that forces a table swap anyway. Read the table as
 * "shelf folders".
 */
export const projectFolders = pgTable('project_folders', {
  id: uuid('id').primaryKey().defaultRandom(),
  /**
   * The owning project, or NULL for an Archiv folder (`scope = 'archiv'`). The
   * CHECK below ties the two: `(scope = 'project') = (project_id IS NOT NULL)`.
   */
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  /**
   * The tenant, stated on the row (migration 0102). Before the Archiv had
   * folders "same project" implied "same organization"; an Archiv folder has no
   * project, so the tenant is a column, pinned by the row-level-security policy
   * and by the composite keys below.
   */
  organizationId: text('organization_id').notNull(),
  /** Which shelf — `documents.scope`'s vocabulary, minus `session`. */
  scope: text('scope').$type<FolderScope>().notNull().default('project'),
  parentId: uuid('parent_id'),
  /**
   * NOTE: the database also has `uniq_project_folders_parent_name`, UNIQUE on
   * `(organization_id, COALESCE(project_id, '000…0'::uuid),
   * COALESCE(parent_id, '000…0'::uuid), name) WHERE deleted_at IS NULL` — one
   * living folder per name per parent on a shelf (migrations 0063, 0102; partial
   * since 0110, so a tombstone does not hold its name). It is not declared here because
   * it is an EXPRESSION index and drizzle's index builder cannot express one,
   * the same arrangement `documents_conversation_idx` has for being partial.
   *
   * The COALESCEs are the whole reason it works. `parent_id` is NULL for a root
   * folder and `project_id` is NULL for every Archiv folder, and NULL is never
   * equal to NULL in a unique index, so a plain index would police every nested
   * project folder and leave root folders — where a fixed, created-on-first-use
   * destination like `Berichte` lands — and the whole Archiv uncontrolled. The
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
  /**
   * Whether the folder inherits its parent's access (`inherit`, the default; a
   * root folder inherits the project) or has its own access list (`custom`),
   * migration 0111, ADR-0088. Who is on a custom list is WorkOS's: the folder
   * is a `folder` resource and the people hold a folder role on it (ADR-0096,
   * migration 0128). `lib/authz/folder-access.ts` is the one place that
   * decides what it means.
   */
  accessMode: text('access_mode', { enum: ['inherit', 'custom'] }).notNull().default('inherit'),
  /**
   * On a custom folder: every project member reads it, and the list decides
   * only who may write (what the `*` entry was). Ignored while `inherit`.
   * Migration 0128, ADR-0096.
   */
  everyoneReads: boolean('everyone_reads').notNull().default(false),
  /** Who last set the folder's own access list, and when; required while it is `custom`. */
  accessChangedBy: text('access_changed_by'),
  accessChangedAt: timestamp('access_changed_at', { withTimezone: true }),
  /**
   * Set when the folder was deleted (migration 0111): the row stays so its
   * access still decides who may read what was derived from it. Every listing,
   * path lookup and placement skips it, and a document filed in it is hidden
   * from everyone; only `effectiveFolderLevel` reads it. With `purgedAt` unset
   * it is in the Papierkorb (migration 0115), restorable until its queue row is
   * purged. A project folder only: an Archiv folder's delete removes the row,
   * and `project_folders_bin_state_check` refuses a deleted Archiv folder.
   */
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  deletedBy: text('deleted_by'),
  /**
   * The folder a person deleted, on every folder that went to the Papierkorb
   * with it (itself included); what a restore puts back together. NULL for a
   * living folder and for a tombstone older than 0114.
   */
  binRootId: uuid('bin_root_id'),
  /**
   * When the purge removed what the folder held: from then on a permanent
   * tombstone, row and grants kept (ADR-0088). What was derived from it is then
   * shown as the organization's „Inhalte aus gelöschten Ordnern" setting says.
   */
  purgedAt: timestamp('purged_at', { withTimezone: true }),
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
   * The key a document's folder and a folder's parent reference so they are
   * held on their own shelf AND tenant (migration 0102). Redundant with the
   * primary key for the same reason `idProjectKey` is, and needed for the same
   * one: a composite foreign key can only reference a unique column set.
   */
  idOrganizationScopeKey: unique('project_folders_id_organization_id_scope_key').on(
    table.id,
    table.organizationId,
    table.scope,
  ),
  scopeCheck: check('project_folders_scope_check', sql`${table.scope} IN ('project', 'archiv')`),
  /** The three columns tell one story: a project folder has a project, an Archiv folder none. */
  scopeOwnerCheck: check(
    'project_folders_scope_owner_check',
    sql`(${table.scope} = 'project') = (${table.projectId} IS NOT NULL)`,
  ),
  /**
   * A folder's parent is on its own shelf and in its own tenant (migration
   * 0102) — the Archiv's counterpart of `parentProjectFk`, which cannot see an
   * Archiv folder (NULL project, MATCH SIMPLE). MATCH SIMPLE is correct here
   * too: a root folder has no parent to validate.
   */
  parentShelfFk: foreignKey({
    name: 'project_folders_parent_id_organization_id_scope_fkey',
    columns: [table.parentId, table.organizationId, table.scope],
    foreignColumns: [table.id, table.organizationId, table.scope],
  }),
  /**
   * A folder's parent must live in the same project. This replaced a
   * row-level-security policy that referenced `project_folders` from its own
   * predicate: Postgres answers that with "infinite recursion detected in
   * policy", and because `documents`' policy joined this table, both became
   * completely unreadable for the runtime role. The rule belongs in the schema,
   * where it is cheaper, non-recursive, and checked on every write.
   *
   * MATCH SIMPLE is correct here: it skips a root folder (no parent to
   * validate) and an Archiv folder (NULL project, covered by `parentShelfFk`).
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
