/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/jobs/service', () => ({
  listJobs: vi.fn(),
  createJob: vi.fn(),
}))

import { GET, POST } from '@/app/api/projects/[id]/jobs/route'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { listJobs, createJob } from '@/lib/jobs/service'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Job } from '@/lib/db/schema'

const mockSession = vi.mocked(requireAuthorizedSession)
const mockList = vi.mocked(listJobs)
const mockCreate = vi.mocked(createJob)

const asJob = (row: Pick<Job, 'id' | 'name'>): Job => row as unknown as Job

const session: Omit<AuthorizedSession, 'featureFlags'> & { featureFlags: null } = {
  userId: 'user_1',
  email: 'user@example.com',
  name: null,
  accessToken: 'tok',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: null,
}

function makeParams(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) }
}

/** A job is a prompt + an output kind; the skill is optional. */
const validBody = { name: 'Weekly', prompt: 'Fasse die Woche zusammen.', output: 'chat' }

function req(body?: unknown): Request {
  return new Request('http://localhost/api/projects/proj_1/jobs', {
    method: body ? 'POST' : 'GET',
    ...(body ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockSession.mockResolvedValue(session as unknown as AuthorizedSession)
})

afterEach(() => {
  delete process.env.GRID_SKILLS_ENABLED
})

describe('GET /api/projects/[id]/jobs', () => {
  it('returns 403 feature-disabled when the gate is off (default)', async () => {
    const res = await GET(req(), makeParams('proj_1'))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'feature-disabled', feature: 'skills' })
    expect(mockList).not.toHaveBeenCalled()
  })

  it('lists jobs when the env gate is on', async () => {
    process.env.GRID_SKILLS_ENABLED = 'true'
    mockList.mockResolvedValue({ jobs: [asJob({ id: 'job-1', name: 'Weekly' })] })
    const res = await GET(req(), makeParams('proj_1'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ jobs: [{ id: 'job-1', name: 'Weekly' }] })
    expect(mockList).toHaveBeenCalledWith(session, 'proj_1')
  })
})

describe('POST /api/projects/[id]/jobs', () => {
  it('returns 403 feature-disabled when off, before validating the body', async () => {
    const res = await POST(req(validBody), makeParams('proj_1'))
    expect(res.status).toBe(403)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when the prompt is missing', async () => {
    process.env.GRID_SKILLS_ENABLED = 'true'
    const res = await POST(req({ name: 'no prompt', output: 'chat' }), makeParams('proj_1'))
    expect(res.status).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns 400 when the output kind is missing or unknown', async () => {
    process.env.GRID_SKILLS_ENABLED = 'true'
    expect((await POST(req({ name: 'W', prompt: 'p' }), makeParams('proj_1'))).status).toBe(400)
    expect(
      (await POST(req({ ...validBody, output: 'report' }), makeParams('proj_1'))).status
    ).toBe(400)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('creates a skill-less job (201) on a valid body', async () => {
    process.env.GRID_SKILLS_ENABLED = 'true'
    mockCreate.mockResolvedValue(asJob({ id: 'job-new', name: 'Weekly' }))
    const res = await POST(req(validBody), makeParams('proj_1'))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ job: { id: 'job-new', name: 'Weekly' } })
    expect(mockCreate).toHaveBeenCalledWith(
      session,
      'proj_1',
      expect.objectContaining({ name: 'Weekly', prompt: 'Fasse die Woche zusammen.', output: 'chat' })
    )
  })

  it('passes an attached skill through when one is named', async () => {
    process.env.GRID_SKILLS_ENABLED = 'true'
    mockCreate.mockResolvedValue(asJob({ id: 'job-new', name: 'Weekly' }))
    await POST(req({ ...validBody, skillName: 'data-table-analysis' }), makeParams('proj_1'))
    expect(mockCreate).toHaveBeenCalledWith(
      session,
      'proj_1',
      expect.objectContaining({ skillName: 'data-table-analysis' })
    )
  })
})
