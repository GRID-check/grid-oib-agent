/**
 * Where rate-limit buckets live (ADR-0040 L2).
 *
 * Thin by design. The counting is `rate-limiter-flexible` (see `./factory.js`);
 * this module's whole job is to own the ioredis connection, memoise one limiter
 * per rule, and expose a typed surface tests can swap.
 *
 * It deliberately does NOT reuse `@/lib/cache`. That store's contract is JSON
 * values with a TTL and no atomic primitive — which is precisely why the
 * counter it used to back (`@/lib/sharing/rate-limit`) could undercount under
 * concurrency, as its own header admitted. Widening that interface to serve one
 * caller would have been the wrong trade; the cost of not doing so is a second
 * ioredis connection per process, which is a connection, not a problem.
 *
 * With `REDIS_URL` unset (local dev, tests) the limiters are per-process. They
 * still limit — just per replica, so the effective budget with N replicas is
 * N x the configured one. Same trade `server.js` already makes, stated rather
 * than discovered.
 */

import 'server-only'
import { consumeLimiter, createLimiter } from './factory.js'
import type { LimitRule } from './types'

/** The normalised outcome `./factory.js` produces for every path. */
export interface StoreOutcome {
  readonly allowed: boolean
  readonly retryAfterMs: number
  readonly remaining: number
  readonly degraded: boolean
}

export interface LimitStore {
  consume(rule: LimitRule, subject: string, cost: number): Promise<StoreOutcome>
}

/** The ioredis surface this module touches. Narrow on purpose. */
interface RedisLike {
  on(event: string, handler: (error: unknown) => void): void
}

class LimiterStore implements LimitStore {
  /** One limiter per rule — building them per call would leak connections. */
  private readonly limiters = new Map<string, ReturnType<typeof createLimiter>>()

  constructor(private readonly client: RedisLike | null) {}

  async consume(rule: LimitRule, subject: string, cost: number): Promise<StoreOutcome> {
    let limiter = this.limiters.get(rule.name)
    if (!limiter) {
      limiter = createLimiter(rule, this.client)
      this.limiters.set(rule.name, limiter)
    }
    return consumeLimiter(limiter, subject, cost)
  }
}

function createClient(url: string): RedisLike {
  // Lazy require keeps ioredis out of bundles that never set REDIS_URL — the
  // same shape `@/lib/cache` uses.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const IORedis = require('ioredis')
  const client = new IORedis(url, {
    connectTimeout: 1000,
    // Tight: this sits in front of a user-visible action, and failing open fast
    // beats blocking a request on a slow store.
    commandTimeout: 500,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  }) as RedisLike
  client.on('error', (error: unknown) => {
    console.warn('[limits] store error:', error)
  })
  return client
}

function createDefaultStore(): LimitStore {
  const url = process.env.REDIS_URL
  if (url) {
    try {
      return new LimiterStore(createClient(url))
    } catch (error) {
      console.warn('[limits] redis store unavailable, using per-process buckets:', error)
    }
  }
  return new LimiterStore(null)
}

let store: LimitStore | null = null

export function getLimitStore(): LimitStore {
  if (!store) store = createDefaultStore()
  return store
}

/** Swap the backing store (tests). Pass `null` to restore the default. */
export function setLimitStore(next: LimitStore | null): void {
  store = next
}

/** Per-process buckets, for tests that want real counting without a store. */
export function createInProcessStore(): LimitStore {
  return new LimiterStore(null)
}
