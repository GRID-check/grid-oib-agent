/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/jobs/service', () => ({
  loadJobForFire: vi.fn(),
  fireScheduledJob: vi.fn(),
}))

import { POST } from '@/app/api/internal/skills/fire/route'
import { loadJobForFire, fireScheduledJob } from '@/lib/jobs/service'
import type { Job } from '@/lib/db/schema'

const mockLoad = vi.mocked(loadJobForFire)
const mockFire = vi.mocked(fireScheduledJob)

/**
 * The handler reads only `id`, `organizationId` and `enabled` off the job and
 * passes it through to the service; `as unknown as` confines the widening to
 * these two named boundaries rather than using `any`.
 */
const asJob = (row: Pick<Job, 'id' | 'organizationId' | 'enabled'>): Job =>
  row as unknown as Job

const REAL_TOKEN = 'a-real-secret-token'
const JOB_ID = '7f9c1d2e-3b4a-4c5d-8e6f-1a2b3c4d5e6f'

function makeRequest(body: unknown, token?: string): Request {
  return new Request('https://grid.test/api/internal/skills/fire', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-grid-internal-token': token } : {}),
    },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/internal/skills/fire', () => {
  it('returns 503 when the internal token is unconfigured', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')
    const res = await POST(makeRequest({ scheduleId: JOB_ID }, REAL_TOKEN))
    expect(res.status).toBe(503)
    expect(mockFire).not.toHaveBeenCalled()
  })

  it('returns 403 without the token header', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    const res = await POST(makeRequest({ scheduleId: JOB_ID }))
    expect(res.status).toBe(403)
    expect(mockLoad).not.toHaveBeenCalled()
  })

  it('returns 403 for a wrong token', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    const res = await POST(makeRequest({ scheduleId: JOB_ID }, 'wrong'))
    expect(res.status).toBe(403)
  })

  it('404s an unknown job', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    mockLoad.mockResolvedValue(null)
    const res = await POST(makeRequest({ scheduleId: JOB_ID }, REAL_TOKEN))
    expect(res.status).toBe(404)
  })

  it('relays a not-fired result (disabled race guard)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    mockLoad.mockResolvedValue(asJob({ id: JOB_ID, organizationId: 'org_1', enabled: false }))
    mockFire.mockResolvedValue({ fired: false, reason: 'disabled' })
    const res = await POST(makeRequest({ scheduleId: JOB_ID }, REAL_TOKEN))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ fired: false, reason: 'disabled' })
    expect(mockFire).toHaveBeenCalledWith({ id: JOB_ID, organizationId: 'org_1', enabled: false })
  })

  it('fires an enabled job through the scheduled-fire wrapper', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    mockLoad.mockResolvedValue(asJob({ id: JOB_ID, organizationId: 'org_1', enabled: true }))
    mockFire.mockResolvedValue({ fired: true, jobId: 'job-1' })
    const res = await POST(makeRequest({ scheduleId: JOB_ID }, REAL_TOKEN))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ fired: true, jobId: 'job-1' })
  })

  // The body field keeps its pre-jobs spelling: the scheduler container and the
  // BFF deploy separately, so renaming it would break every scheduled run in
  // the window between the two deploys.
  it('400s an invalid body (missing scheduleId)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', REAL_TOKEN)
    const res = await POST(makeRequest({}, REAL_TOKEN))
    expect(res.status).toBe(400)
  })
})