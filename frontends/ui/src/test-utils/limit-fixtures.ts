/**
 * Complete `RateLimitDecision` fixtures for specs that stub `consumeLimit`.
 *
 * Same reasoning as `./db-fixtures`: a hand-written partial decision either
 * needs a cast (which switches off checking for the fixture as well as the
 * call site) or drifts from the real shape the moment a field is added. These
 * helpers return the whole thing, derived from the rule under test, so a spec
 * says what it means — "this call was allowed", "this one was refused" — and
 * stays honest when `RateLimitDecision` changes.
 */

import type { LimitRule, RateLimitDecision } from '@/lib/limits'

/** A decision that lets the call through, with budget to spare. */
export function allowedDecision(rule: LimitRule, remaining = rule.limit - 1): RateLimitDecision {
  return {
    allowed: true,
    rule: rule.name,
    remaining,
    limit: rule.limit,
    retryAfterSeconds: 0,
    degraded: false,
  }
}

/** A decision that refuses the call. */
export function refusedDecision(rule: LimitRule, retryAfterSeconds = 30): RateLimitDecision {
  return {
    allowed: false,
    rule: rule.name,
    remaining: 0,
    limit: rule.limit,
    retryAfterSeconds,
    degraded: false,
  }
}

/**
 * The store was unreachable and the call was let through unmetered.
 *
 * Exists so a spec can assert the fail-open path explicitly. Every app-layer
 * limit fails open (ADR-0040), and the whole point of `degraded` is that the
 * state is visible rather than indistinguishable from "within budget".
 */
export function degradedDecision(rule: LimitRule): RateLimitDecision {
  return {
    allowed: true,
    rule: rule.name,
    remaining: rule.limit,
    limit: rule.limit,
    retryAfterSeconds: 0,
    degraded: true,
  }
}
