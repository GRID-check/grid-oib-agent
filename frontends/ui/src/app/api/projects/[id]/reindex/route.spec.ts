/**
 * Project re-index route.
 *
 * The behaviour worth pinning is not the happy path — it is that a document whose
 * old chunks could not be deleted is NOT re-dispatched. Dispatching it anyway is
 * how a re-index becomes a second copy of the project, retrievable and citable,
 * which is the exact defect this endpoint was written to avoid.
 */

import { describe, expect, test, vi, beforeEach } from 'vitest'

const reindexProject = vi.fn()

vi.mock('@/lib/documents/service', () => ({ reindexProject }))
vi.mock('@/lib/api/handler', () => ({
  apiRoute:
    (handler: (ctx: { session: unknown; params: { id: string } }) => Promise<unknown>) =>
    async (_request: Request, ctx: { params: Promise<{ id: string }> }) => {
      const params = await ctx.params
      const body = await handler({ session: { organizationId: 'org-1' }, params })
      return Response.json(body)
    },
}))

describe('POST /api/projects/[id]/reindex', () => {
  beforeEach(() => {
    reindexProject.mockReset()
  })

  test('re-indexes the project named in the path and nothing else', async () => {
    reindexProject.mockResolvedValue({ projectId: 'p-1', queued: 3, skipped: 0, failed: [] })
    const { POST } = await import('./route')

    const response = await POST(new Request('http://t/api/projects/p-1/reindex', { method: 'POST' }), {
      params: Promise.resolve({ id: 'p-1' }),
    })

    expect(reindexProject).toHaveBeenCalledTimes(1)
    expect(reindexProject.mock.calls[0][1]).toBe('p-1')
    await expect(response.json()).resolves.toMatchObject({ queued: 3 })
  })

  test('reports documents left unchanged rather than folding them into the success count', async () => {
    reindexProject.mockResolvedValue({
      projectId: 'p-1',
      queued: 2,
      skipped: 1,
      failed: ['plan.pdf'],
    })
    const { POST } = await import('./route')

    const response = await POST(new Request('http://t/api/projects/p-1/reindex', { method: 'POST' }), {
      params: Promise.resolve({ id: 'p-1' }),
    })

    const body = (await response.json()) as { queued: number; failed: string[] }
    expect(body.queued).toBe(2)
    expect(body.failed).toEqual(['plan.pdf'])
  })
})
