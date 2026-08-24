/**
 * @vitest-environment node
 */
/**
 * Opt-in integration test: real model-config version lifecycle against a real
 * Postgres with migration 0012 applied. Skipped unless GRID_TEST_DATABASE_URL
 * is set (CI has no database).
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL

describe.skipIf(!url)('model-config service against live Postgres', () => {
  beforeAll(() => {
    process.env.GRID_APP_DATABASE_URL = url
  })

  afterAll(async () => {
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('creates versions, resolves overrides, rolls back, deactivates', async () => {
    const { activateVersion, createAndActivateVersion, getActiveModelOverrides, getOrgModelConfig, listVersions } =
      await import('./service')

    const org = `org_test_${Date.now()}`

    // No config yet: defaults.
    expect(await getActiveModelOverrides(org)).toBeNull()

    const v1 = await createAndActivateVersion({
      organizationId: org,
      overrides: { deep_research: { model: 'vendor/model-a' } },
      modelSnapshot: { deep_research: { id: 'vendor/model-a', contextLength: 200000 } },
      comment: 'first',
      actorUserId: 'admin_1',
    })
    expect(v1.version).toBe(1)
    expect(await getActiveModelOverrides(org)).toEqual({ deep_research: 'vendor/model-a' })

    const v2 = await createAndActivateVersion({
      organizationId: org,
      overrides: { deep_research: { model: 'vendor/model-b' }, intent: { model: 'vendor/model-c' } },
      modelSnapshot: null,
      comment: 'second',
      actorUserId: 'admin_1',
    })
    expect(v2.version).toBe(2)
    expect(await getActiveModelOverrides(org)).toEqual({
      deep_research: 'vendor/model-b',
      intent: 'vendor/model-c',
    })

    // History is append-only, newest first.
    const versions = await listVersions(org)
    expect(versions.map((v) => v.version)).toEqual([2, 1])

    // Rollback to v1 repoints without writing a new version.
    await activateVersion({ organizationId: org, versionId: v1.id, actorUserId: 'admin_2' })
    expect(await getActiveModelOverrides(org)).toEqual({ deep_research: 'vendor/model-a' })
    expect((await listVersions(org)).length).toBe(2)
    expect((await getOrgModelConfig(org)).updatedBy).toBe('admin_2')

    // Foreign org's version id is rejected.
    await expect(
      activateVersion({ organizationId: 'org_other', versionId: v1.id, actorUserId: 'admin_2' }),
    ).rejects.toThrow(/not found/)

    // Deactivate → defaults.
    await activateVersion({ organizationId: org, versionId: null, actorUserId: 'admin_2' })
    expect(await getActiveModelOverrides(org)).toBeNull()
  })
})
