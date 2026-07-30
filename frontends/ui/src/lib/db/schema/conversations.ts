import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects'
import { type ResourceVisibility } from './resource-shares'

export const conversations = pgTable('conversations', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull(),
  createdBy: text('created_by').notNull(),
  title: text('title'),
  /**
   * Blanket visibility (ADR-0032). Lives on this row rather than in a generic
   * table so the hottest read in the product costs no join: resolving access to
   * a conversation needs the row anyway.
   *
   * `private` is the default for NEW conversations, so sharing is a deliberate
   * act and the access chip means something. Rows that existed before this
   * column was added were backfilled to `project` (migration 0027): everyone
   * inside the project keeps what they could see, and the accidental org-wide
   * readability — conversations used to be resolved org-scoped only — is
   * withdrawn. See the migration and ADR-0032 §"existing conversations".
   */
  visibility: text('visibility').$type<ResourceVisibility>().notNull().default('private'),
  // OIB topic tag keys (fixed vocabulary — see lib/conversations/tags.ts),
  // assigned by the naming LLM and used by the Historie tag filter. Multiple per
  // conversation; empty by default so legacy rows stay valid.
  tags: text('tags').array().notNull().default([]),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  orgUpdatedIdx: index('conversations_org_updated_idx').on(table.organizationId, table.updatedAt),
  projectIdx: index('conversations_project_idx').on(table.projectId),
  tagsIdx: index('conversations_tags_idx').using('gin', table.tags),
}))

export type Conversation = typeof conversations.$inferSelect
export type NewConversation = typeof conversations.$inferInsert
