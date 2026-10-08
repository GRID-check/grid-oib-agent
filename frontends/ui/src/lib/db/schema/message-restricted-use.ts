import { index, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * `message_restricted_use` — a message id whose conversation drew on a folder
 * with restricted access (ADR-0092, migration 0124).
 *
 * Written by the SERVER, never by a client, from one rule
 * (`grid_conversation_restricted_use`): the BFF marks the id of the answer a
 * turn is writing when restricted content is admitted into it, before the
 * model reads it (`markAnswerRestrictedUse`); a trigger on `messages` marks a
 * row inserted, or its `content` rewritten, while the conversation answers
 * yes; a trigger on `conversation_restricted_folders` marks, at the first
 * admission, every message the conversation already holds and the message id
 * of every vote naming it; triggers on `task_runs`, `documents` and
 * `project_folders` do the same for a revision thread when it starts
 * answering yes; a trigger on `answer_feedback` marks a vote's message id when
 * the voted message's conversation, or the one the vote names, answers yes. A
 * vote's ids are the client's and can only add a mark.
 *
 * `conversation_id` is the conversation that answered yes when the mark was
 * written ('' when unknown), and the rule asks it: once marked, a conversation
 * keeps answering yes (sticky, ADR-0092).
 *
 * Keyed by (organization, message id), because a vote names its answer by
 * message id. No foreign key: deleting the chat deletes its messages and its
 * record, and the mark stays so the votes on it stay out of every cross-tenant
 * reader (`OUTSIDE_RESTRICTED_USE`). The runtime role may not update or delete
 * one.
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
