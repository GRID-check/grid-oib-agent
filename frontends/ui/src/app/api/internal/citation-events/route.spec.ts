/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The route factory (`@/lib/api/handler`) statically imports the session
// guard, which pulls in authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn(),
}))

vi.mock('@/lib/citations/service', () => ({
  recordCitationEvents: vi.fn().mockResolvedValue(2),
}))

import { POST } from './route'
import { recordCitationEvents } from '@/lib/citations/service'

/** The exact shape `citation_events.py` posts for a defective research turn. */
const VALID_BATCH = {
  organizationId: 'org_1',
  conversationId: 'conv_1',
  turnId: 'turn-abc',
  jobId: null,
  agent: 'shallow',
  events: [
    {
      kind: 'turn_verified',
      severity: 'ok',
      count: 1,
      reasons: null,
      detail: { source_count: 4, cited_count: 1, origins: { kb: 3, ris: 1 } },
    },
    {
      kind: 'citations_removed',
      severity: 'warn',
      count: 2,
      reasons: { url_not_in_registry: 2 },
      detail: null,
    },
  ],
}

const request = (body: unknown, token: string | null = 'test-token'): Request =>
  new Request('http://localhost/api/internal/citation-events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-grid-internal-token': token } : {}),
    },
    body: JSON.stringify(body),
  })

describe('POST /api/internal/citation-events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
    process.env.APP_ENV = 'development'
  })

  it('rejects when the token is missing or wrong', async () => {
    expect((await POST(request(VALID_BATCH, null))).status).toBe(403)
    expect((await POST(request(VALID_BATCH, 'wrong'))).status).toBe(403)
    expect(recordCitationEvents).not.toHaveBeenCalled()
  })

  it('fails closed when the token is unconfigured', async () => {
    delete process.env.GRID_INTERNAL_API_TOKEN
    expect((await POST(request(VALID_BATCH, 'anything'))).status).toBe(503)
  })

  it('records a valid batch, flattening it into one row per event', async () => {
    const res = await POST(request(VALID_BATCH))
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ recorded: 2 })

    const rows = vi.mocked(recordCitationEvents).mock.calls[0][0]
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      organizationId: 'org_1',
      conversationId: 'conv_1',
      turnId: 'turn-abc',
      agent: 'shallow',
      kind: 'turn_verified',
      severity: 'ok',
      count: 1,
      reasons: null,
    })
    expect(rows[1]).toMatchObject({
      kind: 'citations_removed',
      count: 2,
      reasons: { url_not_in_registry: 2 },
    })
  })

  it('accepts an anonymous turn (no org / conversation / job)', async () => {
    const res = await POST(
      request({
        turnId: 'turn-1',
        agent: 'deep',
        events: [{ kind: 'registry_empty', severity: 'error' }],
      })
    )
    expect(res.status).toBe(202)
    const rows = vi.mocked(recordCitationEvents).mock.calls[0][0]
    expect(rows[0]).toMatchObject({
      organizationId: null,
      conversationId: null,
      jobId: null,
      count: 1,
    })
  })

  it('rejects unknown kinds, severities and agents', async () => {
    const cases = [
      { turnId: 't', agent: 'shallow', events: [{ kind: 'made_up', severity: 'warn' }] },
      {
        turnId: 't',
        agent: 'shallow',
        events: [{ kind: 'turn_verified', severity: 'catastrophic' }],
      },
      { turnId: 't', agent: 'medium', events: [{ kind: 'turn_verified', severity: 'ok' }] },
    ]
    for (const body of cases) {
      expect((await POST(request(body))).status).toBe(400)
    }
    expect(recordCitationEvents).not.toHaveBeenCalled()
  })

  it('rejects an empty or oversized batch', async () => {
    expect((await POST(request({ turnId: 't', agent: 'shallow', events: [] }))).status).toBe(400)
    const oversized = Array.from({ length: 51 }, () => ({ kind: 'turn_verified', severity: 'ok' }))
    expect((await POST(request({ turnId: 't', agent: 'shallow', events: oversized }))).status).toBe(
      400
    )
  })
})
