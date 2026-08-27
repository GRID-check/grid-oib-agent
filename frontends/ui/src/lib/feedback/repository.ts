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
  conversations,
  messages,
  type AnswerFeedback,
  type AnswerFeedbackReason,
  type AnswerFeedbackVerdict,
} from '@/lib/db/schema'
import { isConversationTagKey, type ConversationTagKey } from '@/lib/conversations/tags'

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
  comment: string | null
  /** Lessons-experiment arm, or null when the holdout is off. */
  lessonsHoldout?: boolean | null
}

/**
 * The caller's existing vote on one answer, if any. Read before the upsert by
 * the memory-implication trigger, which must fire on NEW complaint text only —
 * an unchanged re-vote (same comment saved twice) must not penalize the same
 * notes twice.
 */
export async function getAnswerFeedbackForUser(
  userId: string,
  messageId: string
): Promise<AnswerFeedback | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(answerFeedback)
    .where(and(eq(answerFeedback.userId, userId), eq(answerFeedback.messageId, messageId)))
    .limit(1)
  return row ?? null
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
        comment: values.comment,
        conversationId: values.conversationId,
        projectId: values.projectId,
        organizationId: values.organizationId,
        lessonsHoldout: values.lessonsHoldout ?? null,
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
 * calls `requirePlatformPermission` before this function is reachable, and that is the
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
 * Votes rolled up by the conversation's OIB topic tags.
 *
 * The aggregate everything else here was missing: totals say how the product is
 * doing, and this says *at what*. "Brandschutz answers land, Schallschutz ones
 * do not" is a sentence somebody can act on; "12% negative" is not, and neither
 * is a per-organization split, which describes who is unhappy rather than what
 * about.
 *
 * Tags come from `conversations.tags` (the naming LLM's closed vocabulary, see
 * `lib/conversations/tags.ts`), so this covers only feedback whose conversation
 * row exists AND was tagged — a strict subset of the totals. It is a breakdown,
 * never a second denominator: the numbers here do not sum to `totals`.
 */
export interface FeedbackTopicRollup {
  topic: ConversationTagKey
  up: number
  down: number
  /** Distinct voters on this topic — see the note on `FeedbackHealthTotals`. */
  voters: number
}

/**
 * One voted-on answer, with as much of the turn as survives the join.
 *
 * `question`/`answer` are NULLABLE on purpose, and the UI must render the row
 * without them. `answer_feedback.message_id` is the chat-store id and carries no
 * FK to `messages` (see the schema note) — a turn that was never persisted has
 * no row to join, and `conversation_id` is likewise plain text whose row is
 * written asynchronously. A drill-in that only listed joinable rows would
 * silently hide exactly the feedback nobody has looked at yet.
 *
 * The row carries its own `verdict` because the list serves BOTH directions: the
 * answers that missed, and — asked for by name — the ones that landed. One shape
 * and one query for the two, so the good half can never quietly fall behind the
 * bad half in what it shows.
 */
export interface FeedbackTurn {
  id: string
  organizationId: string
  projectId: string | null
  conversationId: string | null
  messageId: string
  verdict: AnswerFeedbackVerdict
  reason: AnswerFeedbackReason | null
  createdAt: Date
  /** The answer that was voted on, when its message row exists. */
  answer: string | null
  /** The user turn immediately preceding it — the question that was asked. */
  question: string | null
  conversationTitle: string | null
  /** The conversation's topic tags, when it has a row and was tagged. */
  topics: ConversationTagKey[]
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
  topics: FeedbackTopicRollup[]
  /** The drill-in, in whichever direction `filters.verdict` asked for. */
  turns: FeedbackTurn[]
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
  /**
   * Which direction the drill-in lists. Defaults to `down` — that is the
   * actionable list — but `up` is a first-class value, not an afterthought: the
   * answers that landed are what tells you which of the recent changes to keep.
   */
  verdict?: AnswerFeedbackVerdict
  /** Restrict the drill-in to one reason. Only meaningful with `verdict: 'down'`. */
  reason?: AnswerFeedbackReason | null
  /** Restrict everything to one organization. */
  organizationId?: string | null
  /** Restrict everything to one conversation topic tag. */
  topic?: ConversationTagKey | null
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

/**
 * Unwrap a raw `db.execute` result into plain rows.
 *
 * Drizzle types `execute` loosely and the driver returns `{ rows }`, so the cast
 * is unavoidable — but it is unchecked, so it lives in one place rather than
 * being re-derived at each call site. Every field is still coerced individually
 * downstream; this only gets us to the array.
 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  return (result as { rows?: Record<string, unknown>[] })?.rows ?? []
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
  // `verdict`/`reason`/`query` are deliberately NOT read here: they narrow the
  // drill-in only, and applying them to the aggregates would make the headline
  // describe the list rather than the window.
  const { windowDays = FEEDBACK_HEALTH_WINDOW_DAYS, organizationId = null, topic = null } = filters
  const db = getDb()
  const since = windowStart(windowDays)

  // The org filter narrows the aggregates too — asking "how is this tenant
  // doing?" and getting a platform-wide headline over a filtered list would be
  // two different questions answered in one card. The topic filter is the same
  // promise for the other axis, so it is an EXISTS against the conversation
  // rather than a join: a join would multiply a vote by its tag count and
  // inflate every total on the page.
  const orgScope = organizationId ? [eq(answerFeedback.organizationId, organizationId)] : []
  const topicScope = topic
    ? [
        sql`exists (
          select 1 from conversations tc
          where tc.id = ${answerFeedback.conversationId}
            and tc.tags @> array[${topic}]::text[]
        )`,
      ]
    : []
  const scope = [...orgScope, ...topicScope]
  const inWindow = gte(answerFeedback.createdAt, sql`${since}::timestamptz`)

  // The denominator has to obey the org filter too, or a tenant's rate is
  // computed over the whole platform's answers and its coverage reads far higher
  // than it is. `messages` carries no organization: its conversation does, and
  // the column is NOT NULL with an FK, so the join drops nothing when nothing is
  // filtered. The topic filter rides the same join for the same reason — a
  // numerator narrowed to one topic over a denominator that was not is the same
  // bug on a second axis.
  const [answersRow] = await db
    .select({ count: sql<string>`count(*)` })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.role, 'assistant'),
        gte(messages.createdAt, sql`${since}::timestamptz`),
        ...(organizationId ? [eq(conversations.organizationId, organizationId)] : []),
        ...(topic ? [sql`${conversations.tags} @> array[${topic}]::text[]`] : []),
      ),
    )

  const [totalsRow] = await db
    .select({
      up: sql<string>`count(*) filter (where ${answerFeedback.verdict} = 'up')`,
      down: sql<string>`count(*) filter (where ${answerFeedback.verdict} = 'down')`,
      voters: sql<string>`count(distinct ${answerFeedback.userId})`,
      downVoters: sql<string>`count(distinct ${answerFeedback.userId}) filter (where ${answerFeedback.verdict} = 'down')`,
    })
    .from(answerFeedback)
    .where(and(inWindow, ...scope))

  const reasons = await db
    .select({
      reason: answerFeedback.reason,
      count: sql<string>`count(*)`,
    })
    .from(answerFeedback)
    .where(and(eq(answerFeedback.verdict, 'down'), inWindow, ...scope))
    .groupBy(answerFeedback.reason)

  const daily = await db
    .select({
      // UTC-pinned, like every other day bucket in the BFF: `date_trunc` on a
      // timestamptz follows the SESSION timezone, so without this the day
      // boundaries move with whatever the connection happens to be set to.
      day: sql<string>`to_char(date_trunc('day', ${answerFeedback.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
      up: sql<string>`count(*) filter (where ${answerFeedback.verdict} = 'up')`,
      down: sql<string>`count(*) filter (where ${answerFeedback.verdict} = 'down')`,
    })
    .from(answerFeedback)
    .where(and(inWindow, ...scope))
    .groupBy(sql`date_trunc('day', ${answerFeedback.createdAt} at time zone 'UTC')`)
    .orderBy(sql`date_trunc('day', ${answerFeedback.createdAt} at time zone 'UTC')`)

  const organizations = await db
    .select({
      organizationId: answerFeedback.organizationId,
      up: sql<string>`count(*) filter (where ${answerFeedback.verdict} = 'up')`,
      down: sql<string>`count(*) filter (where ${answerFeedback.verdict} = 'down')`,
      voters: sql<string>`count(distinct ${answerFeedback.userId})`,
    })
    .from(answerFeedback)
    .where(and(inWindow, ...scope))
    .groupBy(answerFeedback.organizationId)
    .orderBy(desc(sql`count(*) filter (where ${answerFeedback.verdict} = 'down')`))

  // Votes by topic. `unnest` fans a conversation out over its tags on purpose —
  // here the tag IS the grouping key, so a two-tag conversation legitimately
  // counts once under each. That is also why this cannot be folded into the
  // totals query: the same fan-out there would double-count the headline.
  const topicRows = await db.execute(sql`
    select
      tag                                                  as topic,
      count(*) filter (where f.verdict = 'up')             as up,
      count(*) filter (where f.verdict = 'down')           as down,
      count(distinct f.user_id)                            as voters
    from answer_feedback f
    join conversations c on c.id = f.conversation_id
    cross join lateral unnest(c.tags) as tag
    where f.created_at >= ${since}::timestamptz
      ${organizationId ? sql`and f.organization_id = ${organizationId}` : sql``}
      ${topic ? sql`and c.tags @> array[${topic}]::text[]` : sql``}
    group by tag
    order by count(*) desc
  `)

  const turns = await listFeedbackTurns(filters)

  const topicResultRows = rowsOf(topicRows)

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
    // Unknown tags are dropped, not rendered: `conversations.tags` is written by
    // an LLM and backfilled rows predate the vocabulary, so a stray key would
    // reach the UI as an unlabelled row. Same guard as `normalizeConversationTags`.
    topics: topicResultRows.flatMap((row) => {
      const key = String(row.topic ?? '')
      return isConversationTagKey(key)
        ? [{ topic: key, up: Number(row.up), down: Number(row.down), voters: Number(row.voters) }]
        : []
    }),
    turns,
  }
}

/**
 * The drill-in, on its own so the digest can sample BOTH directions without
 * paying for a second set of aggregates.
 *
 * LEFT JOINs throughout: a vote whose turn was never persisted still has to
 * appear, because unexplained feedback is precisely what the surface exists to
 * show. The question is the newest user turn before the answer — a lateral, so
 * one row per vote rather than a fan-out over the conversation.
 *
 * `verdict` is a parameter rather than a literal so the praised list and the
 * failed list are the SAME query. Two near-identical queries would drift, and
 * the half that drifts is always the one nobody is watching.
 *
 * Cross-tenant like `getFeedbackHealth`, and reachable only through it or
 * through the digest — both of which sit behind `requirePlatformPermission`.
 */
export async function listFeedbackTurns(
  filters: FeedbackHealthFilters = {},
): Promise<FeedbackTurn[]> {
  const {
    windowDays = FEEDBACK_HEALTH_WINDOW_DAYS,
    verdict = 'down',
    reason = null,
    organizationId = null,
    topic = null,
    query = null,
    limit: recentLimit = FEEDBACK_HEALTH_RECENT_LIMIT,
  } = filters
  const db = getDb()
  const since = windowStart(windowDays)

  const result = await db.execute(sql`
    select
      f.id,
      f.organization_id,
      f.project_id,
      f.conversation_id,
      f.message_id,
      f.verdict,
      f.reason,
      f.created_at,
      m.content    as answer,
      q.content    as question,
      c.title      as conversation_title,
      c.tags       as topics
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
    where f.verdict = ${verdict}
      and f.created_at >= ${since}::timestamptz
      ${organizationId ? sql`and f.organization_id = ${organizationId}` : sql``}
      ${topic ? sql`and c.tags @> array[${topic}]::text[]` : sql``}
      ${reason && verdict === 'down' ? sql`and f.reason = ${reason}` : sql``}
      ${
        query
          ? sql`and (m.content ilike ${'%' + query + '%'} or q.content ilike ${'%' + query + '%'})`
          : sql``
      }
    order by f.created_at desc
    limit ${recentLimit}
  `)

  const rows = rowsOf(result)
  return rows.map((row) => ({
    id: String(row.id),
    organizationId: String(row.organization_id),
    projectId: (row.project_id as string | null) ?? null,
    conversationId: (row.conversation_id as string | null) ?? null,
    messageId: String(row.message_id),
    verdict: row.verdict as AnswerFeedbackVerdict,
    reason: (row.reason as AnswerFeedbackReason | null) ?? null,
    // Raw `sql` results are not runtime-validated — coerce at this boundary.
    createdAt: new Date(row.created_at as string),
    answer: (row.answer as string | null) ?? null,
    question: (row.question as string | null) ?? null,
    conversationTitle: (row.conversation_title as string | null) ?? null,
    topics: Array.isArray(row.topics)
      ? (row.topics as unknown[]).map(String).filter(isConversationTagKey)
      : [],
  }))
}
