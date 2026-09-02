/**
 * Opt-in integration test: the first-boot bootstrap against a real Postgres with
 * the migrations applied. Skipped unless GRID_TEST_DATABASE_URL is set (CI has
 * no database).
 *
 * The unit spec covers the decision logic with everything mocked. What only a
 * real database can show is the part that decides whether this is safe to run on
 * every boot of every replica: that the advisory lock is actually taken and
 * released (a leaked lock would block every subsequent boot), that the
 * empty-table guard reads committed state, and that what lands is readable
 * through `getPlatformModelDefaults` — the function the runtime merge calls —
 * rather than merely present in the table.
 *
 * The backend, the catalog and the audit sink are stubbed: this is about the
 * database interaction, not about re-testing the network calls.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_GROUPS } from './agent-groups'

vi.mock('server-only', () => ({}))

const url = process.env.GRID_TEST_DATABASE_URL

const OPENROUTER = 'https://openrouter.ai/api/v1'
const allRefs = AGENT_GROUPS.flatMap((group) => group.configLlmRefs)

const getWorkflowLlmBaseUrls = vi.fn()
vi.mock('./backend-defaults', () => ({
  getWorkflowLlmBaseUrls: (): unknown => getWorkflowLlmBaseUrls(),
}))

vi.mock('./openrouter', () => ({
  fetchModelCatalog: async (): Promise<unknown[]> => [{ id: 'openai/gpt-5.6-luna' }],
  fetchZdrModelIds: async (): Promise<Set<string>> => new Set(['openai/gpt-5.6-luna']),
  baseModelId: (id: string): string => id.split(':')[0],
  validateOverrides: (_catalog: unknown, defaults: Record<string, string>) => ({
    ok: true,
    errors: {},
    snapshot: Object.fromEntries(
      Object.keys(defaults).map((group) => [group, { id: defaults[group] }]),
    ),
  }),
}))

const recordAuditEvent = vi.fn()
vi.mock('@/lib/audit/service', () => ({
  recordAuditEvent: (input: unknown): unknown => recordAuditEvent(input),
}))
vi.mock('@/lib/authz/platform', () => ({
  getPlatformOrganizationId: async (): Promise<string | null> => null,
}))

describe.skipIf(!url)('platform default bootstrap against live Postgres', () => {
  beforeEach(async () => {
    process.env.GRID_APP_DATABASE_URL = url
    vi.clearAllMocks()
    getWorkflowLlmBaseUrls.mockResolvedValue(
      Object.fromEntries(allRefs.map((ref) => [ref, OPENROUTER])),
    )
    const { getDb } = await import('@/lib/db')
    const { sql } = await import('drizzle-orm')
    await getDb().execute(sql`DELETE FROM platform_model_defaults`)
    const { invalidatePlatformModelDefaults } = await import('./platform-defaults')
    await invalidatePlatformModelDefaults()
  })

  afterAll(async () => {
    const { closeDb } = await import('@/lib/db')
    await closeDb()
  })

  it('provisions an empty deployment, is idempotent, and never keeps the lock', async () => {
    const { bootstrapPlatformModelDefaults } = await import('./bootstrap-defaults')
    const { getPlatformModelDefaults, invalidatePlatformModelDefaults } = await import(
      './platform-defaults'
    )
    const { getDb } = await import('@/lib/db')
    const { sql } = await import('drizzle-orm')

    const written = await bootstrapPlatformModelDefaults()
    expect(written.sort()).toEqual(AGENT_GROUPS.map((group) => group.id).sort())

    // Readable through the function the runtime merge actually calls.
    await invalidatePlatformModelDefaults()
    const defaults = await getPlatformModelDefaults()
    expect(Object.keys(defaults).sort()).toEqual(AGENT_GROUPS.map((group) => group.id).sort())
    expect(new Set(Object.values(defaults))).toEqual(new Set(['openai/gpt-5.6-luna']))

    // The ZDR signal survives the round trip — a NULL snapshot would silently
    // disable the warning ZDR tenants depend on.
    const rows = Array.from(
      await getDb().execute<{ agent_group: string; updated_by: string; model_snapshot: unknown }>(
        sql`SELECT agent_group, updated_by, model_snapshot FROM platform_model_defaults ORDER BY agent_group`,
      ),
    )
    expect(rows).toHaveLength(AGENT_GROUPS.length)
    expect(rows.every((row) => row.updated_by === 'system:bootstrap')).toBe(true)
    expect(
      (rows[0].model_snapshot as { _zdr?: { safe?: boolean | null } } | null)?._zdr?.safe,
    ).toBe(true)

    // A leaked advisory lock would silently disable every later boot, so prove
    // the session holds none before asserting the second run is a no-op.
    const held = Array.from(
      await getDb().execute<{ count: number }>(
        sql`SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory'`,
      ),
    )
    expect(Number(held[0].count)).toBe(0)

    await invalidatePlatformModelDefaults()
    expect(await bootstrapPlatformModelDefaults()).toEqual([])
    expect(Array.from(await getDb().execute(sql`SELECT 1 FROM platform_model_defaults`))).toHaveLength(
      AGENT_GROUPS.length,
    )
  })

  it("leaves a deployment that already has an opinion untouched", async () => {
    const { bootstrapPlatformModelDefaults } = await import('./bootstrap-defaults')
    const { savePlatformModelDefaults, getPlatformModelDefaults, invalidatePlatformModelDefaults } =
      await import('./platform-defaults')

    await savePlatformModelDefaults({
      defaults: { shallow_research: 'vendor/owner-pick' },
      modelSnapshot: { shallow_research: { id: 'vendor/owner-pick' } },
      note: 'owner choice',
      actorUserId: 'user_owner',
      actorEmail: 'owner@grid.test',
    })

    expect(await bootstrapPlatformModelDefaults()).toEqual([])
    await invalidatePlatformModelDefaults()
    expect(await getPlatformModelDefaults()).toEqual({ shallow_research: 'vendor/owner-pick' })
  })

  it('writes nothing on a deployment pointed at another provider', async () => {
    const { bootstrapPlatformModelDefaults } = await import('./bootstrap-defaults')
    const { getPlatformModelDefaults, invalidatePlatformModelDefaults } = await import(
      './platform-defaults'
    )
    getWorkflowLlmBaseUrls.mockResolvedValue(
      Object.fromEntries(allRefs.map((ref) => [ref, 'https://api.kimi.com/coding/v1'])),
    )

    expect(await bootstrapPlatformModelDefaults()).toEqual([])
    await invalidatePlatformModelDefaults()
    expect(await getPlatformModelDefaults()).toEqual({})
  })
})
