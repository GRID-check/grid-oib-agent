/**
 * Shared read-through cache for BFF hot-path lookups.
 *
 * Call sites use `getCached(key, ttlMs, loader)` and never talk to the store
 * directly, so the backing store is swappable. The default store is an
 * in-process TTL map (correct for a single replica). When `REDIS_URL` is set,
 * a Redis-protocol store (Dragonfly) backs the cache instead, making entries
 * and invalidations consistent across replicas (ADR-0019).
 *
 * Values must be JSON-serializable — the shared backend round-trips through
 * JSON, and anything that only works with the in-process store would break the
 * moment a second replica appears.
 *
 * **`Set`, `Map` and `Date` are NOT JSON-serializable, and `getCached<T>` casts
 * rather than validates**, so caching one type-checks and then hands every cache
 * HIT a `{}` (or a string) wearing the declared type. Cache the array/plain
 * shape and rebuild the collection at the boundary — see `enabledSlugsForOrg`
 * (`@/lib/workos/feature-flags`), `loadOrganizationDirectory`
 * (`@/lib/sharing/directory`) and `fetchZdrModelIds`
 * (`@/lib/model-config/openrouter`).
 */

export interface CacheStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlMs: number): Promise<void>
  delete(key: string): Promise<void>
  /** Delete all keys starting with `prefix`. */
  deletePrefix(prefix: string): Promise<void>
}

/**
 * What this tier actually did, since the process started.
 *
 * The caching audit's own words: every ranking in it "is structural", because
 * neither cache module counted anything (`latency-and-caching-audit-2026-09.md`
 * §4.4, option E7 — "every rule above arguing from theory"). A hit rate is the
 * one number that says whether a TTL is worth its staleness, and whether the
 * shared tier is reachable at all — a store that is down reads as 100 % miss
 * plus a rising `errors`, which is exactly the fail-open path below.
 *
 * Module-level mutable state, which the conventions reserve for registries with
 * a `reset_*` — `resetCacheCounters()` is that, and the specs use it. Counting
 * is deliberately unconditional and free (three integer increments); nothing
 * samples, so a reader never has to ask whether the number is scaled.
 */
export interface CacheCounters {
  /** A stored value was found and parsed. */
  hits: number
  /** No stored value (or the store failed), so the loader ran. */
  misses: number
  /** A store operation threw. Every one of these is a fail-open degradation. */
  errors: number
}

const counters: CacheCounters = { hits: 0, misses: 0, errors: 0 }

/** A snapshot of the counters. Copied, so a reader cannot mutate the tally. */
export function readCacheCounters(): CacheCounters {
  return { ...counters }
}

/** Zero the counters (tests, and a profiler run that wants a window). */
export function resetCacheCounters(): void {
  counters.hits = 0
  counters.misses = 0
  counters.errors = 0
}

const MAX_LOCAL_ENTRIES = 5000

interface LocalEntry {
  value: string
  expiresAt: number
}

class InProcessStore implements CacheStore {
  private entries = new Map<string, LocalEntry>()

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key)
      return null
    }
    return entry.value
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    if (this.entries.size >= MAX_LOCAL_ENTRIES) {
      // Drop the oldest insertions rather than growing without bound.
      const overflow = this.entries.size - MAX_LOCAL_ENTRIES + 1
      const keys = this.entries.keys()
      for (let i = 0; i < overflow; i++) {
        const next = keys.next()
        if (next.done) break
        this.entries.delete(next.value)
      }
    }
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs })
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key)
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key)
    }
  }
}

/**
 * Redis-protocol store (Dragonfly). Wraps every operation in try/catch at the
 * call sites below, and additionally keeps timeouts tight here so a cache
 * outage degrades to loader calls instead of hanging requests.
 */
class RedisStore implements CacheStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any

  constructor(url: string) {
    // Lazy require keeps ioredis out of bundles that never set REDIS_URL.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const IORedis = require('ioredis')
    this.client = new IORedis(url, {
      connectTimeout: 1000,
      commandTimeout: 500,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    })
    this.client.on('error', (error: unknown) => {
      console.warn('[cache] redis store error:', error)
    })
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key)
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.client.set(key, value, 'PX', Math.max(1, Math.round(ttlMs)))
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key)
  }

  async deletePrefix(prefix: string): Promise<void> {
    let cursor = '0'
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200)
      if (keys.length > 0) await this.client.del(...keys)
      cursor = next
    } while (cursor !== '0')
  }
}

const createDefaultStore = (): CacheStore => {
  const url = process.env.REDIS_URL
  if (url) {
    try {
      return new RedisStore(url)
    } catch (error) {
      console.warn('[cache] failed to initialize redis store, using in-process cache:', error)
    }
  }
  return new InProcessStore()
}

let store: CacheStore = createDefaultStore()

/** Swap the backing store (tests). */
export function setCacheStore(next: CacheStore): void {
  store = next
}

export interface GetCachedOptions {
  /**
   * TTL applied when the loader returns `null`/`undefined` (negative caching).
   * Defaults to `ttlMs`. Use a short value when a miss should be re-checked
   * quickly (e.g. a user who just joined an org).
   */
  negativeTtlMs?: number
}

/**
 * Read-through cache. Loader failures propagate to the caller; loader results
 * (including `null`) are cached for `ttlMs` (or `negativeTtlMs` for nullish
 * results).
 *
 * Store failures degrade to calling the loader directly — a cache outage must
 * never take a request down.
 */
export async function getCached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
  options?: GetCachedOptions,
): Promise<T> {
  try {
    const hit = await store.get(key)
    if (hit !== null) {
      const parsed = JSON.parse(hit) as T
      counters.hits += 1
      return parsed
    }
  } catch (error) {
    // A malformed entry lands here too, and takes the same road as an outage:
    // one warning, one loader call. Counted as an error AND a miss, because
    // both are true and a hit rate that ignored it would read as healthy.
    counters.errors += 1
    counters.misses += 1
    console.warn(`[cache] read failed for ${key}:`, error)
    return loader()
  }

  counters.misses += 1
  const value = await loader()
  const ttl = value === null || value === undefined ? (options?.negativeTtlMs ?? ttlMs) : ttlMs
  try {
    await store.set(key, JSON.stringify(value ?? null), ttl)
  } catch (error) {
    counters.errors += 1
    console.warn(`[cache] write failed for ${key}:`, error)
  }
  return value
}

/**
 * Write a value directly, bypassing the read-through path.
 *
 * For the rare case where the caller has already computed the value and the
 * write is the point — e.g. a fixed-window counter incrementing itself
 * (`@/lib/sharing/rate-limit`). Prefer `getCached` for anything load-shaped.
 * Fails open: a store error is logged, never thrown.
 */
export async function setCached<T>(key: string, value: T, ttlMs: number): Promise<void> {
  try {
    await store.set(key, JSON.stringify(value ?? null), ttlMs)
  } catch (error) {
    counters.errors += 1
    console.warn(`[cache] direct write failed for ${key}:`, error)
  }
}

/** Drop a single cache entry (write-invalidate call sites). */
export async function invalidateCached(key: string): Promise<void> {
  try {
    await store.delete(key)
  } catch (error) {
    counters.errors += 1
    console.warn(`[cache] invalidate failed for ${key}:`, error)
  }
}

/** Drop every entry under a key prefix (e.g. all budget policies of an org). */
export async function invalidateCachedPrefix(prefix: string): Promise<void> {
  try {
    await store.deletePrefix(prefix)
  } catch (error) {
    counters.errors += 1
    console.warn(`[cache] prefix invalidate failed for ${prefix}:`, error)
  }
}
