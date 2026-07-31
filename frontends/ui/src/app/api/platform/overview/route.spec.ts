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

vi.mock('@/lib/platform/service', () => ({
  getPlatformOverview: vi.fn().mockResolvedValue({
    organizations: [
      {
        id: 'org_1',
        name: 'Tenant',
        createdAt: '2026-07-01T00:00:00Z',
        isPlatformOrg: false,
        projectCount: 3,
        dayUsd: 0.5,
        monthUsd: 4.2,
        monthEvents: 120,
      },
    ],
    dailyTrend: [{ day: '2026-07-08', usd: 0.5, events: 12 }],
    totals: { organizations: 1, projects: 3, dayUsd: 0.5, monthUsd: 4.2, monthEvents: 120 },
  }),
}))

vi.mock('@/lib/budgets/service', () => ({
  eurPerUsd: () => 0.86,
}))

import { GET } from './route'

describe('GET /api/platform/overview', () => {
  beforeEach(() => {
    isOwner.value = false
  })

  it('rejects non-owners with 403', async () => {
    expect((await GET(new Request('http://localhost/api/platform'))).status).toBe(403)
  })

  it('returns the overview for the platform owner', async () => {
    isOwner.value = true
    const res = await GET(new Request('http://localhost/api/platform'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totals.organizations).toBe(1)
    expect(body.organizations[0].name).toBe('Tenant')
    expect(body.dailyTrend).toEqual([{ day: '2026-07-08', usd: 0.5, events: 12 }])
    expect(body.eurPerUsd).toBe(0.86)
  })
})
