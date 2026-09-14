/**
 * @vitest-environment node
 */
/**
 * Characterization of the manual "Run now" contract (slice 01 of the
 * task-model follow-up, PR #659): fire with the caller's identity and return
 * the run row bare; a disabled job is the service's 409, not the route's.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    email: 'p@grid.test',
    role: 'admin',
  }),
}))

vi.mock('@/lib/authz/feature-flags', () => ({
  requireSkillsEnabled: vi.fn().mockReturnValue(null),
}))

vi.mock('@/lib/jobs/service', () => ({
  runJobNow: vi.fn(),
}))

import { runJobNow } from '@/lib/jobs/service'
import { POST } from './route'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const JOB = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/projects/[id]/jobs/[jobId]/run', () => {
  it('fires with the session and returns the run', async () => {
    const run = { id: 'run_1', scheduleId: JOB, trigger: 'manual', status: 'submitted', jobId: 'backend-1' }
    vi.mocked(runJobNow).mockResolvedValue(run as never)

    const request = new NextRequest(`https://grid.test/api/projects/${PROJECT}/jobs/${JOB}/run`, {
      method: 'POST',
    })
    const response = await POST(request, { params: Promise.resolve({ id: PROJECT, jobId: JOB }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(run)
    expect(runJobNow).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org_1' }), PROJECT, JOB)
  })
})
