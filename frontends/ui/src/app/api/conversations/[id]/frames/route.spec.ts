/**
 * @vitest-environment node
 */
/**
 * `GET /api/conversations/:id/frames`: the socket-less liveness probe, and
 * nothing else.
 *
 * Whether a thread is answering is a fact about the thread, so the probe is
 * gated exactly as reading the thread is, and the gate runs before the stream
 * is touched. Resume moved to the socket's `attach` (chat wire v2 §d): a
 * request for frames is refused, not served.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/require-auth', () => ({
  requireAuthorizedSession: vi.fn().mockResolvedValue({
    userId: 'user_1',
    organizationId: 'org_1',
    role: 'member',
    permissions: [],
  }),
  authzErrorResponse: () => null,
}))
vi.mock('@/lib/conversations/live', () => ({ requireConversationSpectator: vi.fn() }))
vi.mock('@/lib/events/conversation-frames', () => ({ peekNewestConversationFrame: vi.fn() }))

import { requireConversationSpectator } from '@/lib/conversations/live'
import { peekNewestConversationFrame } from '@/lib/events/conversation-frames'
import { NotFoundError } from '@/lib/api/errors'
import { GET } from './route'

const get = (query = '') =>
  GET(new Request(`http://localhost/api/conversations/conv_1/frames${query}`), {
    params: Promise.resolve({ id: 'conv_1' }),
  })

describe('GET /api/conversations/:id/frames', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('peeks at the newest frame with the server clock', async () => {
    vi.mocked(peekNewestConversationFrame).mockResolvedValue('1727000000000-0')
    const res = await get('?peek=1')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const body = await res.json()
    expect(body).toMatchObject({ available: true, newest: '1727000000000-0' })
    expect(typeof body.now).toBe('number')
    expect(peekNewestConversationFrame).toHaveBeenCalledWith('conv_1')
  })

  it('says an empty stream holds nothing, and a missing one has nothing to ask', async () => {
    vi.mocked(peekNewestConversationFrame).mockResolvedValueOnce(null)
    expect(await (await get('?peek=1')).json()).toMatchObject({ available: true, newest: null })
    vi.mocked(peekNewestConversationFrame).mockResolvedValueOnce(undefined)
    expect(await (await get('?peek=1')).json()).toMatchObject({ available: false, newest: null })
  })

  it('serves no frames: resume is attach on the socket', async () => {
    for (const query of ['', '?after=1-0']) {
      const res = await get(query)
      expect(res.status).toBe(400)
    }
    expect(peekNewestConversationFrame).not.toHaveBeenCalled()
  })

  it('reads nothing for a thread the reader may not see', async () => {
    vi.mocked(requireConversationSpectator).mockRejectedValueOnce(new NotFoundError('Conversation'))
    const res = await get('?peek=1')
    expect(res.status).toBe(404)
    expect(peekNewestConversationFrame).not.toHaveBeenCalled()
  })
})
