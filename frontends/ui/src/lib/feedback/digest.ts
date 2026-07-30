/**
 * The answer-feedback digest — the aggregate, in sentences.
 *
 * **Why.** The surface next door is numbers: a rate, four bars, a line, a table,
 * a list of failed turns. All of it correct, and all of it asking the reader to
 * assemble the story themselves — which mostly means reading the biggest bar and
 * leaving. This turns one window of feedback into what somebody would have said
 * about it: what is going well, what is not, and what to do next.
 *
 * **Why a model rather than a template.** The arithmetic is already on the page
 * and a template could restate it. What a template cannot do is read forty
 * questions and notice that the failures cluster around escape-route lengths
 * while the praise clusters around fire-compartment sizing. Naming themes is the
 * whole value; the percentages are not.
 *
 * **What leaves this process.** Counts, and questions. The organization rollup is
 * stripped to bare `{up, down}` pairs before it goes anywhere — the digest needs
 * the SHAPE of the distribution ("one tenant accounts for most of it"), never the
 * identity, and the table under the digest names them on screen anyway. Answers
 * are not sent at all: they are the long half and the model does not need its own
 * output back to name a theme.
 *
 * **Cached, because it is expensive and slow-moving.** A 30-day window does not
 * change meaningfully between two page loads, and every load would otherwise be
 * an LLM call on a page an operator refreshes while working. It goes through the
 * shared cache (`@/lib/cache`, Dragonfly when `REDIS_URL` is set), so replicas
 * share one digest per window+filters+locale rather than each buying their own.
 * `refresh: true` bypasses the read — the button exists because a cached
 * narrative with no way to re-ask is the kind of thing people stop believing.
 *
 * Stored, not just cached, was the alternative. It is not worth a table yet:
 * nothing reads a digest older than the current one, and a history nobody opens
 * is a migration plus a retention question in exchange for nothing. The cached
 * value carries `generatedAt` so the UI can say how old the sentences are, which
 * is the part that actually matters.
 */

import 'server-only'
import { getBackendUrl } from '@/lib/backend-proxy'
import { getCached, invalidateCached } from '@/lib/cache'
import type { FeedbackHealth, FeedbackHealthFilters } from './repository'
import { listFeedbackTurns } from './repository'
import { fillTrendWindow, feedbackTrendDelta, MIN_TREND_VOTES } from './trend'

/**
 * How long a digest stays fresh.
 *
 * Six hours is roughly "twice a working day": long enough that a page an
 * operator keeps open all morning costs one call, short enough that a bad
 * afternoon is in the text before the day ends.
 */
export const FEEDBACK_DIGEST_TTL_MS = 6 * 60 * 60 * 1000

/** How long a FAILED attempt is remembered. See the call site for why it is short. */
export const FEEDBACK_DIGEST_FAILURE_TTL_MS = 60 * 1000

/** Fewer votes than this and there is nothing to summarise but noise. */
export const FEEDBACK_DIGEST_MIN_VOTES = 10

/** Questions sampled per direction. Bounded: this becomes a prompt. */
const SAMPLES_PER_DIRECTION = 25

/** Per-question characters handed over. Enough to name a theme, not a transcript. */
const MAX_QUESTION_CHARS = 240

const DIGEST_TIMEOUT_MS = 50_000

/** Bump when the prompt or the brief changes, so old entries do not linger. */
const CACHE_VERSION = 'v1'

export interface FeedbackDigest {
  headline: string
  /** What the data says is working. Never merged into one list with `concerns`. */
  strengths: string[]
  concerns: string[]
  recommendation: string | null
  /** When these sentences were written, so the UI can say how old they are. */
  generatedAt: string
  /** The window they describe — a cached digest must not mislabel itself. */
  windowDays: number
  /** Votes it was computed over, so a thin digest can be shown as thin. */
  votes: number
}

export interface FeedbackDigestResult {
  digest: FeedbackDigest | null
  /**
   * Why there is no digest, when there is none. `no_feedback` and
   * `too_few_votes` are ordinary states, not failures — the UI says so.
   */
  error: string | null
}

export interface FeedbackDigestOptions {
  locale?: string
  /** Skip the cached value and write a fresh one. */
  refresh?: boolean
}

/**
 * The cache key. Every input that changes the sentences is in it — window,
 * organization, topic, locale — and nothing that does not.
 *
 * `verdict`, `reason` and `query` are deliberately absent: they narrow the
 * drill-in, not the window, and the digest describes the window. Keying on them
 * would buy four copies of the same paragraph.
 */
function digestKey(filters: FeedbackHealthFilters, locale: string): string {
  const parts = [
    filters.windowDays ?? 30,
    filters.organizationId ?? '*',
    filters.topic ?? '*',
    locale.slice(0, 5),
  ]
  return `feedback:digest:${CACHE_VERSION}:${parts.join(':')}`
}

/**
 * Flatten and truncate one question for the prompt. `null` for anything that is
 * left empty — a blank sample is a line the model would try to interpret.
 */
function trimQuestion(value: string | null): string | null {
  if (!value) return null
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > MAX_QUESTION_CHARS ? `${flat.slice(0, MAX_QUESTION_CHARS - 1)}…` : flat
}

interface BackendDigestResponse {
  headline?: string
  strengths?: string[]
  concerns?: string[]
  recommendation?: string | null
  error?: string | null
}

/**
 * Produce (or serve from cache) the digest for one window.
 *
 * `health` is the aggregate the caller already computed — passing it in rather
 * than recomputing it keeps the digest to exactly one extra query (the helpful
 * samples), and guarantees the sentences describe the same numbers on screen.
 *
 * Fails open in every direction: an unreachable backend, a model without a key,
 * a malformed reply and a cache outage all return `{ digest: null, error }`. The
 * page works without this and must keep working when it is broken.
 */
export async function getFeedbackDigest(
  health: FeedbackHealth,
  filters: FeedbackHealthFilters,
  options: FeedbackDigestOptions = {},
): Promise<FeedbackDigestResult> {
  const locale = options.locale?.toLowerCase().startsWith('en') ? 'en' : 'de'
  const votes = health.totals.up + health.totals.down
  const key = digestKey(filters, locale)

  if (votes === 0) return { digest: null, error: 'no_feedback' }
  if (votes < FEEDBACK_DIGEST_MIN_VOTES) {
    // A paragraph about six votes reads exactly as confidently as a paragraph
    // about six hundred, and that confidence is the whole problem. Refused here
    // rather than hedged in the prompt, because a hedge is still a paragraph.
    return { digest: null, error: 'too_few_votes' }
  }

  if (options.refresh) await invalidateCached(key)

  // Held on an object so the value survives the closure without TypeScript
  // narrowing it back to its initializer at the read below.
  const outcome: { error: string | null } = { error: null }
  const digest = await getCached<FeedbackDigest | null>(
    key,
    FEEDBACK_DIGEST_TTL_MS,
    async () => {
      const result = await generateDigest(health, filters, locale)
      outcome.error = result.error
      return result.digest
    },
    // A failure is cached for a minute, not six hours. Without this, one
    // timeout would leave the card empty for the rest of the working day and
    // the refresh button would be the only way out of it.
    { negativeTtlMs: FEEDBACK_DIGEST_FAILURE_TTL_MS },
  )

  if (digest) return { digest, error: null }
  return { digest: null, error: outcome.error ?? 'digest_unavailable' }
}

/**
 * The uncached path: sample both directions, strip every identifier, ask the
 * model. Only reached on a cache miss, and every failure is returned rather than
 * thrown — `getFeedbackDigest` caches the outcome either way.
 */
async function generateDigest(
  health: FeedbackHealth,
  filters: FeedbackHealthFilters,
  locale: string,
): Promise<FeedbackDigestResult> {
  // The praised turns. `health.turns` holds whichever direction the reader is
  // looking at, so the other one is fetched here — a digest that sampled only
  // what the drill-in happened to be showing would write a different story
  // depending on which tab was open.
  const sampleFilters = { ...filters, reason: null, query: null, limit: SAMPLES_PER_DIRECTION }
  const [helpful, unhelpful] = await Promise.all([
    listFeedbackTurns({ ...sampleFilters, verdict: 'up' }),
    listFeedbackTurns({ ...sampleFilters, verdict: 'down' }),
  ])

  const samples = [...helpful, ...unhelpful].flatMap((turn) => {
    const question = trimQuestion(turn.question)
    if (!question) return []
    return [{ verdict: turn.verdict, reason: turn.reason, topics: turn.topics, question }]
  })

  const delta = feedbackTrendDelta(
    fillTrendWindow(health.daily, health.windowDays, MIN_TREND_VOTES),
  )

  const body = {
    window_days: health.windowDays,
    answers: health.answers,
    up: health.totals.up,
    down: health.totals.down,
    voters: health.totals.voters,
    down_voters: health.totals.downVoters,
    reasons: Object.fromEntries(
      health.reasons.map((entry) => [entry.reason ?? 'other', entry.count]),
    ),
    topics: health.topics.map((t) => ({ topic: t.topic, up: t.up, down: t.down })),
    // Identity stripped here, at the boundary, so no later edit to the rollup
    // can widen what leaves the process.
    organizations: health.organizations.map((o) => ({ up: o.up, down: o.down })),
    trend_delta_points: delta,
    samples,
    locale,
  }

  let response: Response
  try {
    response = await fetch(`${getBackendUrl()}/v1/feedback-digest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DIGEST_TIMEOUT_MS),
    })
  } catch (error) {
    console.error('[FeedbackDigest] Backend unreachable (non-fatal):', error)
    return { digest: null, error: 'backend_unreachable' }
  }

  if (!response.ok) {
    console.error('[FeedbackDigest] Backend error:', response.status)
    return { digest: null, error: 'backend_error' }
  }

  let payload: BackendDigestResponse
  try {
    payload = (await response.json()) as BackendDigestResponse
  } catch {
    return { digest: null, error: 'backend_error' }
  }

  if (payload.error) return { digest: null, error: payload.error }

  const headline = (payload.headline ?? '').trim()
  const strengths = cleanList(payload.strengths)
  const concerns = cleanList(payload.concerns)
  if (!headline && strengths.length === 0 && concerns.length === 0) {
    return { digest: null, error: 'digest_unavailable' }
  }

  return {
    digest: {
      headline,
      strengths,
      concerns,
      recommendation: (payload.recommendation ?? '').trim() || null,
      generatedAt: new Date().toISOString(),
      windowDays: health.windowDays,
      votes: health.totals.up + health.totals.down,
    },
    error: null,
  }
}

/** Never trust a list from over the wire — the UI renders these as its own rows. */
function cleanList(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  return values
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 3)
}
