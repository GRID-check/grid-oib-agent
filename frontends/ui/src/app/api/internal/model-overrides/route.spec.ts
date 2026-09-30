/**
 * @vitest-environment node
 */
/**
 * What the Python backend pins its OpenRouter requests by. `zdrOnly` must be
 * the EFFECTIVE policy as a boolean: an org that never touched the switch is
 * ZDR, so the field is `true` for it, and only an explicit opt-out reads
 * `false`. The real `isZdrOnlyForOrg` runs here; only storage is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn() }))

vi.mock('@/lib/db/tenant-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant-context')>()),
  withTenant: vi.fn(async (_context: unknown, fn: () => Promise<unknown>) => fn()),
}))

vi.mock('@/lib/model-config/service', () => ({
  getEffectiveModelOverrides: vi.fn().mockResolvedValue({ deep_research: 'openai/gpt-6-luna' }),
}))

const stored: { settings: Record<string, unknown> } = { settings: {} }
vi.mock('@/lib/organizations/repository', () => ({
  findOrganization: vi.fn(async () => ({
    workosOrganizationId: 'org_abc',
    displayName: null,
    defaultLocale: 'de',
    settings: stored.settings,
  })),
  upsertOrganization: vi.fn(),
}))
vi.mock('@/lib/cache', () => ({
  getCached: vi.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader()),
  invalidateCached: vi.fn(),
}))
vi.mock('@/lib/workos/client', () => ({ getWorkOS: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({ isOrgFeatureEnabled: vi.fn(), WEB_SEARCH_FLAG: 'web-search' }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))

import { GET } from './route'

const request = (token: string | null = 'test-token'): Request =>
  new Request('http://localhost/api/internal/model-overrides?organizationId=org_abc', {
    method: 'GET',
    headers: token ? { 'x-grid-internal-token': token } : {},
  })

describe('GET /api/internal/model-overrides', () => {
  beforeEach(() => {
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    process.env.APP_ENV = 'development'
    stored.settings = {}
  })

  it('rejects a missing or wrong token', async () => {
    expect((await GET(request(null))).status).toBe(403)
    expect((await GET(request('wrong'))).status).toBe(403)
  })

  it('reports zdrOnly: true for an org that never set it', async () => {
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ overrides: { deep_research: 'openai/gpt-6-luna' }, zdrOnly: true })
  })

  it('reports zdrOnly: false only for an explicit opt-out', async () => {
    stored.settings = { zdrOnly: false }
    expect((await (await GET(request())).json()).zdrOnly).toBe(false)
  })

  it('reports a malformed stored value as ZDR, never as off', async () => {
    stored.settings = { zdrOnly: 'false' }
    expect((await (await GET(request())).json()).zdrOnly).toBe(true)
  })
})
