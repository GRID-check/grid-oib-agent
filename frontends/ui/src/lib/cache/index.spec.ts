/**
 * The floor under ADR-0020: **a cache outage degrades, it never fails.**
 *
 * That contract is what lets every call site in `lib/` call `getCached` without
 * a try/catch of its own, and until this file existed nothing asserted it — the
 * caching audit counted the coverage at zero ("No test covers `common/cache.py`
 * or `lib/cache/index.ts` at all",
 * `docs/architecture/latency-and-caching-audit-2026-09.md` §4.4, option E6).
 * A regression here is silent by construction: a `throw` from the store surfaces
 * as a 500 on whichever route happens to be first past the broken op, and looks
 * like that route's bug.
 *
 * So the fake below throws on EVERY operation, and each public function is
 * asserted on three axes at once: it returns the fallback, it does not throw,
 * and it warns exactly once. The third matters as much as the first two — a
 * fail-open that says nothing is indistinguishable from a cache that is working,
 * and the counters in this module are the only other thing that would tell you.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getCached,
  invalidateCached,
  invalidateCachedPrefix,
  readCacheCounters,
  resetCacheCounters,
  setCacheStore,
  setCached,
  type CacheStore,
} from './index'

class ThrowingStore implements CacheStore {
  async get(): Promise<string | null> {
    throw new Error('ECONNREFUSED 127.0.0.1:6379')
  }
  async set(): Promise<void> {
    throw new Error('ECONNREFUSED 127.0.0.1:6379')
  }
  async delete(): Promise<void> {
    throw new Error('ECONNREFUSED 127.0.0.1:6379')
  }
  async deletePrefix(): Promise<void> {
    throw new Error('ECONNREFUSED 127.0.0.1:6379')
  }
}

/** A store that reads fine and only fails on the way out. */
class WriteOnlyFailingStore implements CacheStore {
  async get(): Promise<string | null> {
    return null
  }
  async set(): Promise<void> {
    throw new Error('OOM command not allowed when used memory > maxmemory')
  }
  async delete(): Promise<void> {}
  async deletePrefix(): Promise<void> {}
}

/** A store holding a value that is not JSON — a half-written entry. */
class CorruptStore implements CacheStore {
  async get(): Promise<string | null> {
    return '{"partial":'
  }
  async set(): Promise<void> {}
  async delete(): Promise<void> {}
  async deletePrefix(): Promise<void> {}
}

class MemoryStore implements CacheStore {
  readonly entries = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.entries.get(key) ?? null
  }
  async set(key: string, value: string): Promise<void> {
    this.entries.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.entries.delete(key)
  }
  async deletePrefix(prefix: string): Promise<void> {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key)
    }
  }
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  resetCacheCounters()
})

afterEach(() => {
  warn.mockRestore()
  setCacheStore(new MemoryStore())
})

describe('fail-open: a store that throws on every operation', () => {
  beforeEach(() => {
    setCacheStore(new ThrowingStore())
  })

  it('getCached returns the loader value and warns once', async () => {
    const loader = vi.fn(async () => ({ bundesland: 'wien' }))

    await expect(getCached('promptview:org_1:proj_1', 1000, loader)).resolves.toEqual({
      bundesland: 'wien',
    })

    expect(loader).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('[cache] read failed for promptview:org_1:proj_1')
  })

  it('getCached is called again on the next request rather than poisoning anything', async () => {
    const loader = vi.fn(async () => 7)

    await expect(getCached('orgname:org_1', 1000, loader)).resolves.toBe(7)
    await expect(getCached('orgname:org_1', 1000, loader)).resolves.toBe(7)

    expect(loader).toHaveBeenCalledTimes(2)
    expect(readCacheCounters()).toEqual({ hits: 0, misses: 2, errors: 2 })
  })

  it('setCached resolves and warns once', async () => {
    await expect(setCached('websearch:org_1', true, 1000)).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('[cache] direct write failed for websearch:org_1')
  })

  it('invalidateCached resolves and warns once', async () => {
    await expect(invalidateCached('modelconfig:org_1')).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('[cache] invalidate failed for modelconfig:org_1')
  })

  it('invalidateCachedPrefix resolves and warns once', async () => {
    await expect(invalidateCachedPrefix('budgetlimits:')).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('[cache] prefix invalidate failed for budgetlimits:')
  })

  it('every public function survives one broken store, in one pass', async () => {
    // The whole surface at once: nothing here may reject, whatever the store does.
    const results = await Promise.allSettled([
      getCached('flags:org_1', 1000, async () => ['image-upload']),
      setCached('flags:org_1', ['image-upload'], 1000),
      invalidateCached('flags:org_1'),
      invalidateCachedPrefix('flags:'),
    ])

    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ])
  })
})

describe('fail-open: partial failures', () => {
  it('a write that fails still returns the loaded value', async () => {
    setCacheStore(new WriteOnlyFailingStore())

    await expect(getCached('zdronly:org_1', 1000, async () => false)).resolves.toBe(false)

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('[cache] write failed for zdronly:org_1')
    expect(readCacheCounters()).toEqual({ hits: 0, misses: 1, errors: 1 })
  })

  it('an entry that is not JSON takes the same road as an outage', async () => {
    // `JSON.parse` throws INSIDE the read try/catch. That is deliberate: a
    // half-written entry is a broken cache, not a broken request.
    setCacheStore(new CorruptStore())

    await expect(getCached('directory:org_1', 1000, async () => ['ada'])).resolves.toEqual(['ada'])

    expect(warn).toHaveBeenCalledTimes(1)
    expect(readCacheCounters()).toEqual({ hits: 0, misses: 1, errors: 1 })
  })

  it('a loader failure still propagates — the cache fails open, the loader does not', async () => {
    setCacheStore(new MemoryStore())

    await expect(
      getCached('orgname:org_1', 1000, async () => {
        throw new Error('WorkOS 503')
      }),
    ).rejects.toThrow('WorkOS 503')
  })
})

describe('counters', () => {
  let memory: MemoryStore

  beforeEach(() => {
    memory = new MemoryStore()
    setCacheStore(memory)
  })

  it('counts a miss then a hit for the same key', async () => {
    const loader = vi.fn(async () => ({ name: 'Büro Nord' }))

    await getCached('orgname:org_1', 60_000, loader)
    await getCached('orgname:org_1', 60_000, loader)

    expect(loader).toHaveBeenCalledTimes(1)
    expect(readCacheCounters()).toEqual({ hits: 1, misses: 1, errors: 0 })
  })

  it('a nullish value is cached, so the second read is a hit and not a second loader call', async () => {
    const loader = vi.fn(async () => null)

    await getCached('membership:org_1:user_1', 60_000, loader, { negativeTtlMs: 1000 })
    await expect(getCached('membership:org_1:user_1', 60_000, loader)).resolves.toBeNull()

    expect(loader).toHaveBeenCalledTimes(1)
    expect(readCacheCounters()).toEqual({ hits: 1, misses: 1, errors: 0 })
  })

  it('readCacheCounters hands back a copy, not the tally', async () => {
    const snapshot = readCacheCounters()
    snapshot.hits = 999

    await getCached('orgname:org_1', 60_000, async () => 1)

    expect(readCacheCounters().hits).toBe(0)
  })

  it('resetCacheCounters zeroes every field', async () => {
    await getCached('orgname:org_1', 60_000, async () => 1)
    expect(readCacheCounters().misses).toBe(1)

    resetCacheCounters()

    expect(readCacheCounters()).toEqual({ hits: 0, misses: 0, errors: 0 })
  })
})
