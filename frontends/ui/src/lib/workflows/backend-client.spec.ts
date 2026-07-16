import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  submitWorkflowJob,
  WorkflowSubmitError,
  WorkflowSubmitSkippedError,
  type WorkflowSubmitPayload,
} from './backend-client'

const payload: WorkflowSubmitPayload = {
  agent_type: 'deep_researcher',
  input: '# Objective\n\nStudy X',
  data_sources: null,
  collection_scope: ['oib_knowledge', 'proj_abc'],
  project_context: null,
  organization_id: 'org-1',
  user_id: 'creator-9',
  project_id: 'proj-1',
  owner_email: 'creator@example.com',
  budget_header: 'YmFzZTY0',
  model_overrides: null,
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('GRID_INTERNAL_API_TOKEN', 'secret')
  vi.stubEnv('BACKEND_URL', 'http://backend:8000')
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('submitWorkflowJob', () => {
  it('throws 503 SubmitError when the internal token is unconfigured', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')
    await expect(submitWorkflowJob(payload)).rejects.toMatchObject({ status: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts to the internal submit route with the X-Internal-Token header', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ job_id: 'job-1' }), { status: 200 }))
    const result = await submitWorkflowJob(payload)
    expect(result).toEqual({ job_id: 'job-1' })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://backend:8000/v1/internal/workflows/submit')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as any).headers['X-Internal-Token']).toBe('secret')
  })

  it('maps a 429 to a SkippedError carrying Retry-After seconds', async () => {
    fetchMock.mockResolvedValue(
      new Response('org cap', { status: 429, headers: { 'Retry-After': '90' } }),
    )
    const err = await submitWorkflowJob(payload).catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowSubmitSkippedError)
    expect(err.retryAfterSeconds).toBe(90)
    expect(err.message).toContain('org cap')
  })

  it('maps a 429 without Retry-After to null seconds', async () => {
    fetchMock.mockResolvedValue(new Response('cap', { status: 429 }))
    const err = await submitWorkflowJob(payload).catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowSubmitSkippedError)
    expect(err.retryAfterSeconds).toBeNull()
  })

  it('maps other non-2xx to a SubmitError with the status', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))
    const err = await submitWorkflowJob(payload).catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowSubmitError)
    expect(err.status).toBe(500)
  })

  it('maps a network failure to a SubmitError (status 0)', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const err = await submitWorkflowJob(payload).catch((e) => e)
    expect(err).toBeInstanceOf(WorkflowSubmitError)
    expect(err.status).toBe(0)
  })

  it('errors when the backend response omits job_id', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    await expect(submitWorkflowJob(payload)).rejects.toBeInstanceOf(WorkflowSubmitError)
  })

  it('merges extraHeaders (the signed context envelope) alongside X-Internal-Token', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ job_id: 'job-2' }), { status: 200 }))
    await submitWorkflowJob(payload, {
      'X-Grid-Request-Context': 'envelope-header-value',
      'X-Grid-Request-Context-Sig': 'deadbeef',
    })
    const [, init] = fetchMock.mock.calls[0]
    const headers = (init as any).headers
    expect(headers['X-Internal-Token']).toBe('secret')
    expect(headers['X-Grid-Request-Context']).toBe('envelope-header-value')
    expect(headers['X-Grid-Request-Context-Sig']).toBe('deadbeef')
  })
})
