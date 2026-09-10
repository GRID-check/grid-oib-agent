/**
 * `document_versions` — the editorial state of a document's bytes (ADR-0054).
 *
 * The item stays `documents`: its id is what citations, subjects, assignments,
 * shares and folders reference, and what the idempotency index on
 * `(organization, project, authored_by_ref, authored_by_producer)` is keyed on.
 * A version is one set of bytes for that item, plus the one fact the item could
 * never carry — **whether the office asserts it**.
 *
 * A row per version rather than a row per document, because every relation in
 * the product binds the item id and a second `documents` row per revision would
 * break all of them at once: the idempotency index forbids it, the folder tree
 * would show a revision as a sibling file, and each row is an object plus a
 * quota charge.
 *
 * ## One history for humans and for Piloti
 *
 * This is NOT an agent-only structure. Re-uploading a file under a name that
 * already exists has replaced the document in place since migration 0074 —
 * same id, so citations, subjects and folder assignments survive — and threw
 * the old bytes away. That was versioning without the history. A human upload
 * now writes version 1 `published`, born approved because the person who
 * uploaded it is the assertion; a re-upload writes version N+1 and leaves N
 * standing as `superseded` with its bytes intact; an agent filing writes a
 * `draft`. One pointer, one badge vocabulary, one version list.
 *
 * ## What the CHECKs are for
 *
 * They are the ratchet, not decoration. The state machine's authority is
 * Postgres — the CHECKs below plus the compare-and-swap `UPDATE … WHERE state =
 * $expected` in `@/lib/documents/lifecycle` — precisely because a state-machine
 * library cannot hold an invariant across two processes, a retry and a
 * half-applied deploy. The one that matters most is
 * `document_versions_published_is_approved`: only a version a PERSON approved
 * can ever be `published`, and only a published version is ever dispatched to
 * the index (slice 4). That makes "an agent-authored document the agent can
 * cite back to itself" a row the database refuses to store, rather than a
 * predicate in a retrieval path whose documented posture is fail-open.
 *
 * `(reviewed_by IS NULL) = (reviewed_at IS NULL)` is copied from
 * `tasks_review_complete` (migration 0075) for the reason that constraint gives:
 * a decision is by somebody, at some time, or it is not a decision.
 *
 * NOTE: the two partial unique indexes — one OPEN version per document, one
 * PUBLISHED version per document — live only in migration 0082 with their
 * `COMMENT ON INDEX`, because drizzle's index builder can express neither a
 * predicate over a value list nor the comment. Same arrangement as
 * `documents_conversation_idx`. `idx_document_versions_origin_conversation`
 * (migration 0084) is partial too and lives there for the same reason.
 */

import { relations, sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import {
  DOCUMENT_VERSION_STATES,
  type DocumentVersionState,
} from '@/lib/documents/lifecycle-types'
import { documents } from './documents'

// Re-exported so `@/lib/db/schema` stays the one import site, exactly as
// `documents.ts` re-exports `DOCUMENT_AUTHORS`. The declaration itself lives
// outside the schema so a route handler can validate against it without
// importing drizzle — `server-component-db-access.spec.ts` fails on that.
export { DOCUMENT_VERSION_STATES, type DocumentVersionState }

/** The states as a SQL list, so the CHECK and the tuple cannot drift. */
const STATE_LIST = sql.raw(DOCUMENT_VERSION_STATES.map((state) => `'${state}'`).join(', '))

export const documentVersions = pgTable(
  'document_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    /**
     * The item. NOT an inline `.references()`: the real constraint is composite
     * on `(document_id, project_id)`, the `documents_folder_id_project_id_fkey`
     * shape, so a version cannot be filed against another tenant's document.
     */
    documentId: uuid('document_id').notNull(),
    /**
     * The document's project, denormalised so the composite foreign key and the
     * row-level-security predicate can both use it. NULL for the two shelves
     * that have no project — the org-wide Archiv and a conversation's private
     * attachments — exactly as `documents.project_id` is NULL for them. The
     * composite key is MATCH SIMPLE, so it skips the check when this is NULL,
     * which is precisely the case with no project to validate.
     */
    projectId: uuid('project_id'),
    /** 1, 2, 3 … within one document. Human-facing; not an id. */
    versionNumber: integer('version_number').notNull(),
    state: text('state').$type<DocumentVersionState>().notNull().default('draft'),
    /** This version's own bytes. Two versions may share a key — see `forkDraft`. */
    storageKey: text('storage_key').notNull(),
    storageBucket: text('storage_bucket'),
    contentType: text('content_type'),
    fileSize: integer('file_size'),
    /** `sha256:<hex>` — the `If-Match` value a content replace must carry. */
    contentHash: text('content_hash'),
    submittedBy: text('submitted_by'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    publishedBy: text('published_by'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** The reviewer's words. Required by a CHECK for the two refusing states. */
    reviewComment: text('review_comment'),
    createdBy: text('created_by').notNull(),
    /**
     * The chat conversation this version was filed from (migration 0084).
     *
     * Written from the VERIFIED request-context envelope at the internal filing
     * route and never off a request body, so it is a fact this tier asserted
     * (ADR-0054 §4). NULL for a human upload, a scheduled run, and any version
     * forked from the Files pane.
     *
     * PROVENANCE, never authorization. It decides two things and nothing else:
     * what the next turn of that conversation is told when a reviewer sends the
     * version back (`REVIEW_DECISIONS v1`), and whether a refused version needs
     * a `revision` task instead — a conversation gets the block, unattended
     * work gets the row.
     *
     * `text` with no foreign key, as `job_runs.conversation_id` is: the honest
     * constraint would be the composite `(conversation_id, organization_id)`,
     * which is worth its cost on a row that decides access and not on one that
     * decides prose.
     */
    originConversationId: text('origin_conversation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentIdx: index('idx_document_versions_document').on(table.documentId, table.versionNumber),
    orgIdx: index('idx_document_versions_organization_id').on(table.organizationId),
    /**
     * Referenceable `(id, document_id)`, so `documents.published_version_id` can
     * bind the version to the item it belongs to. Declared here as well as in
     * migration 0082 because schema-driven provisioning builds the composite FK
     * from THIS file and Postgres rejects a reference whose target unique
     * constraint exists only in the migration.
     */
    idDocumentKey: unique('document_versions_id_document_id_key').on(table.id, table.documentId),
    documentProjectFk: foreignKey({
      name: 'document_versions_document_id_project_id_fkey',
      columns: [table.documentId, table.projectId],
      foreignColumns: [documents.id, documents.projectId],
    }).onDelete('cascade'),
    stateKnown: check('document_versions_state_known', sql`${table.state} IN (${STATE_LIST})`),
    /** A review is by somebody, at some time — both or neither (`tasks_review_complete`). */
    reviewComplete: check(
      'document_versions_review_complete',
      sql`(${table.reviewedBy} IS NULL) = (${table.reviewedAt} IS NULL)`
    ),
    /**
     * The publish door, as a row invariant. Slice 4 dispatches only a published
     * version to the index, so "indexed" implies "a person approved it" without
     * any code being asked to remember.
     */
    publishedIsApproved: check(
      'document_versions_published_is_approved',
      sql`${table.state} <> 'published' OR (${table.approvedBy} IS NOT NULL AND ${table.approvedAt} IS NOT NULL)`
    ),
    /**
     * A refusal carries words. „Änderungen anfordern" and „Ablehnen" both reach
     * the next turn and the revision task as text; a refusal with nothing in it
     * is a decision the next attempt cannot act on (ADR-0051's `review_reason`,
     * one level down).
     */
    refusalHasComment: check(
      'document_versions_refusal_has_comment',
      sql`${table.state} NOT IN ('changes_requested', 'rejected') OR ${table.reviewComment} IS NOT NULL`
    ),
  })
)

export const documentVersionsRelations = relations(documentVersions, ({ one }) => ({
  document: one(documents, {
    fields: [documentVersions.documentId],
    references: [documents.id],
  }),
}))

export type DocumentVersion = typeof documentVersions.$inferSelect
export type NewDocumentVersion = typeof documentVersions.$inferInsert
