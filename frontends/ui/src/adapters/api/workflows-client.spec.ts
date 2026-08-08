/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  createWorkflow,
  deleteWorkflow,
  listWorkflowRuns,
  listWorkflows,
  runWorkflow,
  updateWorkflow,
  WorkflowApiError,
  type WorkflowDefinition,
} from './workflows-client'

const stubFetch = (body: unknown, status = 200): ReturnType<typeof vi.fn> => {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const definition: WorkflowDefinition = {
  version: 1,
  blocks: { objective: 'Research OIB changes' },
}

describe('workflows client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('listWorkflows accepts a bare array', async () => {
    stubFetch([{ id: 'w1', name: 'A', enabled: true }])
    const result = await listWorkflows('proj-1')
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('w1')
  })

  test('listWorkflows accepts a { workflows } envelope', async () => {
    stubFetch({ workflows: [{ id: 'w2', name: 'B' }] })
    const result = await listWorkflows('proj-1')
    expect(result[0].id).toBe('w2')
  })

  test('listWorkflows encodes the project id in the path', async () => {
    const fetchMock = stubFetch([])
    await listWorkflows('proj/with space')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/proj%2Fwith%20space/workflows',
      expect.anything(),
    )
  })

  test('createWorkflow POSTs the payload and returns the detail', async () => {
    const fetchMock = stubFetch({ id: 'w3', name: 'C', definition })
    const detail = await createWorkflow('proj-1', { name: 'C', definition })
    expect(detail.id).toBe('w3')
    const [, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toMatchObject({ name: 'C' })
  })

  test('updateWorkflow issues a PATCH', async () => {
    const fetchMock = stubFetch({ id: 'w3', name: 'C', enabled: false })
    await updateWorkflow('proj-1', 'w3', { enabled: false })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/projects/proj-1/workflows/w3')
    expect(init.method).toBe('PATCH')
  })

  test('deleteWorkflow tolerates an empty 204 response', async () => {
    stubFetch(undefined, 204)
    await expect(deleteWorkflow('proj-1', 'w3')).resolves.toBeUndefined()
  })

  test('runWorkflow unwraps the { run } envelope and defaults status', async () => {
    stubFetch({ run: { status: 'submitted', jobId: 'job-9', detail: null } })
    const result = await runWorkflow('proj-1', 'w3')
    expect(result).toEqual({ status: 'submitted', jobId: 'job-9', detail: null })
  })

  test('runWorkflow passes through a friendly skipped result', async () => {
    stubFetch({ run: { status: 'skipped', jobId: null, detail: 'Org job cap reached' } })
    const result = await runWorkflow('proj-1', 'w3')
    expect(result.status).toBe('skipped')
    expect(result.detail).toBe('Org job cap reached')
    expect(result.jobId).toBeNull()
  })

  test('runWorkflow tolerates a bare (un-enveloped) result', async () => {
    stubFetch({ jobId: 'job-x' })
    const result = await runWorkflow('proj-1', 'w3')
    expect(result).toEqual({ status: 'submitted', jobId: 'job-x', detail: null })
  })

  test('listWorkflowRuns forwards limit/offset as query params', async () => {
    const fetchMock = stubFetch({ runs: [] })
    await listWorkflowRuns('proj-1', 'w3', { limit: 10, offset: 5 })
    expect(fetchMock.mock.calls[0][0]).toBe(
      '/api/projects/proj-1/workflows/w3/runs?limit=10&offset=5',
    )
  })

  test('errors carry the HTTP status, BFF code, and server message', async () => {
    stubFetch({ error: 'cron cadence below the 15-minute minimum', code: 'UNPROCESSABLE' }, 422)
    const error = await createWorkflow('proj-1', { name: 'C', definition }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WorkflowApiError)
    const workflowError = error as WorkflowApiError
    expect(workflowError.status).toBe(422)
    expect(workflowError.code).toBe('UNPROCESSABLE')
    expect(workflowError.serverMessage).toBe('cron cadence below the 15-minute minimum')
    expect(workflowError.message).toContain('422')
  })
})
