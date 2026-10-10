/**
 * The ratings filters on Platform → Answer quality → Bewertungen, and how they
 * travel: the page URL, every API call the tab makes, and the export link.
 *
 * Two halves make one question. The page-wide **scope** (date range,
 * organizations, projects) is `@/lib/quality/scope`, shared with the other two
 * quality views. The **ratings filters** here only mean something for votes:
 * the verdict, the down-vote reason, the conversation's topic, how the answer was
 * produced, its confidence, whether the voter wrote something, and free text.
 * Together they are a `FeedbackQuery`, and that one value is what the figures,
 * the digest, the drill-in and the export are read with, so the file a reader
 * downloads is the set the screen shows.
 *
 * Client-safe on purpose (no zod, no schema values): the page reads and writes
 * these keys. The API's strict reading, which answers 400 on an unknown value, is
 * `./query`.
 */

import type { AnswerFeedbackReason } from '@/lib/db/schema/answer-feedback'
import { CONVERSATION_TAG_KEYS, isConversationTagKey, type ConversationTagKey } from '@/lib/conversations/tags'
import { writeQualityScope, type QualityScope } from '@/lib/quality/scope'

/** Which way a vote went. */
export const FEEDBACK_VERDICT_FILTERS = ['up', 'down'] as const
export type FeedbackVerdictFilter = (typeof FEEDBACK_VERDICT_FILTERS)[number]

/**
 * Down-vote reasons in the page's FIXED order (the bars never reshuffle).
 * Mirrors `ANSWER_FEEDBACK_REASONS`; the type check below fails if a reason is
 * added there and not here.
 */
export const FEEDBACK_REASON_FILTERS = ['inaccurate', 'wrong_source', 'too_slow', 'other'] as const satisfies readonly AnswerFeedbackReason[]
export type FeedbackReasonFilter = (typeof FEEDBACK_REASON_FILTERS)[number]
type MissingReason = Exclude<AnswerFeedbackReason, FeedbackReasonFilter>
const REASONS_EXHAUSTIVE: [MissingReason] extends [never] ? true : never = true
void REASONS_EXHAUSTIVE

/**
 * How the answer was produced: the provenance's routing decision, or `report`
 * for a deep-research run. `error` exists in provenance and is not offered: a
 * failed turn is not an answer anybody rated for its content.
 */
export const FEEDBACK_MODE_FILTERS = ['meta', 'shallow', 'deep', 'report'] as const
export type FeedbackModeFilter = (typeof FEEDBACK_MODE_FILTERS)[number]

/** The confidence the answer showed its reader. */
export const FEEDBACK_CONFIDENCE_FILTERS = ['low', 'medium', 'high'] as const
export type FeedbackConfidenceFilter = (typeof FEEDBACK_CONFIDENCE_FILTERS)[number]

/** Free-text search is bounded: it becomes an ILIKE, not a novel. */
export const MAX_FEEDBACK_QUERY_CHARS = 120

export interface RatingsFilters {
  /** Null is both directions. */
  verdict: FeedbackVerdictFilter | null
  /** Any of these reasons (a chip-less down-vote counts as `other`). Implies down-votes. */
  reasons: FeedbackReasonFilter[]
  /** Any of these topics (OR): the conversation carries at least one. */
  topics: ConversationTagKey[]
  modes: FeedbackModeFilter[]
  confidences: FeedbackConfidenceFilter[]
  hasComment: boolean
  hasExpectedAnswer: boolean
  /** Free text across the question and the answer. */
  query: string | null
}

/** The scope and the ratings filters: everything the ratings tab is read with. */
export interface FeedbackQuery {
  scope: QualityScope
  ratings: RatingsFilters
}

export const NO_RATINGS_FILTERS: RatingsFilters = Object.freeze({
  verdict: null,
  reasons: [],
  topics: [],
  modes: [],
  confidences: [],
  hasComment: false,
  hasExpectedAnswer: false,
  query: null,
}) as RatingsFilters

/** The URL and API parameter of each filter. The same names on the page and on the API. */
export const RATINGS_FILTER_PARAMS = {
  verdict: 'verdict',
  reasons: 'reason',
  topics: 'topic',
  modes: 'mode',
  confidences: 'confidence',
  hasComment: 'has_comment',
  hasExpectedAnswer: 'has_expected',
  query: 'q',
} as const satisfies Record<keyof RatingsFilters, string>

export type RatingsFilterKey = keyof RatingsFilters

/** The values of `list` that `vocabulary` knows, deduplicated, in the vocabulary's order. */
export function inVocabularyOrder<T extends string>(vocabulary: readonly T[], list: readonly string[]): T[] {
  const wanted = new Set(list)
  return vocabulary.filter((value) => wanted.has(value))
}

/**
 * The canonical form: every list in its vocabulary's order, reasons dropped when
 * the verdict is `up` (a reason exists only on a down-vote), and an empty search
 * as null. Canonical so two equal filter sets produce one URL and one cache key.
 */
export function normalizeRatingsFilters(filters: RatingsFilters): RatingsFilters {
  const query = filters.query?.trim().slice(0, MAX_FEEDBACK_QUERY_CHARS) || null
  return {
    verdict: filters.verdict,
    reasons: filters.verdict === 'up' ? [] : inVocabularyOrder(FEEDBACK_REASON_FILTERS, filters.reasons),
    topics: inVocabularyOrder(CONVERSATION_TAG_KEYS, filters.topics),
    modes: inVocabularyOrder(FEEDBACK_MODE_FILTERS, filters.modes),
    confidences: inVocabularyOrder(FEEDBACK_CONFIDENCE_FILTERS, filters.confidences),
    hasComment: filters.hasComment,
    hasExpectedAnswer: filters.hasExpectedAnswer,
    query,
  }
}

/**
 * Read the ratings filters from the PAGE URL, leniently: an unknown value is
 * dropped rather than refused, because a stale or hand-edited link should open
 * a sensible view. The API reads the same keys strictly (`./query`).
 */
export function readRatingsFilters(params: URLSearchParams): RatingsFilters {
  const p = RATINGS_FILTER_PARAMS
  const verdict = params.get(p.verdict)
  const topics = params.getAll(p.topics).map((value) => value.trim().toLowerCase())
  return normalizeRatingsFilters({
    verdict: verdict === 'up' || verdict === 'down' ? verdict : null,
    reasons: inVocabularyOrder(FEEDBACK_REASON_FILTERS, params.getAll(p.reasons)),
    topics: topics.filter(isConversationTagKey),
    modes: inVocabularyOrder(FEEDBACK_MODE_FILTERS, params.getAll(p.modes)),
    confidences: inVocabularyOrder(FEEDBACK_CONFIDENCE_FILTERS, params.getAll(p.confidences)),
    hasComment: params.get(p.hasComment) === '1',
    hasExpectedAnswer: params.get(p.hasExpectedAnswer) === '1',
    query: params.get(p.query),
  })
}

/** Write the ratings filters into URL parameters, replacing any ratings keys already there. */
export function writeRatingsFilters(params: URLSearchParams, filters: RatingsFilters): URLSearchParams {
  const next = new URLSearchParams(params)
  const p = RATINGS_FILTER_PARAMS
  for (const key of Object.values(p)) next.delete(key)
  const canonical = normalizeRatingsFilters(filters)
  if (canonical.verdict) next.set(p.verdict, canonical.verdict)
  for (const value of canonical.reasons) next.append(p.reasons, value)
  for (const value of canonical.topics) next.append(p.topics, value)
  for (const value of canonical.modes) next.append(p.modes, value)
  for (const value of canonical.confidences) next.append(p.confidences, value)
  if (canonical.hasComment) next.set(p.hasComment, '1')
  if (canonical.hasExpectedAnswer) next.set(p.hasExpectedAnswer, '1')
  if (canonical.query) next.set(p.query, canonical.query)
  return next
}

/** True when any ratings filter narrows the votes. */
export function ratingsFiltered(filters: RatingsFilters): boolean {
  return (
    filters.verdict !== null ||
    filters.reasons.length > 0 ||
    filters.topics.length > 0 ||
    filters.modes.length > 0 ||
    filters.confidences.length > 0 ||
    filters.hasComment ||
    filters.hasExpectedAnswer ||
    Boolean(filters.query)
  )
}

/** The ratings filters that are set, by key, in a fixed order. */
export function activeRatingsFilterKeys(filters: RatingsFilters): RatingsFilterKey[] {
  const keys: RatingsFilterKey[] = []
  if (filters.verdict) keys.push('verdict')
  if (filters.reasons.length) keys.push('reasons')
  if (filters.topics.length) keys.push('topics')
  if (filters.modes.length) keys.push('modes')
  if (filters.confidences.length) keys.push('confidences')
  if (filters.hasComment) keys.push('hasComment')
  if (filters.hasExpectedAnswer) keys.push('hasExpectedAnswer')
  if (filters.query) keys.push('query')
  return keys
}

/** The whole query as one API query string: scope first, then the ratings filters. */
export function feedbackQueryString(query: FeedbackQuery): string {
  return writeRatingsFilters(writeQualityScope(new URLSearchParams(), query.scope), query.ratings).toString()
}

/** Toggle one value in a list filter, keeping the vocabulary's order. */
export function toggleValue<T extends string>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value]
}
