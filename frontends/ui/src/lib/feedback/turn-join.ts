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
 * not pull another tenant's answer into a cross-tenant reader (ADR-0092).
 * A reader that wants the conversation (title, topics) joins it through
 * `m.conversation_id` in `f.organization_id`, for the same reason.
 *
 * Expects the feedback row aliased `f`; exposes `m.content` (the answer) and
 * `q.content` (the question). LEFT joins throughout: a vote whose turn was
 * never persisted still has to appear.
 */

import { sql } from 'drizzle-orm'

export const VOTED_TURN_JOINS = sql`
    left join messages m
      on m.id::text = f.message_id
     and m.organization_id = f.organization_id
     and m.role = 'assistant'
    left join lateral (
      select qm.content
      from messages qm
      where qm.conversation_id = m.conversation_id
        and qm.organization_id = f.organization_id
        and qm.role = 'user'
        and qm.created_at <= m.created_at
      order by qm.created_at desc
      limit 1
    ) q on true
`
