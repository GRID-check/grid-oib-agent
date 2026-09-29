import type { CacheStore } from '@/lib/cache'

/**
 * A `CacheStore` for specs: no TTL expiry, every key visible on `map`.
 *
 * Install it with `setCacheStore(new MapCacheStore())` in `beforeEach`, so a
 * spec can assert what was (and was not) written, not only what came back.
 */
export class MapCacheStore implements CacheStore {
  readonly map = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key)
  }
  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.map.keys()]) if (key.startsWith(prefix)) this.map.delete(key)
  }
}
