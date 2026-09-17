/**
 * @vitest-environment node
 */
/**
 * Characterization of the project-scoped /jobs HTTP contract (slice 01 of the
 * task-model follow-up, PR #659). The routes are thin adapters; these pin the
 * wire shape and the service call they delegate to, both of which the
 * definitions/runs collapse must preserve.
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
  listJobs: vi.fn(),
  createJob: vi.fn(),
}))

import { createJob, listJobs } from '@/lib/jobs/service'
import { GET, POST } from './route'

const PROJECT = '11111111-1111-4111-8111-111111111111'

const job = {
  id: '22222222-2222-4222-8222-222222222222',
  projectId: PROJECT,
  organizationId: 'org_1',
  name: 'Wochencheck',
  prompt: 'Prüf das',
  output: 'chat',
  enabled: true,
  scheduleCron: '0 8 * * 1',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(listJobs).mockResolvedValue({ jobs: [job as never] })
  vi.mocked(createJob).mockResolvedValue(job as never)
})

describe('GET /api/projects/[id]/jobs', () => {
  it('returns the project job list as { jobs }', async () => {
    const request = new NextRequest(`https://grid.test/api/projects/${PROJECT}/jobs`)
    const response = await GET(request, { params: Promise.resolve({ id: PROJECT }) })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ jobs: [job] })
    expect(listJobs).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org_1' }), PROJECT)
  })
})

describe('POST /api/projects/[id]/jobs', () => {
  it('creates a job and answers 201 with { job }', async () => {
    const request = new NextRequest(`https://grid.test/api/projects/${PROJECT}/jobs`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Wochencheck',
        prompt: 'Prüf das',
        output: 'chat',
        scheduleCron: '0 8 * * 1',
        scheduleTimezone: 'Europe/Vienna',
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    const response = await POST(request, { params: Promise.resolve({ id: PROJECT }) })

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ job })
    expect(createJob).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1' }),
      PROJECT,
      expect.objectContaining({ name: 'Wochencheck', scheduleCron: '0 8 * * 1' }),
    )
  })

  it('refuses a body with no prompt before calling the service', async () => {
    const request = new NextRequest(`https://grid.test/api/projects/${PROJECT}/jobs`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Wochencheck', output: 'chat' }),
      headers: { 'Content-Type': 'application/json' },
    })
    const response = await POST(request, { params: Promise.resolve({ id: PROJECT }) })

    expect(response.status).toBe(400)
    expect(createJob).not.toHaveBeenCalled()
  })
})
