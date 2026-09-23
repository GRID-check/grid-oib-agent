/**
 * @vitest-environment node
 */
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({ userId: 'user_1', organizationId: 'org_1', email: 'p@grid.test', role: 'admin' }),
}))
vi.mock('@/lib/plans/service', () => ({ getPlan: vi.fn(), editPlan: vi.fn() }))

import { ConflictError, NotFoundError } from '@/lib/api/errors'
import { editPlan, getPlan } from '@/lib/plans/service'
import { GET, PATCH } from './route'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const PLAN = '22222222-2222-4222-8222-222222222222'
const plan = { id: PLAN, status: 'proposed' }
const params = { params: Promise.resolve({ id: PROJECT, planId: PLAN }) }
const url = `https://grid.test/api/projects/${PROJECT}/plans/${PLAN}`

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getPlan).mockResolvedValue(plan as never)
  vi.mocked(editPlan).mockResolvedValue(plan as never)
})

describe('GET /api/projects/[id]/plans/[planId]', () => {
  it('hands the session and both ids to the service', async () => {
    const response = await GET(new NextRequest(url), params)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(plan)
    expect(getPlan).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org_1' }), PROJECT, PLAN)
  })

  it('answers 404 for a plan the service does not know', async () => {
    vi.mocked(getPlan).mockRejectedValue(new NotFoundError('Unknown plan'))
    expect((await GET(new NextRequest(url), params)).status).toBe(404)
  })
})

describe('PATCH /api/projects/[id]/plans/[planId]', () => {
  const patch = (body: unknown) =>
    PATCH(new NextRequest(url, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), params)

  it('hands a valid edit to the service', async () => {
    const response = await patch({ sections: ['Bestand'], grundlage: ['Einreichplan.pdf'] })
    expect(response.status).toBe(200)
    expect(editPlan).toHaveBeenCalledWith(expect.anything(), PROJECT, PLAN, { sections: ['Bestand'], grundlage: ['Einreichplan.pdf'] })
  })

  it('refuses an edit that names a field the contract does not have', async () => {
    expect((await patch({ status: 'started' })).status).toBe(400)
    expect(editPlan).not.toHaveBeenCalled()
  })

  it('answers 409 for a plan that has already started', async () => {
    vi.mocked(editPlan).mockRejectedValue(new ConflictError('This plan has already started'))
    expect((await patch({ genre: 'bericht' })).status).toBe(409)
  })
})
