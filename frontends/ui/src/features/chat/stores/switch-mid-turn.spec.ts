/**
 * Leaving a conversation while its answer streams, and coming back.
 *
 * The socket belongs to the open conversation, so leaving ends the stream. The
 * bubble kept `isStreaming: true` and `streamingAssistantMessageId` pointed at
 * it: on return the caret blinked forever, and the fragment was the last
 * message, which hid the open question from the recovery that fetches the
 * finished answer. Leaving drops the fragment as a reload does, and coming back
 * recovers the turn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/features/layout/store', () => ({
  useLayoutStore: {
    getState: () => ({
      enabledDataSourceIds: ['web_search'],
      availableDataSources: [{ id: 'web_search' }],
      setEnabledDataSources: vi.fn(),
    }),
  },
}))
vi.mock('@/adapters/api/deep-research-client', () => ({
  getJobStatus: vi.fn(),
  cancelJob: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/features/documents/discard-session-resources', () => ({
  discardSessionDocumentsResources: vi.fn(),
}))

const client = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([]),
  get: vi.fn(),
  create: vi.fn().mockResolvedValue({}),
  updateTitle: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  listMessages: vi.fn(),
  createMessage: vi.fn().mockResolvedValue({}),
  createMessages: vi.fn(),
  newestFrameAge: vi.fn().mockResolvedValue(null),
}))
vi.mock('@/adapters/api/conversations-client', () => ({ conversationsClient: client }))

import { useChatStore } from '../store'
import type { ChatMessage, Conversation } from '../types'

const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

const conversation = (id: string, messages: ChatMessage[] = []): Conversation => ({
  id,
  userId: 'u1',
  projectId: null,
  title: id,
  messages,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
})

/** A question sent in A under turn `ws-1`, and the first words of its answer. */
const streamIntoA = (): string => {
  const store = useChatStore.getState()
  store.addUserMessage('Zweiter Fluchtweg?')
  const question = useChatStore.getState().currentConversation!.messages.at(-1)!
  store.markTurnWsParentId(question.id, 'ws-1')
  store.setStreaming(true)
  store.appendAgentResponseDelta('Für die Außen')
  store.appendAgentResponseDelta('treppe gilt')
  return question.id
}

describe('switching conversation while an answer streams', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
    const b = conversation('s_B', [
      { id: 'b1', role: 'user', content: 'hi', timestamp: new Date(), messageType: 'user' },
    ])
    const a = conversation('s_A')
    useChatStore.setState({
      currentUserId: 'u1',
      conversations: [a, b],
      currentConversation: a,
      projectId: null,
      isStreaming: false,
      isLoading: false,
      streamingAssistantMessageId: null,
      pendingInteraction: null,
      composerDrafts: {},
      resumableTurn: null,
    })
  })

  it('leaves no streaming bubble behind, in the list or on the store', () => {
    streamIntoA()
    useChatStore.getState().selectConversation('s_B')

    const state = useChatStore.getState()
    const a = state.conversations.find((c) => c.id === 's_A')!
    expect(a.messages.some((m) => m.isStreaming)).toBe(false)
    expect(state.streamingAssistantMessageId).toBeNull()
    expect(state.isStreaming).toBe(false)
    // B is untouched by A's turn.
    expect(state.currentConversation?.messages.map((m) => m.id)).toEqual(['b1'])
  })

  it('recovers the finished answer on return', async () => {
    const questionId = streamIntoA()
    client.listMessages.mockResolvedValue([
      {
        id: questionId,
        conversationId: 's_A',
        role: 'user',
        content: 'Zweiter Fluchtweg?',
        metadata: { messageType: 'user' },
        createdAt: '2026-01-01T10:00:00Z',
      },
      {
        id: 'answer-1',
        conversationId: 's_A',
        role: 'assistant',
        content: 'Für die Außentreppe gilt OIB-RL 4.',
        metadata: { messageType: 'agent_response' },
        createdAt: '2026-01-01T10:01:00Z',
      },
    ])

    useChatStore.getState().selectConversation('s_B')
    useChatStore.getState().selectConversation('s_A')
    await flush()

    const messages = useChatStore.getState().currentConversation!.messages
    expect(client.listMessages).toHaveBeenCalledWith('s_A')
    expect(messages.map((m) => m.content)).toEqual([
      'Zweiter Fluchtweg?',
      'Für die Außentreppe gilt OIB-RL 4.',
    ])
    expect(messages.some((m) => m.isStreaming)).toBe(false)
  })

  it('hands a turn the server has not finished to the replay on return', async () => {
    const questionId = streamIntoA()
    client.listMessages.mockResolvedValue([])

    useChatStore.getState().selectConversation('s_B')
    useChatStore.getState().selectConversation('s_A')
    await flush()

    expect(useChatStore.getState().resumableTurn).toEqual({
      conversationId: 's_A',
      userMessageId: questionId,
      wsParentId: 'ws-1',
    })
  })

  it('keeps the turn when the switch is refused', () => {
    streamIntoA()
    useChatStore.getState().selectConversation('s_unknown')

    const state = useChatStore.getState()
    expect(state.currentConversation?.id).toBe('s_A')
    expect(state.streamingAssistantMessageId).not.toBeNull()
  })
})
