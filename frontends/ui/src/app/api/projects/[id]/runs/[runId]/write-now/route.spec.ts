/**
 * @vitest-environment node
 */
/**
 * The write-now route is an adapter and nothing else: the ids in the path reach
 * the service unchanged, the view comes back as the body, and the service's
 * refusals arrive as the statuses the errors carry.
 */

import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    email: 'p@grid.test',
    role: 'admin',
  }),
}))
vi.mock('@/lib/runs/service', () => ({ writeNowRun: vi.fn() }))

import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import { writeNowRun } from '@/lib/runs/service'
import { POST } from './route'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const RUN = '22222222-2222-4222-8222-222222222222'

const view = {
  runId: RUN,
  backendJobId: 'job-1',
  conversationId: 's_conv',
  messageId: 'msg-1',
  status: 'running',
  ledger: null,
}

const post = () =>
  POST(
    new NextRequest(`https://grid.test/api/projects/${PROJECT}/runs/${RUN}/write-now`, {
      method: 'POST',
    }),
    { params: Promise.resolve({ id: PROJECT, runId: RUN }) }
  )

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(writeNowRun).mockResolvedValue(view)
})

describe('POST /api/projects/[id]/runs/[runId]/write-now', () => {
  it('hands the session and both ids to the service and answers the run view', async () => {
    const response = await post()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(view)
    expect(writeNowRun).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1' }),
      PROJECT,
      RUN
    )
  })

  it('answers 404 for a run the service does not know', async () => {
    vi.mocked(writeNowRun).mockRejectedValue(new NotFoundError('Unknown run'))
    const response = await post()
    expect(response.status).toBe(404)
  })

  it('answers 403 when the service forbids', async () => {
    vi.mocked(writeNowRun).mockRejectedValue(new ForbiddenError())
    const response = await post()
    expect(response.status).toBe(403)
  })

  it('answers 409 for a run that cannot be stopped', async () => {
    vi.mocked(writeNowRun).mockRejectedValue(new ConflictError('This run has already ended'))
    const response = await post()
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ code: 'CONFLICT' })
  })
})
