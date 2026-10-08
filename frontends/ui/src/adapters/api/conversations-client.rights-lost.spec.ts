/**
 * The browser's reading of the server's "you no longer have the rights"
 * (ADR-0085): a 403 whose `code` is `RESOURCE_RIGHTS_LOST` becomes its own
 * error, and no other failure does.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationRightsLostError, conversationsClient } from './conversations-client'

const refusal = (code: string, status = 403): Response =>
  Response.json({ error: 'x', code, details: { reason: 'rights-lost' } }, { status })

afterEach(() => vi.unstubAllGlobals())

describe.each([
  ['the detail', () => conversationsClient.get('s_1')],
  ['the messages', () => conversationsClient.listMessages('s_1')],
  ['a message written', () => conversationsClient.createMessage('s_1', { id: 'm1', role: 'user', content: 'hi' })],
  ['messages written', () => conversationsClient.createMessages('s_1', [{ id: 'm1', role: 'user', content: 'hi' }])],
])('reading or writing %s of a chat the reader may no longer read', (_name, call) => {
  it('throws ConversationRightsLostError for the typed 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refusal('RESOURCE_RIGHTS_LOST')))

    await expect(call()).rejects.toBeInstanceOf(ConversationRightsLostError)
    await expect(call()).rejects.toMatchObject({ name: 'ConversationRightsLostError' })
  })

  it('does not take any other 403 for it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refusal('FORBIDDEN')))

    const error = await call().catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(ConversationRightsLostError)
  })

  it('does not take a 404 for it: not found is not lost rights', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refusal('NOT_FOUND', 404)))

    await expect(call()).rejects.not.toBeInstanceOf(ConversationRightsLostError)
  })
})
