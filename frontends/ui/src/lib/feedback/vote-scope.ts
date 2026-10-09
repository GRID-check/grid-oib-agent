/**
 * Which votes a ratings request covers, as SQL: the FROM, the joins and the
 * WHERE every read on the ratings tab shares — the figures, the bars, the
 * drill-in, the digest's samples, the export's rows and totals, and the count
 * the export dialog shows.
 *
 * One fragment, because each of those used to carry its own WHERE, and the
 * export's had already drifted from the page's once (it ignored the page's
 * organization). Now a filter is added here or nowhere.
 *
 * Every join is at most one row per vote: the answer `m` by its primary key,
 * the question `q` limited to one, the conversation `c` and the task run `tr`
 * by their primary keys. So a `count(*)` over this scope counts votes, and the
 * filters on joined columns (topic, project, mode, confidence, free text) never
 * multiply a vote. Each join is pinned to the voter's organization
 * (`./turn-join` says why that matters under the platform bypass).
 *
 * Expects nothing and exposes the aliases `f` (the vote), `m`, `c`, `tr` and,
 * with `question`, `q`.
 */

import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { scopeBounds } from '@/lib/quality/scope'
import { likeContains } from '@/lib/text/like-pattern'
import type { FeedbackQuery } from './filters'
import { answerIdOf, VOTED_ANSWER_JOIN, VOTED_QUESTION_JOIN } from './turn-join'

/** `$1, $2, …` for an IN list. Callers never pass an empty list. */
export function sqlList(values: readonly string[]): SQL {
  return sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )
}

/** The project a vote belongs to: its own, else its conversation's. */
export const VOTE_PROJECT = sql`coalesce(f.project_id, c.project_id)`

/** The backend job of a deep-research answer, from its provenance or its run. */
export const ANSWER_JOB_ID = sql`nullif(coalesce(m.metadata->'provenance'->>'deepResearchJobId', tr.backend_job_id), '')`

/** How the answer was produced, as the export's `answer_mode` names it. */
export const ANSWER_MODE = sql`(case when ${ANSWER_JOB_ID} is not null then 'report' else m.metadata->'provenance'->>'routingDecision' end)`

/** The confidence the answer showed. */
export const ANSWER_CONFIDENCE = sql`(m.metadata->'provenance'->>'answerConfidence')`

/** A note is text with something in it; a voter who typed spaces wrote nothing. */
const hasText = (column: SQL): SQL => sql`nullif(btrim(${column}), '') is not null`

export interface VoteScopeOptions {
  /** Join the question too (rows that show it, or a search that reads it). */
  question?: boolean
  /** Apply only the scope (dates, organizations, projects), not the ratings filters. */
  scopeOnly?: boolean
  /** More joins after the shared ones, before the WHERE (a topic fan-out, say). */
  extraJoins?: SQL
}

/**
 * `from … where …` for the votes a request covers. A search reads the question,
 * so it brings the question join along whether or not the caller selects it.
 */
export function voteScope(query: FeedbackQuery, options: VoteScopeOptions = {}): SQL {
  const { scope } = query
  const ratings = options.scopeOnly ? null : query.ratings
  const { start, endExclusive } = scopeBounds(scope)
  const withQuestion = options.question || Boolean(ratings?.query)
  const conditions: SQL[] = [
    sql`f.created_at >= ${start.toISOString()}::timestamptz`,
    sql`f.created_at < ${endExclusive.toISOString()}::timestamptz`,
  ]
  if (scope.organizationIds.length) conditions.push(sql`f.organization_id in (${sqlList(scope.organizationIds)})`)
  if (scope.projectIds.length) conditions.push(sql`${VOTE_PROJECT} in (${sqlList(scope.projectIds)})`)
  if (ratings) conditions.push(...ratingsConditions(ratings))

  return sql`
    from answer_feedback f
    ${VOTED_ANSWER_JOIN}
    ${withQuestion ? VOTED_QUESTION_JOIN : sql``}
    left join conversations c
      on c.id = coalesce(m.conversation_id, f.conversation_id)
     and c.organization_id = f.organization_id
    left join task_runs tr
      on tr.id = ${answerIdOf(sql`m.run_id`)}
     and tr.organization_id = m.organization_id
    ${options.extraJoins ?? sql``}
    where ${sql.join(conditions, sql` and `)}
  `
}

function ratingsConditions(ratings: FeedbackQuery['ratings']): SQL[] {
  const conditions: SQL[] = []
  if (ratings.verdict) conditions.push(sql`f.verdict = ${ratings.verdict}`)
  if (ratings.reasons.length) {
    // A down-vote without a chip counts as `other`, as on the page; a reason
    // only exists on a down-vote, so asking for one asks for down-votes.
    conditions.push(sql`f.verdict = 'down'`)
    conditions.push(sql`coalesce(f.reason, 'other') in (${sqlList(ratings.reasons)})`)
  }
  // Any of the topics: the conversation's tags overlap the chosen ones.
  if (ratings.topics.length) conditions.push(sql`c.tags && array[${sqlList(ratings.topics)}]::text[]`)
  if (ratings.modes.length) conditions.push(sql`${ANSWER_MODE} in (${sqlList(ratings.modes)})`)
  if (ratings.confidences.length) conditions.push(sql`${ANSWER_CONFIDENCE} in (${sqlList(ratings.confidences)})`)
  if (ratings.hasComment) conditions.push(hasText(sql`f.comment`))
  if (ratings.hasExpectedAnswer) conditions.push(hasText(sql`f.expected_answer`))
  if (ratings.query) {
    const pattern = likeContains(ratings.query)
    conditions.push(sql`(m.content ilike ${pattern} or q.content ilike ${pattern})`)
  }
  return conditions
}
