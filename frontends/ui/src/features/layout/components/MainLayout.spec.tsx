import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { MainLayout } from './MainLayout'

const mockUpdateSessionUrl = vi.fn()
const mockClearSessionUrl = vi.fn()
const mockSelectConversation = vi.fn()
const mockStartNewSessionDraft = vi.fn()
const mockDeleteConversation = vi.fn()
const mockDeleteAllConversations = vi.fn()
const mockUpdateConversationTitle = vi.fn()
const mockOpenRightPanel = vi.fn()

// Mock the useSessionUrl hook (uses Next.js App Router hooks)
vi.mock('@/hooks/use-session-url', () => ({
  useSessionUrl: vi.fn(() => ({
    updateSessionUrl: mockUpdateSessionUrl,
    clearSessionUrl: mockClearSessionUrl,
  })),
}))

// Per-test overrides merged into the chat-store state. Read lazily inside the
// mock factory (so it is StrictMode-double-render safe — every useChatStore
// call in every render pass sees the same state), and reset in beforeEach.
let chatStoreOverrides: Record<string, unknown> = {}

// Mock the chat store
vi.mock('@/features/chat', () => ({
  useChatStore: vi.fn((selector?: (s: any) => any) => {
    const state = {
      currentConversation: { id: 'session-1', title: 'Test Session' },
      getUserConversations: vi.fn(() => []),
      selectConversation: mockSelectConversation,
      startNewSessionDraft: mockStartNewSessionDraft,
      deleteConversation: mockDeleteConversation,
      deleteAllConversations: mockDeleteAllConversations,
      updateConversationTitle: mockUpdateConversationTitle,
      isStreaming: false,
      pendingInteraction: null,
      isDeepResearchStreaming: false,
      deepResearchOwnerConversationId: null,
      ...chatStoreOverrides,
    }
    return selector ? selector(state) : state
  }),
  useDeepResearch: vi.fn(() => ({
    isResearching: false,
    connect: vi.fn(),
    disconnect: vi.fn(),
    cancel: vi.fn(),
  })),
  NoSourcesBanner: () => <div data-testid="no-sources-banner">No Sources Banner</div>,
}))

// Mock the layout store
vi.mock('../store', () => ({
  useLayoutStore: vi.fn((selector?: (s: any) => any) => {
    const state = {
      rightPanel: null,
      isSessionsPanelOpen: false,
      setSessionsPanelOpen: vi.fn(),
      enabledDataSourceIds: ['source-1', 'source-2'],
      openRightPanel: mockOpenRightPanel,
    }
    return selector ? selector(state) : state
  }),
}))

// Mock child components
vi.mock('./ChatToolbar', () => ({
  ChatToolbar: ({
    sessionTitle,
    onNewSession,
    isNewSessionDisabled,
  }: {
    sessionTitle: string
    onNewSession?: () => void
    isNewSessionDisabled?: boolean
  }) => (
    <>
      <div data-testid="app-bar">{sessionTitle}</div>
      <button type="button" onClick={onNewSession} disabled={isNewSessionDisabled}>
        Header New Session
      </button>
    </>
  ),
}))

vi.mock('./SessionsPanel', () => ({
  SessionsPanel: ({ sessions }: { sessions?: Array<{ id: string }> }) => (
    <div data-testid="sessions-panel">
      {(sessions ?? []).map((s) => (
        <div key={s.id} data-testid={`session-item-${s.id}`} />
      ))}
    </div>
  ),
}))

vi.mock('./ChatArea', () => ({
  ChatArea: () => <div data-testid="chat-area">Chat Area</div>,
}))

vi.mock('./InputArea', () => ({
  InputArea: () => <div data-testid="input-area">Input Area</div>,
}))

vi.mock('./ResearchPanel', () => ({
  ResearchPanel: () => <div data-testid="research-panel">Research Panel</div>,
}))

vi.mock('./DataSourcesPanel', () => ({
  DataSourcesPanel: () => <div data-testid="data-sources-panel">Data Sources Panel</div>,
}))

import { useChatStore } from '@/features/chat'
import { useLayoutStore } from '../store'

describe('MainLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chatStoreOverrides = {}
  })

  test('renders authenticated main sections', () => {
    render(<MainLayout isAuthenticated={true} />)

    expect(screen.getByTestId('app-bar')).toBeInTheDocument()
    expect(screen.getByTestId('sessions-panel')).toBeInTheDocument()
    expect(screen.getByTestId('chat-area')).toBeInTheDocument()
    expect(screen.getByTestId('input-area')).toBeInTheDocument()
    expect(screen.getByTestId('research-panel')).toBeInTheDocument()
    expect(screen.getByTestId('data-sources-panel')).toBeInTheDocument()
  })

  test('hides the data sources panel when unauthenticated', () => {
    render(<MainLayout />)

    expect(screen.getByTestId('app-bar')).toBeInTheDocument()
    expect(screen.getByTestId('sessions-panel')).toBeInTheDocument()
    expect(screen.getByTestId('chat-area')).toBeInTheDocument()
    expect(screen.getByTestId('input-area')).toBeInTheDocument()
    expect(screen.getByTestId('research-panel')).toBeInTheDocument()
    expect(screen.queryByTestId('data-sources-panel')).not.toBeInTheDocument()
  })

  test('passes session title to AppBar', () => {
    render(<MainLayout />)

    expect(screen.getByTestId('app-bar')).toHaveTextContent('Test Session')
  })

  test('shows no session title when no current conversation', () => {
    chatStoreOverrides = { currentConversation: null }

    render(<MainLayout />)

    expect(screen.getByTestId('app-bar')).toHaveTextContent('')
  })

  test('passes auth state to components', () => {
    render(<MainLayout isAuthenticated={true} />)

    // Components render - props are passed to mocked child components
    expect(screen.getByTestId('app-bar')).toBeInTheDocument()
    expect(screen.getByTestId('chat-area')).toBeInTheDocument()
    expect(screen.getByTestId('input-area')).toBeInTheDocument()
  })

  test('wires the AppBar new session action to draft session flow', async () => {
    const user = userEvent.setup()

    render(<MainLayout isAuthenticated={true} />)

    await user.click(screen.getByRole('button', { name: /header new session/i }))

    expect(mockStartNewSessionDraft).toHaveBeenCalledOnce()
    expect(mockClearSessionUrl).toHaveBeenCalledOnce()
    expect(mockOpenRightPanel).toHaveBeenCalledWith('data-sources')
  })

  test('does not open data sources from new session while unauthenticated', async () => {
    const user = userEvent.setup()

    render(<MainLayout />)

    await user.click(screen.getByRole('button', { name: /header new session/i }))

    expect(mockStartNewSessionDraft).toHaveBeenCalledOnce()
    expect(mockClearSessionUrl).toHaveBeenCalledOnce()
    expect(mockOpenRightPanel).not.toHaveBeenCalled()
  })

  test('disables new session action while shallow streaming is active', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) => {
      const state = {
        currentConversation: { id: 'session-1', title: 'Test Session' },
        getUserConversations: vi.fn(() => []),
        selectConversation: vi.fn(),
        startNewSessionDraft: vi.fn(),
        deleteConversation: vi.fn(),
        deleteAllConversations: vi.fn(),
        updateConversationTitle: vi.fn(),
        isStreaming: true,
        pendingInteraction: null,
        isDeepResearchStreaming: false,
        deepResearchOwnerConversationId: null,
      }
      return selector ? selector(state) : state
    })

    render(<MainLayout />)

    expect(screen.getByRole('button', { name: /header new session/i })).toBeDisabled()
  })

  test('adjusts chat width when details panel is open', () => {
    vi.mocked(useLayoutStore).mockImplementation((selector?: (s: any) => any) => {
      const state = {
        rightPanel: 'research',
        isSessionsPanelOpen: false,
        setSessionsPanelOpen: vi.fn(),
        enabledDataSourceIds: ['source-1', 'source-2'],
      }
      return selector ? selector(state) : state
    })

    const { container } = render(<MainLayout />)

    // The chat container should share width evenly with the research panel when open
    const chatContainer = container.querySelector('[style*="width"]')
    expect(chatContainer).toHaveStyle({ width: '50%' })
  })

  test('sessions panel only lists the active project\'s sessions (legacy unscoped fail open)', () => {
    const makeConv = (id: string, projectId?: string | null) => ({
      id,
      userId: 'user-1',
      projectId,
      title: id,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) => {
      const state = {
        currentConversation: null,
        currentUserId: 'user-1',
        projectId: 'proj-a',
        conversations: [
          makeConv('in-project', 'proj-a'),
          makeConv('other-project', 'proj-b'),
          makeConv('legacy', null),
          { ...makeConv('other-user', 'proj-a'), userId: 'user-2' },
        ],
        getUserConversations: vi.fn(() => []),
        selectConversation: vi.fn(),
        startNewSessionDraft: vi.fn(),
        deleteConversation: vi.fn(),
        deleteAllConversations: vi.fn(),
        updateConversationTitle: vi.fn(),
        isStreaming: false,
        pendingInteraction: null,
        isDeepResearchStreaming: false,
        deepResearchOwnerConversationId: null,
      }
      return selector ? selector(state) : state
    })

    render(<MainLayout isAuthenticated={true} />)

    // Cross-project bleed guard (UX-8): project B's session must NOT appear
    // in project A's panel; unscoped legacy sessions stay visible.
    expect(screen.getByTestId('session-item-in-project')).toBeInTheDocument()
    expect(screen.getByTestId('session-item-legacy')).toBeInTheDocument()
    expect(screen.queryByTestId('session-item-other-project')).not.toBeInTheDocument()
    expect(screen.queryByTestId('session-item-other-user')).not.toBeInTheDocument()
  })

  test('shows full width when details panel is closed', () => {
    vi.mocked(useLayoutStore).mockImplementation((selector?: (s: any) => any) => {
      const state = {
        rightPanel: null,
        isSessionsPanelOpen: false,
        setSessionsPanelOpen: vi.fn(),
        enabledDataSourceIds: ['source-1', 'source-2'],
      }
      return selector ? selector(state) : state
    })

    const { container } = render(<MainLayout />)

    const chatContainer = container.querySelector('[style*="width"]')
    expect(chatContainer).toHaveStyle({ width: '100%' })
  })
})
