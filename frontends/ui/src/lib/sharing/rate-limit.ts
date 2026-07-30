/**
 * Fixed-window rate limiting for collaboration actions (spec SH-16, MN-13, IB-10, NF-5).
 *
 * Purpose: bound the blast radius of one account — mention-bombing, mass
 * sharing, notification flooding. This is an ABUSE BOUND, not an accounting
 * mechanism.
 *
 * **Honest about its precision.** The shared cache exposes get/set but no atomic
 * INCR, so a window counter built on read-modify-write can undercount under
 * concurrency: two simultaneous requests may both read `n` and both write
 * `n + 1`. That is acceptable here — the goal is to stop a runaway loop or a
 * malicious burst, and an attacker who wins a handful of races still hits the
 * ceiling almost immediately. Anything that needs exactness (billing, budgets)
 * must not use this; the usage ledger's write-through rollup (ADR-0019) is the
 * pattern for that.
 *
 * **Fail-open**, like every other cache consumer: if the store is unavailable the
 * action is allowed. A cache outage must not make the product unusable.
 */

import 'server-only'
import { getCached, setCached } from '@/lib/cache'

export interface RateLimitRule {
  /** Stable name, used in the key and in the log line. */
  readonly action: string
  /** Maximum permitted occurrences per window. */
  readonly limit: number
  /** Window length in milliseconds. */
  readonly windowMs: number
}

/** Sharing a resource with someone. */
export const SHARE_RATE_LIMIT: RateLimitRule = { action: 'share', limit: 60, windowMs: 60 * 60 * 1000 }

/** Sending mentions (counted per mentioned person, not per message). */
export const MENTION_RATE_LIMIT: RateLimitRule = { action: 'mention', limit: 100, windowMs: 60 * 60 * 1000 }

/**
 * Maximum people one message may mention (spec MN-13, which mandates a bound but
 * names no number).
 *
 * The single source of truth for that bound: the mentions service refuses above
 * it, and the messages route's request schema caps its `mentions` array with this
 * same constant. Keeping them one value is deliberate — a looser schema cap meant
 * an over-limit message passed validation and was then refused by the service,
 * two different errors for one rule.
 */
export const MAX_MENTIONS_PER_MESSAGE = 10

export interface RateLimitResult {
  allowed: boolean
  /** Occurrences already recorded in the current window (best effort). */
  current: number
  limit: number
}

function windowKey(rule: RateLimitRule, subject: string): string {
  const bucket = Math.floor(Date.now() / rule.windowMs)
  return `ratelimit:${rule.action}:${subject}:${bucket}`
}

/**
 * Record `cost` occurrences against `subject` and report whether the window
 * budget is still intact.
 *
 * Implemented over the read-through cache: the "loader" seeds a fresh window at
 * zero, then the incremented value is written back with the window's remaining
 * TTL. Called for its side effect, so it takes the cost up front — a caller that
 * checks and then acts would leave a gap.
 */
export async function consumeRateLimit(
  rule: RateLimitRule,
  subject: string,
  cost = 1,
): Promise<RateLimitResult> {
  const key = windowKey(rule, subject)
  try {
    const current = await getCached(key, rule.windowMs, async () => 0)
    const next = current + cost
    // Re-seed the same key with the new count; TTL restarts, which can extend a
    // window slightly. Deliberate: erring toward MORE limiting, never less.
    await setCached(key, next, rule.windowMs)
    return { allowed: next <= rule.limit, current: next, limit: rule.limit }
  } catch (error) {
    console.warn(`[rate-limit] ${rule.action} check failed for ${subject}, allowing:`, error)
    return { allowed: true, current: 0, limit: rule.limit }
  }
}
