/**
 * @vitest-environment node
 *
 * The markdown → PDF route, and the hole it was moved out of.
 *
 * This endpoint used to live at `src/pages/api/generate-pdf.ts` and had **no
 * session check of any kind**: it read `req.body.markdown` and rendered it for
 * anyone who could reach the origin. `app/api/authz-coverage.spec.ts` did not
 * catch it because it walks `app/api/**\/route.ts` — a Pages-Router handler was
 * outside the compiler's reach AND outside the inventory. The route was not
 * exempted from the posture rule; it was invisible to it.
 *
 * So the first test here is the one that would have failed then, and the point
 * of the move is that it can be written at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const requireAuthorizedSession = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: () => requireAuthorizedSession(),
}))
vi.mock('server-only', () => ({}))

import { createInProcessStore, setLimitStore } from '@/lib/limits'
import { readPdf } from '@/test-utils/read-pdf'
import { POST } from './route'

let orgCounter = 0
const session = () => ({
  userId: 'user_me',
  organizationId: `org_${++orgCounter}`,
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
})

const post = (body: unknown): Promise<Response> =>
  POST(
    new Request('https://grid.test/api/generate-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  )

beforeEach(() => {
  setLimitStore(createInProcessStore())
  requireAuthorizedSession.mockReset().mockResolvedValue(session())
})

afterEach(() => {
  setLimitStore(null)
})

describe('POST /api/generate-pdf', () => {
  it('refuses a caller with no session, and renders nothing for them', async () => {
    requireAuthorizedSession.mockRejectedValue(new Error('Unauthorized'))

    const response = await post({ markdown: '# Anything' })

    expect(response.status).toBe(403)
    expect(response.headers.get('Content-Type')).not.toBe('application/pdf')
  })

  it('serves a signed-in caller a PDF that a parser can open', async () => {
    const response = await post({ markdown: '# Bericht\n\nEin Absatz.' })

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    // An inline PDF is not a download; the browser would render it in the tab
    // and the user's click would appear to do nothing.
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="report.pdf"'
    )

    const pdf = await readPdf(new Uint8Array(await response.arrayBuffer()))
    expect(pdf.text).toContain('Ein Absatz.')
  })

  /**
   * The default path, asserted at the route rather than only in the renderer:
   * this is a person downloading prose they have read on screen, and stamping
   * it „KI-generiert" would make the marking mean nothing on the documents that
   * need it. The one caller that DOES mark is `lib/documents/research-report`.
   */
  it('marks nothing — this is a human exporting what they are reading', async () => {
    const response = await post({ markdown: '# Bericht\n\nEin Absatz.' })
    const pdf = await readPdf(new Uint8Array(await response.arrayBuffer()))

    expect(pdf.info.Keywords).toBeUndefined()
    expect(pdf.info.Creator).toBe('react-pdf')
  })

  it('rejects a body with no markdown instead of serving a blank page', async () => {
    expect((await post({})).status).toBe(400)
    expect((await post({ markdown: '' })).status).toBe(400)
    expect((await post({ markdown: 42 })).status).toBe(400)
  })
})
