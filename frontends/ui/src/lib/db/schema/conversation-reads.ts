import { sql } from 'drizzle-orm'
import { foreignKey, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import { conversations } from './conversations'

/**
 * `conversation_reads` — how far each participant has read a conversation.
 *
 * Per PERSON, server-side, because that is the whole point: with two people in a
 * thread, "unread" is no longer a property of one browser. This backs the unread
 * separator in the thread and the grouped activity item in the inbox (which is
 * cleared by reading the thread, not by dismissing the notification).
 *
 * Deliberately NOT a per-message read receipt table: one high-water mark per
 * (conversation, person) answers every question the product asks, at a fraction
 * of the write volume. If per-message receipts are ever needed ("Anna saw this
 * one"), that is a different table, not a widening of this one.
 */
export const conversationReads = pgTable(
  'conversation_reads',
  {
    // Composite in the database since 0031 — see the foreign key below.
    conversationId: text('conversation_id').notNull(),
    /** Owning tenant, denormalised from the conversation — see `messages`. */
    organizationId: text('organization_id')
      .notNull()
      .default(sql`nullif(current_setting('grid.organization_id', true), '')`),
    /** WorkOS user id. */
    userId: text('user_id').notNull(),
    /** High-water mark: everything created at or before this is read. */
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
    /** The message the mark was set from, for a stable "new since here" divider. */
    lastReadMessageId: text('last_read_message_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({
      name: 'conversation_reads_pk',
      columns: [table.conversationId, table.userId],
    }),
    /** See `messages`: the copy above cannot disagree with the parent row. */
    conversationTenantFk: foreignKey({
      name: 'conversation_reads_conversation_id_organization_id_fkey',
      columns: [table.conversationId, table.organizationId],
      foreignColumns: [conversations.id, conversations.organizationId],
    }).onDelete('cascade'),
  })
)

export type ConversationRead = typeof conversationReads.$inferSelect
export type NewConversationRead = typeof conversationReads.$inferInsert
