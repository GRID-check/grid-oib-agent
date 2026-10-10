/**
 * The joins that put a vote back next to the turn it rated: the answer that was
 * voted on (`m`) and the question that answer replied to (`q`).
 *
 * One fragment, because two readers need it — the platform drill-in
 * (`listFeedbackTurns`) and the lesson sweep (`listUnprocessedDownvotes`) — and
 * the copy each of them used to carry had the same defect: the question
 * predicate was `m.created_at is null or created_at <= m.created_at`. When the
 * answer row is missing, the first half is always true, so the "question"
 * became the NEWEST user message in the conversation, whichever turn it
 * belonged to. The drill-in then showed a real answer under somebody's later
 * question, and the sweep distilled a lesson from a pairing nobody made.
 *
 * Now the question hangs off the answer row: it is the newest user message in
 * the ANSWER's conversation written no later than the answer. No answer row,
 * no anchor, and the question is NULL — an honest gap the UI already renders,
 * rather than a confident wrong pairing. The conversation comes from the
 * persisted answer, not from `answer_feedback.conversation_id`, which is
 * whatever text the client sent with its vote, and both rows must be in the
 * vote's organization: a message id is the client's text too, and a vote must
 * not pull another tenant's answer into a cross-tenant reader (ADR-0093).
 * A reader that wants the conversation (title, topics) joins it through
 * `m.conversation_id` in `f.organization_id`, for the same reason.
 *
 * **The answer must belong to the voter's organization.** `message_id` is what
 * the client sent, and nothing at vote time can see (let alone refuse) another
 * tenant's message: under row-level security that row is simply invisible. The
 * readers here run with the platform bypass, though, so a join on the id alone
 * paired a vote with any tenant's answer whose id it named, and that tenant's
 * answer text was shown, exported and distilled under the voter's row. The
 * `m.organization_id = f.organization_id` predicate is what keeps the pairing
 * inside one tenant; the question lateral is pinned the same way.
 *
 * Expects the feedback row aliased `f`; exposes `m.content` (the answer),
 * `m.conversation_id`, `m.metadata` and `q.content` (the question). LEFT joins
 * throughout: a vote whose turn was never persisted still has to appear.
 */

import { sql, type SQL } from 'drizzle-orm'

/**
 * `answer_feedback.message_id` as the `messages.id` it names, or NULL when it is
 * not a UUID (the chat store mints UUIDs; a dev page votes on `af-msg`).
 *
 * Comparing `m.id::text = f.message_id` cast the indexed side, so Postgres could
 * not use the primary key and had to scan `messages` for every vote. Casting the
 * other side only when it parses keeps the comparison exact and indexable;
 * `CASE` evaluates the guard before the cast, so a non-UUID never reaches it.
 */
export function answerIdOf(messageId: SQL): SQL {
  return sql`(case when ${messageId} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (${messageId})::uuid end)`
}

/** The voted answer (`m`) alone, for a query that does not need the question. */
export const VOTED_ANSWER_JOIN = sql`
    left join messages m
      on m.id = ${answerIdOf(sql`f.message_id`)}
     and m.role = 'assistant'
     and m.organization_id = f.organization_id
`

/** The question that answer replied to (`q`). Needs `VOTED_ANSWER_JOIN` before it. */
export const VOTED_QUESTION_JOIN = sql`
    left join lateral (
      select qm.content
      from messages qm
      where qm.conversation_id = m.conversation_id
        and qm.organization_id = m.organization_id
        and qm.role = 'user'
        and qm.created_at <= m.created_at
      order by qm.created_at desc
      limit 1
    ) q on true
`

export const VOTED_TURN_JOINS = sql`${VOTED_ANSWER_JOIN}${VOTED_QUESTION_JOIN}`

/**
 * The conversation a vote belongs to: the persisted answer's, falling back to
 * the one the client sent only when the answer has no row in the voter's
 * organization.
 *
 * For a query that does not carry `VOTED_TURN_JOINS` (the aggregates, which
 * must not join a vote to anything that could multiply it). Where `m` is
 * joined, the same rule reads `coalesce(m.conversation_id, f.conversation_id)`.
 * Pass the feedback row's columns as the query names them: `f.message_id` in
 * raw SQL, `${answerFeedback.messageId}` in the query builder.
 */
export function votedConversationId(feedback: {
  messageId: SQL
  conversationId: SQL
  organizationId: SQL
}): SQL {
  return sql`coalesce(
    (select am.conversation_id from messages am
      where am.id = ${answerIdOf(feedback.messageId)}
        and am.role = 'assistant'
        and am.organization_id = ${feedback.organizationId}),
    ${feedback.conversationId}
  )`
}
