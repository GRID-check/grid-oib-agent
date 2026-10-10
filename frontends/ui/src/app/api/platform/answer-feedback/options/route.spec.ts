/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const isOwner = { value: false }

vi.mock('server-only', () => ({}))

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    email: 'support@grid.com',
    role: 'member',
  }),
}))

vi.mock('@/lib/authz/platform', () => {
  class PlatformAccessDeniedError extends Error {}
  return {
    PlatformAccessDeniedError,
    requirePlatformPermission: vi.fn().mockImplementation(async () => {
      if (!isOwner.value) throw new PlatformAccessDeniedError()
    }),
  }
})

const OPTIONS = {
  total: 142,
  scopeTotal: 300,
  cap: 5000,
  overCap: false,
  verdicts: { up: 250, down: 50 },
  reasons: [{ key: 'inaccurate', votes: 30 }],
  topics: [{ key: 'brandschutz', votes: 42 }],
  modes: [],
  confidences: [],
  withComment: 12,
  withExpectedAnswer: 4,
}

// The reads are mocked; the gate runs as the real service runs it.
vi.mock('@/lib/feedback/export-service', () => ({
  getAnswerFeedbackFilterOptions: vi.fn().mockImplementation(async (session: unknown) => {
    const { requirePlatformPermission } = await import('@/lib/authz/platform')
    await requirePlatformPermission(session as never, 'platform:organizations:view')
    return OPTIONS
  }),
}))

import { GET } from './route'
import { getAnswerFeedbackFilterOptions } from '@/lib/feedback/export-service'

const request = (query = ''): Request => new Request(`http://localhost/api/platform/answer-feedback/options${query}`)

describe('GET /api/platform/answer-feedback/options', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isOwner.value = false
  })

  it('refuses anyone without the platform view permission with 403', async () => {
    expect((await GET(request())).status).toBe(403)
  })

  it('answers the count and the per-value counts for the page’s exact query, uncached', async () => {
    isOwner.value = true
    const res = await GET(request('?from=2026-10-01&to=2026-10-07&org=org_2&topic=statik&has_expected=1'))

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual(OPTIONS)
    expect(getAnswerFeedbackFilterOptions).toHaveBeenCalledWith(expect.anything(), {
      scope: { from: '2026-10-01', to: '2026-10-07', organizationIds: ['org_2'], projectIds: [] },
      ratings: expect.objectContaining({ topics: ['statik'], hasExpectedAnswer: true }),
    })
  })

  it('refuses a value the export would refuse, with the same 400', async () => {
    isOwner.value = true
    const res = await GET(request('?confidence=certain'))
    expect(res.status).toBe(400)
    expect(getAnswerFeedbackFilterOptions).not.toHaveBeenCalled()
  })
})
