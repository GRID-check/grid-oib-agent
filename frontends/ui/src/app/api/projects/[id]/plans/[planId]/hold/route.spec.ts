/**
 * @vitest-environment node
 */
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({ userId: 'user_1', organizationId: 'org_1', email: 'p@grid.test', role: 'admin' }),
}))
vi.mock('@/lib/plans/service', () => ({ holdPlan: vi.fn() }))

import { ConflictError } from '@/lib/api/errors'
import { holdPlan } from '@/lib/plans/service'
import { POST } from './route'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const PLAN = '22222222-2222-4222-8222-222222222222'
const post = () =>
  POST(new NextRequest(`https://grid.test/api/projects/${PROJECT}/plans/${PLAN}/hold`, { method: 'POST' }), {
    params: Promise.resolve({ id: PROJECT, planId: PLAN }),
  })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(holdPlan).mockResolvedValue({ id: PLAN } as never)
})

describe('POST /api/projects/[id]/plans/[planId]/hold', () => {
  it('hands the session and both ids to the service and answers the plan', async () => {
    const response = await post()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ id: PLAN })
    expect(holdPlan).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org_1' }), PROJECT, PLAN)
  })

  it('answers 409 when the plan can no longer be changed', async () => {
    vi.mocked(holdPlan).mockRejectedValue(new ConflictError('This plan has already started'))
    expect((await post()).status).toBe(409)
  })
})
