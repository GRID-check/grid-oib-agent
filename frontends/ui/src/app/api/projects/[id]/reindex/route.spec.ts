/**
 * Project re-index route.
 *
 * The route is a thin adapter: it names the project from the path, and answers
 * 202 with the job the service queued. What is worth pinning is that it asks
 * for nothing else and that "accepted" is what it says: the walk runs later,
 * on a `bff-jobs` pod, and the response must not read as a finished one.
 */

import { describe, expect, test, vi, beforeEach } from 'vitest'

const reindexProject = vi.fn()

vi.mock('@/lib/documents/service', () => ({ reindexProject }))
vi.mock('@/lib/api/handler', () => ({
  apiRoute:
    (
      handler: (ctx: { session: unknown; params: { id: string } }) => Promise<unknown>,
      options: { status?: number }
    ) =>
    async (_request: Request, ctx: { params: Promise<{ id: string }> }) => {
      const params = await ctx.params
      const body = await handler({ session: { organizationId: 'org-1' }, params })
      return Response.json(body, { status: options.status ?? 200 })
    },
}))

describe('POST /api/projects/[id]/reindex', () => {
  beforeEach(() => {
    reindexProject.mockReset()
  })

  test('re-indexes the project named in the path and nothing else', async () => {
    reindexProject.mockResolvedValue({ projectId: 'p-1', jobId: 'job-1' })
    const { POST } = await import('./route')

    const response = await POST(new Request('http://t/api/projects/p-1/reindex', { method: 'POST' }), {
      params: Promise.resolve({ id: 'p-1' }),
    })

    expect(reindexProject).toHaveBeenCalledTimes(1)
    expect(reindexProject.mock.calls[0][1]).toBe('p-1')
    await expect(response.json()).resolves.toEqual({ projectId: 'p-1', jobId: 'job-1' })
  })

  test('answers 202 Accepted: the job is queued, not done', async () => {
    reindexProject.mockResolvedValue({ projectId: 'p-1', jobId: 'job-1' })
    const { POST } = await import('./route')

    const response = await POST(new Request('http://t/api/projects/p-1/reindex', { method: 'POST' }), {
      params: Promise.resolve({ id: 'p-1' }),
    })

    expect(response.status).toBe(202)
  })
})
