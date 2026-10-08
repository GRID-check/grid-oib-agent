/**
 * @vitest-environment node
 */
/**
 * The platform default-model endpoint. The contract worth pinning down: only
 * the platform owner may write it, the catalog validates every choice
 * server-side, and an omitted group is a *clear*, not a no-op — that is how a
 * group goes back to the workflow config. Every organization is ZDR unless it
 * opted out, so a default must have a ZDR endpoint serving its group, and an
 * unreadable ZDR list refuses the save.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = {
  userId: 'owner-1',
  organizationId: 'org_platform',
  email: 'owner@grid.com',
  role: 'org-platform-owner',
  permissions: [] as string[],
}

vi.mock('@/lib/auth/session', () => ({ getGridSession: async () => session }))
vi.mock('@/lib/auth/require-auth', () => ({ authzErrorResponse: vi.fn().mockReturnValue(null) }))

const requirePlatformPermission = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/authz/platform', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/authz/platform')>()
  return {
    ...original,
    requirePlatformPermission: (s: unknown) => requirePlatformPermission(s),
    getPlatformOrganizationId: vi.fn().mockResolvedValue('org_platform'),
  }
})

const recordAuditEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: (e: unknown) => recordAuditEvent(e) }))

vi.mock('@/lib/model-config/backend-defaults', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/model-config/backend-defaults')>()),
  getWorkflowGroupDefaults: vi
    .fn()
    .mockResolvedValue({ deep_research: 'deepseek/deepseek-v4-flash' }),
}))

const catalog = [
  {
    id: 'vendor/capable',
    name: 'Capable',
    contextLength: 200000,
    promptPrice: 0.000001,
    completionPrice: 0.000002,
    inputModalities: ['text'],
    supportedParameters: ['tools', 'structured_outputs'],
  },
  {
    id: 'vendor/tiny',
    name: 'Tiny',
    contextLength: 8000,
    promptPrice: 0,
    completionPrice: 0,
    inputModalities: ['text'],
    supportedParameters: [],
  },
]

const fetchModelCatalog = vi.fn().mockResolvedValue(catalog)
type ZdrIndex = import('@/lib/model-config/openrouter').ZdrIndex
const zdrIndex = (...ids: string[]): ZdrIndex =>
  new Map(ids.map((modelId) => [modelId, [{ modelId, supportedParameters: ['tools'], contextLength: 200000 }]]))
const fetchZdrEndpoints = vi.fn<() => Promise<ZdrIndex>>().mockResolvedValue(zdrIndex('vendor/capable'))
vi.mock('@/lib/model-config/openrouter', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/model-config/openrouter')>()
  return {
    ...original,
    fetchModelCatalog: () => fetchModelCatalog(),
    fetchZdrEndpoints: () => fetchZdrEndpoints(),
  }
})

const listPlatformModelDefaults = vi.fn().mockResolvedValue([])
const savePlatformModelDefaults = vi.fn()
vi.mock('@/lib/model-config/platform-defaults', () => ({
  listPlatformModelDefaults: () => listPlatformModelDefaults(),
  savePlatformModelDefaults: (input: unknown) => savePlatformModelDefaults(input),
}))

import { PlatformAccessDeniedError } from '@/lib/authz/platform'
import { ZdrListUnavailableError } from '@/lib/model-config/openrouter'
import { GET, PUT } from './route'

// The route goes through `platformApiRoute`, which reads `request.method` for
// its scope label, so GET takes a real Request like every other route factory.
const get = (): Promise<Response> =>
  GET(new Request('http://localhost/api/platform/model-defaults'))

const put = (body: unknown): Promise<Response> =>
  PUT(
    new Request('http://localhost/api/platform/model-defaults', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  )

describe('/api/platform/model-defaults', () => {
  beforeEach(() => {
    requirePlatformPermission.mockReset().mockResolvedValue(undefined)
    savePlatformModelDefaults
      .mockReset()
      .mockImplementation(async (input: { defaults: Record<string, string> }) =>
        Object.entries(input.defaults).map(([agentGroup, model]) => ({
          agentGroup,
          model,
          note: null,
          updatedBy: session.userId,
          updatedByEmail: session.email,
          updatedAt: new Date('2026-07-29T00:00:00Z'),
          modelSnapshot: null,
        }))
      )
    listPlatformModelDefaults.mockReset().mockResolvedValue([])
    fetchModelCatalog.mockReset().mockResolvedValue(catalog)
    fetchZdrEndpoints.mockReset().mockResolvedValue(zdrIndex('vendor/capable'))
    recordAuditEvent.mockReset().mockResolvedValue(undefined)
  })

  it('rejects a caller who is not the platform owner', async () => {
    requirePlatformPermission.mockRejectedValue(new PlatformAccessDeniedError())
    expect((await get()).status).toBe(403)
    expect((await put({ defaults: {} })).status).toBe(403)
    expect(savePlatformModelDefaults).not.toHaveBeenCalled()
  })

  it('reports the group registry and the workflow model each group falls back to', async () => {
    const body = (await (await get()).json()) as {
      agentGroups: { id: string }[]
      workflowDefaults: Record<string, string>
    }
    expect(body.agentGroups.map((g) => g.id)).toContain('deep_research')
    expect(body.workflowDefaults.deep_research).toBe('deepseek/deepseek-v4-flash')
  })

  it('leaves a retired group out of GET, so a save can round-trip what it loaded', async () => {
    const row = (agentGroup: string) => ({
      agentGroup,
      model: 'vendor/capable',
      note: null,
      updatedBy: session.userId,
      updatedByEmail: session.email,
      updatedAt: new Date('2026-07-29T00:00:00Z'),
      modelSnapshot: null,
    })
    listPlatformModelDefaults.mockResolvedValue([row('deep_research'), row('intent')])

    const body = (await (await get()).json()) as { defaults: Record<string, { model: string }> }
    expect(Object.keys(body.defaults)).toEqual(['deep_research'])

    const defaults = Object.fromEntries(Object.entries(body.defaults).map(([g, v]) => [g, { model: v.model }]))
    expect((await put({ defaults })).status).toBe(200)
  })

  it('saves a validated default and audits the fleet-wide change', async () => {
    const response = await put({
      defaults: { deep_research: { model: 'vendor/capable' } },
      note: 'model bump',
    })
    expect(response.status).toBe(200)
    expect(savePlatformModelDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ defaults: { deep_research: 'vendor/capable' }, note: 'model bump' })
    )
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'platform.model_defaults.updated' })
    )
  })

  it('rejects a model that fails the group capability requirements', async () => {
    // `deep_research` needs tools and 128k of context; vendor/tiny has neither.
    const response = await put({ defaults: { deep_research: { model: 'vendor/tiny' } } })
    expect(response.status).toBe(422)
    expect(savePlatformModelDefaults).not.toHaveBeenCalled()
  })

  it('refuses to pin the fleet to an unvalidated id when the catalog is down', async () => {
    fetchModelCatalog.mockRejectedValue(new Error('openrouter unreachable'))
    const response = await put({ defaults: { deep_research: { model: 'vendor/capable' } } })
    expect(response.status).toBe(503)
    expect(savePlatformModelDefaults).not.toHaveBeenCalled()
  })

  it('treats an empty body as "clear every default" — back to the workflow config', async () => {
    const response = await put({ defaults: {} })
    expect(response.status).toBe(200)
    expect(savePlatformModelDefaults).toHaveBeenCalledWith(
      expect.objectContaining({ defaults: {} })
    )
  })

  it('refuses a default without a zero-data-retention endpoint (422, not_zdr)', async () => {
    catalog.push({
      id: 'vendor/no-zdr',
      name: 'No ZDR',
      contextLength: 200000,
      promptPrice: 0,
      completionPrice: 0,
      inputModalities: ['text'],
      supportedParameters: ['tools'],
    })
    try {
      const response = await put({ defaults: { deep_research: { model: 'vendor/no-zdr' } } })
      expect(response.status).toBe(422)
      const body = (await response.json()) as { details: Record<string, { code: string }[]> }
      expect(body.details.deep_research.map((r) => r.code)).toEqual(['not_zdr'])
      expect(savePlatformModelDefaults).not.toHaveBeenCalled()
    } finally {
      catalog.pop()
    }
  })

  it('refuses the save when the ZDR list cannot be read (503, fail closed)', async () => {
    fetchZdrEndpoints.mockRejectedValue(new ZdrListUnavailableError('zdr listing down'))
    const response = await put({ defaults: { deep_research: { model: 'vendor/capable' } } })
    expect(response.status).toBe(503)
    const body = (await response.json()) as { details?: { reason?: string } }
    expect(body.details?.reason).toBe('zdr_list_unavailable')
    expect(savePlatformModelDefaults).not.toHaveBeenCalled()
  })

  it('stores the catalog snapshot as validated, with no constant ZDR flag nobody reads', async () => {
    await put({ defaults: { deep_research: { model: 'vendor/capable' } } })
    const input = savePlatformModelDefaults.mock.calls[0][0] as { modelSnapshot: Record<string, object> }
    expect(input.modelSnapshot.deep_research).toMatchObject({ id: 'vendor/capable' })
    expect(input.modelSnapshot.deep_research).not.toHaveProperty('_zdr')
  })

  it('the picker lists only models with a ZDR endpoint serving the group', async () => {
    const { GET: search } = await import('./models/route')
    catalog.push({
      id: 'vendor/no-zdr',
      name: 'No ZDR',
      contextLength: 200000,
      promptPrice: 0,
      completionPrice: 0,
      inputModalities: ['text'],
      supportedParameters: ['tools'],
    })
    try {
      const res = await search(new Request('http://localhost/api/platform/model-defaults/models?group=deep_research&q='))
      const body = (await res.json()) as { models: { id: string }[] }
      expect(body.models.map((m) => m.id)).toEqual(['vendor/capable'])
    } finally {
      catalog.pop()
    }
  })

  it('the picker answers 503 zdr_list_unavailable rather than the unfiltered catalog', async () => {
    const { GET: search } = await import('./models/route')
    fetchZdrEndpoints.mockRejectedValue(new ZdrListUnavailableError('down'))
    const res = await search(new Request('http://localhost/api/platform/model-defaults/models?group=deep_research&q='))
    expect(res.status).toBe(503)
    expect(((await res.json()) as { details?: { reason?: string } }).details?.reason).toBe('zdr_list_unavailable')
  })

  it('GET checks a saved default against the LIVE ZDR list, not its save-time snapshot', async () => {
    listPlatformModelDefaults.mockResolvedValue([
      {
        agentGroup: 'deep_research',
        model: 'vendor/capable',
        note: null,
        updatedBy: session.userId,
        updatedByEmail: session.email,
        updatedAt: new Date('2026-07-29T00:00:00Z'),
        modelSnapshot: null,
      },
    ])
    // The model lost its last ZDR endpoint after it was pinned.
    fetchZdrEndpoints.mockResolvedValue(zdrIndex('vendor/other'))
    const body = (await (await get()).json()) as {
      defaults: Record<string, { zdrSafe: boolean | null }>
      workflowDefaultsZdrSafe: Record<string, boolean | null>
    }
    expect(body.defaults.deep_research.zdrSafe).toBe(false)
    // The workflow model (deepseek/deepseek-v4-flash) is not on the list either.
    expect(body.workflowDefaultsZdrSafe.deep_research).toBe(false)
  })

  it('GET reports ZDR status as unknown (null), never safe, when the list cannot be read', async () => {
    listPlatformModelDefaults.mockResolvedValue([
      {
        agentGroup: 'deep_research',
        model: 'vendor/capable',
        note: null,
        updatedBy: session.userId,
        updatedByEmail: session.email,
        updatedAt: new Date('2026-07-29T00:00:00Z'),
        modelSnapshot: null,
      },
    ])
    fetchZdrEndpoints.mockRejectedValue(new ZdrListUnavailableError('down'))
    const body = (await (await get()).json()) as { defaults: Record<string, { zdrSafe: boolean | null }> }
    expect(body.defaults.deep_research.zdrSafe).toBeNull()
  })

  it('rejects an unknown agent group', async () => {
    const response = await put({ defaults: { not_a_group: { model: 'vendor/capable' } } })
    expect(response.status).toBe(400)
    expect(savePlatformModelDefaults).not.toHaveBeenCalled()
  })
})
