/**
 * @vitest-environment node
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

vi.mock('@/lib/model-config/backend-defaults', () => ({
  getGroupDefaults: vi.fn().mockResolvedValue({ deep_research: 'deepseek/deepseek-v4-flash' }),
}))

vi.mock('@/lib/model-config/service', () => ({
  getOrgModelConfig: vi
    .fn()
    .mockResolvedValue({ activeVersion: null, updatedBy: null, updatedAt: null }),
  createAndActivateVersion: vi.fn().mockImplementation(async (params: Record<string, unknown>) => ({
    id: 'version-1',
    version: 1,
    ...params,
  })),
}))

vi.mock('@/lib/model-config/openrouter', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/model-config/openrouter')>()
  return {
    ...original,
    fetchModelCatalog: vi.fn().mockResolvedValue([
      {
        id: 'vendor/capable',
        name: 'Capable',
        contextLength: 200000,
        promptPrice: 0.000001,
        completionPrice: 0.000002,
        inputModalities: ['text'],
        supportedParameters: ['tools', 'structured_outputs'],
      },
    ]),
  }
})

vi.mock('@/lib/model-config/org-catalog', () => ({
  getCatalogForOrg: vi.fn().mockResolvedValue({
    models: [
      {
        id: 'vendor/capable',
        name: 'Capable',
        contextLength: 200000,
        promptPrice: 0.000001,
        completionPrice: 0.000002,
        inputModalities: ['text'],
        supportedParameters: ['tools', 'structured_outputs'],
      },
    ],
    source: 'openrouter',
    provider: null,
    validation: 'full',
    zdrOnly: false,
    zdrApplicable: true,
    zdr: null,
  }),
  isZdrApplicableForOrg: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/lib/model-config/zdr-coverage', () => ({
  UNKNOWN_COVERAGE: { status: 'unknown', blockedGroups: [], unresolvedGroups: [] },
  getZdrCoverage: vi.fn().mockResolvedValue({ status: 'checked', blockedGroups: [], unresolvedGroups: [] }),
}))

vi.mock('@/lib/organizations/service', () => ({
  isZdrOnlyForOrg: vi.fn().mockResolvedValue(false),
}))

import { GET, PUT } from './route'
import { createAndActivateVersion, getOrgModelConfig } from '@/lib/model-config/service'
import { getCatalogForOrg } from '@/lib/model-config/org-catalog'
import { ZdrListUnavailableError, type ZdrIndex } from '@/lib/model-config/openrouter'
import { getZdrCoverage } from '@/lib/model-config/zdr-coverage'
import { isZdrOnlyForOrg } from '@/lib/organizations/service'

const CAPABLE = {
  id: 'vendor/capable',
  name: 'Capable',
  contextLength: 200000,
  promptPrice: 0.000001,
  completionPrice: 0.000002,
  inputModalities: ['text'],
  supportedParameters: ['tools', 'structured_outputs'],
}

const zdrIndex = (...ids: string[]): ZdrIndex =>
  new Map(ids.map((modelId) => [modelId, [{ modelId, supportedParameters: ['tools'], contextLength: 200000 }]]))

/** The catalog an org with ZDR in force gets: the whole list, plus the ZDR index. */
const zdrCatalog = (...zdrIds: string[]): Awaited<ReturnType<typeof getCatalogForOrg>> => ({
  models: [CAPABLE],
  source: 'openrouter',
  provider: null,
  validation: 'full',
  zdrOnly: true,
  zdrApplicable: true,
  zdr: zdrIndex(...zdrIds),
})

const get = (): Request => new Request('http://localhost/api/organization/model-config')

const put = (body: unknown): Request =>
  new Request('http://localhost/api/organization/model-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('/api/organization/model-config', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    session.role = 'admin'
  })

  it('GET rejects non-admins', async () => {
    session.role = 'member'
    expect((await GET(get())).status).toBe(403)
  })

  it('GET returns the agent-group registry with workflow defaults for admins', async () => {
    const res = await GET(get())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.agentGroups.map((g: { id: string }) => g.id)).toContain('deep_research')
    expect(body.defaults.deep_research).toBe('deepseek/deepseek-v4-flash')
  })

  it('GET leaves a retired group out of the active version, so a save can round-trip it', async () => {
    vi.mocked(getOrgModelConfig).mockResolvedValueOnce({
      activeVersion: {
        id: 'version-1',
        overrides: { deep_research: { model: 'vendor/capable' }, intent: { model: 'vendor/capable' } },
      },
      updatedBy: null,
      updatedAt: null,
    } as unknown as Awaited<ReturnType<typeof getOrgModelConfig>>)
    const body = await (await GET(get())).json()
    expect(Object.keys(body.activeVersion.overrides)).toEqual(['deep_research'])
  })

  it('PUT rejects non-admins before validation', async () => {
    session.role = 'member'
    expect((await PUT(put({ overrides: {} }))).status).toBe(403)
    expect(createAndActivateVersion).not.toHaveBeenCalled()
  })

  it('PUT saves a catalog-validated override as a new version', async () => {
    const res = await PUT(
      put({ overrides: { deep_research: { model: 'vendor/capable' } }, comment: 'test' })
    )
    expect(res.status).toBe(201)
    expect(createAndActivateVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        overrides: { deep_research: { model: 'vendor/capable' } },
        actorUserId: 'user-1',
      })
    )
  })

  it('PUT rejects a model that is not in the catalog (422)', async () => {
    const res = await PUT(put({ overrides: { deep_research: { model: 'vendor/unknown' } } }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.details.deep_research).toEqual([
      expect.objectContaining({ code: 'not_in_catalog', params: { model: 'vendor/unknown' } }),
    ])
    expect(createAndActivateVersion).not.toHaveBeenCalled()
  })

  it('PUT rejects malformed model ids and unknown groups (400)', async () => {
    expect(
      (await PUT(put({ overrides: { deep_research: { model: 'model with spaces' } } }))).status
    ).toBe(400)
    expect((await PUT(put({ overrides: { bogus: { model: 'vendor/capable' } } }))).status).toBe(400)
  })

  it('PUT accepts a provider-native id shape but still requires catalog membership (422)', async () => {
    // 'gpt-4o' passes the BYOK-aware shape check; this org's catalog does not
    // list it, so the save is rejected by membership, not by the regex.
    const res = await PUT(put({ overrides: { deep_research: { model: 'gpt-4o' } } }))
    expect(res.status).toBe(422)
  })

  it('PUT validates against the org BYOK catalog in relaxed mode', async () => {
    const { getCatalogForOrg } = await import('@/lib/model-config/org-catalog')
    vi.mocked(getCatalogForOrg).mockResolvedValueOnce({
      models: [
        {
          id: 'gpt-4o',
          name: 'gpt-4o',
          contextLength: 0,
          promptPrice: 0,
          completionPrice: 0,
          inputModalities: [],
          supportedParameters: [],
        },
      ],
      source: 'byok',
      provider: 'openai',
      validation: 'listed',
      zdrOnly: false,
      zdrApplicable: false,
      zdr: null,
    })
    const res = await PUT(put({ overrides: { deep_research: { model: 'gpt-4o' } } }))
    expect(res.status).toBe(201)
    expect(createAndActivateVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        overrides: { deep_research: { model: 'gpt-4o' } },
        modelSnapshot: expect.objectContaining({
          _catalog: { source: 'byok', provider: 'openai', validation: 'listed', zdrOnly: false },
        }),
      })
    )
  })

  it('GET reports the org ZDR policy and, while it is in force, which groups it blocks', async () => {
    vi.mocked(isZdrOnlyForOrg).mockResolvedValueOnce(true)
    const coverage = {
      status: 'checked' as const,
      blockedGroups: [
        { group: 'deep_research', modelId: 'vendor/no-zdr', source: 'platform' as const, reason: 'not_zdr' as const },
      ],
      unresolvedGroups: [],
    }
    vi.mocked(getZdrCoverage).mockResolvedValueOnce(coverage)
    const body = await (await GET(get())).json()
    expect(body.zdrOnly).toBe(true)
    expect(body.zdrApplicable).toBe(true)
    expect(body.zdrCoverage).toEqual(coverage)
  })

  it('GET computes no coverage while ZDR is off', async () => {
    const body = await (await GET(get())).json()
    expect(body.zdrOnly).toBe(false)
    expect(body.zdrCoverage).toBeNull()
    expect(getZdrCoverage).not.toHaveBeenCalled()
  })

  it('GET marks ZDR not applicable for a BYOK key on another provider, keeping the stored value', async () => {
    const { isZdrApplicableForOrg } = await import('@/lib/model-config/org-catalog')
    vi.mocked(isZdrOnlyForOrg).mockResolvedValueOnce(true)
    vi.mocked(isZdrApplicableForOrg).mockResolvedValueOnce(false)
    const body = await (await GET(get())).json()
    expect(body).toMatchObject({ zdrOnly: true, zdrApplicable: false, zdrCoverage: null })
  })

  it('GET stays 200 when credential resolution, the catalog and the coverage all fail — each reads as unknown', async () => {
    const { isZdrApplicableForOrg } = await import('@/lib/model-config/org-catalog')
    vi.mocked(isZdrOnlyForOrg).mockResolvedValueOnce(true)
    vi.mocked(isZdrApplicableForOrg).mockRejectedValueOnce(new Error('db down'))
    vi.mocked(getCatalogForOrg).mockRejectedValueOnce(new Error('openrouter down'))
    vi.mocked(getZdrCoverage).mockRejectedValueOnce(new Error('db down'))
    const res = await GET(get())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      catalogSource: null,
      zdrOnly: true,
      zdrApplicable: null,
      zdrCoverage: { status: 'unknown', blockedGroups: [], unresolvedGroups: [] },
    })
  })

  it('PUT under ZDR rejects a catalog model without a ZDR endpoint as not_zdr (422)', async () => {
    vi.mocked(isZdrOnlyForOrg).mockResolvedValueOnce(true)
    vi.mocked(getCatalogForOrg).mockResolvedValueOnce(zdrCatalog('vendor/other'))
    const res = await PUT(put({ overrides: { deep_research: { model: 'vendor/capable' } } }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.details.deep_research.map((r: { code: string }) => r.code)).toEqual(['not_zdr'])
    expect(createAndActivateVersion).not.toHaveBeenCalled()
  })

  it('PUT under ZDR accepts a model with a ZDR endpoint that serves the group', async () => {
    vi.mocked(isZdrOnlyForOrg).mockResolvedValueOnce(true)
    vi.mocked(getCatalogForOrg).mockResolvedValueOnce(zdrCatalog('vendor/capable'))
    const res = await PUT(put({ overrides: { deep_research: { model: 'vendor/capable' } } }))
    expect(res.status).toBe(201)
  })

  it('PUT answers a ZDR-list outage with a 503 that names it', async () => {
    vi.mocked(isZdrOnlyForOrg).mockResolvedValueOnce(true)
    vi.mocked(getCatalogForOrg).mockRejectedValueOnce(new ZdrListUnavailableError('HTTP 503'))
    const res = await PUT(put({ overrides: { deep_research: { model: 'vendor/capable' } } }))
    expect(res.status).toBe(503)
    expect((await res.json()).details).toEqual({ reason: 'zdr_list_unavailable' })
    expect(createAndActivateVersion).not.toHaveBeenCalled()
  })

  it('PUT asks for the ZDR catalog when the policy is on', async () => {
    vi.mocked(isZdrOnlyForOrg).mockResolvedValueOnce(true)
    await PUT(put({ overrides: { deep_research: { model: 'vendor/capable' } } }))
    expect(getCatalogForOrg).toHaveBeenCalledWith('org-1', { zdrOnly: true })
  })
})
