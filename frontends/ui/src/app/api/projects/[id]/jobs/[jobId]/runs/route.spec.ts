/**
 * @vitest-environment node
 */
/**
 * Characterization of the run-history contract (slice 01 of the task-model
 * follow-up, PR #659): pagination parsed from ?limit&offset with the 50/0
 * defaults, and the service called with the numbers, not the strings.
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
  listJobRuns: vi.fn(),
}))

import { listJobRuns } from '@/lib/jobs/service'
import { GET } from './route'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const JOB = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listJobRuns).mockResolvedValue({ runs: [] })
})

describe('GET /api/projects/[id]/jobs/[jobId]/runs', () => {
  it('passes parsed pagination numbers, defaulting to 50/0', async () => {
    const request = new NextRequest(`https://grid.test/api/projects/${PROJECT}/jobs/${JOB}/runs`)
    const response = await GET(request, { params: Promise.resolve({ id: PROJECT, jobId: JOB }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ runs: [] })
    expect(listJobRuns).toHaveBeenCalledWith(expect.anything(), PROJECT, JOB, 50, 0)
  })

  it('honours an explicit page', async () => {
    const request = new NextRequest(`https://grid.test/api/projects/${PROJECT}/jobs/${JOB}/runs?limit=25&offset=50`)
    await GET(request, { params: Promise.resolve({ id: PROJECT, jobId: JOB }) })

    expect(listJobRuns).toHaveBeenCalledWith(expect.anything(), PROJECT, JOB, 25, 50)
  })

  it('refuses a limit past the page ceiling', async () => {
    const request = new NextRequest(`https://grid.test/api/projects/${PROJECT}/jobs/${JOB}/runs?limit=500`)
    const response = await GET(request, { params: Promise.resolve({ id: PROJECT, jobId: JOB }) })

    expect(response.status).toBe(400)
    expect(listJobRuns).not.toHaveBeenCalled()
  })
})
