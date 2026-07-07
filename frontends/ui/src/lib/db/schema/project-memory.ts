import { boolean, index, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'
import { projects } from './projects'

/**
 * Project Memory — durable, evolving, agent-authored + user-curated findings
 * scoped to a single project. See docs/architecture/project-memory-design.md.
 *
 * Itemized rows (not an append-only blob) so items carry provenance, status,
 * and confidence individually and can be superseded, pinned, or promoted into
 * the structured profile.
 */

export const PROJECT_MEMORY_KINDS = [
  'decision',
  'constraint',
  'open_question',
  'derived_fact',
  'preference',
] as const
export type ProjectMemoryKind = (typeof PROJECT_MEMORY_KINDS)[number]

export const PROJECT_MEMORY_STATUSES = ['proposed', 'active', 'superseded', 'dismissed'] as const
export type ProjectMemoryStatus = (typeof PROJECT_MEMORY_STATUSES)[number]

export const PROJECT_MEMORY_CONFIDENCES = ['low', 'medium', 'high'] as const
export type ProjectMemoryConfidence = (typeof PROJECT_MEMORY_CONFIDENCES)[number]

export const PROJECT_MEMORY_VERIFICATIONS = ['unverified', 'source_grounded', 'user_confirmed'] as const
export type ProjectMemoryVerification = (typeof PROJECT_MEMORY_VERIFICATIONS)[number]

export const PROJECT_MEMORY_PROVENANCES = ['agent', 'user', 'distillation', 'profile_graduation'] as const
export type ProjectMemoryProvenance = (typeof PROJECT_MEMORY_PROVENANCES)[number]

/**
 * Memory scope: 'project' items belong to one project; 'organization' items are
 * cross-cutting knowledge shared by every project in the org (project_id NULL).
 * Never cross-organization — that would leak between tenants.
 */
export const PROJECT_MEMORY_SCOPES = ['project', 'organization'] as const
export type ProjectMemoryScope = (typeof PROJECT_MEMORY_SCOPES)[number]

export const projectMemory = pgTable(
  'project_memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: text('scope').$type<ProjectMemoryScope>().notNull().default('project'),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id').notNull(),
    kind: text('kind').$type<ProjectMemoryKind>().notNull(),
    content: text('content').notNull(),
    status: text('status').$type<ProjectMemoryStatus>().notNull().default('active'),
    confidence: text('confidence').$type<ProjectMemoryConfidence>().notNull().default('medium'),
    verification: text('verification').$type<ProjectMemoryVerification>().notNull().default('unverified'),
    provenanceType: text('provenance_type').$type<ProjectMemoryProvenance>().notNull().default('agent'),
    sourceConversationId: text('source_conversation_id'),
    supersedesId: uuid('supersedes_id'),
    salience: real('salience').notNull().default(0.5),
    pinned: boolean('pinned').notNull().default(false),
    createdBy: text('created_by'),
    lastReferencedAt: timestamp('last_referenced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectIdx: index('idx_project_memory_project_id').on(table.projectId),
    projectStatusIdx: index('idx_project_memory_project_status').on(table.projectId, table.status),
    orgScopeIdx: index('idx_project_memory_org_scope').on(table.organizationId, table.scope, table.status),
    // NOTE: two PARTIAL UNIQUE indexes on a normalized-content expression
    // (uniq_project_memory_{project,org}_content_active) enforce "at most one
    // active item per scope-owner + normalized content". They are expression +
    // partial indexes that the drizzle builder can't express, so they live in
    // migration 0010_project_memory_dedup.sql. See createProjectMemoryItem.
  }),
)

export const projectMemoryRelations = relations(projectMemory, ({ one }) => ({
  project: one(projects, { fields: [projectMemory.projectId], references: [projects.id] }),
  supersedes: one(projectMemory, {
    fields: [projectMemory.supersedesId],
    references: [projectMemory.id],
  }),
}))

export type ProjectMemoryItem = typeof projectMemory.$inferSelect
export type NewProjectMemoryItem = typeof projectMemory.$inferInsert
