import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects'
import { type ResourceVisibility } from './resource-shares'

/**
 * Engagement modes (ADR-0036). Deliberately two values, both meaning something a
 * user can state in one sentence. There is no `auto` — "was this message for me?"
 * is a question about conversation structure, which we hold exactly, and a model
 * asked it measures near chance (arXiv:2501.16643).
 */
export const CONVERSATION_ENGAGEMENTS = ['ask', 'mention'] as const
export type ConversationEngagement = (typeof CONVERSATION_ENGAGEMENTS)[number]

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
  /**
   * When the agent answers a message that tags nobody (ADR-0036).
   *
   *   - `ask`     — a plain message goes to the assistant. Right for the thread
   *                 with one human in it, which is nearly all of them.
   *   - `mention` — a plain message goes to the chat; the assistant answers only
   *                 when tagged. What a real multi-person discussion wants.
   *
   * **NULL means "derive it"**, and derivation is the structural fact: a thread
   * with two or more human authors is in `mention`. Nullable on purpose, so an
   * absent value is never a broken thread and the rule can improve without a
   * backfill. The value is written once, when the flip actually happens, so the
   * derivation query does not run per message forever.
   *
   * Never consulted for a message that DOES tag someone: `@Piloti` always
   * answers and a humans-only tag never starts a turn, in either mode. Those
   * three rules are what make a tag worth typing.
   */
  engagement: text('engagement').$type<ConversationEngagement>(),
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
  /**
   * Redundant on its own — `id` is already the primary key — and required all
   * the same: a composite foreign key can only reference a uniquely-constrained
   * column set, and `messages` / `conversation_reads` reference exactly this
   * pair so their denormalised tenant column cannot drift from ours (migration
   * 0031, ADR-0041).
   */
  idOrganizationKey: unique('conversations_id_organization_id_key').on(table.id, table.organizationId),
}))

export type Conversation = typeof conversations.$inferSelect
export type NewConversation = typeof conversations.$inferInsert
