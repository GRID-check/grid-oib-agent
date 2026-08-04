/**
 * Spending a budget, and what to do when it is gone (ADR-0040 L2).
 *
 * One entry point (`consumeLimit`) so that the failure policy is written once:
 * **every app-layer limit fails open**. A counter store that cannot be reached
 * must degrade to "not limited", never to "not available" — these are abuse
 * bounds, and refusing real users to protect against a hypothetical one is a
 * worse outcome than the abuse. The single exception in the whole system is the
 * ADR-0015 budget refusal, which is about money and stays fail-closed.
 *
 * Fail-open is only defensible if it is visible, so a degraded decision says so
 * (`RateLimitDecision.degraded`) and warns once per occurrence. A limiter that
 * quietly enforces nothing is worse than no limiter, because it also removes
 * the pressure to notice.
 */

import 'server-only'
import { TooManyRequestsError } from '@/lib/api/errors'
import { getLimitStore } from './store'
import type { LimitRule, RateLimitDecision } from './types'

/**
 * Spend `cost` units of `rule` against `subject` and report the outcome.
 *
 * Called for its side effect: the cost is taken up front, because a caller that
 * checks and then acts leaves a gap wide enough to drive the abuse through.
 *
 * `subject` is whatever the rule is per — a user id, an org id, a session id, a
 * client address. It is concatenated into the bucket key, so it must be a value
 * the caller controls, never raw user input that could collide across tenants.
 */
export async function consumeLimit(
  rule: LimitRule,
  subject: string,
  cost = 1,
): Promise<RateLimitDecision> {
  try {
    const outcome = await getLimitStore().consume(rule, subject, cost)
    return {
      allowed: outcome.allowed,
      rule: rule.name,
      remaining: outcome.remaining,
      limit: rule.limit,
      // Round UP: a Retry-After that lands a millisecond early just gets
      // refused again, which reads to a client as a limiter that lies.
      retryAfterSeconds: Math.ceil(outcome.retryAfterMs / 1000),
      degraded: outcome.degraded,
    }
  } catch (error) {
    // `./factory.js` already turns store failures into a degraded allow, so
    // reaching here means something unexpected — a malformed rule, a bad
    // subject. Same policy: an abuse bound must never be the thing that breaks
    // the product.
    console.warn(`[limits] ${rule.name} check failed for ${subject}, allowing:`, error)
    return {
      allowed: true,
      rule: rule.name,
      remaining: rule.limit,
      limit: rule.limit,
      retryAfterSeconds: 0,
      degraded: true,
    }
  }
}

/**
 * `consumeLimit`, but a refusal throws the error the route factory already
 * knows how to render.
 *
 * Services call this when there is nothing sensible to do with a refusal except
 * surface it. Callers that want to shed silently (presence, typing) should use
 * `consumeLimit` and ignore the decision — dropping a presence ping is cheaper
 * for everyone than a 429 the UI has to explain.
 */
export async function enforceLimit(
  rule: LimitRule,
  subject: string,
  cost = 1,
): Promise<RateLimitDecision> {
  const decision = await consumeLimit(rule, subject, cost)
  if (!decision.allowed) throw new TooManyRequestsError(decision)
  return decision
}

/**
 * The standard rate-limit headers for a decision.
 *
 * Emitted on refusals (via `TooManyRequestsError`) and available to any route
 * that wants to advertise remaining budget on success. `X-RateLimit-*` are the
 * de-facto names every HTTP client already understands; `Retry-After` is the
 * one the browser and every retry library actually act on, and here it carries
 * a real number computed by the algorithm rather than the window length.
 */
export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Limit': String(decision.limit),
    'X-RateLimit-Remaining': String(decision.remaining),
    'X-RateLimit-Policy': decision.rule,
  }
  if (!decision.allowed) headers['Retry-After'] = String(Math.max(1, decision.retryAfterSeconds))
  return headers
}
