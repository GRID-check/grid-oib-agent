/**
 * The one vocabulary every rate limit in the BFF speaks (ADR-0040).
 *
 * Before this module there were five limiters and no shared type between them:
 * the WS-upgrade window in `server.js`, the collaboration counters in
 * `@/lib/sharing/rate-limit`, async-job admission in the Python API, the EUR
 * budgets (ADR-0015) and the per-run token ceilings. Each had its own idea of
 * what "refused" looks like, so the UI could not render one story and an
 * operator could not answer "which limit stopped this?" without reading code.
 *
 * These types are deliberately small: a rule, and a decision about a rule.
 */

/** A number of units per window. */
export interface LimitBudget {
  /** Units permitted per `windowMs`. */
  readonly limit: number
  /** Window length in milliseconds. */
  readonly windowMs: number
}

/**
 * A named budget.
 *
 * Rules live in `./rules.js` (CommonJS so the WebSocket proxy can load the same
 * data) and are re-exported with these types by `./catalog`. One place, so a
 * limit can be found by grep and changed once.
 *
 * The unit of a rule is a "unit", not a request: a caller may spend more than
 * one per call (mentioning eight people, an expensive chat turn), which is what
 * lets a single rule bound work rather than merely traffic.
 */
export interface LimitRule extends LimitBudget {
  /** Stable identifier. Appears in the bucket key, the log line and the 429. */
  readonly name: string
  /**
   * An optional second, shorter clause enforced alongside the first: "30 per 5
   * minutes, and never more than 5 in any 10 seconds".
   *
   * Written as its own window rather than as a tolerance parameter because that
   * is what the limiter supports natively — and because two windows read more
   * honestly than one number that means two things.
   */
  readonly burst?: LimitBudget
}

/**
 * What happened, in enough detail to act on.
 *
 * `degraded` is the field that keeps this honest. Every limiter here fails
 * open, so an allowed decision means either "within budget" or "we could not
 * tell" — and a system that cannot distinguish those two reports full health
 * while enforcing nothing. Callers may ignore it; metrics and tests must not.
 */
export interface RateLimitDecision {
  /** Whether the caller may proceed. */
  readonly allowed: boolean
  /** The rule that produced this decision. */
  readonly rule: string
  /** Units still available on the tightest clause. 0 on refusal. */
  readonly remaining: number
  /** The rule's sustained budget, for `X-RateLimit-Limit`. */
  readonly limit: number
  /**
   * Seconds until the request would be admitted — the limiter's own number, not
   * the window length, so `Retry-After` can be trusted. 0 when allowed.
   */
  readonly retryAfterSeconds: number
  /**
   * True when the counter store could not be reached and the request was let
   * through unmetered. Never true together with `allowed: false`.
   */
  readonly degraded: boolean
}
