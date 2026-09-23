/**
 * @vitest-environment node
 */
/**
 * The worker's claim is token-guarded and acts as nobody: the plan id in the
 * path is the only identity, "not yet" is a 200 with data, a replaced plan is
 * the one refusal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/plans/service', () => ({ claimPlanStart: vi.fn() }))

import { ConflictError } from '@/lib/api/errors'
import { claimPlanStart } from '@/lib/plans/service'
import { POST } from './route'

const SECRET = 'internal-token-for-tests' // pragma: allowlist secret
const PLAN = '22222222-2222-4222-8222-222222222222'

const call = (token: string | null = SECRET) =>
  POST(
    new Request(`https://grid.test/api/internal/plans/${PLAN}/start`, {
      method: 'POST',
      headers: token ? { 'x-grid-internal-token': token } : {},
    }),
    { params: Promise.resolve({ planId: PLAN }) }
  )

beforeEach(() => {
  vi.clearAllMocks()
  process.env.GRID_INTERNAL_API_TOKEN = SECRET
  process.env.APP_ENV = 'test'
  vi.mocked(claimPlanStart).mockResolvedValue({ started: false, plan: { id: PLAN } as never, retryAfterSeconds: 3 })
})

describe('POST /api/internal/plans/[planId]/start', () => {
  it('refuses without the service token, before the service is asked', async () => {
    expect((await call(null)).status).toBe(403)
    expect(claimPlanStart).not.toHaveBeenCalled()
  })

  it('answers the claim as data, "not yet" included', async () => {
    const response = await call()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ started: false, plan: { id: PLAN }, retryAfterSeconds: 3 })
    expect(claimPlanStart).toHaveBeenCalledWith(PLAN)
  })

  it('answers 409 for a plan that was replaced', async () => {
    vi.mocked(claimPlanStart).mockRejectedValue(new ConflictError('This plan was replaced'))
    expect((await call()).status).toBe(409)
  })
})
