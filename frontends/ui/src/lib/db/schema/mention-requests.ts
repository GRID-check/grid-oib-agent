import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import type { ShareableResourceType } from './resource-shares'

/**
 * `mention_requests` — an outstanding request for a named person's input
 * (ADR-0034).
 *
 * This is the durable home of the product's headline collaboration behaviour:
 * someone tags a colleague, and **the agent deliberately does not answer** until
 * that colleague responds.
 *
 * Why a table and not the agent's existing human-in-the-loop future? Because the
 * agent's HITL wait is an in-process, loop-bound `asyncio.Future` on whichever
 * replica runs the turn — built for seconds, for whoever holds the socket, and
 * explicitly not durable across restarts (ADR-0028). A mention waits **days**,
 * for a **specific person**, across deploys and devices. Same lesson as ADR-0030:
 * a decision that gates a real consequence belongs in persisted state.
 *
 * **The thread-level "awaiting" state is DERIVED from these rows**, never stored
 * separately: a conversation is awaiting input iff an `open` row exists for it.
 * One source of truth, so the thread banner and the recipient's inbox cannot
 * drift apart.
 */

export const MENTION_REQUEST_STATUSES = ['open', 'answered', 'released', 'void'] as const
export type MentionRequestStatus = (typeof MENTION_REQUEST_STATUSES)[number]

/**
 * How an open request was closed.
 *   - `answered`   — a mentioned person contributed to the resource;
 *   - `asked_back` — they responded by asking the asker something in return;
 *   - `released`   — a participant explicitly chose to continue without them;
 *   - `void`       — the request became meaningless (access lost, resource gone).
 *
 * `asked_back` exists because "they wrote something" and "they answered" are not
 * the same event, and treating them as one produced the product's worst
 * misstatement: a clarifying question from the person who was asked was reported
 * to the asker as "Anna answered", the thread stopped waiting, and the next plain
 * message — the asker replying to ANNA — went to the agent. The lifecycle
 * `status` is still `answered` (the request is closed, they did respond); this
 * column carries the distinction the copy and the notifications need.
 */
export const MENTION_RESOLUTIONS = ['answered', 'asked_back', 'released', 'void'] as const
export type MentionResolution = (typeof MENTION_RESOLUTIONS)[number]

export const mentionRequests = pgTable(
  'mention_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: text('organization_id').notNull(),
    /**
     * The resource the request lives on. Generic from day one so the second
     * mention surface (a comment on a document, a note on a compliance lane)
     * reuses this table rather than growing a sibling.
     */
    resourceType: text('resource_type').$type<ShareableResourceType>().notNull(),
    resourceId: text('resource_id').notNull(),
    /**
     * Opaque id of the exact spot that carries the mention — the message id for
     * a chat. Deliberately not an FK: it is an addressable anchor, not a
     * relation, and its meaning is per resource type.
     */
    anchorId: text('anchor_id'),
    /** WorkOS user id who asked. */
    requestedBy: text('requested_by').notNull(),
    /** WorkOS user id whose input is requested. */
    requestedOf: text('requested_of').notNull(),
    /**
     * The asker's question/reason, carried into the recipient's inbox body.
     * "Is this the right assumption about the atrium?" is far more actionable
     * than "you were mentioned".
     */
    note: text('note'),
    status: text('status').$type<MentionRequestStatus>().notNull().default('open'),
    resolution: text('resolution').$type<MentionResolution>(),
    /** WorkOS user id who closed it (the answerer, or whoever released it). */
    resolvedBy: text('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    /** "Is this thread awaiting anyone?" — the derived banner state. */
    resourceStatusIdx: index('idx_mention_requests_resource_status').on(
      table.resourceType,
      table.resourceId,
      table.status,
    ),
    /** "What is outstanding against me?" — resolution on reply, and reminders. */
    requestedOfIdx: index('idx_mention_requests_requested_of_status').on(table.requestedOf, table.status),
    /** "What have I asked of others?" — the asker's side, and cascade cleanup. */
    orgRequestedByIdx: index('idx_mention_requests_org_requested_by').on(
      table.organizationId,
      table.requestedBy,
      table.status,
    ),
  }),
)

export type MentionRequest = typeof mentionRequests.$inferSelect
export type NewMentionRequest = typeof mentionRequests.$inferInsert
