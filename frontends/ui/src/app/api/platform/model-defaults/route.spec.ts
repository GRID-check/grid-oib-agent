/**
 * The platform default-model endpoint. The contract worth pinning down: only
 * the platform owner may write it, the catalog validates every choice
 * server-side, and an omitted group is a *clear*, not a no-op — that is how a
 * group goes back to the workflow config.
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

const requirePlatformOwner = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/authz/platform', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/authz/platform')>()
  return {
    ...original,
    requirePlatformOwner: (s: unknown) => requirePlatformOwner(s),
    getPlatformOrganizationId: vi.fn().mockResolvedValue('org_platform'),
  }
})

const recordAuditEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: (e: unknown) => recordAuditEvent(e) }))

vi.mock('@/lib/model-config/backend-defaults', () => ({
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
const fetchZdrModelIds = vi.fn().mockResolvedValue(new Set(['vendor/capable']))
vi.mock('@/lib/model-config/openrouter', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/model-config/openrouter')>()
  return {
    ...original,
    fetchModelCatalog: () => fetchModelCatalog(),
    fetchZdrModelIds: () => fetchZdrModelIds(),
  }
})

const listPlatformModelDefaults = vi.fn().mockResolvedValue([])
const savePlatformModelDefaults = vi.fn()
vi.mock('@/lib/model-config/platform-defaults', () => ({
  listPlatformModelDefaults: () => listPlatformModelDefaults(),
  savePlatformModelDefaults: (input: unknown) => savePlatformModelDefaults(input),
}))

import { PlatformAccessDeniedError } from '@/lib/authz/platform'
import { GET, PUT } from './route'

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
    requirePlatformOwner.mockReset().mockResolvedValue(undefined)
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
          modelSnapshot: { _zdr: { safe: true } },
        }))
      )
    listPlatformModelDefaults.mockReset().mockResolvedValue([])
    fetchModelCatalog.mockReset().mockResolvedValue(catalog)
    fetchZdrModelIds.mockReset().mockResolvedValue(new Set(['vendor/capable']))
    recordAuditEvent.mockReset().mockResolvedValue(undefined)
  })

  it('rejects a caller who is not the platform owner', async () => {
    requirePlatformOwner.mockRejectedValue(new PlatformAccessDeniedError())
    expect((await GET()).status).toBe(403)
    expect((await put({ defaults: {} })).status).toBe(403)
    expect(savePlatformModelDefaults).not.toHaveBeenCalled()
  })

  it('reports the group registry and the workflow model each group falls back to', async () => {
    const body = (await (await GET()).json()) as {
      agentGroups: { id: string }[]
      workflowDefaults: Record<string, string>
    }
    expect(body.agentGroups.map((g) => g.id)).toContain('deep_research')
    expect(body.workflowDefaults.deep_research).toBe('deepseek/deepseek-v4-flash')
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

  it('records whether a chosen default can serve zero-data-retention tenants', async () => {
    await put({ defaults: { deep_research: { model: 'vendor/capable' } } })
    const input = savePlatformModelDefaults.mock.calls[0][0] as {
      modelSnapshot: Record<string, { _zdr: { safe: boolean | null } }>
    }
    expect(input.modelSnapshot.deep_research._zdr.safe).toBe(true)
  })

  it('still saves when the ZDR listing is unreachable, recording the unknown', async () => {
    fetchZdrModelIds.mockRejectedValue(new Error('zdr listing down'))
    const response = await put({ defaults: { deep_research: { model: 'vendor/capable' } } })
    expect(response.status).toBe(200)
    const input = savePlatformModelDefaults.mock.calls[0][0] as {
      modelSnapshot: Record<string, { _zdr: { safe: boolean | null } }>
    }
    expect(input.modelSnapshot.deep_research._zdr.safe).toBeNull()
  })

  it('rejects an unknown agent group', async () => {
    const response = await put({ defaults: { not_a_group: { model: 'vendor/capable' } } })
    expect(response.status).toBe(400)
    expect(savePlatformModelDefaults).not.toHaveBeenCalled()
  })
})
