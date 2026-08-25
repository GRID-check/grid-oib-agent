/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const isOwner = { value: false }

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    email: 'owner@grid.com',
    role: 'admin',
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

vi.mock('@/lib/feedback/service', () => ({
  getAnswerFeedbackHealth: vi.fn().mockImplementation(async (session: unknown) => {
    const { requirePlatformPermission } = await import('@/lib/authz/platform')
    await requirePlatformPermission(session as never, 'platform:organizations:view')
    return {
      turns: [
        {
          createdAt: new Date('2026-07-30T09:00:00.000Z'),
          organizationId: 'org_2',
          conversationId: 'c-1',
          messageId: 'm-1',
          verdict: 'up',
          reason: null,
          topics: ['brandschutz', 'energie'],
          question: 'Welcher U-Wert gilt für Außenwände, und warum?',
          answer: 'Höchstens 0,35 W/(m²·K).',
        },
      ],
    }
  }),
}))

import { GET } from './route'
import { getAnswerFeedbackHealth } from '@/lib/feedback/service'

const request = (query = ''): Request =>
  new Request(`http://localhost/api/platform/answer-feedback/export${query}`)

describe('GET /api/platform/answer-feedback/export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isOwner.value = false
  })

  it('refuses a non-owner with 403', async () => {
    expect((await GET(request())).status).toBe(403)
  })

  it('reads with the SAME filters the page uses', async () => {
    isOwner.value = true
    await GET(request('?days=7&verdict=up&topic=brandschutz&org=org_2'))

    // An export that quietly disagreed with the view it was taken from would be
    // worse than no export.
    expect(getAnswerFeedbackHealth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        windowDays: 7,
        verdict: 'up',
        topic: 'brandschutz',
        organizationId: 'org_2',
      })
    )
  })

  /**
   * The drill-in now runs in both directions, so a file of praise and a file of
   * failures are otherwise one download folder away from being indistinguishable.
   */
  it('names the direction in the filename and carries it as a column', async () => {
    isOwner.value = true
    const res = await GET(request('?verdict=up'))
    const body = await res.text()

    expect(res.headers.get('Content-Disposition')).toContain('answer-feedback-up-')
    expect(body.split('\n')[0]).toContain('verdict')
    expect(body).toContain('"up"')
    expect(body).toContain('"brandschutz energie"')
  })

  it('quotes every cell, so a comma in a question cannot shift a column', async () => {
    isOwner.value = true
    const res = await GET(request())
    // `.text()` strips a leading BOM per the fetch spec, so the bytes are read
    // directly — the BOM is the thing under test and is invisible to `.text()`.
    const bytes = new Uint8Array(await res.arrayBuffer())

    expect(new TextDecoder().decode(bytes)).toContain(
      '"Welcher U-Wert gilt für Außenwände, und warum?"'
    )
    // A BOM, so Excel opens the umlauts as umlauts.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })
})
