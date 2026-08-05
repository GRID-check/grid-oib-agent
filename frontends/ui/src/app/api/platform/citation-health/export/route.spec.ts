/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const isOwner = { value: false }

vi.mock('@/lib/auth/session', () => ({
  getGridSession: vi.fn().mockResolvedValue({ userId: 'user_1', organizationId: 'org_1' }),
}))

vi.mock('@/lib/authz/platform', () => {
  class PlatformAccessDeniedError extends Error {
    readonly status = 403
  }
  return {
    PlatformAccessDeniedError,
    requirePlatformOwner: vi.fn().mockImplementation(async () => {
      if (!isOwner.value) throw new PlatformAccessDeniedError()
    }),
  }
})

vi.mock('@/lib/citations/service', () => ({
  getCitationExport: vi.fn().mockResolvedValue({
    schema: 'grid.citation-health.export/v1',
    generatedAt: '2026-07-28T12:00:00.000Z',
    windowDays: 30,
    windowStart: '2026-06-29T00:00:00.000Z',
    truncated: false,
    glossary: { answer_ungrounded: 'explained' },
    summary: { turns: 10, findings: [] },
    turns: [{ turnId: 'turn_1', problems: [{ kind: 'citations_removed' }] }],
  }),
}))

import { GET } from './route'
import { getCitationExport } from '@/lib/citations/service'

const request = (url = 'http://localhost/api/platform/citation-health/export'): Request =>
  new Request(url)

describe('GET /api/platform/citation-health/export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isOwner.value = false
  })

  it('rejects non-owners with 403 and never builds the bundle', async () => {
    expect((await GET(request())).status).toBe(403)
    expect(getCitationExport).not.toHaveBeenCalled()
  })

  it('serves the bundle as a downloadable, uncached JSON file', async () => {
    isOwner.value = true
    const res = await GET(request())

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="citation-health-2026-06-29-to-2026-07-28.json"'
    )

    const body = await res.json()
    expect(body.schema).toBe('grid.citation-health.export/v1')
    expect(body.turns[0].turnId).toBe('turn_1')
  })

  it('takes the default window for every non-window value', async () => {
    isOwner.value = true
    // Blank and non-positive must mean "unspecified" — Number('') and
    // Number(null) are both 0, which would otherwise clamp to a 1-DAY window
    // and silently show the operator a near-empty dashboard.
    for (const query of ['', '?days=', '?days=abc', '?days=0', '?days=-5']) {
      await GET(request(`http://localhost/api/platform/citation-health/export${query}`))
      expect(getCitationExport).toHaveBeenLastCalledWith({ days: undefined })
    }
  })

  it('passes a valid window through untouched', async () => {
    isOwner.value = true
    await GET(request('http://localhost/api/platform/citation-health/export?days=7'))
    expect(getCitationExport).toHaveBeenLastCalledWith({ days: 7 })
  })
})
