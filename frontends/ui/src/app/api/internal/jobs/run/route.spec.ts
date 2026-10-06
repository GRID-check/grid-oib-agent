/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConflictError } from '@/lib/api/errors'

// The route factory statically imports the session guard, which pulls in
// authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn() }))

const runJobSlice = vi.fn()
vi.mock('@/lib/jobs-queue/run', () => ({ runJobSlice: (...args: unknown[]) => runJobSlice(...args) }))

import { POST } from './route'

const TOKEN = 'a-real-secret-token'
const JOB_ID = '0c0c0c0c-0000-4000-8000-000000000001'

const post = (body: unknown, token: string | undefined = TOKEN) =>
  POST(
    new Request('https://grid.test/api/internal/jobs/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-grid-internal-token': token } : {}) },
      body: JSON.stringify(body),
    })
  )

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('POST /api/internal/jobs/run', () => {
  it('runs one slice of the named claim and answers with the state to save', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', TOKEN)
    runJobSlice.mockResolvedValueOnce({ done: false, payload: { cursor: 'p2' } })

    const response = await post({ jobId: JOB_ID, worker: 'bff-jobs-pod-0' })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ done: false, payload: { cursor: 'p2' } })
    expect(runJobSlice).toHaveBeenCalledWith(JOB_ID, 'bff-jobs-pod-0')
  })

  it('answers 409 when the job is not that worker’s, which the runner reads as a lost claim', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', TOKEN)
    runJobSlice.mockRejectedValueOnce(new ConflictError('The job is not claimed by this worker'))

    const response = await post({ jobId: JOB_ID, worker: 'bff-jobs-pod-0' })

    expect(response.status).toBe(409)
  })

  it('refuses a wrong or missing token before reading anything (403)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', TOKEN)

    expect((await post({ jobId: JOB_ID, worker: 'w' }, 'wrong')).status).toBe(403)
    expect((await post({ jobId: JOB_ID, worker: 'w' }, '')).status).toBe(403)
    expect(runJobSlice).not.toHaveBeenCalled()
  })

  it('refuses a body that does not name a job and a worker (400)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', TOKEN)

    expect((await post({ jobId: 'not-a-uuid', worker: 'w' })).status).toBe(400)
    expect((await post({ jobId: JOB_ID })).status).toBe(400)
    expect(runJobSlice).not.toHaveBeenCalled()
  })

  it('is disabled when no token is configured (503)', async () => {
    const response = await post({ jobId: JOB_ID, worker: 'w' })

    expect(response.status).toBe(503)
    expect(runJobSlice).not.toHaveBeenCalled()
  })
})
