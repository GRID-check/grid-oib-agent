/**
 * The answer carries how long the turn took: from the question being sent to
 * the answer being final, on this browser's clock at both ends.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../store'
import type { Conversation } from '../types'

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
    updateMessageProvenance: vi.fn().mockResolvedValue(undefined),
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

const answer = () =>
  useChatStore
    .getState()
    .currentConversation?.messages.find((m) => m.messageType === 'agent_response')

describe('how long the answer took', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-26T10:00:00.000Z'))
    useChatStore.setState({
      currentUserId: 'user-1',
      currentConversation: conversation,
      conversations: [conversation],
      isStreaming: false,
      streamingAssistantMessageId: null,
      currentTurnStartedAt: null,
    })
    useChatStore.getState().addUserMessage('Zweiter Fluchtweg?')
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('is measured to the end of the stream, not to its first word', () => {
    vi.advanceTimersByTime(3_000)
    useChatStore.getState().appendAgentResponseDelta('Zwei ')
    expect(answer()?.answerDurationMs).toBeUndefined()

    vi.advanceTimersByTime(9_000)
    useChatStore.getState().finalizeAgentResponse('Zwei Fluchtwege.')

    expect(answer()?.answerDurationMs).toBe(12_000)
  })

  it('is stamped on an answer that arrives in one piece', () => {
    vi.advanceTimersByTime(4_500)
    useChatStore.getState().finalizeAgentResponse('Zwei Fluchtwege.')

    expect(answer()?.answerDurationMs).toBe(4_500)
  })

  it('is absent when this browser never saw the question go out', () => {
    useChatStore.setState({ currentTurnStartedAt: null })
    useChatStore.getState().finalizeAgentResponse('Zwei Fluchtwege.')

    expect(answer()?.answerDurationMs).toBeUndefined()
  })
})
