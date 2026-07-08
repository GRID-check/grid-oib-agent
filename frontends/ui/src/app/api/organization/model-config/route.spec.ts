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
  getOrgModelConfig: vi.fn().mockResolvedValue({ activeVersion: null, updatedBy: null, updatedAt: null }),
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

import { GET, PUT } from './route'
import { createAndActivateVersion } from '@/lib/model-config/service'

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

  it('PUT rejects non-admins before validation', async () => {
    session.role = 'member'
    expect((await PUT(put({ overrides: {} }))).status).toBe(403)
    expect(createAndActivateVersion).not.toHaveBeenCalled()
  })

  it('PUT saves a catalog-validated override as a new version', async () => {
    const res = await PUT(put({ overrides: { deep_research: { model: 'vendor/capable' } }, comment: 'test' }))
    expect(res.status).toBe(201)
    expect(createAndActivateVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        overrides: { deep_research: { model: 'vendor/capable' } },
        actorUserId: 'user-1',
      }),
    )
  })

  it('PUT rejects a model that is not in the catalog (422)', async () => {
    const res = await PUT(put({ overrides: { deep_research: { model: 'vendor/unknown' } } }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.details.deep_research).toContain('not found')
    expect(createAndActivateVersion).not.toHaveBeenCalled()
  })

  it('PUT rejects malformed model ids and unknown groups (400)', async () => {
    expect((await PUT(put({ overrides: { deep_research: { model: 'no-slash' } } }))).status).toBe(400)
    expect((await PUT(put({ overrides: { bogus: { model: 'vendor/capable' } } }))).status).toBe(400)
  })
})
