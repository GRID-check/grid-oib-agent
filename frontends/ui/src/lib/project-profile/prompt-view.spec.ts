/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Regression coverage for the bundesland cache-invalidation bug (WP-C, Fix 1).
 *
 * Deliberately does NOT mock `@/lib/cache`: it drives a REAL in-memory
 * CacheStore so the test exercises the actual get/set/delete key wiring. A test
 * that stubs the whole cache layer (as profile-service.spec.ts does) cannot see
 * that `bundesland:<id>` was left behind — the exact hole this covers.
 *
 * Only `@/lib/db` is mocked, to control what the loaders read on a cache miss.
 */

let dbRows: unknown[] = []

function makeBuilder() {
  const builder = {
    select: () => builder,
    from: () => builder,
    where: () => builder,
    limit: () => Promise.resolve(dbRows),
  }
  return builder
}

vi.mock('@/lib/db', () => ({ getDb: () => makeBuilder() }))
vi.mock('@/lib/db/schema', () => ({
  projects: { id: 'id', profile: 'profile', profilePromptView: 'profilePromptView' },
}))

/**
 * The repository is the loader behind the cache. Keyed by organization so a
 * test can prove one tenant never receives another's row — which is the point
 * of the partitioned cache key.
 */
const rowsByOrg = new Map<string, { profile: unknown; profilePromptView: string }>()
vi.mock('@/lib/projects/repository', () => ({
  findProjectPromptView: async (_projectId: string, organizationId: string | null | undefined) =>
    rowsByOrg.get(organizationId ?? 'anon')?.profilePromptView ?? (dbRows[0] as { profilePromptView?: string })?.profilePromptView ?? null,
  findProjectProfile: async (_projectId: string, organizationId: string | null | undefined) =>
    rowsByOrg.get(organizationId ?? 'anon')?.profile ?? (dbRows[0] as { profile?: unknown })?.profile ?? null,
}))

import { setCacheStore, type CacheStore } from '@/lib/cache'
import {
  invalidateProjectProfileCaches,
  invalidateProjectPromptViewCache,
  loadProjectBundesland,
  loadProjectPromptView,
} from './prompt-view'

/** Minimal real TTL store — records the exact keys written so we can assert them. */
class TestStore implements CacheStore {
  readonly map = new Map<string, { value: string; expiresAt: number }>()
  async get(key: string) {
    const entry = this.map.get(key)
    if (!entry) return null
    if (Date.now() >= entry.expiresAt) {
      this.map.delete(key)
      return null
    }
    return entry.value
  }
  async set(key: string, value: string, ttlMs: number) {
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs })
  }
  async delete(key: string) {
    this.map.delete(key)
  }
  async deletePrefix(prefix: string) {
    for (const key of this.map.keys()) if (key.startsWith(prefix)) this.map.delete(key)
  }
}

const rowFor = (bundesland: string, promptView: string) => [
  {
    profile: { facts: { bundesland: { value: bundesland } }, goals: {}, unknowns: [], assumptions: {} },
    profilePromptView: promptView,
  },
]

describe('project profile cache invalidation (Fix 1)', () => {
  let store: TestStore

  beforeEach(() => {
    store = new TestStore()
    setCacheStore(store)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('caches both the prompt view and the structured bundesland under their own keys', async () => {
    dbRows = rowFor('wien', 'PROJECT_CONTEXT v1')

    expect(await loadProjectBundesland('proj-1', 'org-1')).toBe('wien')
    expect(await loadProjectPromptView('proj-1', 'org-1')).toBe('PROJECT_CONTEXT v1')

    // Two SEPARATE keys — the crux of the bug: invalidating one leaves the other.
    expect(store.map.has('bundesland:org-1:proj-1')).toBe(true)
    expect(store.map.has('promptview:org-1:proj-1')).toBe(true)
  })

  it('reproduces the bug: prompt-view-only invalidation leaves bundesland stale', async () => {
    dbRows = rowFor('wien', 'PROJECT_CONTEXT v1')
    await loadProjectBundesland('proj-1', 'org-1')
    await loadProjectPromptView('proj-1', 'org-1')

    // The user changes the location and saves; the DB now holds the new value.
    dbRows = rowFor('tirol', 'PROJECT_CONTEXT v2')

    // The OLD invalidation only dropped the prompt-view key…
    await invalidateProjectPromptViewCache('proj-1', 'org-1')

    // …so the prompt view re-reads fresh, but bundesland is served STALE.
    expect(await loadProjectPromptView('proj-1', 'org-1')).toBe('PROJECT_CONTEXT v2')
    expect(await loadProjectBundesland('proj-1', 'org-1')).toBe('wien') // stale — the bug
  })

  it('the fix: invalidateProjectProfileCaches drops BOTH keys so neither goes stale', async () => {
    dbRows = rowFor('wien', 'PROJECT_CONTEXT v1')
    await loadProjectBundesland('proj-1', 'org-1')
    await loadProjectPromptView('proj-1', 'org-1')

    // Location changed + saved.
    dbRows = rowFor('tirol', 'PROJECT_CONTEXT v2')

    await invalidateProjectProfileCaches('proj-1', 'org-1')

    // Both keys were cleared, so both loaders re-read the new stored profile.
    expect(store.map.has('bundesland:org-1:proj-1')).toBe(false)
    expect(store.map.has('promptview:org-1:proj-1')).toBe(false)
    expect(await loadProjectBundesland('proj-1', 'org-1')).toBe('tirol')
    expect(await loadProjectPromptView('proj-1', 'org-1')).toBe('PROJECT_CONTEXT v2')
  })
})

describe('project profile cache is partitioned by tenant', () => {
  let store: TestStore

  beforeEach(() => {
    store = new TestStore()
    setCacheStore(store)
    rowsByOrg.clear()
    dbRows = []
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('does not serve one organization the project context cached for another', async () => {
    // The exploitable shape: `getCached` returns BEFORE the loader runs, and the
    // project id is caller-supplied on the websocket-scope path. With a key of
    // `projectId` alone, org B asking for org A's project id got org A's context
    // straight out of the cache — no query, no tenant scope, no row-level
    // security in the path at all.
    rowsByOrg.set('org-a', {
      profile: { facts: { bundesland: { value: 'wien' } }, goals: {}, unknowns: [], assumptions: {} },
      profilePromptView: 'ORG A CONTEXT',
    })
    rowsByOrg.set('org-b', {
      profile: { facts: { bundesland: { value: 'tirol' } }, goals: {}, unknowns: [], assumptions: {} },
      profilePromptView: 'ORG B CONTEXT',
    })

    expect(await loadProjectPromptView('proj-1', 'org-a')).toBe('ORG A CONTEXT')
    expect(await loadProjectPromptView('proj-1', 'org-b')).toBe('ORG B CONTEXT')

    expect(await loadProjectBundesland('proj-1', 'org-a')).toBe('wien')
    expect(await loadProjectBundesland('proj-1', 'org-b')).toBe('tirol')
  })

  it('does not serve an anonymous caller the context cached for a tenant', async () => {
    rowsByOrg.set('org-a', {
      profile: { facts: { bundesland: { value: 'wien' } }, goals: {}, unknowns: [], assumptions: {} },
      profilePromptView: 'ORG A CONTEXT',
    })
    rowsByOrg.set('anon', {
      profile: { facts: { bundesland: { value: 'tirol' } }, goals: {}, unknowns: [], assumptions: {} },
      profilePromptView: 'ANON CONTEXT',
    })

    expect(await loadProjectPromptView('proj-1', 'org-a')).toBe('ORG A CONTEXT')
    expect(await loadProjectPromptView('proj-1', null)).toBe('ANON CONTEXT')
  })

  it('a write evicts the anonymous variant as well as its own', async () => {
    // An authenticated write knows an organization; an anonymous deployment
    // populated `anon`. Dropping only one leaves the other serving what the
    // write just replaced.
    rowsByOrg.set('org-a', {
      profile: { facts: { bundesland: { value: 'wien' } }, goals: {}, unknowns: [], assumptions: {} },
      profilePromptView: 'BEFORE',
    })
    rowsByOrg.set('anon', {
      profile: { facts: { bundesland: { value: 'wien' } }, goals: {}, unknowns: [], assumptions: {} },
      profilePromptView: 'BEFORE',
    })
    await loadProjectPromptView('proj-1', 'org-a')
    await loadProjectPromptView('proj-1', null)
    await loadProjectBundesland('proj-1', 'org-a')

    await invalidateProjectProfileCaches('proj-1', 'org-a')

    expect(store.map.has('promptview:org-a:proj-1')).toBe(false)
    expect(store.map.has('promptview:anon:proj-1')).toBe(false)
    expect(store.map.has('bundesland:org-a:proj-1')).toBe(false)
  })
})
