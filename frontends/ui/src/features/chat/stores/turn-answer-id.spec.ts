/**
 * A turn's answer has the id the backend would give it.
 *
 * When the socket drops mid-answer, the server may persist the answer itself
 * (nobody to deliver it to) while the phone, back online, replays the terminal
 * frame from the stream and writes the answer too. Both write the id
 * `uuid5(grid:assistant:<conversation>:<turn>)`, so the second write collides
 * on `messages.id` and no-ops, and the recovery dedupes it by id: one answer,
 * never two.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../store'
import type { Conversation } from '../types'
import { turnAnswerId } from '@/lib/conversations/turn-answer-id'

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

describe('the answer id of a turn', () => {
  beforeEach(() => {
    useChatStore.setState({
      currentUserId: 'user-1',
      currentConversation: conversation,
      conversations: [conversation],
      isStreaming: false,
      streamingAssistantMessageId: null,
    })
    useChatStore.getState().addUserMessage('Zweiter Fluchtweg?')
    useChatStore.getState().setStreaming(true)
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('is the backend’s deterministic id once the turn id is known', () => {
    useChatStore.getState().setTurnWsParentId('msg_1')
    useChatStore.getState().appendAgentResponseDelta('Ja, ')
    useChatStore.getState().finalizeAgentResponse('Ja, zwei.')

    const answers = useChatStore
      .getState()
      .currentConversation!.messages.filter((m) => m.role === 'assistant')
    expect(answers.map((m) => m.id)).toEqual([turnAnswerId('conv-1', 'msg_1')])
  })

  it('is a fresh id when no turn id ever arrived', () => {
    useChatStore.getState().finalizeAgentResponse('Ja, zwei.')
    const answer = useChatStore
      .getState()
      .currentConversation!.messages.find((m) => m.role === 'assistant')
    expect(answer?.id).toMatch(/^[0-9a-f-]{36}$/)
  })
})
