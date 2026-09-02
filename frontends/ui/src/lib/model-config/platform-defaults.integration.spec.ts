/**
 * @vitest-environment node
 */
/**
 * Opt-in integration test: the platform default-model set against a real
 * Postgres with migration 0026 applied. Skipped unless GRID_TEST_DATABASE_URL
 * is set (CI has no database).
 *
 * The behaviour worth a real database: a save is a REPLACE, not a patch — a
 * group left out of the payload is cleared back to the workflow config — and
 * the cached read reflects it immediately rather than after a TTL.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL

describe.skipIf(!url)('platform model defaults against live Postgres', () => {
  beforeAll(() => {
    process.env.GRID_APP_DATABASE_URL = url
  })

  afterAll(async () => {
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('saves, replaces and clears the fleet defaults', async () => {
    const { getPlatformModelDefaults, listPlatformModelDefaults, savePlatformModelDefaults } =
      await import('./platform-defaults')

    const actor = { actorUserId: 'user_test', actorEmail: 'owner@grid.test' }

    // Nothing pinned: every group runs on the workflow config.
    await savePlatformModelDefaults({ defaults: {}, modelSnapshot: {}, note: null, ...actor })
    expect(await getPlatformModelDefaults()).toEqual({})

    await savePlatformModelDefaults({
      defaults: { shallow_research: 'vendor/fast', deep_research: 'vendor/deep' },
      modelSnapshot: { shallow_research: { id: 'vendor/fast' }, deep_research: { id: 'vendor/deep' } },
      note: 'initial fleet default',
      ...actor,
    })
    expect(await getPlatformModelDefaults()).toEqual({ shallow_research: 'vendor/fast', deep_research: 'vendor/deep' })

    // A save is the whole set: `shallow_research` changes, `deep_research` is dropped.
    await savePlatformModelDefaults({
      defaults: { shallow_research: 'vendor/faster' },
      modelSnapshot: { shallow_research: { id: 'vendor/faster' } },
      note: 'model bump',
      ...actor,
    })
    expect(await getPlatformModelDefaults()).toEqual({ shallow_research: 'vendor/faster' })

    const rows = await listPlatformModelDefaults()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agentGroup: 'shallow_research', model: 'vendor/faster', note: 'model bump' })

    await savePlatformModelDefaults({ defaults: {}, modelSnapshot: {}, note: null, ...actor })
    expect(await getPlatformModelDefaults()).toEqual({})
  })
})
