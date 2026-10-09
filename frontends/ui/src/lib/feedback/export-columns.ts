/**
 * The answer-feedback export's columns, defined once.
 *
 * Both formats are rendered from these lists and nothing else: the workbook's
 * "Bewertungen" and "Wochen" sheets, the CSV (same columns, same order, the
 * `key` as its header) and the "Spalten" sheet that explains them. Two column
 * lists drift on the first edit, and the half that drifts is the one a script
 * reads by name. `docs/technical-reference/answer-feedback-export.md` lists the
 * same keys, and `export-columns.spec.ts` fails when the two disagree.
 *
 * The CSV keys are a CONTRACT: `scripts/feedback_to_cases.py` reads `verdict`,
 * `question`, `expected_answer`, `reason` and `voted_at` by name. Add columns
 * freely; rename or remove one only together with its readers.
 *
 * Labels and descriptions live in the `feedbackExport` dictionary, keyed by the
 * column key. `voteColumn` and `weekColumn` take a key OF that dictionary, so a
 * column nobody labelled does not compile.
 *
 * Pure: no database, no request. The service hands in rows already named for
 * the reader (`FeedbackExportRecord`).
 */

import type { Dictionary } from '@/i18n/dictionaries'
import { interpolate } from '@/i18n/translate'
import { CONVERSATION_TAG_KEYS } from '@/lib/conversations/tags'
import type { FeedbackExportRow } from './export-repository'
import type { FeedbackWeeklyCount } from './repository'
import { MIN_TREND_VOTES } from './trend'

/** How a column's values are typed. Each has a format label in the dictionary. */
export type ExportFormat = keyof Dictionary['feedbackExport']['formats']

/** One cell before a format renders it. A list is joined by the renderer. */
export type ExportCell = string | number | boolean | Date | readonly string[] | null

export interface ExportColumn<Row> {
  /** The CSV header and the stable name of the column. */
  key: string
  format: ExportFormat
  /** Where the value comes from, for the data dictionary. Not translated: it names tables. */
  source: string
  /** Width in the workbook, in characters. */
  width: number
  /** Wrap long text in the workbook. */
  wrap?: boolean
  label: (dictionary: Dictionary) => string
  description: (dictionary: Dictionary) => string
  value: (row: Row, dictionary: Dictionary) => ExportCell
}

/** A vote row as the service hands it over: the repository row, named and linked. */
export interface FeedbackExportRecord extends FeedbackExportRow {
  organizationName: string | null
  /** Absolute link to the answer in Piloti; null when no app origin is configured or the conversation has no row. */
  appUrl: string | null
  langfuseTraceUrl: string | null
}

/** A weekly row, named for the reader. */
export interface FeedbackWeeklyRecord extends FeedbackWeeklyCount {
  organizationName: string | null
}

type VoteColumnKey = keyof Dictionary['feedbackExport']['columns']
type WeekColumnKey = keyof Dictionary['feedbackExport']['weeklyColumns']

interface ColumnSpec<Row> {
  format: ExportFormat
  source: string
  width: number
  wrap?: boolean
  value: (row: Row, dictionary: Dictionary) => ExportCell
}

function voteColumn(key: VoteColumnKey, spec: ColumnSpec<FeedbackExportRecord>): ExportColumn<FeedbackExportRecord> {
  return {
    key,
    ...spec,
    label: (dictionary) => dictionary.feedbackExport.columns[key].label,
    description: (dictionary) => dictionary.feedbackExport.columns[key].description,
  }
}

function weekColumn(key: WeekColumnKey, spec: ColumnSpec<FeedbackWeeklyRecord>): ExportColumn<FeedbackWeeklyRecord> {
  return {
    key,
    ...spec,
    label: (dictionary) => dictionary.feedbackExport.weeklyColumns[key].label,
    description: (dictionary) => dictionary.feedbackExport.weeklyColumns[key].description,
  }
}

/** A re-vote within a second of the first is the same click landing twice (`created_at` and `updated_at` both default to now). */
const VOTE_CHANGED_AFTER_MS = 1000

/** `YYYY-MM-DD` of a UTC instant, as a Date at UTC midnight (the workbook types it as a date). */
export function utcDay(instant: Date): Date {
  return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()))
}

/** ISO 8601 week label of a UTC instant, e.g. `2026-W41` — the same label Postgres's `IYYY-"W"IW` gives. */
export function isoWeekLabel(instant: Date): string {
  const day = utcDay(instant)
  const weekday = (day.getUTCDay() + 6) % 7 // Monday = 0
  // The Thursday of this week decides the ISO year.
  const thursday = new Date(day.getTime() + (3 - weekday) * 86_400_000)
  const isoYear = thursday.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4))
  const firstWeekday = (firstThursday.getUTCDay() + 6) % 7
  const week1Monday = firstThursday.getTime() - firstWeekday * 86_400_000
  const week = Math.floor((thursday.getTime() - week1Monday) / (7 * 86_400_000)) + 1
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}

const topicLabel = (dictionary: Dictionary, topic: string): string =>
  (dictionary.platform.answerFeedback.topics as Record<string, string>)[topic] ?? topic

/** One 1/0 column per topic tag, in the vocabulary's order, so a pivot can filter on a topic without parsing a list. */
const TOPIC_COLUMNS: ExportColumn<FeedbackExportRecord>[] = CONVERSATION_TAG_KEYS.map((topic) => ({
  key: `topic_${topic}`,
  format: 'boolean',
  source: 'conversations.tags',
  width: 10,
  label: (dictionary) => interpolate(dictionary.feedbackExport.topicColumn.label, { topic: topicLabel(dictionary, topic) }),
  description: (dictionary) =>
    interpolate(dictionary.feedbackExport.topicColumn.description, { topic: topicLabel(dictionary, topic) }),
  value: (row) => row.topics.includes(topic),
}))

/** One row per vote. The order is the CSV's and the sheet's. */
export const FEEDBACK_EXPORT_COLUMNS: readonly ExportColumn<FeedbackExportRecord>[] = [
  // The vote
  voteColumn('feedback_id', { format: 'id', source: 'answer_feedback.id', width: 38, value: (r) => r.feedbackId }),
  voteColumn('voted_at', { format: 'datetime', source: 'answer_feedback.updated_at', width: 20, value: (r) => r.votedAt }),
  voteColumn('first_voted_at', {
    format: 'datetime',
    source: 'answer_feedback.created_at',
    width: 20,
    value: (r) => r.firstVotedAt,
  }),
  voteColumn('vote_changed', {
    format: 'boolean',
    source: 'answer_feedback.updated_at > created_at + 1 s',
    width: 10,
    value: (r) => r.votedAt.getTime() - r.firstVotedAt.getTime() > VOTE_CHANGED_AFTER_MS,
  }),
  voteColumn('vote_date', {
    format: 'date',
    source: 'answer_feedback.created_at (UTC day)',
    width: 12,
    value: (r) => utcDay(r.firstVotedAt),
  }),
  voteColumn('iso_week', {
    format: 'week',
    source: 'answer_feedback.created_at (ISO week, UTC)',
    width: 10,
    value: (r) => isoWeekLabel(r.firstVotedAt),
  }),
  // The verdict
  voteColumn('verdict', { format: 'text', source: 'answer_feedback.verdict', width: 8, value: (r) => r.verdict }),
  voteColumn('helpful', {
    format: 'boolean',
    source: "answer_feedback.verdict = 'up'",
    width: 9,
    value: (r) => r.verdict === 'up',
  }),
  voteColumn('reason', {
    format: 'text',
    source: "answer_feedback.reason (NULL on a down-vote = 'other')",
    width: 13,
    value: (r) => r.reason,
  }),
  voteColumn('reason_label', {
    format: 'text',
    source: 'answer_feedback.reason, labelled',
    width: 16,
    value: (r, d) => (r.reason ? d.platform.answerFeedback.reasons[r.reason] : null),
  }),
  // Where
  voteColumn('organization_name', {
    format: 'text',
    source: 'organizations / WorkOS display name',
    width: 24,
    value: (r) => r.organizationName,
  }),
  voteColumn('organization_id', {
    format: 'id',
    source: 'answer_feedback.organization_id',
    width: 30,
    value: (r) => r.organizationId,
  }),
  voteColumn('project_name', { format: 'text', source: 'projects.name', width: 24, value: (r) => r.projectName }),
  voteColumn('project_id', {
    format: 'id',
    source: 'answer_feedback.project_id, else conversations.project_id',
    width: 38,
    value: (r) => r.projectId,
  }),
  voteColumn('bundesland', {
    format: 'text',
    source: "projects.profile -> facts.bundesland.value",
    width: 14,
    value: (r) => r.bundesland,
  }),
  voteColumn('conversation_title', {
    format: 'text',
    source: 'conversations.title',
    width: 30,
    wrap: true,
    value: (r) => r.conversationTitle,
  }),
  voteColumn('conversation_id', {
    format: 'id',
    source: 'messages.conversation_id, else answer_feedback.conversation_id',
    width: 30,
    value: (r) => r.conversationId,
  }),
  voteColumn('message_id', { format: 'id', source: 'answer_feedback.message_id', width: 38, value: (r) => r.messageId }),
  // Who
  voteColumn('voter_key', {
    format: 'id',
    source: "sha256(organization_id || ':' || user_id), first 12 hex",
    width: 14,
    value: (r) => r.voterKey,
  }),
  // Topics
  voteColumn('topics', { format: 'list', source: 'conversations.tags', width: 22, value: (r) => r.topics }),
  ...TOPIC_COLUMNS,
  // Content
  voteColumn('question', {
    format: 'text',
    source: 'messages.content (the user message before the answer)',
    width: 50,
    wrap: true,
    value: (r) => r.question,
  }),
  voteColumn('answer', {
    format: 'text',
    source: 'messages.content (the rated answer)',
    width: 70,
    wrap: true,
    value: (r) => r.answer,
  }),
  voteColumn('comment', { format: 'text', source: 'answer_feedback.comment', width: 40, wrap: true, value: (r) => r.comment }),
  voteColumn('expected_answer', {
    format: 'text',
    source: 'answer_feedback.expected_answer',
    width: 40,
    wrap: true,
    value: (r) => r.expectedAnswer,
  }),
  voteColumn('answer_chars', {
    format: 'integer',
    source: 'length(messages.content)',
    width: 10,
    value: (r) => (r.answer === null ? null : r.answer.length),
  }),
  // How it was answered
  voteColumn('answer_mode', {
    format: 'text',
    source: "messages.metadata.provenance.routingDecision; 'report' with a job id",
    width: 10,
    value: (r) => r.answerMode,
  }),
  voteColumn('answer_confidence', {
    format: 'text',
    source: 'messages.metadata.provenance.answerConfidence',
    width: 10,
    value: (r) => r.answerConfidence,
  }),
  voteColumn('confidence_capped_reason', {
    format: 'text',
    source: 'messages.metadata.provenance.answerConfidenceCappedReason',
    width: 18,
    value: (r) => r.confidenceCappedReason,
  }),
  voteColumn('sources_cited', {
    format: 'integer',
    source: 'messages.metadata.citations.sources (cited)',
    width: 9,
    value: (r) => r.sourcesCited,
  }),
  voteColumn('citations_removed', {
    format: 'integer',
    source: 'messages.metadata.provenance.citationsRemoved.count',
    width: 9,
    value: (r) => r.citationsRemoved,
  }),
  voteColumn('research_truncated', {
    format: 'boolean',
    source: 'messages.metadata.provenance.researchTruncated',
    width: 10,
    value: (r) => r.researchTruncated,
  }),
  voteColumn('skills', {
    format: 'list',
    source: 'messages.metadata.provenance.skillsActivated',
    width: 20,
    value: (r) => r.skills,
  }),
  voteColumn('answered_at', { format: 'datetime', source: 'messages.created_at', width: 20, value: (r) => r.answeredAt }),
  voteColumn('client_duration_s', {
    format: 'seconds',
    source: 'messages.metadata.provenance.answerDurationMs / 1000 (browser)',
    width: 10,
    value: (r) => (r.clientDurationMs === null ? null : r.clientDurationMs / 1000),
  }),
  // Cost
  voteColumn('llm_calls', {
    format: 'integer',
    source: 'llm_usage_events (count)',
    width: 9,
    value: (r) => r.llmCalls,
  }),
  voteColumn('models', {
    format: 'list',
    source: 'llm_usage_events.model (distinct)',
    width: 26,
    value: (r) => r.models,
  }),
  voteColumn('tokens_total', {
    format: 'integer',
    source: 'llm_usage_events.total_tokens (sum)',
    width: 10,
    value: (r) => r.tokensTotal,
  }),
  voteColumn('cost_usd', { format: 'usd', source: 'llm_usage_events.cost_usd (sum)', width: 10, value: (r) => r.costUsd }),
  // Follow-up
  voteColumn('lesson_id', { format: 'id', source: 'platform_lesson_reports.lesson_id', width: 38, value: (r) => r.lessonId }),
  voteColumn('lesson_status', {
    format: 'text',
    source: "platform_lessons.status; 'skipped' from platform_lesson_reports.outcome",
    width: 11,
    value: (r) => r.lessonStatus,
  }),
  voteColumn('lessons_holdout', {
    format: 'boolean',
    source: 'answer_feedback.lessons_holdout',
    width: 10,
    value: (r) => r.lessonsHoldout,
  }),
  // Links
  voteColumn('app_url', { format: 'url', source: 'app origin + conversation deep link', width: 16, value: (r) => r.appUrl }),
  voteColumn('langfuse_trace_url', {
    format: 'url',
    source: 'LANGFUSE_PUBLIC_URL + project + trace id',
    width: 16,
    value: (r) => r.langfuseTraceUrl,
  }),
  voteColumn('trace_id', { format: 'id', source: "messages.metadata.trace_id", width: 34, value: (r) => r.traceId }),
]

/** A share with too few votes behind it is noise, not a reading — same floor as the page's trend. */
export function helpfulRate(up: number, down: number): number | null {
  const votes = up + down
  return votes >= MIN_TREND_VOTES ? up / votes : null
}

/** Per organization and ISO week. Also the `?summary=weekly` CSV. */
export const FEEDBACK_WEEKLY_COLUMNS: readonly ExportColumn<FeedbackWeeklyRecord>[] = [
  weekColumn('organization_name', {
    format: 'text',
    source: 'organizations / WorkOS display name',
    width: 24,
    value: (w) => w.organizationName,
  }),
  weekColumn('organization_id', { format: 'id', source: 'organization_id', width: 30, value: (w) => w.organizationId }),
  weekColumn('iso_week', { format: 'week', source: 'ISO week, UTC', width: 10, value: (w) => w.isoWeek }),
  weekColumn('week_start', {
    format: 'date',
    source: 'Monday of the ISO week, UTC',
    width: 12,
    value: (w) => new Date(`${w.weekStart}T00:00:00.000Z`),
  }),
  weekColumn('answers', {
    format: 'integer',
    source: 'messages (assistant, produced) ∪ answer_feedback.message_id (rated)',
    width: 10,
    value: (w) => w.answers,
  }),
  weekColumn('rated_answers', {
    format: 'integer',
    source: 'answer_feedback.message_id (distinct)',
    width: 10,
    value: (w) => w.ratedAnswers,
  }),
  weekColumn('up', { format: 'integer', source: "answer_feedback (verdict 'up')", width: 9, value: (w) => w.up }),
  weekColumn('down', { format: 'integer', source: "answer_feedback (verdict 'down')", width: 9, value: (w) => w.down }),
  weekColumn('helpful_rate', {
    format: 'percent',
    source: `up / (up + down), blank under ${MIN_TREND_VOTES} votes`,
    width: 10,
    value: (w) => helpfulRate(w.up, w.down),
  }),
  weekColumn('coverage', {
    format: 'percent',
    source: 'rated_answers / answers',
    width: 10,
    value: (w) => (w.answers > 0 ? w.ratedAnswers / w.answers : null),
  }),
]
