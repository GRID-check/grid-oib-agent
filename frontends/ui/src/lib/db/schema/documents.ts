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
import { type ResourceVisibility } from './resource-shares'

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

/**
 * Whose hand wrote the bytes (migration 0063). The members that exist TODAY:
 *
 *   - `user`  — somebody uploaded a file. Every row that predates the column.
 *   - `agent` — a commissioned run produced it, and `authoredByProducer` /
 *               `authoredByRunId` say what and which.
 *
 * A tuple for the same reason `DOCUMENT_SCOPES` is one: the set is enumerable
 * at runtime (the listing filter validates against it) and the type is derived
 * rather than restated, so a new author reaches every exhaustive switch as a
 * compile error instead of as a string nobody handles.
 *
 * It is deliberately shaped to GROW, which is a different claim from "it will".
 * `system` (a scheduled sync) and `import` (a partner feed, a backfill) are the
 * shapes the design anticipated; NOTHING writes them and they are not members —
 * read them as the reason `agent` is one value in a tuple rather than a boolean,
 * not as a promise. What the shape buys is that the next producer is an entry
 * here, because the column carries no CHECK on its value and
 * `documents_authorship_requires_provenance` is written against `<> 'user'`
 * rather than against `agent`. The alternative — a two-value flag — makes the
 * second producer a migration plus an argument about what `agent` used to mean,
 * held after production rows already exist.
 *
 * This is PROVENANCE, and provenance is never responsibility. `createdBy` stays
 * the commissioning human — the export needs somebody to print and the audit
 * needs somebody to hold — and who is on the hook stays in
 * `resource_assignments`, where `Zuweisen` puts it. ADR-0047's rule is that the
 * three are different questions; this column is the one that makes keeping them
 * apart load-bearing rather than tidy, because it is the first time the answer
 * to "who wrote this" is not a person at all.
 */
import { DOCUMENT_AUTHORS, type DocumentAuthor } from '@/lib/documents/document-authors'

// Re-exported so `@/lib/db/schema` stays the one import site every existing
// caller already uses; the declaration itself lives outside the schema so a
// route can validate against it without importing the database.
export { DOCUMENT_AUTHORS, type DocumentAuthor }

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
   * Who wrote the bytes — see `DOCUMENT_AUTHORS` above (migration 0063).
   *
   * Sits next to `createdBy` on purpose: for an agent-authored report the two
   * disagree, and that disagreement is the point. The user commissioned the run
   * and caused the bytes to exist; Piloti wrote them. Collapsing the pair in
   * either direction loses a question somebody will be asked in front of a
   * Behörde.
   *
   * Defaults to `user`, which is what every row written before this column
   * means — there was no other way for a document to exist — so there is no
   * backfill, the same reasoning `storageBucket` carries.
   *
   * NOTE: the database also has `documents_agent_authored_idx`, PARTIAL
   * (`WHERE authored_by = 'agent'`) on `(project_id, created_at DESC)`, so it
   * carries no entry for the human uploads that are the overwhelming majority
   * while making "everything Piloti wrote in this project" a point query.
   * Drizzle's index builder cannot express a partial index, so it lives only in
   * migration 0063 — the same arrangement as `documents_conversation_idx`.
   *
   * Its predicate is the one place here that does NOT widen with the tuple: it
   * names `'agent'`, so a second producer needs the predicate widened to
   * `<> 'user'` or an index of its own. Deliberate — there is one producer
   * today, and `<> 'user'` would index rows nothing asks for.
   */
  authoredBy: text('authored_by').$type<DocumentAuthor>().notNull().default('user'),
  /**
   * WHAT wrote a document no person wrote, as a producer identifier —
   * `deep_research`, never `Tiefenrecherche` (migration 0063). NULL for
   * everything a person uploaded.
   *
   * A separate column from `authoredByRunId` because a run id answers "which
   * run" and only accidentally answers "what produced this" — it does so for
   * exactly as long as there is one producer. The second one (a compliance
   * export, an IFC take-off, a partner integration writing evidence) turns
   * "what made this file" into a join through job history that may have been
   * pruned by the time anyone asks. A nullable text column now costs nothing;
   * recovering the producer from run ids afterwards is archaeology.
   *
   * An identifier and not a label because this value has to survive a
   * translation, a rename and an export, and because the moment it renders
   * directly somebody will change it to fix a wording and silently repartition
   * every query that groups by it. Deliberately NOT a foreign key to a producer
   * registry: there is no registry, and inventing one to hold two strings is the
   * speculative version of this column.
   */
  authoredByProducer: text('authored_by_producer'),
  /**
   * The backend async job id of the run that wrote a document no person wrote;
   * NULL for everything a person uploaded (migration 0063).
   *
   * `text`, not `uuid`, because it is the backend's job id and is only ever
   * carried, never generated here — the same reason `conversations.id` is text.
   *
   * Required together with `authoredByProducer` whenever `authoredBy` is not
   * `user`, as a CHECK below rather than as a convention, because the reason to
   * record that a machine wrote a document is so somebody can later ask what
   * wrote it, in which run, on whose budget, from which question. A row that
   * says "not a person" and can answer neither is an audit trail in appearance
   * only, and appearing to have one is worse than having none.
   *
   * NOTE: the database also has `uniq_documents_authored_run_producer_per_project`,
   * UNIQUE and PARTIAL — `(organization_id, project_id, authored_by_run_id,
   * authored_by_producer)` WHERE `authored_by <> 'user'` (migration 0065,
   * widening 0064's by the producer because a run can owe more than one FILE: a
   * diagram is a previewable SVG and an attachable PDF and needs both). It is
   * what makes "one filed document per run and producer" true under concurrency
   * rather than only under a lookup: the
   * filing path's probe runs before the insert, so two report tabs both miss it
   * and both file, producing two rows that are identical in every visible
   * attribute because the generated filename is deterministic. Partial on
   * `<> 'user'` because the CHECK below deliberately lets a HUMAN row carry a
   * run id too, and two people saving one run's artefact must not collide.
   * Drizzle's index builder can express neither the predicate nor a unique
   * partial index, so it lives only in migration 0065 — the same arrangement as
   * `documents_conversation_idx` and `documents_agent_authored_idx`.
   *
   * Its columns are `findDocumentAuthoredByRun`'s WHERE clause, deliberately and
   * exactly — all four of them. An index narrower than the probe rejects rows the probe would
   * accept; a wider one admits duplicates the probe was meant to prevent.
   */
  authoredByRunId: text('authored_by_run_id'),
  /**
   * Blanket visibility (ADR-0032). Default `project` — a file is evidence the
   * whole project can see. `private` is available once the type is registered;
   * the first Files vertical does not offer the chip on project-visible rows.
   * Provenance (`createdBy`) is never this column. Assignment is never this
   * column (ADR-0047).
   */
  visibility: text('visibility').$type<ResourceVisibility>().notNull().default('project'),
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
  /**
   * Where ingestion got to: `pending → processing → processed | error`, plus
   * `stored`, which is none of those (migration 0063).
   *
   * `stored` means "the bytes are here and indexing was deliberately skipped" —
   * an agent-authored document, which is never dispatched to `/v1/ingest`
   * because a report the agent wrote, embedded into the project corpus, comes
   * back as retrievable evidence FOR the agent under a *Projektwissen* badge.
   * The four existing states all describe a job that is running or has finished;
   * there was no state for a job that was never started, and leaving such a row
   * at `pending` renders a spinner that never resolves, because nothing will
   * ever report on a job nobody dispatched.
   *
   * It is TERMINAL, and the load-bearing consequence lives in
   * `@/lib/documents/reconcile-status`: `stored` must stay out of
   * `IN_FLIGHT_STATUSES`, or every read of the row polls a backend that has
   * never heard of it and then overwrites the status from a collection file
   * list that will never contain it.
   *
   * Plain `text` with no CHECK, so a new state is a TypeScript change rather
   * than a migration — the same arrangement `scope` has, and the reason 0063
   * adds no DDL for this value.
   */
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
  /**
   * A document no person wrote can always say what wrote it and in which run
   * (migration 0063). See `authoredByRunId` for why half of that answer is worse
   * than none.
   *
   * Written against `<> 'user'` rather than against `'agent'`, which is the
   * whole point: the invariant is true of every producer, not of this one, so a
   * member added to `DOCUMENT_AUTHORS` arrives already constrained instead of
   * arriving as a hole in the audit trail that nothing notices. Naming `agent`
   * here would mean the check silently exempts the next producer — the exact
   * failure this shape exists to foreclose.
   *
   * One-directional on purpose. A `user` row carrying a producer and a run id is
   * legal — a person saving an artefact a run showed them is not a contradiction
   * — and a biconditional would reject it while buying nothing, since the
   * question this constraint protects is only ever asked of the rows no person
   * wrote.
   */
  authorshipRequiresProvenance: check(
    'documents_authorship_requires_provenance',
    sql`${table.authoredBy} = 'user' OR (${table.authoredByProducer} IS NOT NULL AND ${table.authoredByRunId} IS NOT NULL)`
  ),
}))

export type Document = typeof documents.$inferSelect
export type NewDocument = typeof documents.$inferInsert
