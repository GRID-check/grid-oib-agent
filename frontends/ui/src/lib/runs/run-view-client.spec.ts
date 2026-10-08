/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import {
  addRunDocument,
  cancelRun,
  commissionRun,
  fetchRunView,
  runCancelPath,
  runsPath,
  RunViewError,
  runViewPath,
} from './run-view-client'

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
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
  )

describe('fetchRunView', () => {
  it('reads the session route for the project and run, and parses the view', async () => {
    const run = respond(200, view)

    const result = await fetchRunView('p 1', 'run-1', run)

    expect(run).toHaveBeenCalledWith(
      runViewPath('p 1', 'run-1'),
      expect.objectContaining({ method: 'GET' })
    )
    expect(run.mock.calls[0][0]).toBe('/api/projects/p%201/runs/run-1')
    expect(result).toEqual(view)
  })

  it('throws a typed error carrying the status on a refused request', async () => {
    await expect(
      fetchRunView('p1', 'run-1', respond(404, { error: 'Unknown run' }))
    ).rejects.toBeInstanceOf(RunViewError)
    await expect(fetchRunView('p1', 'run-1', respond(404, {}))).rejects.toMatchObject({
      status: 404,
    })
  })

  it('rejects a body this build does not recognise rather than casting it', async () => {
    await expect(fetchRunView('p1', 'run-1', respond(200, { runId: 'run-1' }))).rejects.toThrow()
  })
})

describe('cancelRun', () => {
  it('posts to the run’s cancel door and parses the view it answers', async () => {
    const run = respond(200, view)

    const result = await cancelRun('p 1', 'run-1', run)

    expect(run).toHaveBeenCalledWith(
      runCancelPath('p 1', 'run-1'),
      expect.objectContaining({ method: 'POST' })
    )
    expect(run.mock.calls[0][0]).toBe('/api/projects/p%201/runs/run-1/cancel')
    expect(result).toEqual(view)
  })

  it('throws a typed error carrying the status on a refusal', async () => {
    await expect(
      cancelRun('p1', 'run-1', respond(409, { error: 'This run has already ended' }))
    ).rejects.toMatchObject({ status: 409 })
    await expect(cancelRun('p1', 'run-1', respond(404, {}))).rejects.toBeInstanceOf(RunViewError)
  })

  it('rejects a body this build does not recognise rather than casting it', async () => {
    await expect(cancelRun('p1', 'run-1', respond(200, { cancelled: true }))).rejects.toThrow()
  })
})

describe('commissionRun', () => {
  it('posts the brief to the project’s runs door and parses the ids it answers', async () => {
    const answered = {
      runId: 'run-9',
      runMessageId: 'msg-9',
      conversationId: 's_conv',
      status: 'queued',
    }
    const run = respond(201, answered)

    const result = await commissionRun(
      'p 1',
      { conversationId: 's_conv', question: 'Klären: X', context: 'ctx' },
      run
    )

    expect(run.mock.calls[0][0]).toBe(runsPath('p 1'))
    expect(run).toHaveBeenCalledWith(
      '/api/projects/p%201/runs',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ conversationId: 's_conv', question: 'Klären: X', context: 'ctx' }),
      })
    )
    expect(result).toEqual(answered)
  })

  it('throws a typed error carrying the status on a refusal', async () => {
    await expect(
      commissionRun('p1', { conversationId: 's', question: 'q' }, respond(403, { error: 'no' }))
    ).rejects.toMatchObject({ status: 403 })
  })
})

describe('addRunDocument', () => {
  it('posts only the plan document’s fields, whatever row the caller holds', async () => {
    const run = respond(200, view)
    const row = {
      name: 'Einreichplan.pdf',
      title: 'Einreichplan EG',
      shelf: 'project',
      // What the picker's inventory carries beside the plan document.
      file: { id: 'doc-1' },
      source: 'projekt',
    }

    await addRunDocument('p1', 'run-1', row, run)

    expect(run.mock.calls[0][0]).toBe('/api/projects/p1/runs/run-1/documents')
    expect(JSON.parse(String(run.mock.calls[0][1]?.body))).toEqual({
      name: 'Einreichplan.pdf',
      title: 'Einreichplan EG',
      shelf: 'project',
    })
  })

  it('carries the API’s code and sentence on a refusal, and the status alone on a bare one', async () => {
    const refusal = 'Eine genannte Unterlage liegt in einem Ordner mit eingeschränktem Zugriff …'
    await expect(
      addRunDocument('p1', 'run-1', { name: 'a.pdf' }, respond(403, { error: refusal, code: 'CONVERSATION_CONFINED' }))
    ).rejects.toMatchObject({ status: 403, code: 'CONVERSATION_CONFINED', message: refusal })
    await expect(addRunDocument('p1', 'run-1', { name: 'a.pdf' }, respond(502, {}))).rejects.toMatchObject({
      status: 502,
      code: null,
    })
  })
})
