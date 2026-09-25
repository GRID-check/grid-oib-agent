/**
 * A streamed answer does not write the persisted chat store once per delta.
 *
 * Regression (ADR-0066's streaming made it visible): every delta flush is a
 * store update, and the `persist` middleware prunes, serializes and writes
 * the WHOLE history on each one. On `/dev/stream-chat`, one twelve-second
 * answer beside forty conversations of history wrote 1.3 MB to localStorage
 * 74 times and blocked the main thread for 8 of those 12 seconds. This drives
 * the real store, so a new write path that bypasses the storage's coalescing
 * fails here rather than in someone's browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../store'
import type { Conversation } from '../types'
import { STREAMING_PERSIST_INTERVAL_MS } from './sessions-store'

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

  it('writes a burst of deltas once per window, and the settled answer at once', () => {
    const setItem = vi.spyOn(localStorage, 'setItem')
    const writes = () => setItem.mock.calls.filter(([key]) => key === STORAGE_KEY).length

    for (let i = 0; i < 50; i++) useChatStore.getState().appendAgentResponseDelta(`Wort${i} `)
    expect(writes()).toBeLessThanOrEqual(1)

    vi.advanceTimersByTime(STREAMING_PERSIST_INTERVAL_MS)
    expect(writes()).toBeLessThanOrEqual(2)
    expect(storedAnswer()).toContain('Wort49')

    useChatStore.getState().finalizeAgentResponse('Die ganze Antwort.')
    expect(storedAnswer()).toBe('Die ganze Antwort.')
    setItem.mockRestore()
  })
})
