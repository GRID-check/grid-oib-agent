/**
 * A commissioned run's message goes into the thread that commissioned it.
 *
 * The socket hook fetches the run's message after the turn ends, and the fetch
 * is async: the reader may have opened another thread by the time it lands. The
 * message is routed by the commissioning thread, never by whichever thread is
 * open when it lands.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/features/layout/store', () => ({
  useLayoutStore: {
    getState: () => ({
      enabledDataSourceIds: [],
      availableDataSources: [],
      setEnabledDataSources: vi.fn(),
    }),
  },
}))
vi.mock('@/features/documents/discard-session-resources', () => ({
  discardSessionDocumentsResources: vi.fn(),
}))
vi.mock('@/adapters/api/conversations-client', () => ({
  conversationsClient: {
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    listMessages: vi.fn().mockResolvedValue([]),
    createMessage: vi.fn().mockResolvedValue(undefined),
    newestFrameAge: vi.fn().mockResolvedValue(null),
  },
}))

import { useChatStore } from '../store'
import type { ChatMessage, Conversation } from '../types'

const conversation = (id: string): Conversation => ({
  id,
  userId: 'u1',
  projectId: null,
  title: id,
  messages: [{ id: `${id}-q`, role: 'user', content: 'q', timestamp: new Date(), messageType: 'user' }],
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
})

const runMessage: ChatMessage = {
  id: 'msg-run',
  role: 'assistant',
  content: '',
  timestamp: new Date(),
  messageType: 'agent_response',
}

const messageIds = (id: string) =>
  useChatStore
    .getState()
    .conversations.find((c) => c.id === id)!
    .messages.map((m) => m.id)

describe('adoptRunMessage', () => {
  beforeEach(() => {
    const a = conversation('s_A')
    const b = conversation('s_B')
    useChatStore.setState({ currentUserId: 'u1', conversations: [a, b], currentConversation: b })
  })

  it('writes into the commissioning thread, not the one open when the fetch lands', () => {
    useChatStore.getState().adoptRunMessage('s_A', runMessage)

    expect(messageIds('s_A')).toEqual(['s_A-q', 'msg-run'])
    expect(messageIds('s_B')).toEqual(['s_B-q'])
    expect(useChatStore.getState().currentConversation?.messages.map((m) => m.id)).toEqual(['s_B-q'])
  })

  it('updates the open thread when it is the commissioning one, once', () => {
    useChatStore.getState().adoptRunMessage('s_B', runMessage)
    useChatStore.getState().adoptRunMessage('s_B', runMessage)

    expect(useChatStore.getState().currentConversation?.messages.map((m) => m.id)).toEqual([
      's_B-q',
      'msg-run',
    ])
    expect(messageIds('s_B')).toEqual(['s_B-q', 'msg-run'])
  })
})
