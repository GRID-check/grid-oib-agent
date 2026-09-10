/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn() }))

vi.mock('@/lib/workspace/register-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace/register-service')>()
  return {
    ...actual,
    reconcileProjectRegister: vi.fn(async () => ({ claimed: 0, rebuilt: 0, skipped: 0 })),
  }
})

import { REGISTER_RECONCILE_BATCH, reconcileProjectRegister } from '@/lib/workspace/register-service'
import { POST } from './route'

const REAL_TOKEN = 'a-real-secret-token'

const makeRequest = (token?: string) =>
  new Request('https://grid.test/api/internal/workspace/register/reconcile', {
    method: 'POST',
    headers: token ? { 'x-grid-internal-token': token } : {},
  })

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('POST /api/internal/workspace/register/reconcile', () => {
  it('is token-guarded — a scheduler without the secret rebuilds nothing', async () => {
    expect((await POST(makeRequest(REAL_TOKEN))).status).toBe(503)
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    expect((await POST(makeRequest('nope'))).status).toBe(403)
    expect((await POST(makeRequest())).status).toBe(403)
    expect(reconcileProjectRegister).not.toHaveBeenCalled()
  })

  it('rebuilds exactly one bounded batch and reports what it did', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(reconcileProjectRegister).mockResolvedValue({ claimed: 50, rebuilt: 48, skipped: 2 })

    const response = await POST(makeRequest(REAL_TOKEN))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      claimed: 50,
      rebuilt: 48,
      skipped: 2,
      batchSize: REGISTER_RECONCILE_BATCH,
    })
    expect(reconcileProjectRegister).toHaveBeenCalledWith(REGISTER_RECONCILE_BATCH)
  })

  it('is idempotent: a second call with nothing stale claims nothing', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    vi.mocked(reconcileProjectRegister).mockResolvedValue({ claimed: 0, rebuilt: 0, skipped: 0 })

    const response = await POST(makeRequest(REAL_TOKEN))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ claimed: 0, rebuilt: 0 })
  })
})
