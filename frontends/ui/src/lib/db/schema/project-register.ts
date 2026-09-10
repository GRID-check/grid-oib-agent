import { index, integer, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { projects } from './projects'

/**
 * The Projektregister — one *Steckbrief* per project, the office's index of
 * which projects exist and what they are about (ADR-0054, spec PR-1…PR-9).
 *
 * A Büro turn must be able to answer "in welchen Projekten haben wir GK5 mit
 * Holzbau?" without putting forty project collections into the retrieval scope.
 * This table is what makes that cheap: a small, bounded fingerprint per project
 * — name, status, Bundesland, the cached profile prompt view, a memory
 * headline, the document inventory, last activity — that recall ranks over and
 * the BFF then filters to the projects the caller may actually read.
 *
 * **Derived, never authored.** Every column is a copy of something the four
 * source tables already hold (`projects`, `project_memory`, `documents`, and
 * the profile inside `projects.profile`). The BFF is the single writer
 * (PR-5): `rebuildProjectRegisterRow` in `lib/workspace/register-service.ts`
 * reads the sources, calls the pure builder, and upserts. Nothing else writes
 * here, and nothing reads a Steckbrief as evidence about a project's CONTENT
 * (PR-15) — it answers *which project*, never *what the file says*.
 *
 * **The embedding is row-resident**, exactly as `project_memory` carries one
 * (migration 0069): `embedding real[]` plus the fingerprint of the model that
 * produced it. A vector is comparable only within one model, so a fingerprint
 * that no longer matches the deployment's embedder reads as "not embedded" and
 * recall falls back to its lexical channel. No pgvector, no second store
 * (PR-8).
 *
 * **`status` is a column here and nowhere else.** `projects` has no status:
 * the Steckbrief needs one, and it is READ OUT of the profile facts (the
 * `projektphase` intake answer) by the builder, so it is nullable and may
 * legitimately stay NULL for a project nobody has taken through intake.
 */
export const projectRegister = pgTable(
  'project_register',
  {
    /**
     * One row per project, so the project id IS the primary key. The composite
     * foreign key below (id + organization_id, the belt-and-braces `tasks`
     * uses since 0075) is what stops a row being planted under another
     * tenant's project; drizzle cannot express it, so it lives in migration
     * 0082 beside the CHECKs.
     */
    projectId: uuid('project_id').primaryKey(),
    organizationId: text('organization_id').notNull(),
    projectName: text('project_name').notNull(),
    /** From `profile.facts.projektphase` (or a sibling key); NULL when unstated. */
    status: text('status'),
    /** The validated `bundesland` intake token; NULL outside the vocabulary. */
    bundesland: text('bundesland'),
    /**
     * The prompt block itself, at most 3000 characters — a budget the database
     * enforces (`project_register_steckbrief_bounded`) rather than a
     * convention the builder is trusted to keep. Five of these plus the office
     * memory digest have to fit in a prompt beside everything else the turn
     * already carries (PR-3).
     */
    steckbrief: text('steckbrief').notNull(),
    documentCount: integer('document_count').notNull().default(0),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }),
    embedding: real('embedding').array(),
    embeddingModel: text('embedding_model'),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }),
    /**
     * Set by a writer, cleared by the build. A write-through that cannot
     * afford to rebuild inline (a memory write, which happens several times a
     * turn) stamps this instead, and the bounded reconcile
     * (`POST /api/internal/workspace/register/reconcile`, called by the
     * scheduler) repairs the row later. PR-7: a missed write-through is
     * repaired without a person noticing it.
     */
    staleAt: timestamp('stale_at', { withTimezone: true }),
    builtAt: timestamp('built_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /**
     * The reconcile's own query: `WHERE stale_at IS NOT NULL ORDER BY stale_at`.
     * PARTIAL, because the steady state is "nothing is stale" and a full index
     * would be almost entirely dead entries. Declared here for the schema
     * reader; the `WHERE` clause lives in migration 0082, which drizzle cannot
     * express.
     */
    staleIdx: index('project_register_stale_idx').on(table.organizationId, table.staleAt),
    // NOTE: the lexical half of hybrid recall is a GIN index over
    // `to_tsvector('german', steckbrief)` — an EXPRESSION index the drizzle
    // builder cannot express, so it lives in migration 0082
    // (`project_register_fts_idx`). See `recallSteckbriefe`.
  })
)

export const projectRegisterRelations = relations(projectRegister, ({ one }) => ({
  project: one(projects, {
    fields: [projectRegister.projectId],
    references: [projects.id],
  }),
}))

export type ProjectRegisterRow = typeof projectRegister.$inferSelect
export type NewProjectRegisterRow = typeof projectRegister.$inferInsert
