/**
 * A chat the reader may no longer read (ADR-0087), in the browser's store.
 *
 * The server sends the list row without its title and flagged `contentLocked`,
 * and answers a read of its messages with 403 `RESOURCE_RIGHTS_LOST`. What a
 * browser cached of the chat from when it could read it must not survive
 * either: the title, the messages, and the subject file are dropped, and
 * nothing is fetched for it.
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
  list: vi.fn(),
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
import { chatMessagesKey, isAwaitingServerMessages } from './chat-storage'

const STORE = 'aiq-chat-store'
const flush = () => new Promise((resolve) => setTimeout(resolve, 20))

/** The error the adapter throws for a 403 `RESOURCE_RIGHTS_LOST`; the store knows it by name. */
const rightsLost = () => Object.assign(new Error('rights lost'), { name: 'ConversationRightsLostError' })

const secret: ChatMessage = {
  id: 'm1',
  role: 'user',
  content: 'Was steht im Honorarvertrag Müller?',
  timestamp: new Date('2026-02-01'),
  messageType: 'user',
}

/** A chat this browser read while the reader still could: title, messages and subject cached. */
const cached: Conversation = {
  id: 's_secret',
  userId: 'u1',
  projectId: null,
  title: 'Honorarvertrag Müller',
  subjectResourceType: 'document',
  subjectResourceId: 'doc_9',
  messages: [secret],
  createdAt: new Date('2026-02-01'),
  updatedAt: new Date('2026-02-01'),
}

const other: Conversation = {
  id: 's_other',
  userId: 'u1',
  projectId: null,
  title: 'Brandschutz',
  messages: [{ ...secret, id: 'o1', content: 'Brandschutz?' }],
  createdAt: new Date('2026-02-02'),
  updatedAt: new Date('2026-02-02'),
}

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: 'Brandschutz',
  projectId: null,
  createdBy: 'u1',
  createdAt: '2026-02-01T00:00:00Z',
  updatedAt: '2026-02-03T00:00:00Z',
  ...overrides,
})

/** What the server lists for a locked chat: no title, no tags, no subject, and the flag. */
const lockedRow = (id: string) =>
  row(id, { title: null, tags: [], subjectResourceType: null, subjectResourceId: null, contentLocked: true })

const conversation = (id: string): Conversation | undefined =>
  useChatStore.getState().conversations.find((candidate) => candidate.id === id)

beforeEach(() => {
  localStorage.clear()
  vi.clearAllMocks()
  useChatStore.setState({
    currentUserId: 'u1',
    conversations: [cached, other],
    currentConversation: other,
    projectId: null,
    isStreaming: false,
    isLoading: false,
    pendingInteraction: null,
    composerDrafts: {},
  })
})

describe('the list says a chat is locked', () => {
  it('drops the title, the messages and the subject a browser had cached, and marks it', async () => {
    client.list.mockResolvedValue([lockedRow('s_secret'), row('s_other')])

    await useChatStore.getState().loadServerConversations()

    expect(conversation('s_secret')).toMatchObject({
      contentLocked: true,
      title: '',
      messages: [],
      subjectResourceType: null,
      subjectResourceId: null,
    })
    expect(JSON.stringify(conversation('s_secret'))).not.toContain('Müller')
    // The others are as they were.
    expect(conversation('s_other')?.contentLocked).toBeUndefined()
    expect(conversation('s_other')?.messages).toHaveLength(1)
  })

  it('fetches nothing for it, not even its messages', async () => {
    client.list.mockResolvedValue([lockedRow('s_secret'), lockedRow('s_new')])
    await useChatStore.getState().loadServerConversations()
    await flush()

    useChatStore.getState().selectConversation('s_new')
    await flush()

    expect(client.listMessages).not.toHaveBeenCalled()
    expect(isAwaitingServerMessages('s_new')).toBe(false)
    expect(conversation('s_new')).toMatchObject({ contentLocked: true, title: '', messages: [] })
  })

  it('follows the list for the chat that is OPEN, which is a separate object', async () => {
    useChatStore.setState({ currentConversation: cached })
    client.list.mockResolvedValue([lockedRow('s_secret')])

    await useChatStore.getState().loadServerConversations()

    expect(useChatStore.getState().currentConversation).toMatchObject({
      id: 's_secret',
      contentLocked: true,
      messages: [],
      title: '',
    })
  })

  it('stores no message of it in the browser', async () => {
    client.list.mockResolvedValue([lockedRow('s_secret')])
    await useChatStore.getState().loadServerConversations()
    useChatStore.getState().updateConversationTitle('s_other', 'umbenannt')
    await flush()

    const stored = localStorage.getItem(chatMessagesKey(STORE, 's_secret'))
    expect(stored === null || !stored.includes('Honorarvertrag')).toBe(true)
  })

  it('opens it again, to be read from the server, when the next list says the rights are back', async () => {
    client.list.mockResolvedValue([lockedRow('s_secret')])
    await useChatStore.getState().loadServerConversations()

    client.list.mockResolvedValue([row('s_secret', { title: 'Honorarvertrag Müller' })])
    await useChatStore.getState().loadServerConversations()

    expect(conversation('s_secret')?.contentLocked).toBeUndefined()
    expect(conversation('s_secret')?.title).toBe('Honorarvertrag Müller')
    expect(isAwaitingServerMessages('s_secret')).toBe(true)
  })
})

describe('the server answers 403 rights-lost to a read or a write', () => {
  it('locks the chat when its messages are refused, and drops what was cached', async () => {
    client.listMessages.mockRejectedValue(rightsLost())
    useChatStore.setState({ conversations: [{ ...cached, messages: [] }, other] })

    await useChatStore.getState().hydrateConversationMessages('s_secret')

    expect(conversation('s_secret')).toMatchObject({ contentLocked: true, title: '', messages: [] })
  })

  it('locks the OPEN chat when a message of it is refused, so it closes before the next turn', async () => {
    client.createMessage.mockRejectedValueOnce(rightsLost())
    useChatStore.setState({ currentConversation: cached })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await useChatStore.getState()._appendMessage({ ...secret, id: 'm2', content: 'noch eine Frage' })

    expect(useChatStore.getState().currentConversation).toMatchObject({
      id: 's_secret',
      contentLocked: true,
      messages: [],
    })
    expect(conversation('s_secret')?.contentLocked).toBe(true)
  })

  it('does not lock a chat for any other failure', async () => {
    client.listMessages.mockRejectedValue(new Error('network'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    useChatStore.setState({ conversations: [{ ...cached, messages: [] }, other] })

    await useChatStore.getState().hydrateConversationMessages('s_secret')

    expect(conversation('s_secret')?.contentLocked).toBeUndefined()
    expect(conversation('s_secret')?.title).toBe('Honorarvertrag Müller')
  })
})
