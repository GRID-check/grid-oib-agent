/**
 * A reload in the middle of an answer.
 *
 * `pagehide` (or the streaming persist window) leaves the half-written answer
 * in localStorage with `isStreaming: true`. After the reload the socket
 * reattaches to the running turn and its remaining frames arrive; the store,
 * which no longer knows the persisted bubble is the one streaming, opens a
 * new bubble for them. The stored fragment used to stay beside it, streaming
 * forever; it is dropped on load instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../store'

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

const persistedMidAnswer = () => ({
  version: 0,
  state: {
    currentUserId: 'user-1',
    currentConversation: 'conv-1',
    pendingInteraction: null,
    composerDrafts: {},
    conversations: [
      {
        id: 'conv-1',
        userId: 'user-1',
        title: 'Fluchtweg',
        createdAt: '2026-09-25T09:00:00.000Z',
        updatedAt: '2026-09-25T09:00:00.000Z',
        messages: [
          {
            id: 'u1',
            role: 'user',
            content: 'Zweiter Fluchtweg?',
            timestamp: '2026-09-25T09:00:00.000Z',
            messageType: 'user',
          },
          {
            id: 'a-partial',
            role: 'assistant',
            content: 'Für die Außentreppe gilt',
            timestamp: '2026-09-25T09:00:05.000Z',
            messageType: 'agent_response',
            isStreaming: true,
          },
        ],
      },
    ],
  },
})

const assistantMessages = () =>
  (useChatStore.getState().currentConversation?.messages ?? []).filter(
    (m) => m.role === 'assistant'
  )

describe('reloading in the middle of an answer', () => {
  beforeEach(async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistedMidAnswer()))
    await useChatStore.persist.rehydrate()
  })

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY)
  })

  it('shows the answer once when the reattached turn finishes it', () => {
    useChatStore.getState().appendAgentResponseDelta(' eine Breite von 1,2 m.')
    useChatStore.getState().finalizeAgentResponse('Für die Außentreppe gilt eine Breite von 1,2 m.')

    const answers = assistantMessages()
    expect(answers.map((m) => m.content)).toEqual([
      'Für die Außentreppe gilt eine Breite von 1,2 m.',
    ])
    expect(answers.every((m) => !m.isStreaming)).toBe(true)
  })

  it('leaves the question as the newest turn, for the recovery that fetches a finished answer', () => {
    const messages = useChatStore.getState().currentConversation?.messages ?? []
    expect(messages.map((m) => m.id)).toEqual(['u1'])
  })
})
