/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { fetchRunView, RunViewError, runViewPath } from './run-view-client'

const view = {
  runId: 'run-1',
  backendJobId: 'job-1',
  conversationId: 's_conv',
  messageId: 'msg-1',
  status: 'running',
  ledger: null,
}

const respond = (status: number, body: unknown) =>
  vi.fn(
    async (_input: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  )

describe('fetchRunView', () => {
  it('reads the session route for the project and run, and parses the view', async () => {
    const run = respond(200, view)

    const result = await fetchRunView('p 1', 'run-1', run)

    expect(run).toHaveBeenCalledWith(runViewPath('p 1', 'run-1'), expect.objectContaining({ method: 'GET' }))
    expect(run.mock.calls[0][0]).toBe('/api/projects/p%201/runs/run-1')
    expect(result).toEqual(view)
  })

  it('throws a typed error carrying the status on a refused request', async () => {
    await expect(fetchRunView('p1', 'run-1', respond(404, { error: 'Unknown run' }))).rejects.toBeInstanceOf(
      RunViewError,
    )
    await expect(fetchRunView('p1', 'run-1', respond(404, {}))).rejects.toMatchObject({ status: 404 })
  })

  it('rejects a body this build does not recognise rather than casting it', async () => {
    await expect(fetchRunView('p1', 'run-1', respond(200, { runId: 'run-1' }))).rejects.toThrow()
  })
})
