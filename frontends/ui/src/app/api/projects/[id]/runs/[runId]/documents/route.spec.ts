/**
 * @vitest-environment node
 */
/**
 * The documents route is an adapter and nothing else: the ids in the path and
 * the one document in the body reach the service unchanged, the view comes
 * back as the body, and a body that is not a document is refused before the
 * service is asked.
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
vi.mock('@/lib/runs/service', () => ({ addRunDocument: vi.fn() }))

import { ConflictError, NotFoundError } from '@/lib/api/errors'
import { addRunDocument } from '@/lib/runs/service'
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

const post = (body: unknown) =>
  POST(
    new NextRequest(`https://grid.test/api/projects/${PROJECT}/runs/${RUN}/documents`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
    { params: Promise.resolve({ id: PROJECT, runId: RUN }) }
  )

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(addRunDocument).mockResolvedValue(view)
})

describe('POST /api/projects/[id]/runs/[runId]/documents', () => {
  it('hands the session, both ids and the document to the service and answers the run view', async () => {
    const response = await post({ name: 'Einreichplan.pdf', title: 'Einreichplan', shelf: 'project' })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(view)
    expect(addRunDocument).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_1' }),
      PROJECT,
      RUN,
      { name: 'Einreichplan.pdf', title: 'Einreichplan', shelf: 'project' }
    )
  })

  it('refuses a body without a name before the service is asked', async () => {
    const response = await post({ title: 'Einreichplan' })
    expect(response.status).toBe(400)
    expect(addRunDocument).not.toHaveBeenCalled()
  })

  it('answers 404 for a run the service does not know', async () => {
    vi.mocked(addRunDocument).mockRejectedValue(new NotFoundError('Unknown run'))
    const response = await post({ name: 'Einreichplan.pdf' })
    expect(response.status).toBe(404)
  })

  it('answers 409 for a run that has already ended', async () => {
    vi.mocked(addRunDocument).mockRejectedValue(new ConflictError('This run has already ended'))
    const response = await post({ name: 'Einreichplan.pdf' })
    expect(response.status).toBe(409)
  })
})
