import { afterEach, describe, expect, test, vi } from 'vitest'
import { listResearchRuns } from './research-runs-client'
import { ApiRequestError } from './api-error'

const stubFetchJson = (body: unknown, status = 200): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  )
}

describe('research runs client', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('returns well-formed runs unchanged', async () => {
    stubFetchJson({
      jobs: [
        {
          job_id: 'job-1',
          status: 'completed',
          created_at: '2026-07-01T00:00:00Z',
          conversation_id: 'conv-1',
          project_collection: 'proj_1',
        },
      ],
      total: 1,
    })

    const response = await listResearchRuns({ projectCollection: 'proj_1' })

    expect(response.total).toBe(1)
    expect(response.jobs).toEqual([
      {
        job_id: 'job-1',
        status: 'completed',
        created_at: '2026-07-01T00:00:00Z',
        conversation_id: 'conv-1',
        project_collection: 'proj_1',
      },
    ])
  })

  test('drops malformed entries and defaults missing optional fields', async () => {
    stubFetchJson({
      jobs: [
        { job_id: 'job-ok', status: 'running', created_at: '2026-07-01T00:00:00Z' },
        { job_id: 42, status: 'running', created_at: '2026-07-01T00:00:00Z' }, // wrong job_id type
        { status: 'running', created_at: '2026-07-01T00:00:00Z' }, // missing job_id
        'not-an-object',
        null,
      ],
      total: 5,
    })

    const response = await listResearchRuns()

    expect(response.jobs).toEqual([
      {
        job_id: 'job-ok',
        status: 'running',
        created_at: '2026-07-01T00:00:00Z',
        conversation_id: null,
        project_collection: null,
      },
    ])
    // total from the backend is passed through when numeric
    expect(response.total).toBe(5)
  })

  test('treats a payload without a jobs array as empty', async () => {
    stubFetchJson({ unexpected: true })

    const response = await listResearchRuns()

    expect(response.jobs).toEqual([])
    expect(response.total).toBe(0)
  })

  test('attaches the HTTP status to thrown errors', async () => {
    stubFetchJson({ error: { code: 'NOT_FOUND', message: 'nope' } }, 404)

    const error = await listResearchRuns().catch((err: unknown) => err)

    expect(error).toBeInstanceOf(ApiRequestError)
    expect((error as ApiRequestError).status).toBe(404)
    expect((error as ApiRequestError).message).toBe(
      'Failed to list research runs: 404 - NOT_FOUND: nope'
    )
  })
})
