/**
 * @vitest-environment node
 */
/**
 * `GET /api/conversations/:id/frames`: what a dropped socket missed.
 *
 * The frames are the thread's answers, so the read is gated exactly as reading
 * the thread is, and it runs before anything touches the stream. The cursor is
 * validated, and the response carries the raw frames the socket would have
 * carried, because the client feeds them to its live frame handler.
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
vi.mock('@/lib/events/conversation-frames', () => ({ readConversationFramesAfter: vi.fn() }))

import { requireConversationSpectator } from '@/lib/conversations/live'
import { readConversationFramesAfter } from '@/lib/events/conversation-frames'
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

  it('returns the raw frames after the cursor', async () => {
    vi.mocked(readConversationFramesAfter).mockResolvedValue([
      { id: '2-0', payload: { type: 'system_response_message', grid_frame_id: '2-0' } },
    ])

    const res = await get('?after=1-0')

    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(await res.json()).toEqual({
      frames: [{ type: 'system_response_message', grid_frame_id: '2-0' }],
    })
    expect(readConversationFramesAfter).toHaveBeenCalledWith('conv_1', '1-0')
  })

  it('says there is nothing to resume from with null, not an error', async () => {
    vi.mocked(readConversationFramesAfter).mockResolvedValue(null)
    const res = await get()
    expect(await res.json()).toEqual({ frames: null })
    expect(readConversationFramesAfter).toHaveBeenCalledWith('conv_1', null)
  })

  it('refuses a cursor that is not a stream entry id', async () => {
    const res = await get('?after=%2B')
    expect(res.status).toBe(400)
    expect(readConversationFramesAfter).not.toHaveBeenCalled()
  })

  it('reads nothing for a thread the reader may not see', async () => {
    vi.mocked(requireConversationSpectator).mockRejectedValueOnce(new NotFoundError('Conversation'))
    const res = await get('?after=1-0')
    expect(res.status).toBe(404)
    expect(readConversationFramesAfter).not.toHaveBeenCalled()
  })
})
