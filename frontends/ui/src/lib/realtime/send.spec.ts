/**
 * @vitest-environment node
 */
/**
 * Sending in a live channel: who a message is from is the session's word,
 * never the client's; sending is reading the document; a grant is remembered
 * only as long as a stream re-checks; and the channel's rate limit is spent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))

import { z } from 'zod'
import { BadRequestError, NotFoundError, TooManyRequestsError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getAccessibleDocument } from '@/lib/documents/access'
import { createInProcessStore, ROOM_CLAIM_LIMIT, ROOM_LIMIT, setLimitStore } from '@/lib/limits'
import { __resetGrantsForTests, defineChannel, forgetSendGrant, type AnyChannel } from './channel'
import { __setHubTransportForTests, subscribe } from './hub'
import { CHANNELS } from './registry'
import { sendToChannel } from './send'
import { upstreamBaseSchema } from './types'

const SESSION = {
  userId: 'user_1',
  organizationId: 'org_1',
  email: 'a@grid.test',
  name: 'Anna Berger',
} as Partial<AuthorizedSession> as AuthorizedSession

function listen(topic: string) {
  const heard: unknown[] = []
  const release = subscribe(topic, (payload) => heard.push(payload))
  return { heard, release }
}

beforeEach(async () => {
  vi.clearAllMocks()
  __resetGrantsForTests()
  setLimitStore(createInProcessStore())
  await __setHubTransportForTests(null)
  vi.mocked(getAccessibleDocument).mockResolvedValue({} as never)
})

describe('sendToChannel, the document room', () => {
  it('stamps who said it from the session, and relays presence, pointer with its draft and chat, and view', async () => {
    const room = listen('rt:doc:doc_1')

    await sendToChannel(SESSION, {
      ch: 'doc:doc_1',
      msg: {
        peerId: 'peer_abcdef12',
        presence: 'here',
        cursor: { page: 2, x: 0.25, y: 0.5 },
        tool: 'region',
        draft: { x: 0.2, y: 0.4, w: 0.05, h: 0.1 },
        chat: '  Hier fehlt die Kote ',
        viewport: { page: 2, y: 0.4 },
      },
    })
    room.release()

    const peer = { peerId: 'peer_abcdef12', userId: 'user_1', name: 'Anna Berger', kind: 'person' }
    expect(room.heard).toEqual([
      { kind: 'presence', peer, state: 'here', ttlMs: 25_000 },
      {
        kind: 'cursor',
        peer,
        cursor: { page: 2, x: 0.25, y: 0.5 },
        tool: 'region',
        draft: { x: 0.2, y: 0.4, w: 0.05, h: 0.1 },
        chat: 'Hier fehlt die Kote',
      },
      { kind: 'viewport', peer, viewport: { page: 2, y: 0.4 } },
    ])
  })

  it('refuses a message that names who it is from, and a chat longer than a line', async () => {
    const forged = { peerId: 'peer_abcdef12', presence: 'here', userId: 'user_ceo', name: 'Chefin' }
    await expect(sendToChannel(SESSION, { ch: 'doc:doc_1', msg: forged })).rejects.toBeInstanceOf(BadRequestError)
    const long = { peerId: 'peer_abcdef12', cursor: null, chat: 'x'.repeat(141) }
    await expect(sendToChannel(SESSION, { ch: 'doc:doc_1', msg: long })).rejects.toBeInstanceOf(BadRequestError)
  })

  it('drops a draft when the pointer leaves the pages', async () => {
    const room = listen('rt:doc:doc_1')
    await sendToChannel(SESSION, {
      ch: 'doc:doc_1',
      msg: { peerId: 'peer_abcdef12', cursor: null, draft: { x: 0.2, y: 0.4, w: 0.05, h: 0.1 } },
    })
    room.release()
    expect(room.heard).toEqual([expect.objectContaining({ kind: 'cursor', cursor: null, draft: null })])
  })

  it('is refused, and relays nothing, for a reader who cannot read the document', async () => {
    vi.mocked(getAccessibleDocument).mockRejectedValue(new NotFoundError())
    const room = listen('rt:doc:doc_1')

    await expect(
      sendToChannel(SESSION, { ch: 'doc:doc_1', msg: { peerId: 'peer_abcdef12', presence: 'here' } })
    ).rejects.toBeInstanceOf(NotFoundError)
    room.release()
    expect(room.heard).toEqual([])
  })

  it('refuses a channel that does not exist or takes no messages', async () => {
    await expect(sendToChannel(SESSION, { ch: 'nope:x', msg: {} })).rejects.toBeInstanceOf(BadRequestError)
  })

  it('remembers a grant for the pointer stream, per person and per document, until it is forgotten', async () => {
    const say = (session: AuthorizedSession, ch: string) =>
      sendToChannel(session, { ch, msg: { peerId: 'peer_abcdef12', presence: 'here' } })
    await say(SESSION, 'doc:doc_1')
    await say(SESSION, 'doc:doc_1')
    expect(getAccessibleDocument).toHaveBeenCalledTimes(1)

    await say({ ...SESSION, userId: 'user_2' }, 'doc:doc_1')
    await say(SESSION, 'doc:doc_2')
    expect(getAccessibleDocument).toHaveBeenCalledTimes(3)

    vi.mocked(getAccessibleDocument).mockRejectedValue(new NotFoundError())
    forgetSendGrant(SESSION, 'doc:doc_1')
    await expect(say(SESSION, 'doc:doc_1')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('sendToChannel, the limit', () => {
  const tight = defineChannel({
    kind: 'test',
    parse: (id) => ({ id }),
    topics: ({ id }) => [`rt:test:${id}`],
    authorize: async () => {},
    reauthorizeMs: 30_000,
    events: z.object({ kind: z.string() }),
    presence: { ttlMs: 25_000, refreshMs: 10_000 },
    upstream: {
      schema: upstreamBaseSchema,
      limit: { name: 'test-channel', limit: 2, windowMs: 60_000 },
      handle: () => [],
    },
  }) as AnyChannel
  const channels = { ...CHANNELS, test: tight }

  it('spends the channel’s own limit per member and channel, and refuses past it', async () => {
    const say = (ch = 'test:a') =>
      sendToChannel(SESSION, { ch, msg: { peerId: 'peer_abcdef12', presence: 'here' } }, channels)
    await say()
    await say()
    await expect(say()).rejects.toBeInstanceOf(TooManyRequestsError)
    await expect(
      sendToChannel({ ...SESSION, userId: 'user_2' }, { ch: 'test:a', msg: { peerId: 'peer_abcdef12' } }, channels)
    ).resolves.toBeNull()
    // The same person in a second document (another tab) has a budget of its own.
    await expect(say('test:b')).resolves.toBeNull()
  })

  it('takes a claim from its own budget, so motion past its limit never refuses presence or the selection', async () => {
    const claiming = defineChannel({
      ...tight,
      kind: 'claiming',
      upstream: {
        ...tight.upstream!,
        limit: { name: 'test-motion', limit: 2, windowMs: 60_000 },
        claims: { limit: { name: 'test-claim', limit: 3, windowMs: 60_000 }, fields: ['selected'] },
      },
    }) as AnyChannel
    const send = (msg: Record<string, unknown>) =>
      sendToChannel(SESSION, { ch: 'claiming:a', msg: { peerId: 'peer_abcdef12', ...msg } }, { claiming })
    await send({ cursor: 1 })
    await send({ cursor: 2 })
    await expect(send({ cursor: 3 })).rejects.toBeInstanceOf(TooManyRequestsError)

    await expect(send({ presence: 'here' })).resolves.toBeNull()
    await expect(send({ selected: null })).resolves.toBeNull()
    await expect(send({ presence: 'gone' })).resolves.toBeNull()
    // Claims are bounded too, by their own budget.
    await expect(send({ presence: 'here' })).rejects.toBeInstanceOf(TooManyRequestsError)
  })

  it('gives the document room’s presence and selection the claim budget', () => {
    expect(CHANNELS.doc.upstream?.limit).toBe(ROOM_LIMIT)
    expect(CHANNELS.doc.upstream?.claims).toEqual({ limit: ROOM_CLAIM_LIMIT, fields: ['selected'] })
  })
})
