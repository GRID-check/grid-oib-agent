/**
 * Server-sync behavior of the sessions slice: repopulating past chats from
 * the server-persisted history, and keeping the server rows in step with
 * local deletes/renames so history can't resurrect as empty ghosts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockLayoutState = vi.hoisted(() => ({
  closeRightPanel: vi.fn(),
  enabledDataSourceIds: ['web_search'],
  availableDataSources: [{ id: 'web_search' }],
  setEnabledDataSources: vi.fn(),
}))
vi.mock('@/features/layout/store', () => ({
  useLayoutStore: { getState: () => mockLayoutState },
}))

vi.mock('@/adapters/api/deep-research-client', () => ({
  getJobStatus: vi.fn(),
  cancelJob: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/features/documents/discard-session-resources', () => ({
  discardSessionDocumentsResources: vi.fn(),
}))

const mockConversationsClient = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  updateTitle: vi.fn(),
  delete: vi.fn(),
  listMessages: vi.fn(),
  createMessage: vi.fn(),
  createMessages: vi.fn(),
}))
vi.mock('@/adapters/api/conversations-client', () => ({
  conversationsClient: mockConversationsClient,
}))

import { useChatStore } from '../store'
import type { ChatMessage, Conversation } from '../types'

let uniqueCounter = 0
const uniqueId = (prefix: string) => `${prefix}_${++uniqueCounter}`

const makeConversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: uniqueId('s_test'),
  userId: 'user-1',
  projectId: null,
  title: 'Past chat',
  messages: [],
  createdAt: new Date('2026-07-01T09:00:00.000Z'),
  updatedAt: new Date('2026-07-01T09:00:00.000Z'),
  ...overrides,
})

const serverRow = (conversationId: string, id: string, role: 'user' | 'assistant', content: string) => ({
  id,
  conversationId,
  role,
  content,
  metadata: { messageType: role === 'user' ? 'user' : 'agent_response' },
  createdAt: '2026-07-01T10:00:00.000Z',
})

const resetStore = () => {
  useChatStore.setState({
    currentUserId: 'user-1',
    currentConversation: null,
    conversations: [],
    projectId: null,
    isStreaming: false,
    isLoading: false,
    pendingInteraction: null,
    composerDrafts: {},
  })
}

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  mockConversationsClient.list.mockResolvedValue([])
  mockConversationsClient.listMessages.mockResolvedValue([])
  mockConversationsClient.create.mockResolvedValue(undefined)
  mockConversationsClient.delete.mockResolvedValue(undefined)
  mockConversationsClient.updateTitle.mockResolvedValue(undefined)
  mockConversationsClient.createMessage.mockResolvedValue(undefined)
  resetStore()
})

describe('selectConversation message repopulation', () => {
  it('repopulates an empty past chat from the server history', async () => {
    const conv = makeConversation()
    useChatStore.setState({ conversations: [conv] })
    mockConversationsClient.listMessages.mockResolvedValue([
      serverRow(conv.id, 'm1', 'user', 'What does OIB 2 require?'),
      serverRow(conv.id, 'm2', 'assistant', 'OIB 2 covers fire safety.'),
    ])

    useChatStore.getState().selectConversation(conv.id)

    await vi.waitFor(() => {
      expect(useChatStore.getState().currentConversation?.messages).toHaveLength(2)
    })

    const messages = useChatStore.getState().currentConversation!.messages
    expect(messages[0]).toMatchObject({ role: 'user', content: 'What does OIB 2 require?', messageType: 'user' })
    expect(messages[1]).toMatchObject({ role: 'assistant', messageType: 'agent_response' })
    // The sidebar copy is hydrated too, not just the active pointer.
    expect(
      useChatStore.getState().conversations.find((c) => c.id === conv.id)?.messages
    ).toHaveLength(2)
  })

  it('does not fetch history for a chat that still has local messages', async () => {
    const localMessage: ChatMessage = {
      id: 'local-1',
      role: 'user',
      content: 'kept locally',
      timestamp: new Date(),
      messageType: 'user',
    }
    const conv = makeConversation({ messages: [localMessage] })
    useChatStore.setState({ conversations: [conv] })

    useChatStore.getState().selectConversation(conv.id)
    await Promise.resolve()

    expect(mockConversationsClient.listMessages).not.toHaveBeenCalled()
    expect(useChatStore.getState().currentConversation?.messages).toEqual([localMessage])
  })

  it('never overwrites messages that arrived while the fetch was in flight', async () => {
    const conv = makeConversation()
    useChatStore.setState({ conversations: [conv] })

    let resolveFetch: (rows: unknown[]) => void = () => {}
    mockConversationsClient.listMessages.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve
      })
    )

    useChatStore.getState().selectConversation(conv.id)

    // A live message lands before the server responds.
    useChatStore.getState().addUserMessage('typed while fetching')

    resolveFetch([serverRow(conv.id, 'm1', 'user', 'stale server copy')])
    // Flush the hydration continuation (macrotask so all microtasks drain).
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    const messages = useChatStore.getState().currentConversation!.messages
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('typed while fetching')
  })
})

describe('server row lifecycle sync', () => {
  it('deletes the server row when a conversation is deleted locally', async () => {
    const conv = makeConversation()
    useChatStore.setState({ conversations: [conv] })

    useChatStore.getState().deleteConversation(conv.id)

    await vi.waitFor(() => {
      expect(mockConversationsClient.delete).toHaveBeenCalledWith(conv.id)
    })
    expect(useChatStore.getState().conversations).toHaveLength(0)
  })

  it('deletes all in-scope server rows on delete-all, sparing other projects', async () => {
    const PROJECT_A = '11111111-2222-3333-4444-555555555555'
    const conv1 = makeConversation({ projectId: PROJECT_A })
    const conv2 = makeConversation() // legacy unscoped: in scope everywhere
    const otherProject = makeConversation({ projectId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' })
    useChatStore.setState({ conversations: [conv1, conv2, otherProject], projectId: PROJECT_A })

    useChatStore.getState().deleteAllConversations()

    await vi.waitFor(() => {
      expect(mockConversationsClient.delete).toHaveBeenCalledTimes(2)
    })
    expect(mockConversationsClient.delete).toHaveBeenCalledWith(conv1.id)
    expect(mockConversationsClient.delete).toHaveBeenCalledWith(conv2.id)
    // Out-of-scope sessions (another project) keep their server rows.
    expect(mockConversationsClient.delete).not.toHaveBeenCalledWith(otherProject.id)
  })

  it('syncs a rename to the server row', async () => {
    const conv = makeConversation()
    useChatStore.setState({ conversations: [conv] })

    useChatStore.getState().updateConversationTitle(conv.id, 'Renamed chat')

    await vi.waitFor(() => {
      expect(mockConversationsClient.updateTitle).toHaveBeenCalledWith(conv.id, 'Renamed chat')
    })
  })
})

describe('loadServerConversations merge', () => {
  it('keeps the local title when the server row has none, and normalizes dates', async () => {
    const conv = makeConversation({ title: 'Locally generated title' })
    useChatStore.setState({ conversations: [conv] })
    mockConversationsClient.list.mockResolvedValue([
      {
        id: conv.id,
        title: null,
        createdBy: 'user-1',
        projectId: null,
        createdAt: '2026-07-01T09:00:00.000Z',
        updatedAt: '2026-07-02T09:00:00.000Z',
      },
    ])

    await useChatStore.getState().loadServerConversations()

    const merged = useChatStore.getState().conversations.find((c) => c.id === conv.id)!
    expect(merged.title).toBe('Locally generated title')
    expect(merged.createdAt).toBeInstanceOf(Date)
    expect(merged.updatedAt).toBeInstanceOf(Date)
  })

  it('carries jobId through the merge, so job threads stay out of the chat list', async () => {
    // Regression with a silent failure mode. The merge maps the server row
    // field by field, so a column left out is dropped without a type error and
    // without a failing test — and dropping THIS one makes `isJobConversation`
    // permanently false, which puts every scheduled job's output back into its
    // owner's personal history (a weekly job is 52 threads a year).
    useChatStore.setState({ conversations: [] })
    mockConversationsClient.list.mockResolvedValue([
      {
        id: 's_from_a_job',
        title: 'Weekly OIB scan',
        createdBy: 'user-1',
        projectId: 'proj-1',
        jobId: 'job-1',
        createdAt: '2026-07-01T09:00:00.000Z',
        updatedAt: '2026-07-02T09:00:00.000Z',
      },
      {
        id: 's_from_a_person',
        title: 'A real chat',
        createdBy: 'user-1',
        projectId: 'proj-1',
        createdAt: '2026-07-01T09:00:00.000Z',
        updatedAt: '2026-07-02T09:00:00.000Z',
      },
    ])

    await useChatStore.getState().loadServerConversations()

    const stored = useChatStore.getState().conversations
    expect(stored.find((c) => c.id === 's_from_a_job')?.jobId).toBe('job-1')
    // A conversation a person started must carry null, not undefined-by-accident.
    expect(stored.find((c) => c.id === 's_from_a_person')?.jobId).toBeNull()
  })

  it('hides job threads from the chat list without making them unreachable', async () => {
    // The two halves of "hiding, not withholding". A job's output is not a
    // chat this person started, so it is not in their list — but it is still
    // in the store, so `?session=<id>` and the job's run-history link both
    // still open it.
    useChatStore.setState({ conversations: [], currentUserId: 'user-1', projectId: 'proj-1' })
    mockConversationsClient.list.mockResolvedValue([
      {
        id: 's_from_a_job',
        title: 'Weekly OIB scan',
        createdBy: 'user-1',
        projectId: 'proj-1',
        jobId: 'job-1',
        createdAt: '2026-07-01T09:00:00.000Z',
        updatedAt: '2026-07-02T09:00:00.000Z',
      },
      {
        id: 's_from_a_person',
        title: 'A real chat',
        createdBy: 'user-1',
        projectId: 'proj-1',
        createdAt: '2026-07-01T09:00:00.000Z',
        updatedAt: '2026-07-02T09:00:00.000Z',
      },
    ])

    await useChatStore.getState().loadServerConversations()

    const listed = useChatStore.getState().getUserConversations().map((c) => c.id)
    expect(listed).toContain('s_from_a_person')
    expect(listed).not.toContain('s_from_a_job')
    // Still present in the store — hidden from a list, not withheld.
    expect(useChatStore.getState().conversations.map((c) => c.id)).toContain('s_from_a_job')
  })

  it('preserves the local per-session data-source selection across the merge', async () => {
    // Regression: dropping enabledDataSourceIds re-enables every default data
    // source on the next select, sending messages with sources the user
    // explicitly turned off.
    const conv = makeConversation({ enabledDataSourceIds: [] })
    useChatStore.setState({ conversations: [conv] })
    mockConversationsClient.list.mockResolvedValue([
      {
        id: conv.id,
        title: 'Past chat',
        createdBy: 'user-1',
        projectId: null,
        createdAt: '2026-07-01T09:00:00.000Z',
        updatedAt: '2026-07-02T09:00:00.000Z',
      },
    ])

    await useChatStore.getState().loadServerConversations()

    const merged = useChatStore.getState().conversations.find((c) => c.id === conv.id)!
    expect(merged.enabledDataSourceIds).toEqual([])
  })

  /**
   * A conversation someone ELSE created and shared with me (ADR-0032).
   *
   * `listVisibleConversations` returns it — visibility/grants are resolved
   * server-side — but everything downstream of this merge filters the store on
   * `conversation.userId === currentUserId`: the sessions panel, the
   * `selectConversation` guard, storage protection, deep-research scoping. That
   * field is a MEMBERSHIP marker ("belongs in this user's list"), never rendered
   * as an author — authorship comes from the shared-thread participants. Stamping
   * it with the creator therefore made every shared conversation invisible and
   * unopenable for the person it was shared with, which is the entire feature.
   */
  it('claims a conversation shared by a colleague for the current user', async () => {
    useChatStore.setState({ currentUserId: 'user-anna', conversations: [] })
    mockConversationsClient.list.mockResolvedValue([
      {
        id: 's_shared_1',
        title: 'Brandschutz Halle 3',
        createdBy: 'user-matthias',
        projectId: null,
        createdAt: '2026-07-01T09:00:00.000Z',
        updatedAt: '2026-07-02T09:00:00.000Z',
      },
    ])

    await useChatStore.getState().loadServerConversations()

    const merged = useChatStore.getState().conversations.find((c) => c.id === 's_shared_1')!
    expect(merged.userId).toBe('user-anna')
    // And it is therefore actually reachable — the assertion that matters.
    expect(useChatStore.getState().getUserConversations().map((c) => c.id)).toContain('s_shared_1')

    useChatStore.getState().selectConversation('s_shared_1')
    expect(useChatStore.getState().currentConversation?.id).toBe('s_shared_1')
  })

  it('repopulates the restored current conversation when its messages were pruned', async () => {
    const conv = makeConversation()
    useChatStore.setState({ conversations: [conv], currentConversation: conv })
    mockConversationsClient.list.mockResolvedValue([
      {
        id: conv.id,
        title: 'Past chat',
        createdBy: 'user-1',
        projectId: null,
        createdAt: '2026-07-01T09:00:00.000Z',
        updatedAt: '2026-07-01T09:00:00.000Z',
      },
    ])
    mockConversationsClient.listMessages.mockResolvedValue([
      serverRow(conv.id, 'm1', 'user', 'pruned locally, kept on server'),
    ])

    await useChatStore.getState().loadServerConversations()

    await vi.waitFor(() => {
      expect(useChatStore.getState().currentConversation?.messages).toHaveLength(1)
    })
    expect(useChatStore.getState().currentConversation!.messages[0].content).toBe(
      'pruned locally, kept on server'
    )
  })
})

describe('_appendMessage conversation ensure', () => {
  it('creates the server conversation only once for concurrent appends', async () => {
    const conv = makeConversation({ title: 'Race chat' })
    useChatStore.setState({ conversations: [conv], currentConversation: conv })
    mockConversationsClient.list.mockResolvedValue([])

    const message = (id: string): ChatMessage => ({
      id,
      role: 'user',
      content: `msg ${id}`,
      timestamp: new Date(),
      messageType: 'user',
    })

    await Promise.all([
      useChatStore.getState()._appendMessage(message('m1')),
      useChatStore.getState()._appendMessage(message('m2')),
    ])

    expect(mockConversationsClient.create).toHaveBeenCalledTimes(1)
    expect(mockConversationsClient.createMessage).toHaveBeenCalledTimes(2)
  })
})

describe('hydration-aware interrupted state', () => {
  // A turn that LOOKS interrupted: the last meaningful local message is the
  // user turn carrying thinking steps, with no assistant reply and no pending
  // prompt. This is the exact shape that used to unconditionally show the
  // "response interrupted" banner.
  const interruptedConversation = () => {
    const interruptedUser = {
      id: 'u1',
      role: 'user',
      content: 'What is the height limit?',
      timestamp: new Date('2026-07-01T10:00:00.000Z'),
      messageType: 'user',
      thinkingSteps: [{ id: 'ts1' }],
    } as unknown as ChatMessage
    return makeConversation({ messages: [interruptedUser] })
  }

  it('renders the server-persisted assistant reply and skips the banner', async () => {
    const conv = interruptedConversation()
    useChatStore.setState({ conversations: [conv], currentConversation: conv })
    // Server has the finished response the disconnected client never received.
    mockConversationsClient.listMessages.mockResolvedValue([
      serverRow(conv.id, 'u1', 'user', 'What is the height limit?'),
      serverRow(conv.id, 'assistant-recovered', 'assistant', 'The limit is 12 m.'),
    ])

    useChatStore.getState().restoreSessionState(conv)

    await vi.waitFor(() => {
      const messages = useChatStore.getState().currentConversation!.messages
      expect(messages.some((m) => m.id === 'assistant-recovered')).toBe(true)
    })

    const messages = useChatStore.getState().currentConversation!.messages
    // The recovered assistant reply is rendered, and NO interrupted error card.
    expect(messages.find((m) => m.id === 'assistant-recovered')).toMatchObject({
      role: 'assistant',
      content: 'The limit is 12 m.',
    })
    expect(messages.some((m) => m.messageType === 'error')).toBe(false)
  })

  it('shows the interrupted banner when the server has no assistant reply', async () => {
    const conv = interruptedConversation()
    useChatStore.setState({ conversations: [conv], currentConversation: conv })
    // Server only has the user turn — the response was genuinely lost.
    mockConversationsClient.listMessages.mockResolvedValue([
      serverRow(conv.id, 'u1', 'user', 'What is the height limit?'),
    ])

    useChatStore.getState().restoreSessionState(conv)

    await vi.waitFor(() => {
      const messages = useChatStore.getState().currentConversation!.messages
      expect(messages.some((m) => m.messageType === 'error')).toBe(true)
    })

    const errorCard = useChatStore
      .getState()
      .currentConversation!.messages.find((m) => m.messageType === 'error')
    expect(errorCard?.errorData?.errorCode).toBe('agent.response_interrupted')
  })

  it('shows the interrupted banner when the server refetch fails', async () => {
    const conv = interruptedConversation()
    useChatStore.setState({ conversations: [conv], currentConversation: conv })
    mockConversationsClient.listMessages.mockRejectedValue(new Error('network down'))

    useChatStore.getState().restoreSessionState(conv)

    await vi.waitFor(() => {
      const messages = useChatStore.getState().currentConversation!.messages
      expect(messages.some((m) => m.messageType === 'error')).toBe(true)
    })
  })
})
