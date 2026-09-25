/**
 * A streamed answer does not write the persisted chat store while it streams.
 *
 * Regression (ADR-0066's streaming made it visible): every delta flush is a
 * store update, and the `persist` middleware prunes, serializes and writes
 * the WHOLE history on each one. On `/dev/stream-chat`, one twelve-second
 * answer beside forty conversations of history wrote 1.3 MB to localStorage
 * 74 times and blocked the main thread for 8 of those 12 seconds. This drives
 * the real store, so a new write path that writes the growth
 * fails here rather than in someone's browser. The growth is skipped because a reload drops an answer still marked streaming (`getItem`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../store'
import type { Conversation } from '../types'

const STORAGE_KEY = 'aiq-chat-store'

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
    get: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(undefined),
    updateTitle: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    listMessages: vi.fn().mockResolvedValue([]),
    createMessage: vi.fn().mockResolvedValue(undefined),
    createMessages: vi.fn().mockResolvedValue(undefined),
    updateMessageCardInteractions: vi.fn().mockResolvedValue(undefined),
  },
}))

const conversation: Conversation = {
  id: 'conv-1',
  userId: 'user-1',
  title: 'Fluchtweg',
  messages: [],
  createdAt: new Date('2026-09-25T09:00:00.000Z'),
  updatedAt: new Date('2026-09-25T09:00:00.000Z'),
}

const storedAnswer = (): string | undefined => {
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  const messages = stored.state?.conversations?.[0]?.messages ?? []
  return messages.find((m: { role: string }) => m.role === 'assistant')?.content
}

describe('persisting a streamed answer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    localStorage.removeItem(STORAGE_KEY)
    useChatStore.setState({
      currentUserId: 'user-1',
      currentConversation: conversation,
      conversations: [conversation],
      isStreaming: false,
      streamingAssistantMessageId: null,
    })
    useChatStore.getState().addUserMessage('Zweiter Fluchtweg?')
  })

  afterEach(() => {
    vi.useRealTimers()
    localStorage.removeItem(STORAGE_KEY)
  })

  it('writes nothing while the answer streams, and the settled answer at once', () => {
    const setItem = vi.spyOn(localStorage, 'setItem')
    const writes = () => setItem.mock.calls.filter(([key]) => key === STORAGE_KEY).length

    for (let i = 0; i < 50; i++) useChatStore.getState().appendAgentResponseDelta(`Wort${i} `)
    vi.advanceTimersByTime(30_000)
    expect(writes()).toBe(0)
    expect(storedAnswer()).toBeUndefined()

    useChatStore.getState().finalizeAgentResponse('Die ganze Antwort.')
    expect(storedAnswer()).toBe('Die ganze Antwort.')
    setItem.mockRestore()
  })
})
