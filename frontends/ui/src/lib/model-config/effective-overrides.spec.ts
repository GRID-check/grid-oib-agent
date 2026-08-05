/**
 * @vitest-environment node
 */
/**
 * The three-layer model resolution, at the layer where the layers actually
 * meet: platform default < org override, merged per agent group.
 *
 * These are the cases that decide whether "the admin moved the fleet" works:
 * an org that pinned one group must still follow the new default everywhere
 * else, and a platform-side failure must never cost an org its own choice.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getEffectiveModelOverrides } from './service'

vi.mock('server-only', () => ({}))

const getPlatformModelDefaults = vi.fn()
vi.mock('./platform-defaults', () => ({
  getPlatformModelDefaults: (): unknown => getPlatformModelDefaults(),
}))

// Read-through cache with no store, so each test sees its own stubs.
vi.mock('@/lib/cache', () => ({
  getCached: vi.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader()),
  invalidateCached: vi.fn(),
}))

/**
 * `getOrgModelConfig` issues up to two chained selects (the pointer row, then
 * the version row). This returns each queued result in turn, so a test states
 * what the database holds rather than what the query builder does.
 */
const selectResults: unknown[][] = []
vi.mock('@/lib/db', () => ({
  getDb: () => ({
    select: () => {
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: async () => selectResults.shift() ?? [],
      }
      return chain
    },
  }),
}))

describe('getEffectiveModelOverrides', () => {
  beforeEach(() => {
    selectResults.length = 0
    getPlatformModelDefaults.mockReset()
  })

  /** No pointer row: the org has never configured anything. */
  const orgConfiguredNothing = (): void => {
    selectResults.push([])
  }

  /** Pointer row → version row carrying the org's own choices. */
  const orgChose = (overrides: Record<string, { model: string }>): void => {
    selectResults.push([{ activeVersionId: 'version-1', updatedBy: 'user-1', updatedAt: new Date() }])
    selectResults.push([{ id: 'version-1', overrides }])
  }

  it('serves the platform default to an org that configured nothing', async () => {
    getPlatformModelDefaults.mockResolvedValue({ intent: 'vendor/fast', deep_research: 'vendor/deep' })
    orgConfiguredNothing()

    expect(await getEffectiveModelOverrides('org_1')).toEqual({
      intent: 'vendor/fast',
      deep_research: 'vendor/deep',
    })
  })

  it("keeps the org's own choice and inherits the default for every other group", async () => {
    getPlatformModelDefaults.mockResolvedValue({ intent: 'vendor/fast', deep_research: 'vendor/deep' })
    orgChose({ deep_research: { model: 'org/chosen' } })

    expect(await getEffectiveModelOverrides('org_1')).toEqual({
      // Inherited — the org never touched this group.
      intent: 'vendor/fast',
      // The tenant's decision outranks the platform's.
      deep_research: 'org/chosen',
    })
  })

  it('falls back to the org layer alone when the platform defaults cannot be read', async () => {
    getPlatformModelDefaults.mockRejectedValue(new Error('db down'))
    orgChose({ deep_research: { model: 'org/chosen' } })

    expect(await getEffectiveModelOverrides('org_1')).toEqual({ deep_research: 'org/chosen' })
  })

  it('returns null when neither layer says anything — the YAML models apply', async () => {
    getPlatformModelDefaults.mockResolvedValue({})
    orgConfiguredNothing()

    expect(await getEffectiveModelOverrides('org_1')).toBeNull()
  })
})
