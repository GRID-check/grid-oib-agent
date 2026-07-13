import { beforeEach, describe, expect, it, vi } from 'vitest'

const session = {
  userId: 'user-1',
  organizationId: 'org-1',
  email: 'admin@grid.com',
  role: 'admin',
  permissions: [] as string[],
  featureFlags: null as string[] | null,
}

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockImplementation(async () => session),
  authzErrorResponse: vi.fn().mockReturnValue(null),
}))

vi.mock('@/lib/llm-credentials/service', () => ({
  setLlmProviderMode: vi.fn().mockImplementation(async (_session: unknown, mode: string) => mode),
}))

import { PUT } from './route'
import { setLlmProviderMode } from '@/lib/llm-credentials/service'

const put = (body: unknown): Request =>
  new Request('http://localhost/api/organization/llm-credentials/mode', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('/api/organization/llm-credentials/mode', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    session.role = 'admin'
    session.featureFlags = null
    delete process.env.GRID_ENFORCE_FEATURE_FLAGS
  })

  it('rejects non-admins', async () => {
    session.role = 'member'
    expect((await PUT(put({ mode: 'platform' }))).status).toBe(403)
    expect(setLlmProviderMode).not.toHaveBeenCalled()
  })

  it('rejects unknown modes (400)', async () => {
    expect((await PUT(put({ mode: 'hybrid' }))).status).toBe(400)
    expect(setLlmProviderMode).not.toHaveBeenCalled()
  })

  it('switches between platform and byok', async () => {
    const res = await PUT(put({ mode: 'platform' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: 'platform' })
    expect(setLlmProviderMode).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
      'platform',
      expect.any(Request),
    )
  })

  it('fails closed under flag enforcement without the byok-llm claim', async () => {
    process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
    session.featureFlags = []
    expect((await PUT(put({ mode: 'byok' }))).status).toBe(403)
  })
})
