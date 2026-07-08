import { afterEach, describe, expect, it, vi } from 'vitest'

// The route factory (`@/lib/api/handler`) statically imports the session
// guard, which pulls in authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/projects/memory-service', () => ({
  buildProjectMemoryDigest: vi.fn(),
}))

import { buildProjectMemoryDigest } from '@/lib/projects/memory-service'
import { GET } from './route'

const DEV_DEFAULT_TOKEN = 'grid-internal-dev-token'
const REAL_TOKEN = 'a-real-secret-token'
const PROJECT_ID = '4f9c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f'
const ORG_ID = 'org_123'

const makeRequest = (query: string, token?: string) =>
  new Request(`https://grid.test/api/internal/memory/digest${query}`, {
    method: 'GET',
    headers: token ? { 'x-grid-internal-token': token } : {},
  })

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('GET /api/internal/memory/digest', () => {
  it('returns 503 when the internal token is not configured', async () => {
    const response = await GET(makeRequest(`?projectId=${PROJECT_ID}`, REAL_TOKEN))
    expect(response.status).toBe(503)
    expect(buildProjectMemoryDigest).not.toHaveBeenCalled()
  })

  it('returns 403 for a wrong token', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    const response = await GET(makeRequest(`?projectId=${PROJECT_ID}`, 'nope'))
    expect(response.status).toBe(403)
    expect(buildProjectMemoryDigest).not.toHaveBeenCalled()
  })

  it('returns 403 when the token header is missing', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    const response = await GET(makeRequest(`?projectId=${PROJECT_ID}`))
    expect(response.status).toBe(403)
  })

  it('refuses the well-known dev default token outside dev environments (503)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', DEV_DEFAULT_TOKEN)
    vi.stubEnv('NODE_ENV', 'production')
    const response = await GET(makeRequest(`?projectId=${PROJECT_ID}`, DEV_DEFAULT_TOKEN))
    expect(response.status).toBe(503)
  })

  it('returns 400 when neither projectId nor organizationId is provided', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    const response = await GET(makeRequest('', REAL_TOKEN))
    expect(response.status).toBe(400)
    expect(buildProjectMemoryDigest).not.toHaveBeenCalled()
  })

  it('returns the digest for a valid token (200)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(buildProjectMemoryDigest).mockResolvedValue('PROJECT_MEMORY v1\n- [decision | high | user_confirmed] "x"')

    const response = await GET(makeRequest(`?projectId=${PROJECT_ID}&organizationId=${ORG_ID}`, REAL_TOKEN))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.digest).toContain('PROJECT_MEMORY v1')
    expect(buildProjectMemoryDigest).toHaveBeenCalledWith(PROJECT_ID, ORG_ID)
  })

  it('returns digest:null (200) when there is no active memory', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(buildProjectMemoryDigest).mockResolvedValue(null)

    const response = await GET(makeRequest(`?organizationId=${ORG_ID}`, REAL_TOKEN))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.digest).toBeNull()
    expect(buildProjectMemoryDigest).toHaveBeenCalledWith(undefined, ORG_ID)
  })

  it('returns 500 when the digest builder throws', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(buildProjectMemoryDigest).mockRejectedValue(new Error('db down'))

    const response = await GET(makeRequest(`?projectId=${PROJECT_ID}`, REAL_TOKEN))
    expect(response.status).toBe(500)
  })
})
