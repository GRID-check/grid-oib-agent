/**
 * The wire shape of `GET /api/platform/answer-feedback`, and the few constants
 * the answer-feedback organism and its parts share.
 *
 * The optional fields (`organizationName`, `comment`, `expectedAnswer`,
 * `langfuseTraceUrl`, `langfuse`) arrived after the first version of the route.
 * They are typed optional AND nullable so the surface renders against either
 * server: a missing name falls back to the organization id, a missing trace URL
 * hides the Langfuse button rather than drawing a dead one.
 */

import type { ConversationTagKey } from '@/lib/conversations/tags'

/**
 * Down-vote reasons in FIXED order. A reason keeps its row when another drops
 * out of the window, so the bars never reshuffle between loads. Mirrors
 * `ANSWER_FEEDBACK_REASONS`.
 */
export const FEEDBACK_REASONS = ['inaccurate', 'wrong_source', 'too_slow', 'other'] as const
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number]

/** Below this many votes a percentage is noise, not a rate. */
export const MIN_RATE_VOTES = 5

/** Which half of the feedback the drill-in lists. */
export type FeedbackVerdict = 'down' | 'up'

export interface FeedbackHealthTurn {
  id: string
  organizationId: string
  organizationName?: string | null
  projectId: string | null
  conversationId: string | null
  messageId: string
  verdict: FeedbackVerdict
  reason: FeedbackReason | null
  createdAt: string
  answer: string | null
  question: string | null
  conversationTitle: string | null
  topics: ConversationTagKey[]
  /** The voter's free text on a down-vote. */
  comment?: string | null
  /** What the voter says a good answer would have contained. */
  expectedAnswer?: string | null
  /** Deep link to the turn's trace, when Langfuse is configured and the trace is known. */
  langfuseTraceUrl?: string | null
}

export interface FeedbackOrgRow {
  organizationId: string
  organizationName?: string | null
  up: number
  down: number
  voters: number
}

export interface FeedbackHealthResponse {
  windowDays: number
  answers: number
  /** Distinct answers that carry a vote (server, when present). */
  ratedAnswers?: number
  /**
   * Share of answers rated, 0–1, or null when the window has no answers. The
   * server counts answers produced in the window PLUS answers voted on in it,
   * so this never exceeds 1; prefer it over dividing votes by answers here.
   */
  coverage?: number | null
  totals: { up: number; down: number; voters: number; downVoters: number }
  reasons: { reason: FeedbackReason | null; count: number }[]
  daily: { day: string; up: number; down: number }[]
  organizations: FeedbackOrgRow[]
  topics: { topic: ConversationTagKey; up: number; down: number; voters: number }[]
  turns: FeedbackHealthTurn[]
  langfuse?: { projectUrl: string } | null
}

/**
 * Numbers wear the reader's locale: German writes 1.284 and 12,9 where
 * `toFixed` would print 1284 and 12.9.
 */
export const formatCount = (value: number, locale: string, decimals = 0): string =>
  value.toLocaleString(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })

/** The display name of an organization: its name when the server sent one, else its id. */
export const orgLabel = (row: {
  organizationId: string
  organizationName?: string | null
}): string => row.organizationName?.trim() || row.organizationId

/** Flatten and trim a persisted turn to something a scannable row can hold. */
export function excerpt(value: string | null | undefined, max = 180): string | null {
  if (!value) return null
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
