/**
 * @vitest-environment node
 */
/**
 * Characterization of the single-job HTTP contract (slice 01 of the
 * task-model follow-up, PR #659): get returns the row bare, patch returns the
 * updated row bare, delete answers 204.
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
  getJob: vi.fn(),
  updateJob: vi.fn(),
  deleteJob: vi.fn(),
}))

import { deleteJob, getJob, updateJob } from '@/lib/jobs/service'
import { DELETE, GET, PATCH } from './route'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const JOB = '22222222-2222-4222-8222-222222222222'

const job = { id: JOB, projectId: PROJECT, name: 'Wochencheck', enabled: true }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getJob).mockResolvedValue(job as never)
  vi.mocked(updateJob).mockResolvedValue({ ...job, enabled: false } as never)
  vi.mocked(deleteJob).mockResolvedValue({ deleted: true })
})

describe('GET /api/projects/[id]/jobs/[jobId]', () => {
  it('returns the job row', async () => {
    const request = new NextRequest(`https://grid.test/api/projects/${PROJECT}/jobs/${JOB}`)
    const response = await GET(request, { params: Promise.resolve({ id: PROJECT, jobId: JOB }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(job)
    expect(getJob).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org_1' }), PROJECT, JOB)
  })
})

describe('PATCH /api/projects/[id]/jobs/[jobId]', () => {
  it('returns the updated row', async () => {
    const request = new NextRequest(`https://grid.test/api/projects/${PROJECT}/jobs/${JOB}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
      headers: { 'Content-Type': 'application/json' },
    })
    const response = await PATCH(request, { params: Promise.resolve({ id: PROJECT, jobId: JOB }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ...job, enabled: false })
    expect(updateJob).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1' }),
      PROJECT,
      JOB,
      { enabled: false },
    )
  })
})

describe('DELETE /api/projects/[id]/jobs/[jobId]', () => {
  it('answers 204 with no body', async () => {
    const request = new NextRequest(`https://grid.test/api/projects/${PROJECT}/jobs/${JOB}`, {
      method: 'DELETE',
    })
    const response = await DELETE(request, { params: Promise.resolve({ id: PROJECT, jobId: JOB }) })

    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
    expect(deleteJob).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org_1' }), PROJECT, JOB)
  })
})
