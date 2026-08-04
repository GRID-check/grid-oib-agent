/**
 * Turning a rule into an enforced budget (ADR-0040 L2 / L2b).
 *
 * The enforcement is `rate-limiter-flexible` — atomic Lua against Dragonfly,
 * with an in-memory implementation of the same interface for processes that
 * have no store configured. We do not implement a counting algorithm here, and
 * that is the point: the earlier draft of this module hand-rolled GCRA, which
 * was ~40 lines nobody else had ever run.
 *
 * CommonJS for the same reason as `./rules.js`: `server.js` enforces three of
 * these rules on an open WebSocket and cannot import TypeScript. Both sides
 * construct limiters through this one function, so the BFF and the WS proxy
 * cannot end up with different key prefixes, windows, or failure behaviour.
 *
 * ## Two clauses per rule
 *
 * A rule may carry a `burst` budget alongside its sustained one, and both are
 * enforced together via `RateLimiterUnion`: "30 per 5 minutes, and never more
 * than 5 in any 10 seconds". Expressing burst as its own short window (rather
 * than as a tolerance parameter) is what the library supports natively, and it
 * reads more honestly in the catalog than a single number that means two
 * things.
 *
 * One behaviour worth knowing: a request refused by the burst clause has still
 * spent a point of the sustained clause. A client that ignores `Retry-After`
 * and hammers therefore depletes its own longer budget. For an abuse bound that
 * is the right direction — but it means the sustained window is a floor on
 * misbehaviour, not a promise to well-behaved clients that they can always
 * spend all 30.
 */

// `require` rather than `import`, and not negotiable: this module is loaded by
// `server.js`, which is CommonJS. Same exemption `@/lib/cache` takes for ioredis.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RateLimiterMemory, RateLimiterRedis, RateLimiterUnion } = require('rate-limiter-flexible')

/** @typedef {import('./rules.js').LimitRule} LimitRule */

/**
 * @typedef {Object} LimitOutcome
 * @property {boolean} allowed
 * @property {number} retryAfterMs Milliseconds until the request would be
 *   admitted, from the limiter's own accounting. 0 when allowed.
 * @property {number} remaining Units left on the tightest clause.
 * @property {boolean} degraded True when the store could not be reached and the
 *   request was let through unmetered.
 */

/** Seconds, rounded up — the library's windows are integer seconds. */
function toSeconds(ms) {
  return Math.max(1, Math.ceil(ms / 1000))
}

/**
 * Build the limiter (or pair of limiters) enforcing one rule.
 *
 * @param {LimitRule} rule
 * @param {unknown} storeClient An ioredis client, or null/undefined for
 *   per-process buckets. A process without a store still limits — it just
 *   limits per replica, so the effective budget is N x the configured one with
 *   N replicas. Stated here rather than discovered later.
 * @returns {{ consume(key: string, points: number): Promise<unknown> }}
 */
function createLimiter(rule, storeClient) {
  const make = (suffix, budget) => {
    const options = {
      keyPrefix: `rl:${rule.name}${suffix}`,
      points: budget.limit,
      duration: toSeconds(budget.windowMs),
    }
    return storeClient
      ? new RateLimiterRedis({ ...options, storeClient })
      : new RateLimiterMemory(options)
  }

  const sustained = make('', { limit: rule.limit, windowMs: rule.windowMs })
  if (!rule.burst) return sustained
  return new RateLimiterUnion(sustained, make(':burst', rule.burst))
}

/**
 * Spend `points` and normalise every possible result into one shape.
 *
 * `rate-limiter-flexible` signals three different things by rejecting:
 * a refusal (a `RateLimiterRes`, or a map of them from a union), and a store
 * failure (a real `Error`). Collapsing them here is what lets every caller —
 * TypeScript route, CommonJS socket proxy — handle one shape.
 *
 * **Store failures fail open** (`degraded: true`). These are abuse bounds; a
 * Dragonfly blip must degrade to "not limited", never to "not available". The
 * one fail-CLOSED limit in the system is the ADR-0015 budget refusal, which is
 * about money. Fail-open is only defensible if it is visible, hence the flag —
 * a limiter that quietly enforces nothing also removes the pressure to notice.
 *
 * @param {{ consume(key: string, points: number): Promise<unknown> }} limiter
 * @param {string} key
 * @param {number} [points]
 * @returns {Promise<LimitOutcome>}
 */
async function consumeLimiter(limiter, key, points = 1) {
  try {
    const result = await limiter.consume(key, points)
    return { allowed: true, retryAfterMs: 0, remaining: minRemaining(result), degraded: false }
  } catch (rejection) {
    if (rejection instanceof Error) {
      // The rule, never the key: `key` is the subject, and the API path passes
      // `organizationId:userId` — identifiers that should not land in logs to
      // record that a cache was briefly unreachable.
      console.warn('[limits] store unavailable, allowing:', rejection.message)
      return { allowed: true, retryAfterMs: 0, remaining: 0, degraded: true }
    }
    return {
      allowed: false,
      retryAfterMs: maxMsBeforeNext(rejection),
      remaining: 0,
      degraded: false,
    }
  }
}

/**
 * A single limiter answers with one `RateLimiterRes`; a union answers with a
 * map of them keyed by prefix. The tightest clause is the one that matters.
 */
function minRemaining(result) {
  const values = isRes(result) ? [result] : Object.values(result ?? {})
  const remaining = values.map((res) => Number(res?.remainingPoints ?? 0))
  return remaining.length ? Math.min(...remaining) : 0
}

/** Wait for the LONGEST refusing clause — the shortest would just re-refuse. */
function maxMsBeforeNext(rejection) {
  const values = isRes(rejection) ? [rejection] : Object.values(rejection ?? {})
  const waits = values.map((res) => Number(res?.msBeforeNext ?? 0))
  return waits.length ? Math.max(...waits) : 0
}

function isRes(value) {
  return value != null && typeof value === 'object' && 'msBeforeNext' in value
}

module.exports = { createLimiter, consumeLimiter }
