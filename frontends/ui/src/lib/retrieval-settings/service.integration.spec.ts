/**
 * Opt-in integration test: the platform retrieval settings against a real
 * Postgres with migration 0029 applied. Skipped unless GRID_TEST_DATABASE_URL
 * is set (CI has no database).
 *
 * The behaviour worth a real database: a save is a REPLACE, not a patch — a
 * key left out of the payload is cleared back to the catalog default — and
 * the cached read reflects it immediately rather than after a TTL.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL

describe.skipIf(!url)('platform retrieval settings against live Postgres', () => {
  beforeAll(() => {
    process.env.GRID_APP_DATABASE_URL = url
  })

  afterAll(async () => {
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('saves, replaces and clears the pinned counts', async () => {
    const {
      getPlatformRetrievalSettings,
      listPlatformRetrievalSettings,
      savePlatformRetrievalSettings,
    } = await import('./service')

    const actor = { actorUserId: 'user_test', actorEmail: 'owner@grid.test' }

    // Nothing pinned: the map is empty, the view shows catalog defaults.
    await savePlatformRetrievalSettings({ settings: {}, note: null, ...actor })
    expect(await getPlatformRetrievalSettings()).toEqual({})

    let view = await listPlatformRetrievalSettings()
    expect(view).toHaveLength(9)
    expect(view.every((row) => !row.overridden && row.value === row.defaultValue)).toBe(true)

    await savePlatformRetrievalSettings({
      settings: { 'knowledge.top_k': 12, 'web.max_results': 7 },
      note: 'wider net',
      ...actor,
    })
    expect(await getPlatformRetrievalSettings()).toEqual({ 'knowledge.top_k': 12, 'web.max_results': 7 })

    // A save is the whole set: `knowledge.top_k` changes, `web.max_results` is dropped.
    await savePlatformRetrievalSettings({ settings: { 'knowledge.top_k': 10 }, note: 'bump', ...actor })
    expect(await getPlatformRetrievalSettings()).toEqual({ 'knowledge.top_k': 10 })

    view = await listPlatformRetrievalSettings()
    const topK = view.find((row) => row.key === 'knowledge.top_k')
    expect(topK).toMatchObject({ value: 10, defaultValue: 8, overridden: true, note: 'bump' })
    expect(view.find((row) => row.key === 'web.max_results')).toMatchObject({ value: 5, overridden: false })

    await savePlatformRetrievalSettings({ settings: {}, note: null, ...actor })
    expect(await getPlatformRetrievalSettings()).toEqual({})
  })

  it('rejects values outside the catalog before touching the database', async () => {
    const { savePlatformRetrievalSettings } = await import('./service')
    const actor = { actorUserId: 'user_test', actorEmail: 'owner@grid.test' }

    await expect(
      savePlatformRetrievalSettings({ settings: { 'knowledge.top_k': 0 }, note: null, ...actor })
    ).rejects.toMatchObject({ status: 422 })
    await expect(
      savePlatformRetrievalSettings({ settings: { 'ris.page_size': 30 }, note: null, ...actor })
    ).rejects.toMatchObject({ status: 422 })
    await expect(
      savePlatformRetrievalSettings({ settings: { 'not.a.key': 1 }, note: null, ...actor })
    ).rejects.toMatchObject({ status: 422 })
  })
})
