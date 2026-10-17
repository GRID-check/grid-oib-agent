/**
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

// The route factory statically imports the session guard, which pulls in
// authkit; internal routes never call it.
vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn() }))

const recoverStuckProcessing = vi.fn()
vi.mock('@/lib/documents/stuck-processing', () => ({ recoverStuckProcessing: () => recoverStuckProcessing() }))
const recoverStuckFilings = vi.fn()
vi.mock('@/lib/tasks/filing-sweep', () => ({ recoverStuckFilings: () => recoverStuckFilings() }))
const sweepStaleMailImports = vi.fn()
vi.mock('@/lib/mail-import/job', () => ({ sweepStaleMailImports: () => sweepStaleMailImports() }))
const sweepInboundMail = vi.fn()
vi.mock('@/lib/inbound-mail/job', () => ({ sweepInboundMail: () => sweepInboundMail() }))

import { POST } from './route'

const TOKEN = 'a-real-secret-token'

const post = (token?: string) =>
  POST(
    new Request('https://grid.test/api/internal/maintenance/reconcile-background-work', {
      method: 'POST',
      headers: { ...(token ? { 'x-grid-internal-token': token } : {}) },
    })
  )

const DOCUMENTS = { checked: 2, requeued: 1, failed: 1, gone: 0, errors: 0 }
const FILINGS = { checked: 1, filed: 0, failed: 1, waiting: 0, errors: 0 }
const MAIL_IMPORTS = { checked: 1, aborted: 0, requeued: 1, failed: 0, waiting: 0, errors: 0 }
const INBOUND_MAIL = { requeued: 1, waiting: 2, failed: 0, stagingExpired: 0, deleted: 3, errors: 0 }

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('POST /api/internal/maintenance/reconcile-background-work', () => {
  it('runs every part with a valid token and answers with each count', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', TOKEN)
    recoverStuckProcessing.mockResolvedValueOnce(DOCUMENTS)
    recoverStuckFilings.mockResolvedValueOnce(FILINGS)
    sweepStaleMailImports.mockResolvedValueOnce(MAIL_IMPORTS)
    sweepInboundMail.mockResolvedValueOnce(INBOUND_MAIL)

    const response = await post(TOKEN)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      documents: DOCUMENTS,
      filings: FILINGS,
      mailImports: MAIL_IMPORTS,
      inboundMail: INBOUND_MAIL,
    })
  })

  it('still runs the other parts when one throws, then answers with the failure', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', TOKEN)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    recoverStuckProcessing.mockRejectedValueOnce(new Error('database gone'))
    recoverStuckFilings.mockResolvedValueOnce(FILINGS)
    sweepStaleMailImports.mockResolvedValueOnce(MAIL_IMPORTS)
    sweepInboundMail.mockResolvedValueOnce(INBOUND_MAIL)

    const response = await post(TOKEN)

    expect(recoverStuckFilings).toHaveBeenCalledTimes(1)
    expect(sweepStaleMailImports).toHaveBeenCalledTimes(1)
    expect(sweepInboundMail).toHaveBeenCalledTimes(1)
    expect(response.status).toBeGreaterThanOrEqual(500)
  })

  it('refuses a wrong or missing token before touching anything (403)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', TOKEN)

    expect((await post('wrong')).status).toBe(403)
    expect((await post()).status).toBe(403)
    expect(recoverStuckProcessing).not.toHaveBeenCalled()
    expect(recoverStuckFilings).not.toHaveBeenCalled()
    expect(sweepInboundMail).not.toHaveBeenCalled()
  })
})
