/**
 * Feedback repository — the only module that queries the `answer_feedback`
 * table (ADR-0017, WS-7).
 *
 * Repository rules (see docs/architecture/bff-service-architecture.md):
 *   - drizzle only; no HTTP, no auth, no WorkOS.
 *   - Every query that serves tenant data takes `organizationId` and scopes
 *     the WHERE clause with it — tenancy is enforced in SQL, not in JS.
 *   - List queries are always bounded (`limit`).
 *
 * Voting model (documented on the schema): re-vote = upsert on the
 * (user_id, message_id) unique key; toggle-off = delete. The upsert's
 * conflict target already pins the row to the voting user, and the service
 * only ever passes the session's own user/org ids, so a conflicting update
 * can never cross tenants.
 */

import 'server-only'
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  answerFeedback,
  messages,
  type AnswerFeedback,
  type AnswerFeedbackReason,
  type AnswerFeedbackVerdict,
} from '@/lib/db/schema'

/** Hard cap for the per-conversation hydration list. */
export const CONVERSATION_FEEDBACK_LIST_LIMIT = 200

export interface UpsertAnswerFeedbackValues {
  organizationId: string
  projectId: string | null
  conversationId: string | null
  messageId: string
  userId: string
  verdict: AnswerFeedbackVerdict
  reason: AnswerFeedbackReason | null
}

/** Insert or update the caller's vote on one answer (re-vote semantics). */
export async function upsertAnswerFeedback(values: UpsertAnswerFeedbackValues): Promise<AnswerFeedback> {
  const db = getDb()
  const [row] = await db
    .insert(answerFeedback)
    .values(values)
    .onConflictDoUpdate({
      target: [answerFeedback.userId, answerFeedback.messageId],
      set: {
        verdict: values.verdict,
        reason: values.reason,
        conversationId: values.conversationId,
        projectId: values.projectId,
        organizationId: values.organizationId,
        updatedAt: new Date(),
      },
    })
    .returning()
  return row
}

/** Toggle-off: delete the caller's vote. Returns whether a row existed. */
export async function deleteAnswerFeedbackForUser(
  userId: string,
  messageId: string,
  organizationId: string,
): Promise<boolean> {
  const db = getDb()
  const rows = await db
    .delete(answerFeedback)
    .where(
      and(
        eq(answerFeedback.userId, userId),
        eq(answerFeedback.messageId, messageId),
        eq(answerFeedback.organizationId, organizationId),
      ),
    )
    .returning({ id: answerFeedback.id })
  return rows.length > 0
}

/** The caller's own votes in one conversation (bounded; newest first). */
export async function listAnswerFeedbackForConversation(
  userId: string,
  conversationId: string,
  organizationId: string,
  limit = CONVERSATION_FEEDBACK_LIST_LIMIT,
): Promise<AnswerFeedback[]> {
  const db = getDb()
  return db
    .select()
    .from(answerFeedback)
    .where(
      and(
        eq(answerFeedback.organizationId, organizationId),
        eq(answerFeedback.userId, userId),
        eq(answerFeedback.conversationId, conversationId),
      ),
    )
    .orderBy(desc(answerFeedback.createdAt))
    .limit(limit)
}

/* ------------------------------------------------------------------ *
 * Platform health — the cross-tenant read
 * ------------------------------------------------------------------ */

/**
 * Days of history the health read covers, and the cap on the drill-in list.
 *
 * Both bounded for the same reason every list here is: this table grows with
 * every thumb in the product and a platform page must not be the one query
 * that scans it whole.
 */
export const FEEDBACK_HEALTH_WINDOW_DAYS = 30
export const FEEDBACK_HEALTH_RECENT_LIMIT = 50

/**
 * **Deliberately NOT organization-scoped** — the one read in this file that
 * crosses tenants.
 *
 * Every other query here takes an `organizationId` and pins the WHERE clause to
 * it, because it serves a tenant. This one serves the *platform owner*, whose
 * whole job is the cross-org view, so scoping it to one org would answer the
 * wrong question. The guard therefore does not live in SQL: `getAnswerFeedbackHealth`
 * calls `requirePlatformOwner` before this function is reachable, and that is the
 * only caller. Do not export a route that reaches this directly.
 */
export interface FeedbackHealthTotals {
  up: number
  down: number
  /**
   * DISTINCT people behind those votes.
   *
   * The count alone cannot distinguish "nineteen people had a bad answer" from
   * "three people had a bad afternoon", and the rate is identical in both. One
   * determined user can move a platform-wide figure on their own, so the number
   * of humans is published beside the number of votes.
   */
  voters: number
  downVoters: number
}

export interface FeedbackReasonCount {
  reason: AnswerFeedbackReason | null
  count: number
}

export interface FeedbackDailyPoint {
  day: string
  up: number
  down: number
}

export interface FeedbackOrgRollup {
  organizationId: string
  up: number
  down: number
  /** Distinct voters in this org — see the note on `FeedbackHealthTotals`. */
  voters: number
}

/**
 * One down-voted answer, with as much of the turn as survives the join.
 *
 * `question`/`answer` are NULLABLE on purpose, and the UI must render the row
 * without them. `answer_feedback.message_id` is the chat-store id and carries no
 * FK to `messages` (see the schema note) — a turn that was never persisted has
 * no row to join, and `conversation_id` is likewise plain text whose row is
 * written asynchronously. A drill-in that only listed joinable rows would
 * silently hide exactly the feedback nobody has looked at yet.
 */
export interface FeedbackDefect {
  id: string
  organizationId: string
  projectId: string | null
  conversationId: string | null
  messageId: string
  reason: AnswerFeedbackReason | null
  createdAt: Date
  /** The answer that was voted down, when its message row exists. */
  answer: string | null
  /** The user turn immediately preceding it — the question that went wrong. */
  question: string | null
  conversationTitle: string | null
}

export interface FeedbackHealth {
  windowDays: number
  /**
   * Assistant answers produced in the same window — the DENOMINATOR the vote
   * counts are meaningless without.
   *
   * A negative rate computed over votes alone describes the people who chose to
   * vote, not the product: raters self-select and skew negative, so "12.9% of
   * votes were negative" reads as a quality figure while actually being a figure
   * about who reaches for a thumb. Publishing the coverage beside it is what stops
   * the headline being quoted as something it is not.
   *
   * Best available, not perfect: it counts persisted assistant messages, and
   * persistence is best-effort per turn. It therefore UNDER-counts answers, which
   * biases coverage upward — so the real coverage is at most this, never more.
   */
  answers: number
  totals: FeedbackHealthTotals
  reasons: FeedbackReasonCount[]
  daily: FeedbackDailyPoint[]
  organizations: FeedbackOrgRollup[]
  defects: FeedbackDefect[]
}

/**
 * What the reader has narrowed the view to.
 *
 * Applied in SQL, not in the browser: the drill-in is capped at
 * `FEEDBACK_HEALTH_RECENT_LIMIT` rows, so a client-side filter would search only
 * the 50 rows that happened to arrive and quietly claim there was nothing else.
 * Filtering has to happen where the whole table is.
 */
export interface FeedbackHealthFilters {
  windowDays?: number
  /** Restrict the drill-in to one reason. */
  reason?: AnswerFeedbackReason | null
  /** Restrict everything to one organization. */
  organizationId?: string | null
  /** Free text across the question and the answer. */
  query?: string | null
  limit?: number
}

/** Allowed windows. Anything else is coerced, never trusted from a query string. */
export const FEEDBACK_WINDOW_OPTIONS = [7, 30, 90] as const

export function parseFeedbackWindowDays(raw: string | null): number {
  const parsed = Number(raw)
  return (FEEDBACK_WINDOW_OPTIONS as readonly number[]).includes(parsed)
    ? parsed
    : FEEDBACK_HEALTH_WINDOW_DAYS
}

/** Start of the health window, as an ISO instant. */
function windowStart(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * The whole platform view in one round trip's worth of queries.
 *
 * See the tenancy note above: this is the deliberate cross-org read, and
 * `getAnswerFeedbackHealth` is the only caller.
 */
export async function getFeedbackHealth(
  filters: FeedbackHealthFilters = {},
): Promise<FeedbackHealth> {
  const {
    windowDays = FEEDBACK_HEALTH_WINDOW_DAYS,
    reason = null,
    organizationId = null,
    query = null,
    limit: recentLimit = FEEDBACK_HEALTH_RECENT_LIMIT,
  } = filters
  const db = getDb()
  const since = windowStart(windowDays)

  // The org filter narrows the aggregates too — asking "how is this tenant
  // doing?" and getting a platform-wide headline over a filtered list would be
  // two different questions answered in one card.
  const orgScope = organizationId ? [eq(answerFeedback.organizationId, organizationId)] : []
  const inWindow = gte(answerFeedback.createdAt, sql`${since}::timestamptz`)

  const [answersRow] = await db
    .select({ count: sql<string>`count(*)` })
    .from(messages)
    .where(
      and(eq(messages.role, 'assistant'), gte(messages.createdAt, sql`${since}::timestamptz`)),
    )

  const [totalsRow] = await db
    .select({
      up: sql<string>`count(*) filter (where ${answerFeedback.verdict} = 'up')`,
      down: sql<string>`count(*) filter (where ${answerFeedback.verdict} = 'down')`,
      voters: sql<string>`count(distinct ${answerFeedback.userId})`,
      downVoters: sql<string>`count(distinct ${answerFeedback.userId}) filter (where ${answerFeedback.verdict} = 'down')`,
    })
    .from(answerFeedback)
    .where(and(inWindow, ...orgScope))

  const reasons = await db
    .select({
      reason: answerFeedback.reason,
      count: sql<string>`count(*)`,
    })
    .from(answerFeedback)
    .where(and(eq(answerFeedback.verdict, 'down'), inWindow, ...orgScope))
    .groupBy(answerFeedback.reason)

  const daily = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${answerFeedback.createdAt}), 'YYYY-MM-DD')`,
      up: sql<string>`count(*) filter (where ${answerFeedback.verdict} = 'up')`,
      down: sql<string>`count(*) filter (where ${answerFeedback.verdict} = 'down')`,
    })
    .from(answerFeedback)
    .where(and(inWindow, ...orgScope))
    .groupBy(sql`date_trunc('day', ${answerFeedback.createdAt})`)
    .orderBy(sql`date_trunc('day', ${answerFeedback.createdAt})`)

  const organizations = await db
    .select({
      organizationId: answerFeedback.organizationId,
      up: sql<string>`count(*) filter (where ${answerFeedback.verdict} = 'up')`,
      down: sql<string>`count(*) filter (where ${answerFeedback.verdict} = 'down')`,
      voters: sql<string>`count(distinct ${answerFeedback.userId})`,
    })
    .from(answerFeedback)
    .where(and(inWindow, ...orgScope))
    .groupBy(answerFeedback.organizationId)
    .orderBy(desc(sql`count(*) filter (where ${answerFeedback.verdict} = 'down')`))

  // The drill-in. LEFT JOINs throughout: a defect whose turn was never
  // persisted still has to appear, because unexplained feedback is precisely
  // what this page exists to surface. The question is the newest user turn
  // before the answer — a lateral, so one row per defect rather than a fan-out.
  const defectRows = await db.execute(sql`
    select
      f.id,
      f.organization_id,
      f.project_id,
      f.conversation_id,
      f.message_id,
      f.reason,
      f.created_at,
      m.content    as answer,
      q.content    as question,
      c.title      as conversation_title
    from answer_feedback f
    left join messages m on m.id::text = f.message_id
    left join conversations c on c.id = f.conversation_id
    left join lateral (
      select content
      from messages
      where conversation_id = f.conversation_id
        and role = 'user'
        and (m.created_at is null or created_at <= m.created_at)
      order by created_at desc
      limit 1
    ) q on true
    where f.verdict = 'down'
      and f.created_at >= ${since}::timestamptz
      ${organizationId ? sql`and f.organization_id = ${organizationId}` : sql``}
      ${reason ? sql`and f.reason = ${reason}` : sql``}
      ${
        query
          ? sql`and (m.content ilike ${'%' + query + '%'} or q.content ilike ${'%' + query + '%'})`
          : sql``
      }
    order by f.created_at desc
    limit ${recentLimit}
  `)

  const rows = (defectRows as unknown as { rows?: Record<string, unknown>[] }).rows ?? []

  return {
    windowDays,
    answers: Number(answersRow?.count ?? 0),
    totals: {
      up: Number(totalsRow?.up ?? 0),
      down: Number(totalsRow?.down ?? 0),
      voters: Number(totalsRow?.voters ?? 0),
      downVoters: Number(totalsRow?.downVoters ?? 0),
    },
    reasons: reasons.map((r) => ({ reason: r.reason, count: Number(r.count) })),
    daily: daily.map((d) => ({ day: d.day, up: Number(d.up), down: Number(d.down) })),
    organizations: organizations.map((o) => ({
      organizationId: o.organizationId,
      up: Number(o.up),
      down: Number(o.down),
      voters: Number(o.voters),
    })),
    defects: rows.map((row) => ({
      id: String(row.id),
      organizationId: String(row.organization_id),
      projectId: (row.project_id as string | null) ?? null,
      conversationId: (row.conversation_id as string | null) ?? null,
      messageId: String(row.message_id),
      reason: (row.reason as AnswerFeedbackReason | null) ?? null,
      createdAt: new Date(row.created_at as string),
      answer: (row.answer as string | null) ?? null,
      question: (row.question as string | null) ?? null,
      conversationTitle: (row.conversation_title as string | null) ?? null,
    })),
  }
}
