import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { projects } from './projects'

/**
 * Per-answer thumbs feedback (WS-7, click-dummy overhaul spec §1/§6).
 *
 * One row per (user, assistant message): a verdict (`up`/`down`) plus an
 * optional reason key for down-votes. Voting semantics are the simplest
 * honest model:
 *   - re-vote (same or different verdict/reason) = UPSERT on the
 *     (user_id, message_id) unique key — the row is updated in place;
 *   - toggle-off = DELETE — no "retracted" tombstone state is kept.
 *
 * `message_id` is the client-side assistant message identifier (the chat
 * store's message id), NOT a `messages.id` FK: shallow chat turns are not
 * individually persisted as `messages` rows, so the feedback row must stand
 * on its own. `conversation_id` is likewise plain text without an FK — the
 * conversation row is created asynchronously by the chat client and a vote
 * must not race it. `project_id` keeps a cascading FK (mirrors
 * `conversations.project_id`) so a purged project takes its feedback along.
 * `organization_id` is denormalized for SQL-level tenancy scoping (ADR-0007).
 */

export const ANSWER_FEEDBACK_VERDICTS = ['up', 'down'] as const
export type AnswerFeedbackVerdict = (typeof ANSWER_FEEDBACK_VERDICTS)[number]

/** Fixed down-vote reason keys — i18n labels live in the chat dictionary. */
export const ANSWER_FEEDBACK_REASONS = ['inaccurate', 'too_slow', 'wrong_source', 'other'] as const
export type AnswerFeedbackReason = (typeof ANSWER_FEEDBACK_REASONS)[number]

export const answerFeedback = pgTable(
  'answer_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id'),
    /** Client-side assistant message identifier (chat-store message id). */
    messageId: text('message_id').notNull(),
    userId: text('user_id').notNull(),
    verdict: text('verdict').$type<AnswerFeedbackVerdict>().notNull(),
    reason: text('reason').$type<AnswerFeedbackReason>(),
    /** Optional free-text from a down-vote — the chips are not the whole story. */
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** Upsert target: one vote per user per answer. */
    userMessageUidx: uniqueIndex('answer_feedback_user_message_uidx').on(table.userId, table.messageId),
    /** Serves the per-conversation hydration list (org + user + conversation). */
    orgConversationIdx: index('answer_feedback_org_conversation_idx').on(
      table.organizationId,
      table.conversationId,
    ),
    orgProjectIdx: index('answer_feedback_org_project_idx').on(table.organizationId, table.projectId),
  }),
)

export type AnswerFeedback = typeof answerFeedback.$inferSelect
export type NewAnswerFeedback = typeof answerFeedback.$inferInsert
