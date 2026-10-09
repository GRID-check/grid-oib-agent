/**
 * The answer-feedback export's reads: one row per vote with everything the
 * platform knows about the turn it rated, and the totals of the same set.
 *
 * A sibling of `./repository` rather than more of it, because the export joins
 * five tables the page never needs (projects, the usage ledger, task runs and
 * the two lesson tables) and that file is already the page's. Same rules: raw
 * SQL coerced at this boundary, every list bounded, and cross-tenant only
 * because the platform owner's export is — reachable solely through
 * `getAnswerFeedbackWorkbookData` / `getAnswerFeedbackExport`, which sit behind
 * `requirePlatformPermission`.
 *
 * **Bounded and set-based.** The vote rows are selected once (`sel`, capped at
 * `FEEDBACK_EXPORT_ROW_CAP + 1`); usage and lessons are aggregated over that
 * set with GROUP BY in the same statement, so the cost does not grow with a
 * query per row.
 */

import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { executeRows } from '@/lib/db/execute-rows'
import type { AnswerFeedbackReason, AnswerFeedbackVerdict, PlatformLessonStatus } from '@/lib/db/schema'
import { isConversationTagKey, type ConversationTagKey } from '@/lib/conversations/tags'
import { sanitizeProvenance, type MessageProvenance } from '@/lib/conversations/message-provenance'
import { isTraceId } from '@/lib/langfuse/config'
import { likeContains } from '@/lib/text/like-pattern'
import { FEEDBACK_EXPORT_ROW_CAP } from './repository'
import { feedbackWindowStart } from './trend'
import { answerIdOf, VOTED_TURN_JOINS } from './turn-join'

/**
 * What the export covers. Unlike the page's filters, every field is explicit:
 * `verdict: null` means BOTH directions, which is what the default export is.
 */
export interface FeedbackExportFilters {
  windowDays: number
  verdict: AnswerFeedbackVerdict | null
  /** Only applied with `verdict: 'down'`, like the page. */
  reason: AnswerFeedbackReason | null
  organizationId: string | null
  topic: ConversationTagKey | null
  query: string | null
}

/** How the answer was produced. `report` is a deep-research run's answer. */
export type FeedbackAnswerMode = NonNullable<MessageProvenance['routingDecision']> | 'report'

/** `lesson_status`: the lesson's own status, or `skipped` when the pipeline looked and made none. */
export type FeedbackLessonStatus = PlatformLessonStatus | 'skipped'

/** One vote, with the turn it rated, as far as the joins reach. */
export interface FeedbackExportRow {
  feedbackId: string
  organizationId: string
  projectId: string | null
  projectName: string | null
  /** The project profile's `facts.bundesland.value`, when the profile has one. */
  bundesland: string | null
  /** The persisted answer's conversation, else the one the client sent. */
  conversationId: string | null
  /** True when that conversation has a row in the voter's organization. */
  conversationFound: boolean
  conversationTitle: string | null
  messageId: string
  /** sha256 of `organization_id:user_id`, first 12 hex digits. Never the user id. */
  voterKey: string
  verdict: AnswerFeedbackVerdict
  reason: AnswerFeedbackReason | null
  comment: string | null
  expectedAnswer: string | null
  /** First vote (`created_at`): what the window, the page and the weeks count by. */
  firstVotedAt: Date
  /** Latest vote (`updated_at`): a re-vote moves it. */
  votedAt: Date
  question: string | null
  answer: string | null
  /** When the answer row was written; null without one. */
  answeredAt: Date | null
  topics: ConversationTagKey[]
  answerMode: FeedbackAnswerMode | null
  answerConfidence: NonNullable<MessageProvenance['answerConfidence']> | null
  confidenceCappedReason: NonNullable<MessageProvenance['answerConfidenceCappedReason']> | null
  /** Cited sources on the answer row; null without one. */
  sourcesCited: number | null
  citationsRemoved: number | null
  researchTruncated: boolean | null
  skills: string[]
  /** `provenance.answerDurationMs`, measured in the asker's browser. */
  clientDurationMs: number | null
  traceId: string | null
  /** The backend job id of a deep-research run; null for a chat turn. */
  jobId: string | null
  /** Null when the ledger holds no call for this turn. */
  llmCalls: number | null
  models: string[]
  tokensTotal: number | null
  costUsd: number | null
  lessonId: string | null
  lessonStatus: FeedbackLessonStatus | null
  lessonsHoldout: boolean | null
}

export interface FeedbackExportTotals {
  votes: number
  up: number
  down: number
  /** Distinct people behind the votes. */
  voters: number
  organizations: number
}

/** The provenance fields the export reads, picked in SQL so a row's thinking steps never leave the database. */
const PROVENANCE_FIELDS = [
  'routingDecision',
  'answerConfidence',
  'answerConfidenceCappedReason',
  'citationsRemoved',
  'researchTruncated',
  'skillsActivated',
  'answerDurationMs',
  'deepResearchJobId',
] as const

const pickedProvenance = sql.raw(
  `jsonb_strip_nulls(jsonb_build_object(${PROVENANCE_FIELDS.map(
    (field) => `'${field}', m.metadata->'provenance'->'${field}'`,
  ).join(', ')}))`,
)

/**
 * The run an answer is the account of (`messages.run_id`, ADR-0062), for its
 * backend job id when the row's provenance does not carry one. One row per
 * answer at most: `task_runs.id` is the primary key.
 */
const TASK_RUN_JOIN = sql`
    left join task_runs tr
      on tr.id = ${answerIdOf(sql`m.run_id`)}
     and tr.organization_id = m.organization_id
`

/**
 * FROM, joins and WHERE shared by the rows and the totals, so the two can never
 * describe different sets. Each join is at most one row per vote (`m` by its
 * primary key, `q` limited to one, `c` by its primary key), so a count over it
 * counts votes.
 */
function exportScope(filters: FeedbackExportFilters, extraJoins: SQL = sql``): SQL {
  const since = feedbackWindowStart(filters.windowDays).toISOString()
  const { verdict, reason, organizationId, topic, query } = filters
  return sql`
    from answer_feedback f
    ${VOTED_TURN_JOINS}
    left join conversations c
      on c.id = coalesce(m.conversation_id, f.conversation_id)
     and c.organization_id = f.organization_id
    ${extraJoins}
    where f.created_at >= ${since}::timestamptz
      ${verdict ? sql`and f.verdict = ${verdict}` : sql``}
      ${organizationId ? sql`and f.organization_id = ${organizationId}` : sql``}
      ${topic ? sql`and c.tags @> array[${topic}]::text[]` : sql``}
      ${reason && verdict === 'down' ? sql`and coalesce(f.reason, 'other') = ${reason}` : sql``}
      ${
        query
          ? sql`and (m.content ilike ${likeContains(query)} or q.content ilike ${likeContains(query)})`
          : sql``
      }
  `
}

/**
 * The export's rows, newest first vote first, at most `limit` (the service asks
 * for one over the cap to tell "full" from "cut").
 *
 * Cost follows `sumAnswerUsage` (`lib/budgets/repository.ts`): a chat turn's
 * calls are the ledger rows with its organization, conversation and answer id;
 * a deep-research run's are the rows with its backend job id. The two halves are
 * a UNION ALL rather than one OR'd join so each can use its own index.
 */
export async function listFeedbackExportRows(
  filters: FeedbackExportFilters,
  limit: number,
): Promise<FeedbackExportRow[]> {
  const bounded = Math.max(0, Math.min(limit, FEEDBACK_EXPORT_ROW_CAP + 1))
  const db = getDb()
  const result = await db.execute(sql`
    with sel as (
      select
        f.id,
        f.organization_id,
        f.message_id,
        f.verdict,
        f.reason,
        f.comment,
        f.expected_answer,
        f.created_at,
        f.updated_at,
        f.lessons_holdout,
        left(encode(sha256(convert_to(f.organization_id || ':' || f.user_id, 'UTF8')), 'hex'), 12) as voter_key,
        coalesce(m.conversation_id, f.conversation_id) as conversation_id,
        c.id is not null                               as conversation_found,
        c.title                                        as conversation_title,
        c.tags                                         as topics,
        coalesce(f.project_id, c.project_id)           as project_id,
        m.content                                      as answer,
        m.created_at                                   as answered_at,
        q.content                                      as question,
        m.metadata->>'trace_id'                        as trace_id,
        ${pickedProvenance}                            as provenance,
        case when jsonb_typeof(m.metadata->'citations'->'sources') = 'array' then (
          select count(*) from jsonb_array_elements(m.metadata->'citations'->'sources') s
          where s->'is_cited' is distinct from 'false'::jsonb
        ) end                                          as sources_cited,
        nullif(coalesce(m.metadata->'provenance'->>'deepResearchJobId', tr.backend_job_id), '') as job_id
      ${exportScope(filters, TASK_RUN_JOIN)}
      order by f.created_at desc, f.id
      limit ${bounded}
    ),
    usage_rows as (
      select s.id, u.model, u.total_tokens, u.cost_usd
      from sel s
      join llm_usage_events u
        on u.organization_id = s.organization_id
       and u.conversation_id = s.conversation_id
       and u.message_id = s.message_id
      where s.job_id is null
      union all
      select s.id, u.model, u.total_tokens, u.cost_usd
      from sel s
      join llm_usage_events u
        on u.organization_id = s.organization_id
       and u.job_id = s.job_id
      where s.job_id is not null
    ),
    usage as (
      select
        id,
        count(*)                                                as llm_calls,
        array_agg(distinct model order by model) filter (where model is not null) as models,
        sum(total_tokens)                                       as tokens_total,
        sum(cost_usd)                                           as cost_usd
      from usage_rows
      group by id
    )
    select
      sel.*,
      p.name                                       as project_name,
      p.profile->'facts'->'bundesland'->>'value'   as bundesland,
      usage.llm_calls,
      usage.models,
      usage.tokens_total,
      usage.cost_usd,
      r.lesson_id,
      r.outcome                                    as lesson_outcome,
      l.status                                     as lesson_status
    from sel
    left join projects p on p.id = sel.project_id and p.organization_id = sel.organization_id
    left join usage on usage.id = sel.id
    left join platform_lesson_reports r on r.feedback_id = sel.id
    left join platform_lessons l on l.id = r.lesson_id
    order by sel.created_at desc, sel.id
  `)
  return executeRows(result).map(toExportRow)
}

/** Votes, verdicts, voters and organizations over the SAME set the rows come from, uncapped. */
export async function getFeedbackExportTotals(filters: FeedbackExportFilters): Promise<FeedbackExportTotals> {
  const db = getDb()
  const [row] = executeRows(
    await db.execute(sql`
      select
        count(*)                                     as votes,
        count(*) filter (where f.verdict = 'up')     as up,
        count(*) filter (where f.verdict = 'down')   as down,
        count(distinct f.user_id)                    as voters,
        count(distinct f.organization_id)            as organizations
      ${exportScope(filters)}
    `),
  )
  return {
    votes: Number(row?.votes ?? 0),
    up: Number(row?.up ?? 0),
    down: Number(row?.down ?? 0),
    voters: Number(row?.voters ?? 0),
    organizations: Number(row?.organizations ?? 0),
  }
}

/* ------------------------------------------------------------------ *
 * Coercion — raw `sql` rows are not runtime-validated
 * ------------------------------------------------------------------ */

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null)

const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const dateOrNull = (value: unknown): Date | null => {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(date.getTime()) ? null : date
}

const LESSON_STATUSES: readonly string[] = ['candidate', 'active', 'retired']

function lessonStatus(status: unknown, outcome: unknown): FeedbackLessonStatus | null {
  if (typeof status === 'string' && LESSON_STATUSES.includes(status)) return status as PlatformLessonStatus
  return outcome === 'skipped' ? 'skipped' : null
}

function toExportRow(row: Record<string, unknown>): FeedbackExportRow {
  const provenance = sanitizeProvenance(row.provenance) ?? {}
  const jobId = text(row.job_id)
  const answer = typeof row.answer === 'string' ? row.answer : null
  const verdict = row.verdict as AnswerFeedbackVerdict
  const llmCalls = numberOrNull(row.llm_calls)
  return {
    feedbackId: String(row.id),
    organizationId: String(row.organization_id),
    projectId: text(row.project_id),
    projectName: text(row.project_name),
    bundesland: text(row.bundesland),
    conversationId: text(row.conversation_id),
    conversationFound: row.conversation_found === true,
    conversationTitle: text(row.conversation_title),
    messageId: String(row.message_id),
    voterKey: String(row.voter_key),
    verdict,
    // A down-vote without a chip counts as `other`, as on the page.
    reason: verdict === 'down' ? ((text(row.reason) as AnswerFeedbackReason | null) ?? 'other') : null,
    comment: text(row.comment),
    expectedAnswer: text(row.expected_answer),
    firstVotedAt: new Date(String(row.created_at)),
    votedAt: new Date(String(row.updated_at)),
    question: typeof row.question === 'string' ? row.question : null,
    answer,
    answeredAt: dateOrNull(row.answered_at),
    topics: Array.isArray(row.topics) ? row.topics.map(String).filter(isConversationTagKey) : [],
    answerMode: jobId ? 'report' : (provenance.routingDecision ?? null),
    answerConfidence: provenance.answerConfidence ?? null,
    confidenceCappedReason: provenance.answerConfidenceCappedReason ?? null,
    sourcesCited: answer === null ? null : numberOrNull(row.sources_cited),
    citationsRemoved: provenance.citationsRemoved?.count ?? null,
    researchTruncated: answer === null ? null : provenance.researchTruncated === true,
    skills: provenance.skillsActivated ?? [],
    clientDurationMs: provenance.answerDurationMs ?? null,
    traceId: isTraceId(row.trace_id) ? row.trace_id : null,
    jobId,
    llmCalls: llmCalls && llmCalls > 0 ? llmCalls : null,
    models: Array.isArray(row.models) ? row.models.map(String).filter(Boolean) : [],
    tokensTotal: llmCalls ? numberOrNull(row.tokens_total) : null,
    costUsd: llmCalls ? numberOrNull(row.cost_usd) : null,
    lessonId: text(row.lesson_id),
    lessonStatus: lessonStatus(row.lesson_status, row.lesson_outcome),
    lessonsHoldout: typeof row.lessons_holdout === 'boolean' ? row.lessons_holdout : null,
  }
}
