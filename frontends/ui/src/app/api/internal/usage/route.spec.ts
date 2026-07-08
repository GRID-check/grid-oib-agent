import { beforeEach, describe, expect, it, vi } from 'vitest'

// The route factory (`@/lib/api/handler`) statically imports the session
// guard, which pulls in authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/budgets/service', () => ({
  recordUsageEvents: vi.fn().mockResolvedValue(1),
}))

import { POST } from './route'
import { recordUsageEvents } from '@/lib/budgets/service'

const VALID_EVENT = {
  model: 'deepseek/deepseek-v4-flash',
  requestedModel: 'deepseek/deepseek-v4-flash',
  generationId: 'gen-abc123',
  promptTokens: 1204,
  completionTokens: 331,
  totalTokens: 1535,
  cachedTokens: 512,
  reasoningTokens: 128,
  costUsd: 0.00214,
  costSource: 'usage_field',
  isByok: false,
}

const request = (body: unknown, token: string | null = 'test-token'): Request =>
  new Request('http://localhost/api/internal/usage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-grid-internal-token': token } : {}),
    },
    body: JSON.stringify(body),
  })

describe('POST /api/internal/usage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    process.env.APP_ENV = 'development'
  })

  it('rejects when the token is missing or wrong', async () => {
    expect((await POST(request({ events: [VALID_EVENT] }, null))).status).toBe(403)
    expect((await POST(request({ events: [VALID_EVENT] }, 'wrong'))).status).toBe(403)
    expect(recordUsageEvents).not.toHaveBeenCalled()
  })

  it('fails closed when the token is unconfigured', async () => {
    delete process.env.GRID_INTERNAL_API_TOKEN
    expect((await POST(request({}, 'anything'))).status).toBe(503)
  })

  it('records a valid batch (the backend tracker payload shape)', async () => {
    const res = await POST(
      request({
        organizationId: 'org_1',
        userId: 'user_1',
        projectId: 'proj-1',
        conversationId: 'conv-1',
        jobId: null,
        events: [VALID_EVENT],
      }),
    )
    expect(res.status).toBe(202)
    expect(recordUsageEvents).toHaveBeenCalledTimes(1)
    const rows = vi.mocked(recordUsageEvents).mock.calls[0][0]
    expect(rows[0]).toMatchObject({
      organizationId: 'org_1',
      userId: 'user_1',
      model: 'deepseek/deepseek-v4-flash',
      generationId: 'gen-abc123',
      costUsd: '0.00214000',
      costSource: 'usage_field',
    })
  })

  it('skips events without an organization (anonymous mode)', async () => {
    const res = await POST(request({ organizationId: null, events: [VALID_EVENT] }))
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ recorded: 0, skipped: 1 })
    expect(recordUsageEvents).not.toHaveBeenCalled()
  })

  it('rejects malformed payloads', async () => {
    expect((await POST(request({ organizationId: 'org_1', events: [] }))).status).toBe(400)
    expect(
      (await POST(request({ organizationId: 'org_1', events: [{ ...VALID_EVENT, costUsd: -1 }] }))).status,
    ).toBe(400)
  })
})
