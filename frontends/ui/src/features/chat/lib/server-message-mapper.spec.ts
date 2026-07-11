import { describe, it, expect } from 'vitest'
import type { Message } from '@/lib/db/schema'
import { mapServerMessageToChatMessage, mapServerMessagesToChatMessages } from './server-message-mapper'

const serverMessage = (overrides: Partial<Message> = {}): Message =>
  ({
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    conversationId: 's_conv_1',
    role: 'user',
    content: 'Hello',
    metadata: {},
    // Over JSON, timestamps arrive as ISO strings despite the Date type.
    createdAt: '2026-07-01T10:00:00.000Z' as unknown as Date,
    ...overrides,
  }) as Message

describe('mapServerMessageToChatMessage', () => {
  it('maps core fields and parses the ISO timestamp', () => {
    const mapped = mapServerMessageToChatMessage(serverMessage())

    expect(mapped).not.toBeNull()
    expect(mapped!.id).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(mapped!.role).toBe('user')
    expect(mapped!.content).toBe('Hello')
    expect(mapped!.timestamp).toBeInstanceOf(Date)
    expect(mapped!.timestamp.toISOString()).toBe('2026-07-01T10:00:00.000Z')
  })

  it('uses the persisted messageType from metadata', () => {
    const mapped = mapServerMessageToChatMessage(
      serverMessage({ role: 'assistant', metadata: { messageType: 'agent_response' } })
    )

    expect(mapped!.messageType).toBe('agent_response')
  })

  it('infers messageType from role when metadata has none (legacy rows)', () => {
    expect(mapServerMessageToChatMessage(serverMessage({ role: 'user' }))!.messageType).toBe('user')
    expect(
      mapServerMessageToChatMessage(serverMessage({ role: 'assistant' }))!.messageType
    ).toBe('agent_response')
  })

  it('ignores an unknown messageType value and falls back to the role', () => {
    const mapped = mapServerMessageToChatMessage(
      serverMessage({ role: 'assistant', metadata: { messageType: 'not-a-real-type' } })
    )

    expect(mapped!.messageType).toBe('agent_response')
  })

  it('drops system and tool rows the chat window never renders', () => {
    expect(mapServerMessageToChatMessage(serverMessage({ role: 'system' }))).toBeNull()
    expect(mapServerMessageToChatMessage(serverMessage({ role: 'tool' }))).toBeNull()
  })

  it('restores persisted metadata payloads (errorData, cards, data sources, files)', () => {
    const mapped = mapServerMessageToChatMessage(
      serverMessage({
        role: 'assistant',
        metadata: {
          messageType: 'error',
          errorData: { errorCode: 'system.unknown', errorMessage: 'boom' },
          cards: [{ kind: 'test' }],
          enabledDataSources: ['web_search'],
          messageFiles: [{ id: 'f1', fileName: 'a.pdf' }],
        },
      })
    )

    expect(mapped!.messageType).toBe('error')
    expect(mapped!.errorData).toEqual({ errorCode: 'system.unknown', errorMessage: 'boom' })
    expect(mapped!.cards).toEqual([{ kind: 'test' }])
    expect(mapped!.enabledDataSources).toEqual(['web_search'])
    expect(mapped!.messageFiles).toEqual([{ id: 'f1', fileName: 'a.pdf' }])
  })

  it('tolerates a null metadata column', () => {
    const mapped = mapServerMessageToChatMessage(serverMessage({ metadata: null }))

    expect(mapped!.messageType).toBe('user')
    expect(mapped!.errorData).toBeUndefined()
  })
})

describe('mapServerMessagesToChatMessages', () => {
  it('maps a history in order and filters unrenderable rows', () => {
    const mapped = mapServerMessagesToChatMessages([
      serverMessage({ id: 'm1', role: 'user', content: 'q' }),
      serverMessage({ id: 'm2', role: 'system', content: 'internal' }),
      serverMessage({ id: 'm3', role: 'assistant', content: 'a' }),
    ])

    expect(mapped.map((m) => m.id)).toEqual(['m1', 'm3'])
  })
})
