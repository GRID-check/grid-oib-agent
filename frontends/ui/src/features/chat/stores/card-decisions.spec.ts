/**
 * Interactive-card decisions must be recorded ON THE MESSAGE, because that is
 * the only place that reaches BOTH persistence layers: the `persist` middleware
 * writes it to localStorage, and `_persistCardInteractions` mirrors it to the
 * server message row (`metadata.cardInteractions`) so it also survives a quota
 * wipe or a different device.
 *
 * Regression: the outcome used to live in component-local `useState`, so a
 * reload re-mounted an accepted `project_profile_patch` / saved
 * `memory_proposal` as pending — with a live button that would apply the patch
 * or write the memory a SECOND time (neither endpoint is idempotent).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../store'
import type { Conversation } from '../types'

const STORAGE_KEY = 'aiq-chat-store'

vi.mock('@/features/layout/store', () => ({
  useLayoutStore: {
    getState: () => ({
      closeRightPanel: vi.fn(),
      enabledDataSourceIds: [],
      availableDataSources: [],
      setEnabledDataSources: vi.fn(),
    }),
  },
}))

vi.mock('@/features/documents/discard-session-resources', () => ({
  discardSessionDocumentsResources: vi.fn(),
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
  updateMessageCardInteractions: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/adapters/api/conversations-client', () => ({
  conversationsClient: mockConversationsClient,
}))

const conversationWithCardMessage = (id: string, messageId: string): Conversation => ({
  id,
  userId: 'user-1',
  title: 'Brandschutz',
  messages: [
    {
      id: messageId,
      role: 'assistant',
      content: 'Vorschlag',
      timestamp: new Date('2026-07-28T09:00:00.000Z'),
      messageType: 'agent_response',
      cards: [
        {
          type: 'memory_proposal',
          title: 'Merken?',
          content: 'REI 90',
          kind: 'preference',
          confidence: 'high',
        },
      ],
    },
  ],
  createdAt: new Date('2026-07-28T09:00:00.000Z'),
  updatedAt: new Date('2026-07-28T09:00:00.000Z'),
})

const messageIn = (conversation: Conversation | null, messageId: string) =>
  conversation?.messages.find((m) => m.id === messageId)

describe('setCardDecision', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
    vi.clearAllMocks()
    const conversation = conversationWithCardMessage('conv-1', 'msg-1')
    useChatStore.setState({
      currentUserId: 'user-1',
      currentConversation: conversation,
      conversations: [conversation],
    })
  })

  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY)
  })

  it('records the decision on the message in both the current conversation and the list', () => {
    useChatStore.getState().setCardDecision('msg-1', 'memory_proposal-0', 'savedOrg')

    const { currentConversation, conversations } = useChatStore.getState()
    expect(messageIn(currentConversation, 'msg-1')?.cardInteractions).toEqual({
      'memory_proposal-0': { decision: 'savedOrg', decidedAt: expect.any(String) },
    })
    expect(messageIn(conversations[0], 'msg-1')?.cardInteractions?.['memory_proposal-0'].decision).toBe(
      'savedOrg',
    )
  })

  it('keeps decisions of sibling cards on the same message', () => {
    useChatStore.getState().setCardDecision('msg-1', 'memory_proposal-0', 'dismissed')
    useChatStore.getState().setCardDecision('msg-1', 'project_profile_patch-1', 'accepted')

    const interactions = messageIn(useChatStore.getState().currentConversation, 'msg-1')?.cardInteractions
    expect(interactions?.['memory_proposal-0'].decision).toBe('dismissed')
    expect(interactions?.['project_profile_patch-1'].decision).toBe('accepted')
  })

  it('mirrors the decision to the server message row', async () => {
    useChatStore.getState().setCardDecision('msg-1', 'memory_proposal-0', 'savedProject')

    // The mirror runs through the lazily imported conversations client, so it
    // lands a microtask later than the local write.
    await vi.waitFor(() =>
      expect(mockConversationsClient.updateMessageCardInteractions).toHaveBeenCalledWith(
        'conv-1',
        'msg-1',
        expect.objectContaining({
          'memory_proposal-0': expect.objectContaining({ decision: 'savedProject' }),
        }),
      ),
    )
  })

  it('survives a persist round trip through localStorage', () => {
    useChatStore.getState().setCardDecision('msg-1', 'memory_proposal-0', 'savedOrg')

    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    const message = persisted.state.conversations[0].messages[0]
    // The pruner must not treat this as heavy refetchable state: nothing can
    // re-derive "the user already saved this" from the backend.
    expect(message.cardInteractions['memory_proposal-0'].decision).toBe('savedOrg')
    expect(message.cards).toHaveLength(1)
  })

  it('records onto a conversation that is not the current one', () => {
    // The deep-research report panel can outlive a session switch, so the owner
    // must be located rather than assumed to be `currentConversation`.
    const other = conversationWithCardMessage('conv-2', 'msg-2')
    useChatStore.setState({ conversations: [...useChatStore.getState().conversations, other] })

    useChatStore.getState().setCardDecision('msg-2', 'memory_proposal-0', 'dismissed')

    const stored = useChatStore.getState().conversations.find((c) => c.id === 'conv-2')
    expect(messageIn(stored ?? null, 'msg-2')?.cardInteractions?.['memory_proposal-0'].decision).toBe(
      'dismissed',
    )
  })

  it('does not reorder the session list (answering a card is not new activity)', () => {
    const before = useChatStore.getState().currentConversation?.updatedAt

    useChatStore.getState().setCardDecision('msg-1', 'memory_proposal-0', 'savedOrg')

    expect(useChatStore.getState().currentConversation?.updatedAt).toEqual(before)
  })

  it('is a no-op for an unknown message', async () => {
    // Nothing is written and nothing is mirrored. The card itself still settles
    // for the rest of the mount — see the local fallback in `useCardDecision`,
    // which matters because the API write has already happened by this point.
    useChatStore.getState().setCardDecision('nope', 'memory_proposal-0', 'savedOrg')
    await Promise.resolve()

    expect(messageIn(useChatStore.getState().currentConversation, 'msg-1')?.cardInteractions).toBeUndefined()
    expect(mockConversationsClient.updateMessageCardInteractions).not.toHaveBeenCalled()
  })

  it('keeps the local decision when the server mirror fails', async () => {
    mockConversationsClient.updateMessageCardInteractions.mockRejectedValueOnce(new Error('offline'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    useChatStore.getState().setCardDecision('msg-1', 'memory_proposal-0', 'savedOrg')
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())

    expect(
      messageIn(useChatStore.getState().currentConversation, 'msg-1')?.cardInteractions?.[
        'memory_proposal-0'
      ].decision,
    ).toBe('savedOrg')
    warn.mockRestore()
  })
})
