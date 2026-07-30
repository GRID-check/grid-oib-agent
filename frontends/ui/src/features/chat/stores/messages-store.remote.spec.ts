/**
 * `insertRemoteMessages` — the store half of the ADR-0033 seam.
 *
 * Kept in its own file rather than folded into the 2 800-line `store.spec.ts`,
 * because what is being pinned down here is one narrow contract: messages that
 * came FROM the server splice in without disturbing anything that belongs to this
 * client's turn. Every existing action's behaviour is covered where it already is.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest'
import { useChatStore } from '../store'
import type { ChatMessage, Conversation } from '../types'
import type { MessagesSlice } from './messages-store'

const mockLayoutState = vi.hoisted(() => ({
  closeRightPanel: vi.fn(),
  enabledDataSourceIds: ['web_search'],
  availableDataSources: [{ id: 'web_search' }],
  setEnabledDataSources: vi.fn(),
}))
vi.mock('@/features/layout/store', () => ({
  useLayoutStore: { getState: () => mockLayoutState },
}))

const mockConversationsClient = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue([]),
  get: vi.fn().mockResolvedValue(undefined),
  create: vi.fn().mockResolvedValue(undefined),
  updateTitle: vi.fn().mockResolvedValue(undefined),
  delete: vi.fn().mockResolvedValue(undefined),
  listMessages: vi.fn().mockResolvedValue([]),
  createMessage: vi.fn().mockResolvedValue(undefined),
  createMessages: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/adapters/api/conversations-client', () => ({
  conversationsClient: mockConversationsClient,
}))

const CONVERSATION_ID = 's_conv_1'

const at = (minute: number): Date => new Date(`2026-07-29T09:0${minute}:00.000Z`)

const message = (id: string, overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role: 'user',
  content: `message ${id}`,
  timestamp: at(1),
  messageType: 'user',
  ...overrides,
})

const seed = (messages: ChatMessage[]): Conversation => {
  const conversation: Conversation = {
    id: CONVERSATION_ID,
    userId: 'user_me',
    projectId: 'p1',
    title: 'Brandschutz',
    messages,
    createdAt: at(0),
    updatedAt: at(0),
  }
  useChatStore.setState({
    currentUserId: 'user_me',
    conversations: [conversation],
    currentConversation: conversation,
  })
  return conversation
}

const messagesNow = (): ChatMessage[] =>
  useChatStore.getState().conversations.find((c) => c.id === CONVERSATION_ID)?.messages ?? []

/**
 * Direct handle on the action. It is declared on the messages slice rather than on
 * the shared `ChatActions` union (features/chat/types.ts), so the cast lives here
 * exactly as it does at the hook's single call site.
 */
const insertRemoteMessages = (
  conversationId: string,
  messages: ChatMessage[],
  options?: { replace?: boolean }
): void => {
  const store = useChatStore.getState() as unknown as Pick<MessagesSlice, 'insertRemoteMessages'>
  store.insertRemoteMessages(conversationId, messages, options)
}

describe('insertRemoteMessages', () => {
  beforeEach(() => {
    localStorage.removeItem('aiq-chat-store')
    useChatStore.setState({
      conversations: [],
      currentConversation: null,
      currentUserId: null,
      isStreaming: false,
      isLoading: false,
      currentUserMessageId: null,
      streamingAssistantMessageId: null,
      thinkingSteps: [],
    })
    mockConversationsClient.createMessage.mockClear()
    mockConversationsClient.createMessages.mockClear()
  })

  test('appends a message the local copy does not have', () => {
    seed([message('m1')])

    insertRemoteMessages(CONVERSATION_ID, [message('m1'), message('m2', { timestamp: at(2) })])

    expect(messagesNow().map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  test('skips ids already present — an echo of our own write renders once', () => {
    // The push channel hands your own message back to you. Without dedup this is
    // the double-render ADR-0033 §5 exists to prevent.
    seed([message('m1', { content: 'my optimistic echo' })])

    insertRemoteMessages(CONVERSATION_ID, [message('m1', { content: 'the persisted copy' })])

    expect(messagesNow()).toHaveLength(1)
    // The LOCAL object survives: it carries turn state the server never stored.
    expect(messagesNow()[0].content).toBe('my optimistic echo')
  })

  test('folds the server facts (author, mentions) onto a message we already hold', () => {
    seed([message('m1')])

    insertRemoteMessages(CONVERSATION_ID, [
      message('m1', {
        authorUserId: 'user_anna',
        authorName: 'Anna Berger',
        mentions: [{ targetId: 'agent:piloti', display: 'Piloti' }],
        addressees: { agent: true, users: [] },
      }),
    ])

    const stored = messagesNow()[0]
    expect(stored.authorUserId).toBe('user_anna')
    expect(stored.authorName).toBe('Anna Berger')
    expect(stored.mentions).toEqual([{ targetId: 'agent:piloti', display: 'Piloti' }])
    expect(stored.addressees).toEqual({ agent: true, users: [] })
  })

  test('orders by timestamp, then by id (spec CC-11)', () => {
    seed([message('b', { timestamp: at(3) })])

    insertRemoteMessages(CONVERSATION_ID, [
      message('c', { timestamp: at(4) }),
      message('a', { timestamp: at(3) }),
    ])

    expect(messagesNow().map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  test('is a no-op when nothing new arrived: the array keeps its identity', () => {
    const conversation = seed([message('m1')])
    const before = messagesNow()

    insertRemoteMessages(CONVERSATION_ID, [message('m1')])

    expect(messagesNow()).toBe(before)
    // No conversation rebuild either, so no re-render and no reshuffled session list.
    expect(useChatStore.getState().currentConversation).toBe(conversation)
  })

  test('never touches turn state, and never persists back to the server', () => {
    seed([message('m1')])
    useChatStore.setState({
      isStreaming: true,
      isLoading: true,
      currentUserMessageId: 'm1',
      streamingAssistantMessageId: 'live-answer',
    })

    insertRemoteMessages(CONVERSATION_ID, [message('m2', { timestamp: at(2) })])

    const state = useChatStore.getState()
    expect(state.isStreaming).toBe(true)
    expect(state.isLoading).toBe(true)
    expect(state.currentUserMessageId).toBe('m1')
    expect(state.streamingAssistantMessageId).toBe('live-answer')
    // These messages came FROM the server; mirroring them back would be a loop.
    expect(mockConversationsClient.createMessage).not.toHaveBeenCalled()
    expect(mockConversationsClient.createMessages).not.toHaveBeenCalled()
  })

  test('an arriving message counts as activity; a corrected one does not reshuffle the list', () => {
    seed([message('m1')])
    const before = useChatStore.getState().conversations[0].updatedAt

    // Resolving an author name on a message already on screen is not new activity.
    insertRemoteMessages(CONVERSATION_ID, [message('m1', { authorName: 'Anna Berger' })])
    expect(useChatStore.getState().conversations[0].updatedAt).toBe(before)

    insertRemoteMessages(CONVERSATION_ID, [message('m2', { timestamp: at(2) })])
    expect(useChatStore.getState().conversations[0].updatedAt).not.toBe(before)
  })

  test('mirrors into both the conversations list and currentConversation', () => {
    seed([message('m1')])

    insertRemoteMessages(CONVERSATION_ID, [message('m2', { timestamp: at(2) })])

    const state = useChatStore.getState()
    expect(state.conversations[0].messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(state.currentConversation?.messages).toBe(state.conversations[0].messages)
  })

  test('leaves another conversation alone', () => {
    seed([message('m1')])
    const other: Conversation = {
      id: 's_other',
      userId: 'user_me',
      projectId: 'p1',
      title: 'Other',
      messages: [message('o1')],
      createdAt: at(0),
      updatedAt: at(0),
    }
    useChatStore.setState({ conversations: [...useChatStore.getState().conversations, other] })

    insertRemoteMessages(CONVERSATION_ID, [message('m2', { timestamp: at(2) })])

    expect(
      useChatStore.getState().conversations.find((c) => c.id === 's_other')?.messages.map((m) => m.id)
    ).toEqual(['o1'])
  })

  test('ignores an unknown conversation instead of inventing one', () => {
    seed([message('m1')])

    insertRemoteMessages('s_nope', [message('x')])

    expect(useChatStore.getState().conversations).toHaveLength(1)
    expect(messagesNow().map((m) => m.id)).toEqual(['m1'])
  })

  describe('replace (the load-on-open path)', () => {
    test('drops a stale local-only message the server does not know about', () => {
      seed([message('stale', { timestamp: at(1) })])

      insertRemoteMessages(CONVERSATION_ID, [message('m1', { timestamp: at(3) })], {
        replace: true,
      })

      expect(messagesNow().map((m) => m.id)).toEqual(['m1'])
    })

    test('keeps an in-flight streaming bubble, which the server has not been told about', () => {
      seed([
        message('live', {
          role: 'assistant',
          messageType: 'agent_response',
          isStreaming: true,
          timestamp: at(1),
        }),
      ])

      insertRemoteMessages(CONVERSATION_ID, [message('m1', { timestamp: at(3) })], {
        replace: true,
      })

      expect(messagesNow().map((m) => m.id)).toEqual(['live', 'm1'])
    })

    test('keeps a local message newer than the server snapshot (the just-sent turn)', () => {
      seed([message('just-sent', { timestamp: at(5) })])

      insertRemoteMessages(CONVERSATION_ID, [message('m1', { timestamp: at(3) })], {
        replace: true,
      })

      expect(messagesNow().map((m) => m.id)).toEqual(['m1', 'just-sent'])
    })

    test('an empty server history never wipes a thread', () => {
      seed([message('m1'), message('m2', { timestamp: at(2) })])

      insertRemoteMessages(CONVERSATION_ID, [], { replace: true })

      expect(messagesNow().map((m) => m.id)).toEqual(['m1', 'm2'])
    })
  })
})
