import { index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * `message_restricted_use` — a message written while its conversation drew on
 * a folder with restricted access (ADR-0089, migration 0122).
 *
 * Written by the DATABASE, never by a client: a trigger on `messages` marks a
 * row when it is inserted, or its `content` rewritten, while the conversation
 * holds a `conversation_restricted_folders` record. The record is written when
 * the BFF admits restricted content into a turn, before the answer is
 * persisted, so the answer of that turn and every later message is marked.
 *
 * Keyed by (organization, message id), because a vote names its answer by
 * message id and its conversation id is whatever the client sent. No foreign
 * key: deleting the chat deletes its messages and its record, and the mark
 * stays so the votes on it stay out of every cross-tenant reader
 * (`OUTSIDE_RESTRICTED_USE`). The runtime role may not update or delete one.
 */
export const messageRestrictedUse = pgTable(
  'message_restricted_use',
  {
    organizationId: text('organization_id').notNull(),
    /** `messages.id` as text: the form `answer_feedback.message_id` holds it in. */
    messageId: text('message_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    markedAt: timestamp('marked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ name: 'message_restricted_use_pk', columns: [table.organizationId, table.messageId] }),
    conversationIdx: index('message_restricted_use_conversation_idx').on(table.organizationId, table.conversationId),
  })
)

export type MessageRestrictedUse = typeof messageRestrictedUse.$inferSelect
