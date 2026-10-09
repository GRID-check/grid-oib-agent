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
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  answerFeedback,
  type AnswerFeedback,
  type AnswerFeedbackReason,
  type AnswerFeedbackVerdict,
} from '@/lib/db/schema'
import { isConversationTagKey, type ConversationTagKey } from '@/lib/conversations/tags'
import { executeRows } from '@/lib/db/execute-rows'
import { VOTED_TURN_JOINS, votedConversationId } from './turn-join'
import { feedbackWindowStart } from './trend'
import { likeContains } from '@/lib/text/like-pattern'
import { isTraceId } from '@/lib/langfuse/config'

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
 * Days of history the health read covers, and the cap on the drill-in list.
 *
 * Both bounded for the same reason every list here is: this table grows with
 * every thumb in the product and a platform page must not be the one query
 * that scans it whole.
 */
export const FEEDBACK_HEALTH_WINDOW_DAYS = 30
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

/** `votedConversationId` for a raw query that aliases the feedback row `f`. */
const FEEDBACK_CONVERSATION = votedConversationId({
  messageId: sql`f.message_id`,
  conversationId: sql`f.conversation_id`,
  organizationId: sql`f.organization_id`,
})

/** A down-vote without a reason is an `other`; one expression, used by the count and the filter. */
const REASON_OR_OTHER = sql<AnswerFeedbackReason>`coalesce(${answerFeedback.reason}, 'other')`

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
  return executeRows(result)
}

/**
 * Start of the health window, as an ISO instant: UTC midnight, N-1 days back,
 * the same calendar days the chart draws (`feedbackWindowStart`).
 */
function windowStart(days: number): string {
  return feedbackWindowStart(days).toISOString()
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
  //
  // The conversation is the voted answer's (`votedConversationId`), not the
  // client's `conversation_id`, and it must be the voter's organization's: the
  // client's text could otherwise borrow another tenant's tags.
  const orgScope = organizationId ? [eq(answerFeedback.organizationId, organizationId)] : []
  const topicScope = topic
    ? [
        sql`exists (
          select 1 from conversations tc
          where tc.id = ${votedConversationId({
            messageId: sql`${answerFeedback.messageId}`,
            conversationId: sql`${answerFeedback.conversationId}`,
            organizationId: sql`${answerFeedback.organizationId}`,
          })}
            and tc.organization_id = ${answerFeedback.organizationId}
            and tc.tags @> array[${topic}]::text[]
        )`,
      ]
    : []
  const scope = [...orgScope, ...topicScope]
  const inWindow = gte(answerFeedback.createdAt, sql`${since}::timestamptz`)

  // The denominator: every answer the window is about. That is the answers
  // PRODUCED in it (persisted assistant messages) united with the answers RATED
  // in it, deduplicated by id. Counting only the produced ones let coverage pass
  // 100%: a vote today on last month's answer, a turn whose row was never
  // persisted, and two people rating one answer all added to the numerator and
  // never to the denominator. With the union, `ratedAnswers <= answers` holds by
  // construction.
  //
  // Both halves obey the org and topic filters, or a tenant's coverage is
  // computed over the whole platform's answers. `messages` carries its
  // organization through its conversation (NOT NULL, FK), so the join drops
  // nothing when nothing is filtered; the rated half takes the same EXISTS the
  // vote aggregates use.
  const coverageRows = await db.execute(sql`
    with produced as (
      select m.id::text as message_id
      from messages m
      join conversations c on c.id = m.conversation_id
      where m.role = 'assistant'
        and m.created_at >= ${since}::timestamptz
        ${organizationId ? sql`and c.organization_id = ${organizationId}` : sql``}
        ${topic ? sql`and c.tags @> array[${topic}]::text[]` : sql``}
    ),
    rated as (
      select distinct f.message_id
      from answer_feedback f
      where f.created_at >= ${since}::timestamptz
        ${organizationId ? sql`and f.organization_id = ${organizationId}` : sql``}
        ${
          topic
            ? sql`and exists (
                select 1 from conversations tc
                where tc.id = ${FEEDBACK_CONVERSATION}
                  and tc.organization_id = f.organization_id
                  and tc.tags @> array[${topic}]::text[]
              )`
            : sql``
        }
    )
    select
      (select count(*) from (select message_id from produced union select message_id from rated) u) as answers,
      (select count(*) from rated) as rated_answers
  `)
  const [coverageRow] = rowsOf(coverageRows)
  const answers = Number(coverageRow?.answers ?? 0)
  const ratedAnswers = Number(coverageRow?.rated_answers ?? 0)

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
      reason: REASON_OR_OTHER,
      count: sql<string>`count(*)`,
    })
    .from(answerFeedback)
    .where(and(eq(answerFeedback.verdict, 'down'), inWindow, ...scope))
    .groupBy(REASON_OR_OTHER)

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
    .orderBy(desc(sql`count(*) filter (where ${answerFeedback.verdict} = 'down')`), desc(sql`count(*)`))
    .limit(FEEDBACK_ORG_ROLLUP_LIMIT)

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
    join conversations c
      on c.id = ${FEEDBACK_CONVERSATION}
     and c.organization_id = f.organization_id
    cross join lateral unnest(c.tags) as tag
    where f.created_at >= ${since}::timestamptz
      ${organizationId ? sql`and f.organization_id = ${organizationId}` : sql``}
      ${topic ? sql`and c.tags @> array[${topic}]::text[]` : sql``}
    group by tag
    order by count(*) desc
    limit ${FEEDBACK_TOPIC_ROLLUP_LIMIT}
  `)

  const turns = await listFeedbackTurns(filters)

  const topicResultRows = rowsOf(topicRows)

  return {
    windowDays,
    answers,
    ratedAnswers,
    coverage: answers > 0 ? ratedAnswers / answers : null,
    totals: {
      up: Number(totalsRow?.up ?? 0),
      down: Number(totalsRow?.down ?? 0),
      voters: Number(totalsRow?.voters ?? 0),
      downVoters: Number(totalsRow?.downVoters ?? 0),
    },
    reasons: reasons.map((r) => ({ reason: String(r.reason) as AnswerFeedbackReason, count: Number(r.count) })),
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
 * show. The answer and its question come from `VOTED_TURN_JOINS` (`./turn-join`),
 * shared with the lesson sweep: no answer row, no question.
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
    limit = FEEDBACK_HEALTH_RECENT_LIMIT,
  } = filters
  // The caller picks the size, the repository owns the bound: one row over the
  // export cap is the most anyone may ask for (that row is how "exactly full"
  // is told apart from "truncated").
  const recentLimit = Math.max(0, Math.min(limit, FEEDBACK_EXPORT_ROW_CAP + 1))
  const db = getDb()
  const since = windowStart(windowDays)

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
    from answer_feedback f
    ${VOTED_TURN_JOINS}
    left join conversations c
      on c.id = coalesce(m.conversation_id, f.conversation_id)
     and c.organization_id = f.organization_id
    where f.verdict = ${verdict}
      and f.created_at >= ${since}::timestamptz
      ${organizationId ? sql`and f.organization_id = ${organizationId}` : sql``}
      ${topic ? sql`and c.tags @> array[${topic}]::text[]` : sql``}
      ${reason && verdict === 'down' ? sql`and coalesce(f.reason, 'other') = ${reason}` : sql``}
      ${
        query
          ? sql`and (m.content ilike ${likeContains(query)} or q.content ilike ${likeContains(query)})`
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
 * Where the weekly summary starts: the Monday of the ISO week `windowDays`
 * ago, so the first row is a whole week. One function for the query and the
 * file name, so the name never claims a different start than the rows.
 */
export function weeklyWindowStart(windowDays: number, now: Date = new Date()): string {
  return isoWeekStart(new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000))
}

/** Monday 00:00 UTC of the ISO week containing `instant`, as an ISO instant. */
export function isoWeekStart(instant: Date): string {
  const day = (instant.getUTCDay() + 6) % 7 // Monday = 0
  return new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate() - day),
  ).toISOString()
}

/**
 * Answers, rated answers, up-votes and down-votes per organization and ISO week.
 *
 * The vote rows cannot say how often an answer fails; this is the denominator,
 * taken from the same two tables and with the same definition the page's
 * coverage uses: the answers PRODUCED in a week (assistant `messages`, joined
 * to their conversation for the organization) united with the answers RATED in
 * it, deduplicated by id, so `ratedAnswers <= answers` holds in every row. The
 * votes are counted on their own and joined per bucket, so a vote is never
 * multiplied by a message count. The window starts on the Monday of the week
 * `windowDays` ago, so no row is a partial week at the front. Weeks are UTC,
 * like every other bucket in the BFF, and a vote counts in the week of its
 * FIRST cast (`created_at`), as on the page.
 *
 * Cross-tenant like `getFeedbackHealth`; reachable only through
 * `getAnswerFeedbackWeeklySummary` and the workbook, which sit behind the
 * platform permission.
 */
export async function getFeedbackWeeklySummary(
  filters: Pick<FeedbackHealthFilters, 'windowDays' | 'organizationId'> = {},
): Promise<FeedbackWeeklySummary> {
  const { windowDays = FEEDBACK_HEALTH_WINDOW_DAYS, organizationId = null } = filters
  const db = getDb()
  const since = weeklyWindowStart(windowDays)

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
        ${organizationId ? sql`and c.organization_id = ${organizationId}` : sql``}
    ),
    votes as (
      select
        f.organization_id,
        date_trunc('week', f.created_at at time zone 'UTC') as week,
        f.message_id,
        f.verdict
      from answer_feedback f
      where f.created_at >= ${since}::timestamptz
        ${organizationId ? sql`and f.organization_id = ${organizationId}` : sql``}
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
