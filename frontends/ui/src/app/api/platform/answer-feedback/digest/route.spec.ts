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
    requirePlatformOwner: vi.fn().mockImplementation(async () => {
      if (!isOwner.value) throw new PlatformAccessDeniedError()
    }),
  }
})

vi.mock('@/lib/feedback/service', () => ({
  getAnswerFeedbackDigest: vi.fn().mockImplementation(async (session: unknown) => {
    // The real service gates before it reads; mirrored here so the 403 test is
    // testing the route's translation of a refusal, not a mock that never refuses.
    const { requirePlatformOwner } = await import('@/lib/authz/platform')
    await requirePlatformOwner(session as never)
    return { digest: { headline: 'Fine.' }, error: null }
  }),
}))

import { GET } from './route'
import { getAnswerFeedbackDigest } from '@/lib/feedback/service'

const request = (query = ''): Request =>
  new Request(`http://localhost/api/platform/answer-feedback/digest${query}`)

describe('GET /api/platform/answer-feedback/digest', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isOwner.value = false
  })

  it('refuses a non-owner with 403', async () => {
    expect((await GET(request())).status).toBe(403)
  })

  it('passes the window, the aggregate filters and the locale through', async () => {
    isOwner.value = true
    await GET(request('?days=7&org=org_2&topic=brandschutz&locale=en'))

    expect(getAnswerFeedbackDigest).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ windowDays: 7, organizationId: 'org_2', topic: 'brandschutz' }),
      { locale: 'en', refresh: false },
    )
  })

  it('forwards an explicit refresh so the button can bypass the cache', async () => {
    isOwner.value = true
    await GET(request('?refresh=1'))

    expect(getAnswerFeedbackDigest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ refresh: true }),
    )
  })

  /**
   * A young window is not an error. Answering 4xx would send the client down the
   * "something is broken" path for the ordinary state of a product that has just
   * started collecting votes.
   */
  it('answers 200 with a reason when there is no digest to give', async () => {
    isOwner.value = true
    vi.mocked(getAnswerFeedbackDigest).mockResolvedValueOnce({
      digest: null,
      error: 'too_few_votes',
    })

    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ digest: null, error: 'too_few_votes' })
  })

  it('is never cached by the browser, so refresh means refresh', async () => {
    isOwner.value = true
    expect((await GET(request())).headers.get('Cache-Control')).toBe('no-store')
  })
})
