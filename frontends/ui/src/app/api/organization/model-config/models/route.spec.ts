/**
 * @vitest-environment node
 */
/**
 * The org picker lists only models with a zero-data-retention endpoint by
 * default, never falls back to the whole catalog when the ZDR list is down, and
 * shows an org that opted out every model with the non-ZDR ones marked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = {
  userId: 'user-1',
  organizationId: 'org-1',
  email: 'admin@grid.com',
  role: 'admin',
  permissions: [] as string[],
}

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockImplementation(async () => session),
  authzErrorResponse: vi.fn().mockReturnValue(null),
}))
vi.mock('@/lib/organizations/service', () => ({ isZdrOnlyForOrg: vi.fn() }))
vi.mock('@/lib/model-config/org-catalog', () => ({ getCatalogForOrg: vi.fn() }))
vi.mock('@/lib/pricing/service', () => ({
  getEffectivePricing: vi.fn().mockResolvedValue({}),
  estimateCreditsPerRequest: vi.fn().mockReturnValue(1),
}))
vi.mock('@/lib/budgets/service', () => ({ getOrgBudgetUnit: vi.fn().mockResolvedValue('credit') }))
vi.mock('@/lib/model-config/openrouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/model-config/openrouter')>()),
  fetchZdrEndpoints: vi.fn(),
}))

import { GET } from './route'
import { fetchZdrEndpoints, ZdrListUnavailableError, type ZdrIndex } from '@/lib/model-config/openrouter'
import { getCatalogForOrg } from '@/lib/model-config/org-catalog'
import { isZdrOnlyForOrg } from '@/lib/organizations/service'

const model = (id: string) => ({
  id,
  name: id,
  contextLength: 200000,
  promptPrice: 0,
  completionPrice: 0,
  inputModalities: ['text'],
  supportedParameters: ['tools'],
})

const zdrIndex = (...ids: string[]): ZdrIndex =>
  new Map(ids.map((modelId) => [modelId, [{ modelId, supportedParameters: ['tools'], contextLength: 200000 }]]))

const catalog = (zdr: ZdrIndex | null): Awaited<ReturnType<typeof getCatalogForOrg>> => ({
  models: [model('vendor/zdr'), model('vendor/no-zdr'), model('vendor/zdr:free')],
  source: 'openrouter',
  provider: null,
  validation: 'full',
  zdrOnly: zdr !== null,
  zdrApplicable: true,
  zdr,
})

const search = (): Promise<Response> =>
  GET(new Request('http://localhost/api/organization/model-config/models?group=deep_research&q='))

describe('GET /api/organization/model-config/models', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('lists only models with a serving ZDR endpoint while ZDR is on (exact ids)', async () => {
    vi.mocked(isZdrOnlyForOrg).mockResolvedValue(true)
    vi.mocked(getCatalogForOrg).mockResolvedValue(catalog(zdrIndex('vendor/zdr')))
    const body = (await (await search()).json()) as { models: { id: string; zdrSafe: boolean | null }[] }
    expect(body.models).toEqual([expect.objectContaining({ id: 'vendor/zdr', zdrSafe: true })])
  })

  it('refuses (503, zdr_list_unavailable) rather than listing the whole catalog when the ZDR list is down', async () => {
    vi.mocked(isZdrOnlyForOrg).mockResolvedValue(true)
    vi.mocked(getCatalogForOrg).mockRejectedValue(new ZdrListUnavailableError('HTTP 503'))
    const res = await search()
    expect(res.status).toBe(503)
    expect(((await res.json()) as { details?: { reason?: string } }).details?.reason).toBe('zdr_list_unavailable')
  })

  it('shows an opted-out org every model, marking the ones without a ZDR endpoint', async () => {
    vi.mocked(isZdrOnlyForOrg).mockResolvedValue(false)
    vi.mocked(getCatalogForOrg).mockResolvedValue(catalog(null))
    vi.mocked(fetchZdrEndpoints).mockResolvedValue(zdrIndex('vendor/zdr'))
    const body = (await (await search()).json()) as { models: { id: string; zdrSafe: boolean | null }[] }
    expect(Object.fromEntries(body.models.map((m) => [m.id, m.zdrSafe]))).toEqual({
      'vendor/no-zdr': false,
      'vendor/zdr': true,
      'vendor/zdr:free': false,
    })
  })

  it('leaves the marks unknown for an opted-out org when the ZDR list is down', async () => {
    vi.mocked(isZdrOnlyForOrg).mockResolvedValue(false)
    vi.mocked(getCatalogForOrg).mockResolvedValue(catalog(null))
    vi.mocked(fetchZdrEndpoints).mockRejectedValue(new ZdrListUnavailableError('down'))
    const body = (await (await search()).json()) as { models: { zdrSafe: boolean | null }[] }
    expect(body.models.every((m) => m.zdrSafe === null)).toBe(true)
  })
})
