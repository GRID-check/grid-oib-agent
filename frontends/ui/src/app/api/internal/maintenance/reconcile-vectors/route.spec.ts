/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// The route factory (`@/lib/api/handler`) statically imports the session
// guard, which pulls in authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

const reconcileMock = vi.fn()
vi.mock('@/lib/platform/vector-reconcile', () => ({
  reconcileOrphanedVectors: () => reconcileMock(),
}))

import { POST } from './route'

const REAL_TOKEN = 'a-real-secret-token'

const makeRequest = (token?: string) =>
  new Request('https://grid.test/api/internal/maintenance/reconcile-vectors', {
    method: 'POST',
    headers: { ...(token ? { 'x-grid-internal-token': token } : {}) },
  })

const RESULT = {
  collectionsScanned: 3,
  orphansFound: 2,
  orphansDeleted: 9,
  summariesForgotten: 1,
  failures: [{ collectionName: 'proj_b', error: 'list returned 503' }],
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('POST /api/internal/maintenance/reconcile-vectors', () => {
  it('runs the reconciler with a valid token and answers with its counts', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    reconcileMock.mockResolvedValueOnce(RESULT)

    const response = await POST(makeRequest(REAL_TOKEN))

    expect(response.status).toBe(200)
    // The body IS the run's record: the CronJob's pod log captures it, and the
    // failures are named there for the operator who reads that log.
    expect(await response.json()).toEqual(RESULT)
    expect(reconcileMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a wrong token before touching the store (403)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

    const response = await POST(makeRequest('wrong-token'))

    expect(response.status).toBe(403)
    expect(reconcileMock).not.toHaveBeenCalled()
  })

  it('refuses a missing token (403)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)

    const response = await POST(makeRequest())

    expect(response.status).toBe(403)
    expect(reconcileMock).not.toHaveBeenCalled()
  })

  it('is disabled when no token is configured (503)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')

    const response = await POST(makeRequest(REAL_TOKEN))

    expect(response.status).toBe(503)
    expect(reconcileMock).not.toHaveBeenCalled()
  })

  it('refuses the well-known dev default token outside dev environments (503)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', 'grid-internal-dev-token')
    vi.stubEnv('APP_ENV', 'production')
    vi.stubEnv('NODE_ENV', 'production')

    const response = await POST(makeRequest('grid-internal-dev-token'))

    expect(response.status).toBe(503)
    expect(reconcileMock).not.toHaveBeenCalled()
  })

  it('a reconciler that throws is a 5xx, so the CronJob run fails rather than reporting success', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    reconcileMock.mockRejectedValueOnce(new Error('database unreachable'))

    const response = await POST(makeRequest(REAL_TOKEN))

    expect(response.status).toBeGreaterThanOrEqual(500)
  })
})
