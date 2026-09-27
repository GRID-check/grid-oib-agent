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
import { readStoredChat } from './chat-storage'
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
  const messages = readStoredChat(STORAGE_KEY)?.state.conversations[0]?.messages ?? []
  return messages.find((m) => m.role === 'assistant')?.content
}

describe('persisting a streamed answer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useChatStore.persist.clearStorage()
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
    useChatStore.persist.clearStorage()
  })

  it('writes nothing while the answer opens and grows, and the settled answer after its frame', () => {
    const setItem = vi.spyOn(localStorage, 'setItem')
    const writes = () => setItem.mock.calls.filter(([key]) => key.startsWith(STORAGE_KEY)).length

    for (let i = 0; i < 50; i++) useChatStore.getState().appendAgentResponseDelta(`Wort${i} `)
    vi.advanceTimersByTime(30_000)
    // Neither the opening nor the growth: the send already moved the session
    // to the top, and a full write here was a 330 ms freeze with forty
    // conversations stored, the moment the first words appeared.
    expect(writes()).toBe(0)
    expect(storedAnswer() ?? '').not.toContain('Wort49')

    // Not inside the settle: it was most of a 1 s task at the end of a
    // recorded turn, ahead of the render that shows the answer settled.
    useChatStore.getState().finalizeAgentResponse('Die ganze Antwort.')
    expect(writes()).toBe(0)
    expect(storedAnswer()).not.toBe('Die ganze Antwort.')

    vi.advanceTimersByTime(0)
    expect(storedAnswer()).toBe('Die ganze Antwort.')
    setItem.mockRestore()
  })

  it('writes the settled answer at once when the page is left before the write ran', () => {
    useChatStore.getState().appendAgentResponseDelta('Wort ')
    vi.advanceTimersByTime(1_000)
    useChatStore.getState().finalizeAgentResponse('Die ganze Antwort.')
    expect(storedAnswer()).not.toBe('Die ganze Antwort.')

    window.dispatchEvent(new Event('pagehide'))
    expect(storedAnswer()).toBe('Die ganze Antwort.')
  })
})
