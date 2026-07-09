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
 */

export interface CacheStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlMs: number): Promise<void>
  delete(key: string): Promise<void>
  /** Delete all keys starting with `prefix`. */
  deletePrefix(prefix: string): Promise<void>
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
      return JSON.parse(hit) as T
    }
  } catch (error) {
    console.warn(`[cache] read failed for ${key}:`, error)
    return loader()
  }

  const value = await loader()
  const ttl = value === null || value === undefined ? (options?.negativeTtlMs ?? ttlMs) : ttlMs
  try {
    await store.set(key, JSON.stringify(value ?? null), ttl)
  } catch (error) {
    console.warn(`[cache] write failed for ${key}:`, error)
  }
  return value
}

/** Drop a single cache entry (write-invalidate call sites). */
export async function invalidateCached(key: string): Promise<void> {
  try {
    await store.delete(key)
  } catch (error) {
    console.warn(`[cache] invalidate failed for ${key}:`, error)
  }
}

/** Drop every entry under a key prefix (e.g. all budget policies of an org). */
export async function invalidateCachedPrefix(prefix: string): Promise<void> {
  try {
    await store.deletePrefix(prefix)
  } catch (error) {
    console.warn(`[cache] prefix invalidate failed for ${prefix}:`, error)
  }
}
