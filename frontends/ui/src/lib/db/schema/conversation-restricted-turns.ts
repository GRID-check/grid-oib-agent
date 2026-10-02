import { check, integer, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

/**
 * `conversation_restricted_turns` — a turn of this conversation ran with a
 * restricted folder's collection in its signed scope (ADR-0078, migration 0105).
 *
 * Written at turn START by the confinement route the agent asks before every
 * such turn, so it exists before the answer does: the inventory block can put a
 * restricted document's summary into an answer that cites nothing, and the
 * owner can share while the answer streams. The sharing service refuses to
 * widen a conversation with a row here.
 *
 * No foreign key: the first turn of a new chat runs before its conversation row
 * exists. `deleteConversationInOrg` removes the row with the conversation.
 */
export const conversationRestrictedTurns = pgTable(
  'conversation_restricted_turns',
  {
    organizationId: text('organization_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    firstAt: timestamp('first_at', { withTimezone: true }).notNull().defaultNow(),
    lastAt: timestamp('last_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * How many restricted turns asked. At 1 the mark is its first asker's alone,
     * which is what lets a refused first ask withdraw it without taking a mark a
     * concurrent turn also wrote.
     */
    turnCount: integer('turn_count').notNull().default(1),
  },
  (table) => ({
    pk: primaryKey({
      name: 'conversation_restricted_turns_pk',
      columns: [table.organizationId, table.conversationId],
    }),
    turnCount: check('conversation_restricted_turns_turn_count', sql`${table.turnCount} >= 1`),
    order: check('conversation_restricted_turns_order', sql`${table.lastAt} >= ${table.firstAt}`),
  })
)

export type ConversationRestrictedTurn = typeof conversationRestrictedTurns.$inferSelect
