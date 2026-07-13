import { afterEach, describe, expect, it, vi } from 'vitest'

// The route factory (`@/lib/api/handler`) statically imports the session
// guard, which pulls in authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

import { GET } from './route'

const DEV_DEFAULT_TOKEN = 'grid-internal-dev-token'
const REAL_TOKEN = 'a-real-secret-token'

const makeRequest = (token?: string) =>
  new Request('https://grid.test/api/internal/health', {
    method: 'GET',
    headers: {
      ...(token ? { 'x-grid-internal-token': token } : {}),
    },
  })

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('GET /api/internal/health', () => {
  it('returns 200 {ok:true} with a valid token', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

    const response = await GET(makeRequest(REAL_TOKEN))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ ok: true })
  })

  it('returns 403 for a wrong token', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

    const response = await GET(makeRequest('wrong-token'))

    expect(response.status).toBe(403)
  })

  it('returns 403 when the token header is missing', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

    const response = await GET(makeRequest())

    expect(response.status).toBe(403)
  })

  it('returns 503 when the internal token is not configured', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')

    const response = await GET(makeRequest(REAL_TOKEN))

    expect(response.status).toBe(503)
  })

  it('refuses the well-known dev default token outside dev environments (503)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', DEV_DEFAULT_TOKEN)
    vi.stubEnv('APP_ENV', 'production')
    vi.stubEnv('NODE_ENV', 'production')

    const response = await GET(makeRequest(DEV_DEFAULT_TOKEN))

    expect(response.status).toBe(503)
  })
})
