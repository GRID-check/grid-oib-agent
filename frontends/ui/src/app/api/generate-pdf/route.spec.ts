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

const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  POST(
    new Request('https://grid.test/api/generate-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
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

/**
 * The bound that the Pages Router applied for free, and that the move to the App
 * Router silently removed.
 *
 * `git show f90dad67^:frontends/ui/src/pages/api/generate-pdf.ts` declares no
 * `config`, so Next's `api.bodyParser.sizeLimit` default of 1mb bounded every
 * request to it. App Router handlers have no such default —
 * `serverActions.bodySizeLimit` governs Server Actions only — so the schema's
 * `z.string().min(1)` was the entire distance between a signed-in caller and
 * `renderToStream`. Rendering is superlinear in the markdown's length: 64 KiB
 * takes ~11 s here, 128 KiB ~61 s, and the 2 MB body that found this had not
 * finished after ten minutes, at 300 permitted mutations per member per minute.
 */
describe('the body bounds', () => {
  it('refuses markdown past the render bound, and renders nothing for it', async () => {
    const response = await post({ markdown: 'x'.repeat(64 * 1024 + 1) })

    expect(response.status).toBe(400)
    expect(response.headers.get('Content-Type')).not.toBe('application/pdf')
  })

  it('still renders markdown at the bound, so the limit is not a ban', async () => {
    // The pair is the test: only the refusal above would also pass with the
    // limit set to one character, and a route that renders nothing is not a
    // route. Kept just under the bound so this stays a test of the limit rather
    // than of how long CI will wait.
    const response = await post({ markdown: '# T\n\n' + 'wort '.repeat(2_000) })

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
  }, 60_000)

  it('refuses a body that declares itself too large, before reading it', async () => {
    // `Content-Length` is a claim, and refusing on it is the only check that
    // runs before the bytes are buffered. 1 MiB is the Pages default this route
    // used to inherit, restated where it can be read.
    const response = await post({ markdown: '# Bericht' }, { 'content-length': String(2 * 1024 * 1024) })

    expect(response.status).toBe(413)
  })
})
