/**
 * A post-answer stage frame, from arrival to the message it lands on
 * (`docs/architecture/post-answer-stages.md` §4.3, §7.2, §8).
 *
 * The interesting behaviour here is almost entirely REFUSAL. A stage's output
 * is a navigation aid on an answer that is already delivered and already read,
 * so the reader loses nothing when it is dropped — and the design spends that
 * licence on a hard rule: the rail reserves no space, and therefore must never
 * appear anywhere it could push something the reader has already read.
 *
 * §8 justifies "reserve nothing" with "the rail is the last element in the
 * column, so growing it moves nothing". That is true of the message's own
 * column and NOT true of the thread: an answer with a later message under it
 * has a whole conversation below the rail. The last-message check is what makes
 * the design's claim true rather than nearly true, and these tests are where it
 * is stated.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../store'
import type { ChatMessage, Conversation } from '../types'

const STORAGE_KEY = 'aiq-chat-store'
const PARENT = 'msg_1755600000000_3'

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
  updateMessageStages: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/adapters/api/conversations-client', () => ({
  conversationsClient: mockConversationsClient,
}))

const answer = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'msg-answer',
  role: 'assistant',
  content: 'Das Fluchtniveau ist …',
  timestamp: new Date('2026-08-19T10:31:00.000Z'),
  messageType: 'agent_response',
  wsParentId: PARENT,
  ...overrides,
})

const threadOf = (...messages: ChatMessage[]): Conversation => ({
  id: 'conv-1',
  userId: 'user-1',
  title: 'Fluchtniveau',
  messages,
  createdAt: new Date('2026-08-19T10:30:00.000Z'),
  updatedAt: new Date('2026-08-19T10:31:00.000Z'),
})

const seed = (conversation: Conversation) =>
  useChatStore.setState({
    currentUserId: 'user-1',
    currentConversation: conversation,
    conversations: [conversation],
    composerDrafts: {},
  })

const READY = {
  conversationId: 'conv-1',
  parentId: PARENT,
  stage: 'follow_ups' as const,
  status: 'ready' as const,
  payload: {
    items: [
      { question: 'Wie wird das Fluchtniveau genau gemessen?', hint: 'Messpunkt und Bezugsebene' },
      { question: 'Was wäre bei Gebäudeklasse 5 anders?' },
    ],
  },
}

/**
 * What the reflection stage delivered for this turn: the rows it wrote, in write
 * order. Unlike the rail's, this payload is a record of something that HAPPENED
 * — `project_memory` already holds these rows — so the rules it lands under are
 * different, and the block at the bottom of this file is where that is stated.
 */
const NOTED = {
  conversationId: 'conv-1',
  parentId: PARENT,
  stage: 'memory_reflection' as const,
  status: 'ready' as const,
  payload: {
    items: [
      {
        id: '9d2f6b41-7c3e-4a58-9f0b-6a1c2d3e4f50',
        kind: 'derived_fact',
        content: 'Das oberste Fluchtniveau beträgt 9,80 m.',
      },
    ],
  },
}

const storedOn = (messageId: string) =>
  useChatStore.getState().currentConversation?.messages.find((m) => m.id === messageId)?.stages

describe('the turn key crosses from the socket onto the answer', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
    vi.clearAllMocks()
    useChatStore.setState({ currentTurnWsParentId: null })
  })

  it('stamps the streaming bubble with the WS turn id of the turn in flight', () => {
    seed(threadOf())
    useChatStore.getState().setTurnWsParentId(PARENT)
    useChatStore.getState().appendAgentResponseDelta('Das Fluchtniveau ')

    const bubble = useChatStore.getState().currentConversation?.messages.at(-1)
    expect(bubble?.wsParentId).toBe(PARENT)
  })

  it('forgets the turn key when the next turn starts', () => {
    // Two answers carrying one turn key would give a late frame two targets.
    seed(threadOf())
    useChatStore.getState().setTurnWsParentId(PARENT)
    useChatStore.getState().addUserMessage('Und bei Hanglage?')

    expect(useChatStore.getState().currentTurnWsParentId).toBeNull()
  })
})

describe('a ready frame lands on the turn it addresses', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
    vi.clearAllMocks()
    seed(threadOf(answer()))
  })

  it('stores the payload under the stage key of the matching message', () => {
    expect(useChatStore.getState().applyStageFrame(READY)).toBe('msg-answer')
    expect(storedOn('msg-answer')?.followUps?.items).toHaveLength(2)
    expect(storedOn('msg-answer')?.followUps?.items[0]).toEqual({
      question: 'Wie wird das Fluchtniveau genau gemessen?',
      hint: 'Messpunkt und Bezugsebene',
    })
  })

  it('overwrites rather than appends on a duplicate delivery', () => {
    // A reconnect replays the bus stream (§7.2). A fixed key makes two chip
    // sets structurally impossible.
    useChatStore.getState().applyStageFrame(READY)
    useChatStore.getState().applyStageFrame(READY)
    expect(storedOn('msg-answer')?.followUps?.items).toHaveLength(2)
  })

  it('mirrors what it stored onto the server message row', async () => {
    // The browser is what persists it, and that is not an implementation
    // detail: the agent tier holds the turn id and the browser holds the row id
    // (§1.6). The half that owns the row does the writing.
    useChatStore.getState().applyStageFrame(READY)

    await vi.waitFor(() =>
      expect(mockConversationsClient.updateMessageStages).toHaveBeenCalledWith(
        'conv-1',
        'msg-answer',
        { followUps: { items: expect.arrayContaining([expect.objectContaining({ question: expect.any(String) })]) } },
      ),
    )
  })

  it('drops a payload its own contract rejects', () => {
    expect(
      useChatStore.getState().applyStageFrame({ ...READY, payload: { items: [{ hint: 'nur ein Hinweis' }] } }),
    ).toBeNull()
    expect(storedOn('msg-answer')).toBeUndefined()
  })
})

describe('a frame with nothing to show changes nothing', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
    vi.clearAllMocks()
    seed(threadOf(answer()))
  })

  it.each(['empty', 'failed'] as const)('%s is rendered as nothing and persisted as nothing', (status) => {
    expect(useChatStore.getState().applyStageFrame({ ...READY, status, payload: undefined })).toBeNull()
    expect(storedOn('msg-answer')).toBeUndefined()
    expect(mockConversationsClient.updateMessageStages).not.toHaveBeenCalled()
  })
})

describe('a frame that could move something already read is refused', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
    vi.clearAllMocks()
  })

  it('refuses a turn that has a later message under it', () => {
    // The §8 claim — "the rail is the last element, so growing it moves nothing"
    // — is false the moment anything sits below the answer.
    seed(
      threadOf(
        answer(),
        { id: 'msg-next', role: 'user', content: 'Und bei Hanglage?', timestamp: new Date(), messageType: 'user' },
      ),
    )
    expect(useChatStore.getState().applyStageFrame(READY)).toBeNull()
    expect(storedOn('msg-answer')).toBeUndefined()
  })

  it('refuses an answer that is still streaming', () => {
    seed(threadOf(answer({ isStreaming: true })))
    expect(useChatStore.getState().applyStageFrame(READY)).toBeNull()
    expect(storedOn('msg-answer')).toBeUndefined()
  })

  it('refuses once the reader has started typing their own question', () => {
    seed(threadOf(answer()))
    useChatStore.setState({ composerDrafts: { 'conv-1': 'Und wenn das Dachgeschoß ' } })
    expect(useChatStore.getState().applyStageFrame(READY)).toBeNull()
    expect(storedOn('msg-answer')).toBeUndefined()
  })

  it('is not put off by whitespace left in the composer', () => {
    seed(threadOf(answer()))
    useChatStore.setState({ composerDrafts: { 'conv-1': '   \n' } })
    expect(useChatStore.getState().applyStageFrame(READY)).toBe('msg-answer')
  })
})

describe('a frame addressed to no message here is dropped silently', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
    vi.clearAllMocks()
  })

  it('drops a frame whose parent_id matches nothing', () => {
    seed(threadOf(answer({ wsParentId: 'msg_1755600000000_9' })))
    expect(useChatStore.getState().applyStageFrame(READY)).toBeNull()
  })

  it('drops a frame for a conversation this tab is not looking at', () => {
    seed(threadOf(answer()))
    expect(
      useChatStore.getState().applyStageFrame({ ...READY, conversationId: 'conv-other' }),
    ).toBeNull()
    expect(storedOn('msg-answer')).toBeUndefined()
  })

  it('never lands on the user message that shares the turn', () => {
    // Both halves of a turn can carry the same key; only the ANSWER may be
    // addressed by a stage.
    seed(
      threadOf({
        id: 'msg-user',
        role: 'user',
        content: 'Was ist das Fluchtniveau?',
        timestamp: new Date(),
        messageType: 'user',
        wsParentId: PARENT,
      }),
    )
    expect(useChatStore.getState().applyStageFrame(READY)).toBeNull()
  })
})

describe('a second stage writes beside the first, not over it', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
    vi.clearAllMocks()
    seed(threadOf(answer()))
  })

  it('stores the reflection stage under its own key', () => {
    expect(useChatStore.getState().applyStageFrame(NOTED)).toBe('msg-answer')
    expect(storedOn('msg-answer')?.memoryReflection?.items).toEqual([
      {
        id: '9d2f6b41-7c3e-4a58-9f0b-6a1c2d3e4f50',
        kind: 'derived_fact',
        content: 'Das oberste Fluchtniveau beträgt 9,80 m.',
      },
    ])
  })

  it('lets both stages land on one turn without either erasing the other', () => {
    // §7.7. The two stages are independent tasks with no ordering between them,
    // so this must hold in either arrival order.
    useChatStore.getState().applyStageFrame(NOTED)
    useChatStore.getState().applyStageFrame(READY)
    expect(storedOn('msg-answer')?.memoryReflection?.items).toHaveLength(1)
    expect(storedOn('msg-answer')?.followUps?.items).toHaveLength(2)
  })

  it('mirrors the reflection payload onto the server row under its own key', async () => {
    // The turn identity is the ONLY thing this write adds: the rows themselves
    // are already in `project_memory`. Which TURN produced them lives nowhere
    // else, which is what made the old chip per-conversation.
    useChatStore.getState().applyStageFrame(NOTED)
    await vi.waitFor(() =>
      expect(mockConversationsClient.updateMessageStages).toHaveBeenCalledWith('conv-1', 'msg-answer', {
        memoryReflection: { items: [expect.objectContaining({ kind: 'derived_fact' })] },
      }),
    )
  })

  it('drops a payload whose kind no project_memory row could carry', () => {
    expect(
      useChatStore
        .getState()
        .applyStageFrame({ ...NOTED, payload: { items: [{ id: 'a', kind: 'geheim', content: 'x' }] } }),
    ).toBeNull()
    expect(storedOn('msg-answer')).toBeUndefined()
  })
})

describe('a record of a write is not held to the rules a suggestion is', () => {
  // §8's three arrival conditions exist to protect the page from a block that
  // appears BELOW the answer and pushes what is under it. The memory chip is
  // not that: it renders inside the answer's own footer meta row, which is
  // already on screen and already reserved at `min-h-6` before the stage
  // finishes. Applying the rail's conditions to it would suppress the only
  // notice a reader gets that something was written to their project's durable
  // memory — and suppress it precisely in the cases that are most likely.
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY)
    vi.clearAllMocks()
  })

  it('lands even though the reader has already asked the next question', () => {
    // The most common case of all: reflection takes seconds, and a reader who
    // moves on still needs to see what was recorded about their project.
    seed(
      threadOf(answer(), {
        id: 'msg-next',
        role: 'user',
        content: 'Und bei Hanglage?',
        timestamp: new Date(),
        messageType: 'user',
      }),
    )
    expect(useChatStore.getState().applyStageFrame(NOTED)).toBe('msg-answer')
    expect(storedOn('msg-answer')?.memoryReflection?.items).toHaveLength(1)
  })

  it('lands while the answer is still streaming', () => {
    // Not a hypothetical: reflection is scheduled BEFORE the answer's deltas
    // are yielded, so on a long answer its frame genuinely can arrive first.
    // Refusing it there would lose the record on exactly the longest turns.
    seed(threadOf(answer({ isStreaming: true })))
    expect(useChatStore.getState().applyStageFrame(NOTED)).toBe('msg-answer')
  })

  it('lands while the reader is typing', () => {
    seed(threadOf(answer()))
    useChatStore.setState({ composerDrafts: { 'conv-1': 'Und wenn das Dachgeschoß ' } })
    expect(useChatStore.getState().applyStageFrame(NOTED)).toBe('msg-answer')
  })

  it('is still refused when it addresses no answer in this tab', () => {
    // The two refusals that are about IDENTITY rather than about movement hold
    // for every stage: a frame for another turn, or another conversation, is
    // not this message's to carry.
    seed(threadOf(answer({ wsParentId: 'msg_1755600000000_9' })))
    expect(useChatStore.getState().applyStageFrame(NOTED)).toBeNull()
    expect(useChatStore.getState().applyStageFrame({ ...NOTED, conversationId: 'conv-other' })).toBeNull()
  })

  it('overwrites rather than appends when a reconnect replays it', () => {
    // §7.2: the bus replays a frame after a reconnect, and a fixed key makes a
    // second „Piloti hat sich gemerkt 2" structurally impossible.
    seed(threadOf(answer()))
    useChatStore.getState().applyStageFrame(NOTED)
    useChatStore.getState().applyStageFrame(NOTED)
    expect(storedOn('msg-answer')?.memoryReflection?.items).toHaveLength(1)
  })
})
