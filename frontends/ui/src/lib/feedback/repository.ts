/**
 * Feedback repository — the module that queries the `answer_feedback` table
 * (ADR-0017, WS-7), with its sibling `./export-repository` for the export's
 * wider joins and the lesson sweep's read in `lib/platform-lessons`.
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
import { and, desc, eq, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  answerFeedback,
  type AnswerFeedback,
  type AnswerFeedbackReason,
  type AnswerFeedbackVerdict,
} from '@/lib/db/schema'
import { isConversationTagKey, type ConversationTagKey } from '@/lib/conversations/tags'
import { executeRows } from '@/lib/db/execute-rows'
import { rangeDays, scopeBounds, type QualityScope } from '@/lib/quality/scope'
import type { FeedbackQuery, RatingsFilters } from './filters'
import { VOTED_ANSWER_JOIN } from './turn-join'
import { OUTSIDE_RESTRICTED_USE, sqlList, VOTE_PROJECT, voteScope } from './vote-scope'
import { isTraceId } from '@/lib/langfuse/config'

/** Re-exported for the readers that already import it from here (`platform-lessons`). */
export { OUTSIDE_RESTRICTED_USE }

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
  expectedAnswer: string | null
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
        expectedAnswer: values.expectedAnswer,
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

/**
 * Toggle-off: delete the caller's vote. Returns the deleted row's id, or null
 * when there was none. The id is what the vote's Langfuse score is keyed by.
 */
export async function deleteAnswerFeedbackForUser(
  userId: string,
  messageId: string,
  organizationId: string,
): Promise<string | null> {
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
  return rows[0]?.id ?? null
}

/** An answer id as the agent mints it: a UUID (`turn.response.answer_message_id`). */
const ANSWER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The trace the answer was produced in, as its persisted row names it
 * (`metadata.trace_id`, written by the agent: `observability/turn_trace.py`),
 * or null. Read, never derived: a row that does not name its trace is one whose
 * trace nobody recorded, and a guessed id would score or link a trace that may
 * not exist.
 *
 * Tenant-scoped like every other read here. Null for an id that is not a UUID
 * (`messages.id` is one, and the cast would otherwise throw).
 */
export async function getAnswerTraceId(messageId: string, organizationId: string): Promise<string | null> {
  if (!ANSWER_ID.test(messageId)) return null
  const db = getDb()
  const rows = rowsOf(
    await db.execute(sql`
      select metadata->>'trace_id' as trace_id
      from messages
      where id = ${messageId}::uuid
        and organization_id = ${organizationId}
        and role = 'assistant'
      limit 1
    `),
  )
  const traceId = rows[0]?.trace_id
  return isTraceId(traceId) ? traceId : null
}

/**
 * Whether a stored vote sits on a conversation that drew on a restricted folder
 * (`OUTSIDE_RESTRICTED_USE` turned around). The Langfuse score of such a vote
 * carries its number and reason chip, never the voter's words: those may quote
 * the folder, and Langfuse's readers are platform staff outside its audience.
 */
export async function isRestrictedUseVote(feedbackId: string, organizationId: string): Promise<boolean> {
  const rows = rowsOf(
    await getDb().execute(sql`
      select 1
      from answer_feedback f
      where f.id = ${feedbackId}
        and f.organization_id = ${organizationId}
        and not (${OUTSIDE_RESTRICTED_USE})
      limit 1
    `),
  )
  return rows.length > 0
}

/**
 * The conversation a persisted answer belongs to, in the caller's organization,
 * or null when there is no such answer row (yet).
 *
 * The vote path stores THIS conversation rather than the one the client sent:
 * `answer_feedback.conversation_id` is otherwise whatever text came with the
 * request, and every reader that joins on it (topics, titles) would trust it.
 * Null is not a refusal. A shallow turn may never be persisted, and a deep one
 * is written after the vote can already be cast, so a vote on a turn without a
 * row keeps the client's value; the readers prefer the answer row's
 * conversation whenever one exists (`votedConversationId`). Another tenant's
 * answer is invisible here by construction (the WHERE and row-level security
 * both say so), which is why the readers also pin the join to the voter's
 * organization (`VOTED_TURN_JOINS`).
 */
export async function getPersistedAnswerConversationId(
  messageId: string,
  organizationId: string,
): Promise<string | null> {
  if (!ANSWER_ID.test(messageId)) return null
  const db = getDb()
  const rows = rowsOf(
    await db.execute(sql`
      select conversation_id
      from messages
      where id = ${messageId}::uuid
        and organization_id = ${organizationId}
        and role = 'assistant'
      limit 1
    `),
  )
  const conversationId = rows[0]?.conversation_id
  return typeof conversationId === 'string' && conversationId ? conversationId : null
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
 * The cap on the drill-in list. The window itself is the page's scope
 * (`@/lib/quality/scope`), at most `QUALITY_MAX_RANGE_DAYS` long.
 *
 * Bounded for the same reason every list here is: this table grows with every
 * thumb in the product and a platform page must not be the one query that
 * scans it whole.
 */
export const FEEDBACK_HEALTH_RECENT_LIMIT = 50

/**
 * Ceiling on the export's rows. The export is the analysis that does not fit
 * on a page, so it cannot share the page's 50, but it is still a list and still
 * bounded; the service reports when it was reached instead of truncating quietly.
 */
export const FEEDBACK_EXPORT_ROW_CAP = 5000

/**
 * Ceilings on the two rollups, which group by a value the table does not bound:
 * organizations grow with the customer list, and topic tags are written by an
 * LLM (unknown keys are dropped only after the read). Ordered by volume, so a
 * cut drops the quietest rows, never the ones the page leads with.
 */
export const FEEDBACK_ORG_ROLLUP_LIMIT = 500
export const FEEDBACK_TOPIC_ROLLUP_LIMIT = 100

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

/**
 * Down-votes per reason chip. Never a null reason: a down-vote with no chip
 * (the reason arrives on a later click, or never) counts as `other`, in SQL, so
 * the rows sum to `totals.down`. Before, NULL and `other` came back as two rows
 * and every reader that keyed them by reason kept whichever came last.
 */
export interface FeedbackReasonCount {
  reason: AnswerFeedbackReason
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
  /** The down-vote's free text, when the voter wrote one. */
  comment: string | null
  /** What the voter says a good answer would have contained. */
  expectedAnswer: string | null
  createdAt: Date
  /** The answer that was voted on, when its message row exists. */
  answer: string | null
  /** The user turn immediately preceding it — the question that was asked. */
  question: string | null
  conversationTitle: string | null
  /** The conversation's topic tags, when it has a row and was tagged. */
  topics: ConversationTagKey[]
  /**
   * The Langfuse trace the answer was produced in, as its row names it
   * (`metadata.trace_id`); null when the row is missing or predates the field.
   */
  traceId: string | null
}

export interface FeedbackHealth {
  /** The scope's first and last day, `YYYY-MM-DD`, UTC, inclusive. */
  from: string
  to: string
  /** Days from `from` to `to`, inclusive. */
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
   * Counted as the answers PRODUCED in the window (persisted assistant
   * messages) united with the answers RATED in it, so a vote on an older or an
   * unpersisted answer brings its answer into the denominator too. Persistence
   * is best-effort per turn, so this can still under-count unrated answers.
   */
  answers: number
  /** Distinct answers that received at least one vote in the window. Never more than `answers`. */
  ratedAnswers: number
  /**
   * `ratedAnswers / answers`, a fraction in [0, 1]; `null` when there were no
   * answers, which is "no reading", not 0 %. This, and not votes over answers,
   * is the coverage figure: votes exceed answers whenever two people rate one,
   * and that ratio passed 100 %.
   */
  coverage: number | null
  totals: FeedbackHealthTotals
  reasons: FeedbackReasonCount[]
  daily: FeedbackDailyPoint[]
  organizations: FeedbackOrgRollup[]
  topics: FeedbackTopicRollup[]
  /** The drill-in: the newest matching votes, both directions unless the filters name one. */
  turns: FeedbackTurn[]
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
  return executeRows(result)
}

/** `count(*) filter (…)` pairs every aggregate below reads. */
const VERDICT_COUNTS = sql`
  count(*) filter (where f.verdict = 'up')   as up,
  count(*) filter (where f.verdict = 'down') as down
`

/**
 * The whole platform view in one round trip's worth of queries.
 *
 * Every figure is read over the SAME votes (`voteScope`): the scope the page
 * header set and every ratings filter. That is what makes a filter on the tab a
 * filter on the tab, rather than on the list at the bottom of it — before, the
 * reason and the search narrowed only the drill-in, and the headline above it
 * described a different set of votes than the rows below.
 *
 * See the tenancy note above: this is the deliberate cross-org read, and
 * `getAnswerFeedbackHealth` / `getAnswerFeedbackDigest` are the only callers.
 */
export async function getFeedbackHealth(
  query: FeedbackQuery,
  options: { turnLimit?: number } = {},
): Promise<FeedbackHealth> {
  const db = getDb()
  const { scope, ratings } = query
  const votes = voteScope(query)
  const { start, endExclusive } = scopeBounds(scope)

  // The denominator: every answer the window is about. That is the answers
  // PRODUCED in it (persisted assistant messages) united with the answers RATED
  // in it, deduplicated by id. Counting only the produced ones let coverage pass
  // 100%: a vote today on last month's answer, a turn whose row was never
  // persisted, and two people rating one answer all added to the numerator and
  // never to the denominator. With the union, `ratedAnswers <= answers` holds by
  // construction.
  //
  // The produced half honours what an ANSWER can be filtered by: the scope
  // (dates, organizations, projects) and the topic. What only a vote has (its
  // verdict, reason, note) narrows the rated half alone, so under such a filter
  // coverage reads "share of answers that drew a matching vote".
  const coverageRows = await db.execute(sql`
    with produced as (
      select m.id::text as message_id
      from messages m
      join conversations c on c.id = m.conversation_id
      where m.role = 'assistant'
        and m.created_at >= ${start.toISOString()}::timestamptz
        and m.created_at < ${endExclusive.toISOString()}::timestamptz
        ${scope.organizationIds.length ? sql`and c.organization_id in (${sqlList(scope.organizationIds)})` : sql``}
        ${scope.projectIds.length ? sql`and c.project_id in (${sqlList(scope.projectIds)})` : sql``}
        ${ratings.topics.length ? sql`and c.tags && array[${sqlList(ratings.topics)}]::text[]` : sql``}
    ),
    rated as (
      select distinct f.message_id
      ${votes}
    )
    select
      (select count(*) from (select message_id from produced union select message_id from rated) u) as answers,
      (select count(*) from rated) as rated_answers
  `)
  const [coverageRow] = rowsOf(coverageRows)
  const answers = Number(coverageRow?.answers ?? 0)
  const ratedAnswers = Number(coverageRow?.rated_answers ?? 0)

  const [totalsRow] = rowsOf(
    await db.execute(sql`
      select
        ${VERDICT_COUNTS},
        count(distinct f.user_id)                                    as voters,
        count(distinct f.user_id) filter (where f.verdict = 'down')  as down_voters
      ${votes}
    `),
  )

  // A down-vote without a chip counts as `other`, in SQL, so the rows sum to
  // the down-votes (see `FeedbackReasonCount`).
  const reasonRows = rowsOf(
    await db.execute(sql`
      select coalesce(f.reason, 'other') as reason, count(*) as count
      ${votes}
        and f.verdict = 'down'
      group by 1
    `),
  )

  // UTC-pinned, like every other day bucket in the BFF: `date_trunc` on a
  // timestamptz follows the SESSION timezone, so without this the day
  // boundaries move with whatever the connection happens to be set to.
  const dailyRows = rowsOf(
    await db.execute(sql`
      select to_char(date_trunc('day', f.created_at at time zone 'UTC'), 'YYYY-MM-DD') as day, ${VERDICT_COUNTS}
      ${votes}
      group by 1
      order by 1
    `),
  )

  const organizationRows = rowsOf(
    await db.execute(sql`
      select f.organization_id, ${VERDICT_COUNTS}, count(distinct f.user_id) as voters
      ${votes}
      group by f.organization_id
      order by down desc, count(*) desc, f.organization_id
      limit ${FEEDBACK_ORG_ROLLUP_LIMIT}
    `),
  )

  // Votes by topic. `unnest` fans a conversation out over its tags on purpose —
  // here the tag IS the grouping key, so a two-tag conversation legitimately
  // counts once under each. That is also why this cannot be folded into the
  // totals query: the same fan-out there would double-count the headline.
  const topicRows = rowsOf(
    await db.execute(sql`
      select tag as topic, ${VERDICT_COUNTS}, count(distinct f.user_id) as voters
      ${voteScope(query, { extraJoins: sql`cross join lateral unnest(c.tags) as tag` })}
      group by tag
      order by count(*) desc
      limit ${FEEDBACK_TOPIC_ROLLUP_LIMIT}
    `),
  )

  const turnLimit = options.turnLimit ?? FEEDBACK_HEALTH_RECENT_LIMIT
  const turns = turnLimit > 0 ? await listFeedbackTurns(query, { limit: turnLimit }) : []

  return {
    from: scope.from,
    to: scope.to,
    windowDays: rangeDays(scope.from, scope.to),
    answers,
    ratedAnswers,
    coverage: answers > 0 ? ratedAnswers / answers : null,
    totals: {
      up: Number(totalsRow?.up ?? 0),
      down: Number(totalsRow?.down ?? 0),
      voters: Number(totalsRow?.voters ?? 0),
      downVoters: Number(totalsRow?.down_voters ?? 0),
    },
    reasons: reasonRows.map((row) => ({
      reason: String(row.reason) as AnswerFeedbackReason,
      count: Number(row.count ?? 0),
    })),
    daily: dailyRows.map((row) => ({ day: String(row.day), up: Number(row.up ?? 0), down: Number(row.down ?? 0) })),
    organizations: organizationRows.map((row) => ({
      organizationId: String(row.organization_id),
      up: Number(row.up ?? 0),
      down: Number(row.down ?? 0),
      voters: Number(row.voters ?? 0),
    })),
    // Unknown tags are dropped, not rendered: `conversations.tags` is written by
    // an LLM and backfilled rows predate the vocabulary, so a stray key would
    // reach the UI as an unlabelled row. Same guard as `normalizeConversationTags`.
    topics: topicRows.flatMap((row) => {
      const key = String(row.topic ?? '')
      return isConversationTagKey(key)
        ? [{ topic: key, up: Number(row.up ?? 0), down: Number(row.down ?? 0), voters: Number(row.voters ?? 0) }]
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
 * show. The answer and its question come from `VOTED_TURN_JOINS` (`./turn-join`),
 * shared with the lesson sweep: no answer row, no question.
 *
 * The same votes as the figures (`voteScope`); both directions unless the
 * request names one. `verdict` here is the digest's sampling override, and it
 * may only NARROW: a request already limited to one direction is not widened to
 * the other.
 *
 * Cross-tenant like `getFeedbackHealth`, and reachable only through it or
 * through the digest — both of which sit behind `requirePlatformPermission`.
 *
 * A content-bearing read, so it leaves out votes on an answer whose
 * conversation drew on a restricted folder (`voteScope`'s `contentBearing`,
 * the database's `grid_feedback_restricted_use`, as the export's rows do).
 * The aggregates above still count them: a count quotes nothing. A vote that
 * names a restricted chat is not returned at all, so no row carries the title
 * the staff profiler withholds; otherwise the answer row's conversation is
 * the authority, the vote's own `conversation_id` the fallback (`voteScope`).
 */
export async function listFeedbackTurns(
  query: FeedbackQuery,
  options: { limit?: number; verdict?: AnswerFeedbackVerdict } = {},
): Promise<FeedbackTurn[]> {
  const { ratings } = query
  if (options.verdict && ratings.verdict && options.verdict !== ratings.verdict) return []
  if (options.verdict === 'up' && ratings.reasons.length) return []
  const narrowed: FeedbackQuery = options.verdict
    ? { ...query, ratings: { ...ratings, verdict: options.verdict } }
    : query
  // The caller picks the size, the repository owns the bound: one row over the
  // export cap is the most anyone may ask for (that row is how "exactly full"
  // is told apart from "truncated").
  const limit = options.limit ?? FEEDBACK_HEALTH_RECENT_LIMIT
  const recentLimit = Math.max(0, Math.min(limit, FEEDBACK_EXPORT_ROW_CAP + 1))
  const db = getDb()

  const result = await db.execute(sql`
    select
      f.id,
      f.organization_id,
      f.project_id,
      coalesce(m.conversation_id, f.conversation_id) as conversation_id,
      f.message_id,
      f.verdict,
      f.reason,
      f.comment,
      f.expected_answer,
      f.created_at,
      m.content    as answer,
      q.content    as question,
      c.title      as conversation_title,
      c.tags       as topics,
      m.metadata->>'trace_id' as trace_id
    ${voteScope(narrowed, { question: true, contentBearing: true })}
    order by f.created_at desc, f.id
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
    comment: typeof row.comment === 'string' && row.comment.trim() ? row.comment : null,
    expectedAnswer:
      typeof row.expected_answer === 'string' && row.expected_answer.trim()
        ? row.expected_answer
        : null,
    // Raw `sql` results are not runtime-validated — coerce at this boundary.
    createdAt: new Date(row.created_at as string),
    answer: (row.answer as string | null) ?? null,
    question: (row.question as string | null) ?? null,
    conversationTitle: (row.conversation_title as string | null) ?? null,
    topics: Array.isArray(row.topics)
      ? (row.topics as unknown[]).map(String).filter(isConversationTagKey)
      : [],
    traceId: isTraceId(row.trace_id) ? row.trace_id : null,
  }))
}

/* ------------------------------------------------------------------ *
 * Weekly rate inputs — the export's denominator
 * ------------------------------------------------------------------ */

/**
 * Cap on the weekly summary: 90 days is 14 ISO weeks, so this is orgs x 14 with
 * room to spare. Reached, it is reported (`FeedbackWeeklySummary.truncated`),
 * never applied quietly, and the rows are ordered newest week first, so what
 * the cap drops is the OLDEST weeks rather than an arbitrary slice of tenants.
 */
export const FEEDBACK_WEEKLY_SUMMARY_LIMIT = 5000

/** One organization in one ISO week: what a failure rate is computed from. */
export interface FeedbackWeeklyCount {
  organizationId: string
  /** ISO week label, e.g. `2026-W41`. */
  isoWeek: string
  /** The Monday that week starts on (UTC), `YYYY-MM-DD`. */
  weekStart: string
  /**
   * The answers the week is about: produced in it (persisted assistant
   * messages) united with the answers rated in it — the page's coverage
   * denominator (`FeedbackHealth.answers`), bucketed by week.
   */
  answers: number
  /** Distinct answers that received at least one vote in the week. Never more than `answers`. */
  ratedAnswers: number
  up: number
  down: number
}

/** The weekly rows, and whether the cap cut them. */
export interface FeedbackWeeklySummary {
  weeks: FeedbackWeeklyCount[]
  /** True when the window held more than `FEEDBACK_WEEKLY_SUMMARY_LIMIT` rows; the oldest weeks were dropped. */
  truncated: boolean
  cap: number
}

/**
 * Where the weekly summary starts: the Monday of the ISO week the scope's first
 * day falls in, so the first row is a whole week. One function for the query
 * and the file name, so the name never claims a different start than the rows.
 */
export function weeklyWindowStart(scope: Pick<QualityScope, 'from'>): string {
  return isoWeekStart(new Date(`${scope.from}T00:00:00Z`))
}

/** Monday 00:00 UTC of the ISO week containing `instant`, as an ISO instant. */
export function isoWeekStart(instant: Date): string {
  const day = (instant.getUTCDay() + 6) % 7 // Monday = 0
  return new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate() - day),
  ).toISOString()
}

/**
 * Which ratings filters the weekly summary applies. A rate needs BOTH verdicts
 * and every answer as its denominator, so the filters that describe a vote
 * rather than an answer (verdict, reason, mode, confidence, the notes, the
 * search) cannot narrow it without turning the rate into something else. The
 * topic can: it is a property of the conversation, so answers and votes narrow
 * alike. The scope (dates, organizations, projects) always applies.
 */
export const WEEKLY_APPLIED_RATINGS_FILTERS = ['topics'] as const satisfies readonly (keyof RatingsFilters)[]

/**
 * Answers, rated answers, up-votes and down-votes per organization and ISO week.
 *
 * The vote rows cannot say how often an answer fails; this is the denominator,
 * taken from the same two tables and with the same definition the page's
 * coverage uses: the answers PRODUCED in a week (assistant `messages`, joined
 * to their conversation for the organization) united with the answers RATED in
 * it, deduplicated by id, so `ratedAnswers <= answers` holds in every row. The
 * votes are counted on their own and joined per bucket, so a vote is never
 * multiplied by a message count. The window starts on the Monday of the scope's
 * first week and ends with its last day, so no row is a partial week at the
 * front. Weeks are UTC, like every other bucket in the BFF, and a vote counts in
 * the week of its FIRST cast (`created_at`), as on the page.
 *
 * Applies the scope and the topic (`WEEKLY_APPLIED_RATINGS_FILTERS`); a vote's
 * project and topic are its conversation's, as everywhere on the tab.
 *
 * Cross-tenant like `getFeedbackHealth`; reachable only through
 * `getAnswerFeedbackWeeklyExport` and the workbook, which sit behind the
 * platform permission.
 */
export async function getFeedbackWeeklySummary(query: FeedbackQuery): Promise<FeedbackWeeklySummary> {
  const { scope, ratings } = query
  const db = getDb()
  const since = weeklyWindowStart(scope)
  const until = scopeBounds(scope).endExclusive.toISOString()
  const orgs = scope.organizationIds
  const projects = scope.projectIds
  const topics = ratings.topics

  const result = await db.execute(sql`
    with produced as (
      select
        c.organization_id,
        date_trunc('week', m.created_at at time zone 'UTC') as week,
        m.id::text as message_id
      from messages m
      join conversations c on c.id = m.conversation_id
      where m.role = 'assistant'
        and m.created_at >= ${since}::timestamptz
        and m.created_at < ${until}::timestamptz
        ${orgs.length ? sql`and c.organization_id in (${sqlList(orgs)})` : sql``}
        ${projects.length ? sql`and c.project_id in (${sqlList(projects)})` : sql``}
        ${topics.length ? sql`and c.tags && array[${sqlList(topics)}]::text[]` : sql``}
    ),
    votes as (
      select
        f.organization_id,
        date_trunc('week', f.created_at at time zone 'UTC') as week,
        f.message_id,
        f.verdict
      from answer_feedback f
      ${VOTED_ANSWER_JOIN}
      left join conversations c
        on c.id = coalesce(m.conversation_id, f.conversation_id)
       and c.organization_id = f.organization_id
      where f.created_at >= ${since}::timestamptz
        and f.created_at < ${until}::timestamptz
        ${orgs.length ? sql`and f.organization_id in (${sqlList(orgs)})` : sql``}
        ${projects.length ? sql`and ${VOTE_PROJECT} in (${sqlList(projects)})` : sql``}
        ${topics.length ? sql`and c.tags && array[${sqlList(topics)}]::text[]` : sql``}
    ),
    a as (
      select organization_id, week, count(*) as answers
      from (
        select organization_id, week, message_id from produced
        union
        select organization_id, week, message_id from votes
      ) u
      group by 1, 2
    ),
    v as (
      select
        organization_id,
        week,
        count(distinct message_id)                  as rated_answers,
        count(*) filter (where verdict = 'up')      as up,
        count(*) filter (where verdict = 'down')    as down
      from votes
      group by 1, 2
    )
    select
      a.organization_id,
      to_char(a.week, 'IYYY-"W"IW')   as iso_week,
      to_char(a.week, 'YYYY-MM-DD')   as week_start,
      a.answers,
      coalesce(v.rated_answers, 0)    as rated_answers,
      coalesce(v.up, 0)               as up,
      coalesce(v.down, 0)             as down
    from a
    left join v on v.organization_id = a.organization_id and v.week = a.week
    order by week_start desc, a.organization_id
    limit ${FEEDBACK_WEEKLY_SUMMARY_LIMIT + 1}
  `)

  // One row over the cap tells "exactly full" apart from "cut". Newest first,
  // so the rows that fall off are the oldest weeks.
  const rows = rowsOf(result)
  const truncated = rows.length > FEEDBACK_WEEKLY_SUMMARY_LIMIT
  // Raw `sql` results are not runtime-validated; counts arrive as strings.
  const weeks = rows.slice(0, FEEDBACK_WEEKLY_SUMMARY_LIMIT).map((row) => ({
    organizationId: String(row.organization_id),
    isoWeek: String(row.iso_week),
    weekStart: String(row.week_start),
    answers: Number(row.answers ?? 0),
    ratedAnswers: Number(row.rated_answers ?? 0),
    up: Number(row.up ?? 0),
    down: Number(row.down ?? 0),
  }))
  return { weeks, truncated, cap: FEEDBACK_WEEKLY_SUMMARY_LIMIT }
}
