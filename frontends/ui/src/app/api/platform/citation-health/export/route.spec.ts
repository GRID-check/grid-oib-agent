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
    requirePlatformPermission: vi.fn().mockImplementation(async () => {
      if (!isOwner.value) throw new PlatformAccessDeniedError()
    }),
  }
})

vi.mock('@/lib/citations/service', () => ({
  getCitationExport: vi.fn().mockResolvedValue({
    schema: 'grid.citation-health.export/v1',
    generatedAt: '2026-07-28T12:00:00.000Z',
    scope: { from: '2026-06-29', to: '2026-07-28', organizationIds: [], projectIds: [] },
    windowDays: 30,
    windowStart: '2026-06-29T00:00:00.000Z',
    windowEnd: '2026-07-29T00:00:00.000Z',
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

  it('names the file after the scope range, not the day it was generated', async () => {
    isOwner.value = true
    vi.mocked(getCitationExport).mockResolvedValueOnce({
      scope: { from: '2026-09-01', to: '2026-09-30', organizationIds: ['org_1'], projectIds: [] },
      turns: [],
    } as never)
    const res = await GET(request())
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="citation-health-2026-09-01-to-2026-09-30.json"'
    )
  })

  it('passes the same scope as the dashboard through to the export', async () => {
    isOwner.value = true
    await GET(
      request(
        'http://localhost/api/platform/citation-health/export?from=2026-09-01&to=2026-09-30&org=org_2&project=p_1&project=p_2'
      )
    )
    expect(getCitationExport).toHaveBeenLastCalledWith({
      from: '2026-09-01',
      to: '2026-09-30',
      organizationIds: ['org_2'],
      projectIds: ['p_1', 'p_2'],
    })
  })

  it('answers a bad range with 400 instead of exporting a different window', async () => {
    isOwner.value = true
    const res = await GET(
      request('http://localhost/api/platform/citation-health/export?from=2026-10-01&to=2026-09-01')
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ details: { scope: 'range_inverted' } })
    expect(getCitationExport).not.toHaveBeenCalled()
  })
})
