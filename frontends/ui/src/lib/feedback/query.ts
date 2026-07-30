/**
 * One parser for the health filters, shared by the read route and the export.
 *
 * Two parsers would be a bug waiting: an export whose filters drift from the
 * table above it hands somebody a CSV that does not match what they were looking
 * at, and nothing on screen would say so. Everything here is coerced — a query
 * string is user input, and `reason` in particular reaches a SQL comparison.
 */

import { ANSWER_FEEDBACK_REASONS, type AnswerFeedbackReason } from '@/lib/db/schema'
import { isConversationTagKey } from '@/lib/conversations/tags'
import { parseFeedbackWindowDays, type FeedbackHealthFilters } from './repository'

/** Free-text search is bounded: it becomes an ILIKE, not a novel. */
const MAX_QUERY_CHARS = 120

/**
 * Coerce a query string into the filters the repository accepts.
 *
 * Nothing is trusted: an unknown reason or topic becomes `null` rather than
 * reaching a SQL comparison, and an unparseable direction falls back to the
 * failures.
 */
export function parseFeedbackFilters(params: URLSearchParams): FeedbackHealthFilters {
  const rawReason = params.get('reason')
  const reason = (ANSWER_FEEDBACK_REASONS as readonly string[]).includes(rawReason ?? '')
    ? (rawReason as AnswerFeedbackReason)
    : null

  // Anything but an explicit `up` is `down`: the failed answers are the
  // actionable list, so an unparseable value must not land the reader in the
  // praise list wondering where the problems went.
  const verdict = params.get('verdict') === 'up' ? 'up' : 'down'

  const rawTopic = params.get('topic')?.trim().toLowerCase() ?? ''
  const topic = isConversationTagKey(rawTopic) ? rawTopic : null

  const organizationId = params.get('org')?.trim() || null
  const query = params.get('q')?.trim().slice(0, MAX_QUERY_CHARS) || null

  return {
    windowDays: parseFeedbackWindowDays(params.get('days')),
    verdict,
    reason,
    organizationId,
    topic,
    query,
  }
}
