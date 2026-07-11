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
  activeSecretBackend: vi.fn().mockReturnValue('local-aes-gcm'),
  listOrgCredentials: vi.fn().mockResolvedValue([
    {
      id: 'cred-1',
      provider: 'openrouter',
      label: 'Corp key',
      keyHint: '…abcd',
      keyFingerprint: 'deadbeefdeadbeef',
      status: 'active',
    },
  ]),
  createCredential: vi.fn().mockResolvedValue({ id: 'cred-2', provider: 'openrouter', status: 'active' }),
}))

import { GET, POST } from './route'
import { createCredential } from '@/lib/llm-credentials/service'

const get = (): Request => new Request('http://localhost/api/organization/llm-credentials')
const post = (body: unknown): Request =>
  new Request('http://localhost/api/organization/llm-credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

describe('/api/organization/llm-credentials', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    session.role = 'admin'
    session.featureFlags = null
    delete process.env.GRID_ENFORCE_FEATURE_FLAGS
  })

  it('GET rejects non-admins', async () => {
    session.role = 'member'
    expect((await GET(get())).status).toBe(403)
  })

  it('GET returns metadata only for admins', async () => {
    const res = await GET(get())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.secretBackend).toBe('local-aes-gcm')
    expect(body.credentials[0].keyHint).toBe('…abcd')
    expect(JSON.stringify(body)).not.toContain('apiKey')
  })

  it('fails closed under flag enforcement without the byok-llm claim', async () => {
    process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
    session.featureFlags = ['deep-research']
    const res = await GET(get())
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('feature-disabled')
  })

  it('allows the route under enforcement when the org holds the flag', async () => {
    process.env.GRID_ENFORCE_FEATURE_FLAGS = 'true'
    session.featureFlags = ['byok-llm']
    expect((await GET(get())).status).toBe(200)
  })

  it('POST validates the payload shape (400) before touching the service', async () => {
    expect((await POST(post({ provider: 'openrouter', label: 'x', apiKey: 'short' }))).status).toBe(400)
    expect((await POST(post({ provider: 'anthropic', label: 'x', apiKey: 'sk-long-enough' }))).status).toBe(400)
    expect(createCredential).not.toHaveBeenCalled()
  })

  it('POST creates a credential (201) with the session + request threaded through', async () => {
    const res = await POST(post({ provider: 'openrouter', label: 'Corp key', apiKey: 'sk-long-enough' }))
    expect(res.status).toBe(201)
    expect(createCredential).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
      expect.objectContaining({ provider: 'openrouter', apiKey: 'sk-long-enough' }),
      expect.any(Request),
    )
  })
})
