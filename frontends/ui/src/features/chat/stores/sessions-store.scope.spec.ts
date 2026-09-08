/**
 * The store's half of the two chat surfaces (ADR-0054): what `setScope` does to
 * the state around it, which rows the Büro asks the server for, and which rows
 * each surface then lists.
 *
 * These are the guards a later refactor is most likely to lose, because every
 * one of them is a NEGATIVE: nothing renders differently until a project thread
 * leaks into the office, and by then it has been retrieved against.
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
import type { Conversation } from '../types'

const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: `s_${Math.random().toString(36).slice(2)}`,
  userId: 'user-1',
  projectId: null,
  title: 'A chat',
  messages: [],
  createdAt: new Date('2026-09-01T09:00:00.000Z'),
  updatedAt: new Date('2026-09-01T09:00:00.000Z'),
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockConversationsClient.list.mockResolvedValue([])
  mockConversationsClient.listMessages.mockResolvedValue([])
  useChatStore.setState({
    currentUserId: 'user-1',
    currentConversation: null,
    conversations: [],
    projectId: null,
    scope: 'project',
    isStreaming: false,
    isLoading: false,
    pendingInteraction: null,
    composerDrafts: {},
  })
})

describe('setScope', () => {
  it('clears the active project when the Büro opens', () => {
    useChatStore.setState({ projectId: 'proj-a' })

    useChatStore.getState().setScope('workspace')

    expect(useChatStore.getState().scope).toBe('workspace')
    expect(useChatStore.getState().projectId).toBeNull()
  })

  it("drops a project thread rather than continuing it in the office", () => {
    const projectThread = conversation({ projectId: 'proj-a', scope: 'project' })
    useChatStore.setState({
      projectId: 'proj-a',
      conversations: [projectThread],
      currentConversation: projectThread,
    })

    useChatStore.getState().setScope('workspace')

    expect(useChatStore.getState().currentConversation).toBeNull()
  })

  it('keeps a workspace thread selected when the Büro opens', () => {
    const officeThread = conversation({ scope: 'workspace' })
    useChatStore.setState({ conversations: [officeThread], currentConversation: officeThread })

    useChatStore.getState().setScope('workspace')

    expect(useChatStore.getState().currentConversation?.id).toBe(officeThread.id)
  })

  it('restores the project surface on the way back', () => {
    useChatStore.getState().setScope('workspace')
    useChatStore.getState().setScope('project')

    expect(useChatStore.getState().scope).toBe('project')
  })
})

describe('loadServerConversations', () => {
  it('asks for workspace rows in the Büro, and names no project', async () => {
    useChatStore.getState().setScope('workspace')

    await useChatStore.getState().loadServerConversations()

    expect(mockConversationsClient.list).toHaveBeenCalledWith({ scope: 'workspace' })
  })

  it("asks for the project's rows in a project", async () => {
    await useChatStore.getState().loadServerConversations('proj-a')

    expect(mockConversationsClient.list).toHaveBeenCalledWith({ projectId: 'proj-a' })
  })

  it('keeps the scope a server row declares', async () => {
    mockConversationsClient.list.mockResolvedValue([
      {
        id: 's_office',
        projectId: null,
        scope: 'workspace',
        title: 'Office chat',
        createdAt: '2026-09-01T09:00:00.000Z',
        updatedAt: '2026-09-01T09:00:00.000Z',
      },
    ])

    useChatStore.getState().setScope('workspace')
    await useChatStore.getState().loadServerConversations()

    expect(useChatStore.getState().conversations[0].scope).toBe('workspace')
  })
})

describe('getUserConversations', () => {
  it('lists only workspace threads in the Büro', () => {
    const office = conversation({ scope: 'workspace', title: 'Office' })
    const project = conversation({ projectId: 'proj-a', scope: 'project', title: 'Project' })
    const legacy = conversation({ title: 'Legacy' })
    useChatStore.setState({ conversations: [office, project, legacy], scope: 'workspace' })

    const titles = useChatStore
      .getState()
      .getUserConversations()
      .map((c) => c.title)

    // The legacy row has no project and no scope, so the office is where it
    // belongs — the same reading the server-side backfill made.
    expect(titles).toEqual(['Office', 'Legacy'])
  })

  it('keeps office threads out of a project', () => {
    const office = conversation({ scope: 'workspace', title: 'Office' })
    const project = conversation({ projectId: 'proj-a', scope: 'project', title: 'Project' })
    useChatStore.setState({
      conversations: [office, project],
      projectId: 'proj-a',
      scope: 'project',
    })

    const titles = useChatStore
      .getState()
      .getUserConversations()
      .map((c) => c.title)

    expect(titles).toEqual(['Project'])
  })
})

describe('createConversation', () => {
  it('stamps a new thread with the surface it was started on', () => {
    useChatStore.getState().setScope('workspace')

    const created = useChatStore.getState().createConversation()

    expect(created.scope).toBe('workspace')
    expect(created.projectId).toBeNull()
  })
})
