/**
 * The one strict reader of a ratings request, shared by every endpoint on the
 * ratings tab: the figures (`/api/platform/answer-feedback`), the digest, the
 * filter options and count, and the export.
 *
 * Two parsers would be a bug waiting: an export whose filters drift from the
 * screen above it hands somebody a file that does not match what they were
 * looking at, and nothing on screen would say so. So the scope comes from
 * `parseQualityScopeStrict` (the same reader the other quality views use) and the
 * ratings filters from the zod schema below, and an unknown value is a 400 that
 * names the parameter, never a silent fallback to a different set of votes.
 *
 * **Older links keep working.** `days=7|30|90` stands for a range ending today
 * (the scope reader's own fallback). The export's `scope` parameter predates
 * the page-wide filters: `scope=all` asks for every vote in the scope, ratings
 * filters ignored, and `scope=selection` was the page's drill-in, which defaulted
 * to the down-votes when no `verdict` was sent.
 */

import { z } from 'zod'
import { BadRequestError } from '@/lib/api/errors'
import { CONVERSATION_TAG_KEYS } from '@/lib/conversations/tags'
import { parseQualityScopeStrict } from '@/lib/quality/scope'
import { scopeIdsError } from '@/lib/quality/scope-ids'
import {
  FEEDBACK_CONFIDENCE_FILTERS,
  FEEDBACK_MODE_FILTERS,
  FEEDBACK_REASON_FILTERS,
  MAX_FEEDBACK_QUERY_CHARS,
  NO_RATINGS_FILTERS,
  normalizeRatingsFilters,
  RATINGS_FILTER_PARAMS as P,
  type FeedbackQuery,
} from './filters'

const flag = z.enum(['0', '1']).optional()

const ratingsSchema = z.object({
  [P.verdict]: z.enum(['up', 'down', 'all']).optional(),
  [P.reasons]: z.array(z.enum(FEEDBACK_REASON_FILTERS)),
  [P.topics]: z.array(z.enum(CONVERSATION_TAG_KEYS)),
  [P.modes]: z.array(z.enum(FEEDBACK_MODE_FILTERS)),
  [P.confidences]: z.array(z.enum(FEEDBACK_CONFIDENCE_FILTERS)),
  [P.hasComment]: flag,
  [P.hasExpectedAnswer]: flag,
  scope: z.enum(['all', 'selection']).optional(),
})

export type FeedbackQueryParse =
  | { ok: true; query: FeedbackQuery }
  | { ok: false; error: string; param: string }

const optional = (params: URLSearchParams, key: string): string | undefined => params.get(key) ?? undefined

/** Read a ratings request strictly. `now` is injectable so a spec can pin "today". */
export function parseFeedbackQuery(params: URLSearchParams, now: Date = new Date()): FeedbackQueryParse {
  const scoped = parseQualityScopeStrict(params, now)
  if (!scoped.ok) return { ok: false, error: scoped.error, param: scoped.error === 'invalid_to' ? 'to' : 'from' }
  const { scope } = scoped
  const idsError = scopeIdsError(scope)
  if (idsError) return { ok: false, ...idsError }

  const parsed = ratingsSchema.safeParse({
    [P.verdict]: optional(params, P.verdict),
    [P.reasons]: params.getAll(P.reasons),
    [P.topics]: params.getAll(P.topics).map((value) => value.trim().toLowerCase()),
    [P.modes]: params.getAll(P.modes),
    [P.confidences]: params.getAll(P.confidences),
    [P.hasComment]: optional(params, P.hasComment),
    [P.hasExpectedAnswer]: optional(params, P.hasExpectedAnswer),
    scope: optional(params, 'scope'),
  })
  if (!parsed.success) {
    const param = String(parsed.error.issues[0]?.path[0] ?? 'query')
    return { ok: false, error: 'invalid_value', param }
  }
  const raw = parsed.data

  if (raw.scope === 'all') return { ok: true, query: { scope, ratings: NO_RATINGS_FILTERS } }

  // The old drill-in export defaulted to the down-votes; an explicit verdict wins.
  const verdictParam = raw[P.verdict] ?? (raw.scope === 'selection' ? 'down' : 'all')
  const verdict = verdictParam === 'all' ? null : verdictParam
  const reasons = raw[P.reasons]
  // A reason exists only on a down-vote. Asking for helpful votes WITH a reason
  // is a contradiction, and answering it with "nothing matches" would hide that.
  if (verdict === 'up' && reasons.length > 0) return { ok: false, error: 'reason_requires_down', param: P.reasons }

  const ratings = normalizeRatingsFilters({
    verdict,
    reasons,
    topics: raw[P.topics],
    modes: raw[P.modes],
    confidences: raw[P.confidences],
    hasComment: raw[P.hasComment] === '1',
    hasExpectedAnswer: raw[P.hasExpectedAnswer] === '1',
    query: params.get(P.query)?.slice(0, MAX_FEEDBACK_QUERY_CHARS * 2) ?? null,
  })
  return { ok: true, query: { scope, ratings } }
}

/** The same, for a route: a refused request is a 400 naming the parameter. */
export function requireFeedbackQuery(params: URLSearchParams, now: Date = new Date()): FeedbackQuery {
  const parsed = parseFeedbackQuery(params, now)
  if (!parsed.ok) {
    throw new BadRequestError(`Invalid filter parameter "${parsed.param}" (${parsed.error}).`, {
      param: parsed.param,
      error: parsed.error,
    })
  }
  return parsed.query
}
