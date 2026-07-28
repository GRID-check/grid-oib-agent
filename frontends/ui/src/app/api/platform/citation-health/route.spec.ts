import { beforeEach, describe, expect, it, vi } from 'vitest'

const isOwner = { value: false }

vi.mock('@/lib/auth/session', () => ({
  getGridSession: vi.fn().mockResolvedValue({ userId: 'user_1', organizationId: 'org_1' }),
}))

vi.mock('@/lib/authz/platform', () => {
  // Defined inside the factory: vi.mock is hoisted above module-level classes.
  class PlatformAccessDeniedError extends Error {
    readonly status = 403
  }
  return {
    PlatformAccessDeniedError,
    requirePlatformOwner: vi.fn().mockImplementation(async () => {
      if (!isOwner.value) {
        throw new PlatformAccessDeniedError()
      }
    }),
  }
})

vi.mock('@/lib/citations/service', () => ({
  getCitationHealth: vi.fn().mockResolvedValue({
    windowDays: 30,
    totals: {
      turns: 100,
      defectTurns: 12,
      cleanTurns: 88,
      cleanRate: 0.88,
      citationsRemoved: 30,
      unverifiedQuotes: 4,
      ungroundedAnswers: 3,
      emptyRegistries: 1,
    },
    byKind: [{ kind: 'citations_removed', turns: 9, items: 30, share: 0.09 }],
    dailyTrend: [{ day: '2026-07-28', turns: 10, defectTurns: 2, byKind: { citations_removed: 2 } }],
    reasons: [{ kind: 'citations_removed', reason: 'url_not_in_registry', occurrences: 20, share: 0.66 }],
    sourceMix: [{ dimension: 'tool', label: 'ris_search_tool', turns: 7 }],
    organizations: [
      { organizationId: 'org_1', name: 'Tenant', turns: 100, defectTurns: 12, errorTurns: 1, defectRate: 0.12 },
    ],
    recent: [],
  }),
}))

import { GET } from './route'
import { getCitationHealth } from '@/lib/citations/service'

const request = (url = 'http://localhost/api/platform/citation-health'): Request => new Request(url)

describe('GET /api/platform/citation-health', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isOwner.value = false
  })

  it('rejects non-owners with 403', async () => {
    expect((await GET(request())).status).toBe(403)
    expect(getCitationHealth).not.toHaveBeenCalled()
  })

  it('returns the snapshot for the platform owner', async () => {
    isOwner.value = true
    const res = await GET(request())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totals.cleanRate).toBe(0.88)
    expect(body.organizations[0].name).toBe('Tenant')
    expect(body.reasons[0].reason).toBe('url_not_in_registry')
  })

  it('passes the requested window through to the service', async () => {
    isOwner.value = true
    await GET(request('http://localhost/api/platform/citation-health?days=7'))
    expect(getCitationHealth).toHaveBeenCalledWith({ days: 7 })
  })

  it('lets the service default the window when days is absent or junk', async () => {
    isOwner.value = true
    await GET(request())
    expect(getCitationHealth).toHaveBeenLastCalledWith({ days: undefined })

    await GET(request('http://localhost/api/platform/citation-health?days=abc'))
    expect(getCitationHealth).toHaveBeenLastCalledWith({ days: undefined })
  })
})
