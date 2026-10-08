/**
 * @vitest-environment node
 */
/**
 * What the chat socket masks a message with (ADR-0086). The content half of
 * the office's policy, never the name terms, and never "off" because the
 * settings could not be read: the real policy resolution runs here, only
 * storage is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn() }))

vi.mock('@/lib/db/tenant-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db/tenant-context')>()),
  withTenant: vi.fn(async (_context: unknown, fn: () => Promise<unknown>) => fn()),
}))

const stored: { settings: Record<string, unknown> | Error } = { settings: {} }
vi.mock('@/lib/organizations/repository', () => ({
  findOrganization: vi.fn(async () => {
    if (stored.settings instanceof Error) throw stored.settings
    return {
      workosOrganizationId: 'org_abc',
      displayName: null,
      defaultLocale: 'de',
      settings: stored.settings,
    }
  }),
  upsertOrganization: vi.fn(),
}))
vi.mock('@/lib/cache', () => ({
  getCached: vi.fn(async (_key: string, _ttl: number, loader: () => Promise<unknown>) => loader()),
  invalidateCached: vi.fn(),
}))
vi.mock('@/lib/workos/client', () => ({ getWorkOS: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({
  isOrgFeatureEnabled: vi.fn(),
  WEB_SEARCH_FLAG: 'web-search',
}))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))

import { withTenant } from '@/lib/db/tenant-context'
import { SUGGESTED_SCREENING_POLICY } from '@/lib/upload-screening/policy'
import { GET } from './route'

const request = (token: string | null = 'test-token', organizationId = 'org_abc'): Request =>
  new Request(`http://localhost/api/internal/chat-screening?organizationId=${organizationId}`, {
    method: 'GET',
    headers: token ? { 'x-grid-internal-token': token } : {},
  })

const OWN_POLICY = {
  enabled: true,
  nameTerms: ['Rechnung'],
  nameExceptions: [],
  contentTerms: ['Gehaltsabrechnung'],
  detectors: ['iban'],
}

describe('GET /api/internal/chat-screening', () => {
  beforeEach(() => {
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    process.env.APP_ENV = 'development'
    stored.settings = {}
  })

  it('rejects a missing or wrong token', async () => {
    expect((await GET(request(null))).status).toBe(403)
    expect((await GET(request('wrong'))).status).toBe(403)
  })

  it("answers the office's content terms and detectors, never its name terms, in the organization's scope", async () => {
    stored.settings = { uploadScreening: OWN_POLICY }
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      enabled: true,
      content_terms: ['Gehaltsabrechnung'],
      detectors: ['iban'],
    })
    expect(withTenant).toHaveBeenCalledWith({ organizationId: 'org_abc' }, expect.any(Function))
  })

  it('says off when the office switched screening off', async () => {
    stored.settings = { uploadScreening: { ...OWN_POLICY, enabled: false } }
    expect((await (await GET(request())).json()).enabled).toBe(false)
  })

  it.each([
    ['never saved', {}],
    ['malformed', { uploadScreening: { enabled: 'no' } }],
    ['unreadable', new Error('db down')],
  ])('answers the suggested list when the policy is %s, never "off"', async (_case, settings) => {
    stored.settings = settings
    expect(await (await GET(request())).json()).toEqual({
      enabled: true,
      content_terms: SUGGESTED_SCREENING_POLICY.contentTerms,
      detectors: SUGGESTED_SCREENING_POLICY.detectors,
    })
  })
})
