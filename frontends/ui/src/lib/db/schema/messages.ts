import { sql } from 'drizzle-orm'
import { foreignKey, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { conversations } from './conversations'

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  // No inline `.references()`: the real constraint is composite (see below), and
  // declaring the single-column one here would have drizzle generate a migration
  // undoing 0031 the next time anybody touches this file.
  conversationId: text('conversation_id').notNull(),
  /**
   * The owning tenant, denormalised from the conversation (migration 0031).
   *
   * Not a second source of truth: a composite foreign key ties
   * `(conversation_id, organization_id)` to `conversations (id, organization_id)`,
   * so Postgres refuses a message whose organization disagrees with its
   * conversation's. It exists so the row-level-security policy is a plain
   * column comparison rather than a subquery — measured at 4.01 ms -> 0.70 ms
   * on the hottest read in the product (ADR-0041).
   *
   * Defaulted from the tenant context in SQL, so inserts need not set it.
   */
  organizationId: text('organization_id').notNull().default(sql`nullif(current_setting('grid.organization_id', true), '')`),
  role: text('role').notNull(),
  /**
   * WorkOS user id of the human who wrote this message; NULL for assistant,
   * system and tool messages, and NULL for messages written before authorship
   * existed.
   *
   * `role` only ever recorded the KIND of author (user vs assistant), which was
   * free when a thread had exactly one human in it. With two it is a defect:
   * multi-author rendering, mention attribution and per-person read state all
   * need to know WHICH person. Legacy rows are attributed to the conversation's
   * creator at read time rather than backfilled, so the data never claims a
   * precision it does not have (spec MG-3).
   */
  authorUserId: text('author_user_id'),
  content: text('content').notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  conversationCreatedIdx: index('messages_conversation_created_idx').on(table.conversationId, table.createdAt),
  /**
   * The constraint that makes the denormalised `organizationId` above safe: a
   * message's (conversation, organization) pair must exist on the conversation
   * itself, so the copy cannot disagree with its parent and a message cannot be
   * re-parented across tenants. Created by migration 0031; declared here so the
   * schema and the database say the same thing.
   */
  conversationTenantFk: foreignKey({
    name: 'messages_conversation_id_organization_id_fkey',
    columns: [table.conversationId, table.organizationId],
    foreignColumns: [conversations.id, conversations.organizationId],
  }).onDelete('cascade'),
}))

export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
