/**
 * @vitest-environment node
 */
/**
 * Discarding a conversation's drafts on the Python tier.
 *
 * The working directory lives in the agent service's own LangGraph store
 * (ADR-0003 puts it on the other side of a boundary no cascade reaches), so
 * `deleteConversation` erasing every row it owns leaves those namespaces
 * standing forever, holding whatever the model had written into them.
 *
 * Two things are asserted, and the second is the more important: the call is
 * made, and it can NEVER stop the deletion. A person who asked to be rid of a
 * chat must not be left with it because a service was down.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/backend-proxy', () => ({ getBackendUrl: () => 'http://backend:8000' }))

import { discardConversationDrafts } from './working-directory'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  process.env.GRID_INTERNAL_API_TOKEN = 'test-token'
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('discardConversationDrafts', () => {
  it('DELETEs the conversation’s drafts with the internal service token', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 })

    await expect(discardConversationDrafts('s_conv 1')).resolves.toBe(true)

    const [url, init] = fetchMock.mock.calls[0]
    // Encoded: a conversation id is a client-generated string and goes into a
    // path segment.
    expect(url).toBe('http://backend:8000/v1/drafts/s_conv%201')
    expect(init.method).toBe('DELETE')
    expect(init.headers['x-grid-internal-token']).toBe('test-token')
    expect(init.signal).toBeDefined()
  })

  it('reads a 404 as success, because most conversations never wrote a draft', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 })
    await expect(discardConversationDrafts('s_conv_1')).resolves.toBe(true)
  })

  it('reports a refusal without throwing', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 })
    await expect(discardConversationDrafts('s_conv_1')).resolves.toBe(false)
  })

  it('never throws when the service is unreachable', async () => {
    // The conversation is already gone by the time this runs, and a working
    // directory is addressable by the conversation id alone — so a failure here
    // costs a sweep, never the delete.
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(discardConversationDrafts('s_conv_1')).resolves.toBe(false)
  })

  it('does not call an unauthenticated DELETE when the token is unconfigured', async () => {
    delete process.env.GRID_INTERNAL_API_TOKEN
    await expect(discardConversationDrafts('s_conv_1')).resolves.toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
