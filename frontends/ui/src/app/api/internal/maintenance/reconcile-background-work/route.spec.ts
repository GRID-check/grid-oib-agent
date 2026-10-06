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

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('POST /api/internal/maintenance/reconcile-background-work', () => {
  it('runs both halves with a valid token and answers with both counts', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', TOKEN)
    recoverStuckProcessing.mockResolvedValueOnce(DOCUMENTS)
    recoverStuckFilings.mockResolvedValueOnce(FILINGS)

    const response = await post(TOKEN)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ documents: DOCUMENTS, filings: FILINGS })
  })

  it('still runs the other half when one throws, then answers with the failure', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', TOKEN)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    recoverStuckProcessing.mockRejectedValueOnce(new Error('database gone'))
    recoverStuckFilings.mockResolvedValueOnce(FILINGS)

    const response = await post(TOKEN)

    expect(recoverStuckFilings).toHaveBeenCalledTimes(1)
    expect(response.status).toBeGreaterThanOrEqual(500)
  })

  it('refuses a wrong or missing token before touching anything (403)', async () => {
    vi.stubEnv('GRID_INTERNAL_API_TOKEN', TOKEN)

    expect((await post('wrong')).status).toBe(403)
    expect((await post()).status).toBe(403)
    expect(recoverStuckProcessing).not.toHaveBeenCalled()
    expect(recoverStuckFilings).not.toHaveBeenCalled()
  })
})
