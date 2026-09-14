/**
 * `?session=` hydration on the project chat route.
 *
 * Task rows link to `/app/projects/<id>/chat?session=<conversationId>`, and a
 * finished `chat`-output run IS its conversation — usually a job-produced one
 * the sessions panel deliberately hides. `useSessionUrl` (inside MainLayout)
 * only resolves ids from the personal list, so without hydration here such a
 * link reads as stale, gets stripped, and lands on whatever thread was last
 * active. These tests pin that this client selects the deep-linked thread
 * itself — for job threads and ordinary ones — while never activating another
 * project's session (UX-8) and never inventing a thread for an unknown id.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render } from '@/test-utils'
import { ProjectChatClient } from './project-chat-client'
import { asStoreState, type DeepPartial, type StoreSelector } from '@/test-utils/store-fixtures'
import type { ChatStoreWithHydration } from '@/features/chat/store'
import type { Conversation } from '@/features/chat/types'

let mockSearchParams = new URLSearchParams()
const mockReplace = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mockReplace, push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/app/projects/p1/chat',
  useSearchParams: () => mockSearchParams,
}))

vi.mock('@/adapters/auth', () => ({
  useAuth: () => ({ isAuthenticated: true, signIn: vi.fn() }),
}))

vi.mock('@/features/layout', () => ({
  MainLayout: () => <div data-testid="main-layout-stub" />,
}))

vi.mock('@/features/documents/hooks/use-citation-peek', () => ({
  useCitationPeek: vi.fn(),
}))

vi.mock('@/features/documents/stores/file-preview-store', () => ({
  useFilePreviewStore: Object.assign(
    (selector: (state: { file: null }) => unknown) => selector({ file: null }),
    { getState: () => ({ file: null, close: vi.fn() }) }
  ),
}))

const conversation = (overrides: Partial<Conversation> = {}): Conversation => ({
  id: 'conv-1',
  userId: 'user-1',
  projectId: 'p1',
  jobId: null,
  title: 'Fluchtwege prüfen',
  messages: [],
  createdAt: new Date('2026-09-01T10:00:00Z'),
  updatedAt: new Date('2026-09-01T10:00:00Z'),
  ...overrides,
})

// Fixture for the store fields this client selects. `satisfies` keeps every
// field checked against the real store while the `vi.fn()` methods keep their
// mock types for reconfiguration.
const chatState = {
  currentConversation: null as Conversation | null,
  currentUserId: 'user-1' as string | null,
  conversations: [] as Conversation[],
  serverConversationsLoaded: true as boolean,
  composerSubject: null as { resourceId: string } | null,
  setProjectId: vi.fn(),
  loadServerConversations: vi.fn(async () => {}),
  setComposerPrefill: vi.fn(),
  startNewSessionDraft: vi.fn(),
  selectConversation: vi.fn(),
} satisfies DeepPartial<ChatStoreWithHydration>

vi.mock('@/features/chat', () => ({
  useChatStore: Object.assign(
    (selector?: StoreSelector<ChatStoreWithHydration>) =>
      selector ? selector(asStoreState<ChatStoreWithHydration>(chatState)) : chatState,
    { getState: () => chatState }
  ),
  useLoadJobData: () => ({ loadResearchPanelTab: vi.fn() }),
  useDeepResearchTitle: vi.fn(),
}))

const clientProps = {
  projectId: 'p1',
  showSourceBadges: true,
  showConfidenceChip: true,
  showAnswerFeedback: true,
  showResearchInHistory: false,
  projectCollection: null as string | null,
  projectName: 'Lacknergasse',
}

describe('ProjectChatClient ?session= hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSearchParams = new URLSearchParams()
    chatState.currentConversation = null
    chatState.currentUserId = 'user-1'
    chatState.conversations = []
    chatState.serverConversationsLoaded = true
    chatState.composerSubject = null
  })

  test('selects a job-output conversation the sessions panel hides', () => {
    // The red-team case: a task row's "continue in chat" link names the
    // conversation a finished run wrote into, which carries a jobId and is
    // therefore absent from the personal list `useSessionUrl` consults.
    const jobThread = conversation({ id: 'conv-job', jobId: 'job-1' })
    chatState.conversations = [jobThread]
    mockSearchParams = new URLSearchParams('session=conv-job')

    render(<ProjectChatClient {...clientProps} />)

    expect(chatState.selectConversation).toHaveBeenCalledWith('conv-job')
  })

  test('selects an ordinary same-project conversation', () => {
    const thread = conversation({ id: 'conv-3' })
    chatState.conversations = [thread]
    mockSearchParams = new URLSearchParams('session=conv-3')

    render(<ProjectChatClient {...clientProps} />)

    expect(chatState.selectConversation).toHaveBeenCalledWith('conv-3')
  })

  test('never activates another project’s session (UX-8)', () => {
    chatState.conversations = [conversation({ id: 'conv-other', projectId: 'p2' })]
    mockSearchParams = new URLSearchParams('session=conv-other')

    render(<ProjectChatClient {...clientProps} />)

    expect(chatState.selectConversation).not.toHaveBeenCalled()
  })

  test('waits for the server list, then resolves a never-seen id', () => {
    mockSearchParams = new URLSearchParams('session=conv-late')
    chatState.conversations = []
    chatState.serverConversationsLoaded = false

    const { rerender } = render(<ProjectChatClient {...clientProps} />)
    expect(chatState.selectConversation).not.toHaveBeenCalled()

    // The project load lands: the id resolves and is selected.
    chatState.conversations = [conversation({ id: 'conv-late' })]
    chatState.serverConversationsLoaded = true
    rerender(<ProjectChatClient {...clientProps} />)

    expect(chatState.selectConversation).toHaveBeenCalledWith('conv-late')
  })

  test('leaves a genuinely unknown id alone for stale handling', () => {
    chatState.conversations = [conversation({ id: 'conv-1' })]
    chatState.serverConversationsLoaded = true
    mockSearchParams = new URLSearchParams('session=conv-gone')

    render(<ProjectChatClient {...clientProps} />)

    // Selecting nothing keeps the wrong thread from opening here;
    // `useSessionUrl` clears the stale param.
    expect(chatState.selectConversation).not.toHaveBeenCalled()
  })
})
