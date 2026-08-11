/**
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SkillSubmitError,
  SkillSubmitSkippedError,
  submitSkillJob,
  type SkillSubmitPayload,
} from './backend-client'

const headersOf = (init: RequestInit | undefined): Record<string, string> =>
  (init as RequestInit).headers as Record<string, string>

const payload: SkillSubmitPayload = {
  input: 'Führe den folgenden Skill verbindlich und vollständig aus:',
  skills: ['data-table-analysis'],
  execution: 'chat',
  data_sources: null,
  collection_scope: ['oib_knowledge', 'proj_abc'],
  project_context: null,
  organization_id: 'org-1',
  user_id: 'creator-9',
  project_id: 'proj-1',
  owner_email: null,
  budget_header: null,
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

describe('submitSkillJob', () => {
  it('throws 503 SubmitError when the internal token is unconfigured', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', '')
    await expect(submitSkillJob(payload, {})).rejects.toMatchObject({ status: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts to the internal skills submit route with the X-Internal-Token header', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ jobId: 'job-1' }), { status: 200 }))
    await submitSkillJob(payload, { 'x-grid-organization-id': 'org-1' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://backend:8000/v1/internal/skills/submit')
    expect(headersOf(init)['x-grid-internal-token']).toBe('secret')
    expect(headersOf(init)['content-type']).toBe('application/json')
    expect(headersOf(init)['x-grid-organization-id']).toBe('org-1')
    expect(JSON.parse(init.body as string)).toMatchObject({ skills: ['data-table-analysis'] })
  })

  it('maps a 429 to SkippedError carrying Retry-After', async () => {
    fetchMock.mockResolvedValue(
      new Response('cap', { status: 429, headers: { 'retry-after': '13' } })
    )
    await expect(submitSkillJob(payload, {})).rejects.toBeInstanceOf(SkillSubmitSkippedError)
    await expect(submitSkillJob(payload, {})).rejects.toMatchObject({ retryAfterSeconds: 13 })
  })

  it('maps other failures and network errors to SubmitError', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))
    await expect(submitSkillJob(payload, {})).rejects.toBeInstanceOf(SkillSubmitError)
    fetchMock.mockRejectedValue(new TypeError('network down'))
    await expect(submitSkillJob(payload, {})).rejects.toMatchObject({ status: 503 })
  })
})