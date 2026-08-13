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
import { conversations } from './conversations'

/**
 * The shelf a stored document lives on (ADR-0047, "DB scope").
 *
 *   - `project` — hangs off a single project. The default, and every legacy row.
 *   - `archiv`  — the org-wide "Archiv": NULL `projectId`, in the per-org
 *                 `archiv_<orgId>` collection, shared across every project.
 *   - `session` — a file the user dropped into one chat: NULL `projectId`, a
 *                 non-NULL `conversationId`, in that conversation's own
 *                 `s_<conversationId>` collection (ADR-0047 Phase 2).
 *
 * Declared as a tuple so the set is enumerable at runtime and the type is
 * derived from it rather than restated — a scope added here reaches every
 * exhaustive switch over `DocumentScope` as a compile error, which is decision
 * 3 of ADR-0047 applied to the DB shelf.
 *
 * The column carries no CHECK constraint, so adding a member needs no
 * migration for the VALUE itself. What `session` did need is the
 * `conversation_id` column below (migration 0049).
 */
export const DOCUMENT_SCOPES = ['project', 'archiv', 'session'] as const
export type DocumentScope = (typeof DOCUMENT_SCOPES)[number]

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: text('organization_id').notNull(),
  // NULL for org-wide `archiv` documents, which belong to the organization
  // rather than any single project.
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  scope: text('scope').$type<DocumentScope>().notNull().default('project'),
  /**
   * The conversation a `session` document was dropped into (migration 0049),
   * NULL for every other scope.
   *
   * A real column and a real foreign key rather than a read of
   * `collectionName`. The two happen to hold the same string today — a
   * conversation id already IS `s_<uuid>`, and the collection is named after it
   * — but that is a coincidence of naming, and reading a conversation id out of
   * a column that means "which retrieval collection" is exactly the inference
   * ADR-0047 exists to delete. It also buys three things a name cannot: a
   * session document cannot point at a conversation that does not exist, it
   * cannot point at another tenant's (the FK is composite, on
   * `(conversation_id, organization_id)`, the same pattern `messages` uses),
   * and discarding a chat cannot leave its attachments behind.
   *
   * `text`, not `uuid`: `conversations.id` is a client-minted `s_…` string.
   *
   * NOTE: the database also has `documents_conversation_idx`, PARTIAL
   * (`WHERE conversation_id IS NOT NULL`) so it carries no entry for the
   * project and Archiv rows that are the overwhelming majority. Drizzle's index
   * builder cannot express a partial index, so it lives only in migration 0049
   * — the same arrangement as `conversations_job_id_idx`.
   */
  conversationId: text('conversation_id'),
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
  /**
   * A session document belongs to a conversation in its OWN tenant (migration
   * 0049). Composite rather than a plain `references(conversations.id)` for the
   * same reason `messages` and `conversation_reads` are composite (0031/0032):
   * `documents.organization_id` is denormalised, so without the tenant column
   * inside the key nothing stops a row claiming this org while pointing at
   * another org's conversation. `conversations` carries the matching unique
   * constraint on `(id, organization_id)` precisely so keys like this can exist.
   *
   * MATCH SIMPLE skips the check when `conversation_id` is NULL, which is every
   * project and Archiv row — exactly the rows that have no conversation to
   * validate.
   *
   * CASCADE: discarding a chat takes its private attachments with it. The
   * service deletes them explicitly first (chunks, objects, then rows), so this
   * is the backstop for the paths that do not go through it — notably a project
   * purge, which deletes the project's conversations directly.
   */
  conversationFk: foreignKey({
    name: 'documents_conversation_id_organization_id_fkey',
    columns: [table.conversationId, table.organizationId],
    foreignColumns: [conversations.id, conversations.organizationId],
  }).onDelete('cascade'),
  /**
   * The scope partition, stated as a database invariant instead of a
   * convention. Two halves, both of which a session row must satisfy:
   *
   *   1. a session row has a conversation, and nothing else does;
   *   2. a session row has NO project.
   *
   * Before `session` existed, "which shelf is this row on" was answered in
   * three different ways across the codebase — `scope = 'archiv'`,
   * `project_id IS NULL`, and `project_id = $1` — and they agreed only because
   * there were two shelves and the second one happened to be the only one with
   * a null project. A third shelf with a null project is what breaks that, so
   * the tie between a scope and its owning column is written down here rather
   * than left for each query to reconstruct.
   *
   * The second half does not follow from the first: a row with `scope =
   * 'session'`, a conversation AND a project satisfies the biconditional while
   * being a contradiction — a file readable only inside one chat, filed inside
   * a project's estate. What makes it worth stating is the cascade. `projectId`
   * is `ON DELETE CASCADE`, so deleting that project would take the row with it
   * WITHOUT going through `deleteSessionDocument`, the only path that first
   * purges the document's Chroma chunks and its SeaweedFS objects. The row
   * would disappear and its bytes and chunks would remain, orphaned in two
   * stores no cascade can reach.
   *
   * Nothing violates this today: the only writer of session rows is
   * `uploadSessionDocument`, which passes `projectId: null` to both the insert
   * and the dispatch (`lib/session-documents/service.ts`), and uses the project
   * a chat belongs to only to create the conversation row. So the bug this
   * forecloses is LATENT — the invariant holds because one function is careful,
   * which is precisely the convention-versus-invariant gap migration 0049
   * exists to close. The next writer (a backfill, an import, a "promote this
   * attachment into the project" feature) is one column away from it, and the
   * failure mode is silent orphaning in the object store rather than an error
   * anyone sees.
   *
   * Kept as ONE constraint under the original name because it is one statement
   * — where a session document is filed — and splitting it would let half the
   * partition be dropped without the other half noticing.
   */
  sessionRequiresConversation: check(
    'documents_session_requires_conversation',
    sql`(${table.scope} = 'session') = (${table.conversationId} IS NOT NULL) AND (${table.scope} <> 'session' OR ${table.projectId} IS NULL)`
  ),
}))

export type Document = typeof documents.$inferSelect
export type NewDocument = typeof documents.$inferInsert
