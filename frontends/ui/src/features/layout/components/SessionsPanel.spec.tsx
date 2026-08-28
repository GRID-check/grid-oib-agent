import type { ReactNode } from 'react'
import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { SessionsPanel } from './SessionsPanel'
import type { ResearchRun } from '@/adapters/api/research-runs-client'
import { asStoreState, type DeepPartial, type StoreSelector } from '@/test-utils/store-fixtures'
import type { LayoutStore } from '../types'
import type { ChatStoreWithHydration } from '@/features/chat/store'

// Mock the layout store
const mockSetSessionsPanelOpen = vi.fn()

// FB-10: the Deep Research section fetches server-truth runs on panel open.
const mockListResearchRuns = vi.fn()
vi.mock('@/adapters/api/research-runs-client', () => ({
  listResearchRuns: (...args: unknown[]) => mockListResearchRuns(...args),
}))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

vi.mock('../store', () => ({
  useLayoutStore: vi.fn((selector?: StoreSelector<LayoutStore>) => {
    const state: DeepPartial<LayoutStore> = {
      isSessionsPanelOpen: true,
      setSessionsPanelOpen: mockSetSessionsPanelOpen,
    }
    return selector ? selector(asStoreState<LayoutStore>(state)) : state
  }),
}))

// Mock the chat store (no longer uses useIsCurrentSessionBusy for navigation)
vi.mock('@/features/chat', () => ({
  useChatStore: vi.fn(),
}))

// Mock the delete confirmation modal
vi.mock('./DeleteSessionConfirmationModal', () => ({
  DeleteSessionConfirmationModal: ({
    open,
    onConfirm,
    onOpenChange,
  }: {
    open: boolean
    onConfirm: () => void
    onOpenChange: (open: boolean) => void
  }) =>
    open ? (
      <div data-testid="delete-modal">
        <button onClick={onConfirm}>Confirm Delete</button>
        <button onClick={() => onOpenChange(false)}>Cancel</button>
      </div>
    ) : null,
}))

import { useLayoutStore } from '../store'
import { useChatStore } from '@/features/chat'

/**
 * Helper to create a mock chat store state.
 * Components select individual fields via useChatStore((state) => state.X).
 */
const createMockChatState = (
  overrides: {
    isSessionBusy?: (sessionId: string) => boolean
    hasAnyBusySession?: () => boolean
    isStreaming?: boolean
    pendingInteraction?: { id: string; type: string; content: string } | null
    refreshDeepResearchSessionStatuses?: () => Promise<void>
  } = {}
) => ({
  isSessionBusy: overrides.isSessionBusy ?? (() => false),
  hasAnyBusySession: overrides.hasAnyBusySession ?? (() => false),
  isStreaming: overrides.isStreaming ?? false,
  pendingInteraction: overrides.pendingInteraction ?? null,
  refreshDeepResearchSessionStatuses: overrides.refreshDeepResearchSessionStatuses ?? vi.fn(),
})

const setupChatStoreMock = (overrides: Parameters<typeof createMockChatState>[0] = {}) => {
  const state = createMockChatState(overrides)
  vi.mocked(useChatStore).mockImplementation((selector: StoreSelector<ChatStoreWithHydration>) => {
    if (typeof selector === 'function') {
      return selector(asStoreState<ChatStoreWithHydration>(state))
    }
    return undefined
  })
}

/** The card row (`<li>`) a chat button lives in — where the row styling sits. */
const rowOf = (element: HTMLElement): HTMLElement => {
  const row = element.closest('li')
  if (!row) throw new Error('expected the element to sit inside a list row')
  return row
}

describe('SessionsPanel', () => {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  const mockSessions = [
    { id: 'session-1', title: 'First Session', date: today },
    { id: 'session-2', title: 'Second Session', date: yesterday },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    setupChatStoreMock()

    // Reset mock to default open state
    vi.mocked(useLayoutStore).mockImplementation((selector?: StoreSelector<LayoutStore>) => {
      const state: DeepPartial<LayoutStore> = {
        isSessionsPanelOpen: true,
        setSessionsPanelOpen: mockSetSessionsPanelOpen,
      }
      return selector ? selector(asStoreState<LayoutStore>(state)) : state
    })
  })

  test('renders panel with heading', () => {
    render(<SessionsPanel sessions={mockSessions} />)

    expect(screen.getByText('Chat history')).toBeInTheDocument()
  })

  test('renders the new-chat button', () => {
    render(<SessionsPanel sessions={mockSessions} />)

    expect(screen.getByRole('button', { name: /start a new chat/i })).toBeInTheDocument()
  })

  test('states how many chats the project has', () => {
    render(<SessionsPanel sessions={mockSessions} />)

    expect(screen.getByText('2 chats')).toBeInTheDocument()
  })

  test('renders session list grouped by date', () => {
    render(<SessionsPanel sessions={mockSessions} />)

    expect(screen.getByText('Today')).toBeInTheDocument()
    expect(screen.getByText('Yesterday')).toBeInTheDocument()
    expect(screen.getByText('First Session')).toBeInTheDocument()
    expect(screen.getByText('Second Session')).toBeInTheDocument()
  })

  test('does not render the scope filter when the research section is off', () => {
    render(<SessionsPanel sessions={mockSessions} />)

    expect(screen.queryByRole('radiogroup', { name: /filter history/i })).not.toBeInTheDocument()
  })

  test('shows empty state when no sessions', () => {
    render(<SessionsPanel sessions={[]} />)

    expect(screen.getByText('No chats yet')).toBeInTheDocument()
    // The pinned New chat button is the only CTA — the empty state does not add
    // a second identical one two rows below it.
    expect(screen.getAllByRole('button', { name: /start a new chat/i })).toHaveLength(1)
  })

  test('hides search and delete-all when there is nothing to search or delete', () => {
    render(<SessionsPanel sessions={[]} />)

    expect(screen.queryByRole('textbox', { name: /search chats/i })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /delete all chats in this project/i })
    ).not.toBeInTheDocument()
  })

  test('shows the search-specific empty state, quoting the query, when nothing matches', async () => {
    const user = userEvent.setup()
    render(<SessionsPanel sessions={mockSessions} />)

    await user.type(screen.getByRole('textbox', { name: /search chats/i }), 'zzzzz')

    expect(screen.getByText('No matching chats')).toBeInTheDocument()
    expect(screen.getByText(/zzzzz/)).toBeInTheDocument()
  })

  test('reports how much of the list the query is hiding', async () => {
    const user = userEvent.setup()
    render(<SessionsPanel sessions={mockSessions} />)

    await user.type(screen.getByRole('textbox', { name: /search chats/i }), 'First')

    expect(screen.getByText('1 of 2 chats')).toBeInTheDocument()
  })

  test('clearing the search restores the full list', async () => {
    const user = userEvent.setup()
    render(<SessionsPanel sessions={mockSessions} />)

    const search = screen.getByRole('textbox', { name: /search chats/i })
    await user.type(search, 'First')
    expect(screen.queryByText('Second Session')).not.toBeInTheDocument()

    // Two ways out of a filtered list, both real controls.
    await user.click(screen.getAllByRole('button', { name: /clear search/i })[0])

    expect(screen.getByText('Second Session')).toBeInTheDocument()
    expect(search).toHaveValue('')
  })

  test('finds an untitled chat by the placeholder the user actually sees', async () => {
    const user = userEvent.setup()
    render(<SessionsPanel sessions={[{ id: 'blank', title: '', date: today }]} />)

    await user.type(screen.getByRole('textbox', { name: /search chats/i }), 'untitled')

    expect(screen.getByRole('button', { name: /chat: untitled chat/i })).toBeInTheDocument()
  })

  test('calls onNewSession when new session button clicked', async () => {
    const user = userEvent.setup()
    const onNewSession = vi.fn()

    render(<SessionsPanel sessions={mockSessions} onNewSession={onNewSession} />)

    await user.click(screen.getByRole('button', { name: /start a new chat/i }))

    expect(onNewSession).toHaveBeenCalled()
    expect(mockSetSessionsPanelOpen).toHaveBeenCalledWith(false)
  })

  test('calls onSelectSession when session clicked', async () => {
    const user = userEvent.setup()
    const onSelectSession = vi.fn()

    render(<SessionsPanel sessions={mockSessions} onSelectSession={onSelectSession} />)

    await user.click(screen.getByRole('button', { name: /chat: first session/i }))

    expect(onSelectSession).toHaveBeenCalledWith('session-1')
    expect(mockSetSessionsPanelOpen).toHaveBeenCalledWith(false)
  })

  test('highlights selected session', () => {
    render(<SessionsPanel sessions={mockSessions} selectedSessionId="session-1" />)

    const firstSession = screen.getByRole('button', { name: /chat: first session/i })
    // The selected treatment sits on the card row the button stretches over,
    // and the row also announces itself to AT.
    expect(rowOf(firstSession)).toHaveClass('bg-accent')
    expect(firstSession).toHaveAttribute('aria-current', 'true')
  })

  test('shows edit and delete icons on hover', async () => {
    const user = userEvent.setup()
    render(<SessionsPanel sessions={mockSessions} />)

    const sessionItem = screen.getByRole('button', { name: /chat: first session/i })
    await user.hover(sessionItem)

    expect(screen.getByRole('button', { name: /rename chat/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete chat/i })).toBeInTheDocument()
  })

  test('states in the footer where chats actually live: the workspace, not this browser', () => {
    render(<SessionsPanel sessions={mockSessions} />)

    expect(
      screen.getByText(/Chats are saved to your workspace and available on any device/i)
    ).toBeInTheDocument()
  })

  test('says why every row is dimmed while a turn is in flight', () => {
    setupChatStoreMock({ isStreaming: true })

    render(<SessionsPanel sessions={mockSessions} />)

    expect(
      screen.getByText(/Starting or switching chats is paused until it finishes/i)
    ).toBeInTheDocument()
  })

  test('says nothing about the block when nothing is in flight', () => {
    render(<SessionsPanel sessions={mockSessions} />)

    expect(screen.queryByText(/switching chats is paused/i)).not.toBeInTheDocument()
  })

  test('drops a stale query when the panel closes', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<SessionsPanel sessions={mockSessions} />)

    await user.type(screen.getByRole('textbox', { name: /search chats/i }), 'First')
    expect(screen.queryByText('Second Session')).not.toBeInTheDocument()

    vi.mocked(useLayoutStore).mockImplementation((selector?: StoreSelector<LayoutStore>) => {
      const state: DeepPartial<LayoutStore> = {
        isSessionsPanelOpen: false,
        setSessionsPanelOpen: mockSetSessionsPanelOpen,
      }
      return selector ? selector(asStoreState<LayoutStore>(state)) : state
    })
    // A fresh array so the memoized component actually re-renders — in the app
    // the store subscription does that job.
    rerender(<SessionsPanel sessions={[...mockSessions]} />)

    // Closed, the sheet unmounts its content entirely (Radix dialog) — after
    // the exit animation, hence the waitFor: the rows are motion elements now,
    // so dismissal plays out instead of snapping.
    await waitFor(() => {
      expect(screen.queryByRole('textbox', { name: /search chats/i })).not.toBeInTheDocument()
    })

    // Reopen: the stale query is gone and the list is unfiltered.
    vi.mocked(useLayoutStore).mockImplementation((selector?: StoreSelector<LayoutStore>) => {
      const state: DeepPartial<LayoutStore> = {
        isSessionsPanelOpen: true,
        setSessionsPanelOpen: mockSetSessionsPanelOpen,
      }
      return selector ? selector(asStoreState<LayoutStore>(state)) : state
    })
    rerender(<SessionsPanel sessions={[...mockSessions]} />)
    expect(screen.getByRole('textbox', { name: /search chats/i })).toHaveValue('')
    expect(screen.getByText('Second Session')).toBeInTheDocument()
  })

  test('checks persisted deep research jobs when the sessions panel opens', () => {
    const refreshDeepResearchSessionStatuses = vi.fn().mockResolvedValue(undefined)
    setupChatStoreMock({ refreshDeepResearchSessionStatuses })

    render(<SessionsPanel sessions={mockSessions} />)

    expect(refreshDeepResearchSessionStatuses).toHaveBeenCalledTimes(1)
  })

  test('does not start overlapping deep research status refreshes', async () => {
    let isPanelOpen = true
    let resolveRefresh: () => void = () => {}
    const refreshDeepResearchSessionStatuses = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve
        })
    )
    setupChatStoreMock({ refreshDeepResearchSessionStatuses })
    vi.mocked(useLayoutStore).mockImplementation((selector?: StoreSelector<LayoutStore>) => {
      const state: DeepPartial<LayoutStore> = {
        isSessionsPanelOpen: isPanelOpen,
        setSessionsPanelOpen: mockSetSessionsPanelOpen,
      }
      return selector ? selector(asStoreState<LayoutStore>(state)) : state
    })

    const { rerender } = render(<SessionsPanel sessions={mockSessions} />)

    expect(refreshDeepResearchSessionStatuses).toHaveBeenCalledTimes(1)

    isPanelOpen = false
    rerender(<SessionsPanel sessions={[...mockSessions]} />)
    isPanelOpen = true
    rerender(<SessionsPanel sessions={[...mockSessions]} />)

    expect(refreshDeepResearchSessionStatuses).toHaveBeenCalledTimes(1)

    resolveRefresh()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    isPanelOpen = false
    rerender(<SessionsPanel sessions={[...mockSessions]} />)
    await Promise.resolve()
    isPanelOpen = true
    rerender(<SessionsPanel sessions={[...mockSessions]} />)

    await vi.waitFor(() => {
      expect(refreshDeepResearchSessionStatuses).toHaveBeenCalledTimes(2)
    })
  })

  test('does not show session content when panel is closed', () => {
    vi.mocked(useLayoutStore).mockImplementation((selector?: StoreSelector<LayoutStore>) => {
      const state: DeepPartial<LayoutStore> = {
        isSessionsPanelOpen: false,
        setSessionsPanelOpen: mockSetSessionsPanelOpen,
      }
      return selector ? selector(asStoreState<LayoutStore>(state)) : state
    })

    render(<SessionsPanel sessions={mockSessions} />)

    // A closed sheet renders NOTHING — the Radix dialog unmounts its content,
    // so there is no hidden copy of the history in the DOM to leak into the
    // tab order or the accessibility tree.
    expect(screen.queryByText('Chat history')).not.toBeInTheDocument()
  })

  test('does not refresh deep research job state when panel is closed', () => {
    const refreshDeepResearchSessionStatuses = vi.fn().mockResolvedValue(undefined)
    setupChatStoreMock({ refreshDeepResearchSessionStatuses })
    vi.mocked(useLayoutStore).mockImplementation((selector?: StoreSelector<LayoutStore>) => {
      const state: DeepPartial<LayoutStore> = {
        isSessionsPanelOpen: false,
        setSessionsPanelOpen: mockSetSessionsPanelOpen,
      }
      return selector ? selector(asStoreState<LayoutStore>(state)) : state
    })

    render(<SessionsPanel sessions={mockSessions} />)

    expect(refreshDeepResearchSessionStatuses).not.toHaveBeenCalled()
  })

  // The leading icon is decorative; the row is one button whose accessible name
  // carries the same state in words, so none of it is visual-only.
  test('an ordinary chat row is named by its title alone', () => {
    render(<SessionsPanel sessions={mockSessions} />)

    expect(screen.getByRole('button', { name: 'Chat: First Session' })).toBeInTheDocument()
  })

  test('a chat with a finished report says so in its name', () => {
    render(
      <SessionsPanel
        sessions={[
          {
            id: 'session-report',
            title: 'Completed Report',
            date: new Date(),
            hasCompletedReport: true,
          },
        ]}
      />
    )

    expect(
      screen.getByRole('button', { name: 'Chat: Completed Report — Report ready' })
    ).toBeInTheDocument()
  })

  test('a chat with an expired report says so in its name', () => {
    render(
      <SessionsPanel
        sessions={[
          {
            id: 'session-expired',
            title: 'Expired Report',
            date: new Date(),
            hasExpiredReport: true,
          },
        ]}
      />
    )

    expect(
      screen.getByRole('button', { name: 'Chat: Expired Report — Report expired' })
    ).toBeInTheDocument()
  })

  test('a chat Piloti is working on says so in its name', () => {
    setupChatStoreMock({
      isSessionBusy: (sessionId: string) => sessionId === 'session-1',
      hasAnyBusySession: () => true,
    })

    render(<SessionsPanel sessions={mockSessions} />)

    expect(
      screen.getByRole('button', { name: 'Chat: First Session — Working on this chat' })
    ).toBeInTheDocument()
  })
})

describe('SessionsPanel - Session Switching', () => {
  const mockSessions = [
    { id: 'session-1', title: 'Deep Research Session', date: new Date() },
    { id: 'session-2', title: 'Idle Session', date: new Date() },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    setupChatStoreMock()
    vi.mocked(useLayoutStore).mockImplementation((selector?: StoreSelector<LayoutStore>) => {
      const state: DeepPartial<LayoutStore> = {
        isSessionsPanelOpen: true,
        setSessionsPanelOpen: mockSetSessionsPanelOpen,
      }
      return selector ? selector(asStoreState<LayoutStore>(state)) : state
    })
  })

  test('allows switching sessions during active deep research (server-side SSE)', async () => {
    // Deep research is running but no shallow streaming or HITL — navigation allowed
    setupChatStoreMock({
      isSessionBusy: (sessionId: string) => sessionId === 'session-1',
      hasAnyBusySession: () => true,
      isStreaming: false,
      pendingInteraction: null,
    })

    const user = userEvent.setup()
    const onSelectSession = vi.fn()
    render(
      <SessionsPanel
        sessions={mockSessions}
        selectedSessionId="session-2"
        onSelectSession={onSelectSession}
      />
    )

    // Deep research session should be clickable (not visually disabled)
    const deepResearchSession = screen.getByRole('button', {
      name: /chat: deep research session/i,
    })
    expect(rowOf(deepResearchSession)).not.toHaveClass('cursor-not-allowed')
    expect(deepResearchSession).not.toBeDisabled()

    await user.click(deepResearchSession)
    expect(onSelectSession).toHaveBeenCalledWith('session-1')
  })

  test('blocks switching when shallow thinking (WebSocket) is active', async () => {
    setupChatStoreMock({
      isStreaming: true,
      pendingInteraction: null,
    })

    const user = userEvent.setup()
    const onSelectSession = vi.fn()
    render(
      <SessionsPanel
        sessions={mockSessions}
        selectedSessionId="session-1"
        onSelectSession={onSelectSession}
      />
    )

    // All sessions should be visually disabled
    const session2 = screen.getByRole('button', {
      name: /chat: idle session \(processing in progress\)/i,
    })
    expect(rowOf(session2)).toHaveClass('cursor-not-allowed')
    expect(session2).toBeDisabled()

    await user.click(session2)
    expect(onSelectSession).not.toHaveBeenCalled()
  })

  test('blocks switching when pending HITL interaction exists', async () => {
    setupChatStoreMock({
      isStreaming: false,
      pendingInteraction: { id: 'p1', type: 'approval', content: 'Approve plan?' },
    })

    const user = userEvent.setup()
    const onSelectSession = vi.fn()
    render(
      <SessionsPanel
        sessions={mockSessions}
        selectedSessionId="session-1"
        onSelectSession={onSelectSession}
      />
    )

    const session2 = screen.getByRole('button', {
      name: /chat: idle session \(processing in progress\)/i,
    })
    expect(session2).toBeDisabled()

    await user.click(session2)
    expect(onSelectSession).not.toHaveBeenCalled()
  })

  test('allows switching between sessions when nothing is active', async () => {
    setupChatStoreMock({
      isStreaming: false,
      pendingInteraction: null,
    })

    const user = userEvent.setup()
    const onSelectSession = vi.fn()
    render(
      <SessionsPanel
        sessions={mockSessions}
        selectedSessionId="session-1"
        onSelectSession={onSelectSession}
      />
    )

    const session2 = screen.getByRole('button', { name: /chat: idle session/i })
    expect(rowOf(session2)).not.toHaveClass('cursor-not-allowed')

    await user.click(session2)
    expect(onSelectSession).toHaveBeenCalledWith('session-2')
  })
})

describe('SessionsPanel - New chat button', () => {
  const mockSessions = [{ id: 'session-1', title: 'First Session', date: new Date() }]

  beforeEach(() => {
    vi.clearAllMocks()
    setupChatStoreMock()
    vi.mocked(useLayoutStore).mockImplementation((selector?: StoreSelector<LayoutStore>) => {
      const state: DeepPartial<LayoutStore> = {
        isSessionsPanelOpen: true,
        setSessionsPanelOpen: mockSetSessionsPanelOpen,
      }
      return selector ? selector(asStoreState<LayoutStore>(state)) : state
    })
  })

  test('disables new session button when shallow streaming is active', () => {
    setupChatStoreMock({ isStreaming: true })

    render(<SessionsPanel sessions={mockSessions} />)

    const newSessionBtn = screen.getByRole('button', {
      name: /start a new chat \(disabled during active operations\)/i,
    })
    expect(newSessionBtn).toBeDisabled()
  })

  test('disables new session button when HITL interaction is pending', () => {
    setupChatStoreMock({
      pendingInteraction: { id: 'p1', type: 'approval', content: 'Approve?' },
    })

    render(<SessionsPanel sessions={mockSessions} />)

    const newSessionBtn = screen.getByRole('button', {
      name: /start a new chat \(disabled during active operations\)/i,
    })
    expect(newSessionBtn).toBeDisabled()
  })

  test('enables new session button during active deep research (server-side)', () => {
    setupChatStoreMock({
      isSessionBusy: (sessionId: string) => sessionId === 'session-1',
      hasAnyBusySession: () => true,
      isStreaming: false,
      pendingInteraction: null,
    })

    render(<SessionsPanel sessions={mockSessions} />)

    // Deep research does NOT block navigation — new session should be enabled
    const newSessionBtn = screen.getByRole('button', { name: /^start a new chat$/i })
    expect(newSessionBtn).not.toBeDisabled()
  })

  test('enables new session button when no active operations', () => {
    setupChatStoreMock({ isStreaming: false, pendingInteraction: null })

    render(<SessionsPanel sessions={mockSessions} />)

    const newSessionBtn = screen.getByRole('button', { name: /^start a new chat$/i })
    expect(newSessionBtn).not.toBeDisabled()
  })
})

describe('SessionsPanel - Delete Button States', () => {
  const mockSessions = [
    { id: 'session-1', title: 'First Session', date: new Date() },
    { id: 'session-2', title: 'Second Session', date: new Date() },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    setupChatStoreMock()
    vi.mocked(useLayoutStore).mockImplementation((selector?: StoreSelector<LayoutStore>) => {
      const state: DeepPartial<LayoutStore> = {
        isSessionsPanelOpen: true,
        setSessionsPanelOpen: mockSetSessionsPanelOpen,
      }
      return selector ? selector(asStoreState<LayoutStore>(state)) : state
    })
  })

  test('disables individual delete button when session has active deep research', async () => {
    // Session-1 has active deep research (per-session busy)
    setupChatStoreMock({
      isSessionBusy: (sessionId: string) => sessionId === 'session-1',
      hasAnyBusySession: () => true,
      isStreaming: false,
      pendingInteraction: null,
    })

    const user = userEvent.setup()
    render(<SessionsPanel sessions={mockSessions} />)

    // Hover over first session to show action buttons
    const firstSession = screen.getByRole('button', { name: /chat: first session/i })
    await user.hover(firstSession)

    // Delete button for session with active deep research should be disabled
    const deleteButton = screen.getByRole('button', { name: /delete chat \(disabled\)/i })
    expect(deleteButton).toBeDisabled()
  })

  test('disables individual delete button when shallow streaming is active (global block)', async () => {
    setupChatStoreMock({ isStreaming: true })

    const user = userEvent.setup()
    render(<SessionsPanel sessions={mockSessions} />)

    // With streaming active, chat rows are disabled and show
    // "(processing in progress)" in their aria-label
    const firstSession = screen.getByRole('button', {
      name: /chat: first session \(processing in progress\)/i,
    })
    await user.hover(firstSession)

    // Delete button should be disabled due to global streaming
    const deleteButton = screen.getByRole('button', { name: /delete chat \(disabled\)/i })
    expect(deleteButton).toBeDisabled()
  })

  test('enables delete button when session is idle and no global block', async () => {
    setupChatStoreMock({
      isSessionBusy: () => false,
      hasAnyBusySession: () => false,
      isStreaming: false,
      pendingInteraction: null,
    })

    const user = userEvent.setup()
    render(<SessionsPanel sessions={mockSessions} />)

    // Hover over first session
    const firstSession = screen.getByRole('button', { name: /chat: first session/i })
    await user.hover(firstSession)

    // Delete button should be enabled
    const deleteButton = screen.getByRole('button', { name: /^delete chat$/i })
    expect(deleteButton).not.toBeDisabled()
  })

  test('disables "Delete All" button when any session is busy', () => {
    setupChatStoreMock({
      isSessionBusy: () => false,
      hasAnyBusySession: () => true,
      isStreaming: false,
      pendingInteraction: null,
    })

    render(<SessionsPanel sessions={mockSessions} />)

    const deleteAllButton = screen.getByRole('button', {
      name: /delete all chats in this project \(disabled\)/i,
    })
    expect(deleteAllButton).toBeDisabled()
  })

  test('enables "Delete All" button when no sessions are busy', () => {
    setupChatStoreMock({
      isSessionBusy: () => false,
      hasAnyBusySession: () => false,
      isStreaming: false,
      pendingInteraction: null,
    })

    render(<SessionsPanel sessions={mockSessions} />)

    const deleteAllButton = screen.getByRole('button', {
      name: /^delete all chats in this project$/i,
    })
    expect(deleteAllButton).not.toBeDisabled()
  })

  test('has appropriate title attribute on disabled delete button for active session', async () => {
    setupChatStoreMock({
      isSessionBusy: (sessionId: string) => sessionId === 'session-1',
      hasAnyBusySession: () => true,
      isStreaming: false,
      pendingInteraction: null,
    })

    const user = userEvent.setup()
    render(<SessionsPanel sessions={mockSessions} />)

    // Hover over session to show buttons
    const firstSession = screen.getByRole('button', { name: /chat: first session/i })
    await user.hover(firstSession)

    // Check that delete button has appropriate title attribute
    const deleteButton = screen.getByRole('button', { name: /delete chat \(disabled\)/i })
    expect(deleteButton).toHaveAttribute('title', 'Cannot delete while operations are in progress')
  })
})

describe('SessionsPanel - Deep Research section (FB-10)', () => {
  const today = new Date()

  const makeRun = (overrides: Partial<ResearchRun>): ResearchRun => ({
    job_id: 'job-aaaaaaaa1111',
    status: 'completed',
    created_at: today.toISOString(),
    conversation_id: null,
    project_collection: 'proj_1',
    ...overrides,
  })

  const sessions = [{ id: 'conv-1', title: 'Fire safety review', date: today }]

  const renderPanel = (extra: Partial<Parameters<typeof SessionsPanel>[0]> = {}) =>
    render(
      <SessionsPanel
        sessions={sessions}
        showDeepResearchSection
        projectId="p1"
        projectCollection="proj_1"
        {...extra}
      />
    )

  beforeEach(() => {
    vi.clearAllMocks()
    setupChatStoreMock()
    mockListResearchRuns.mockResolvedValue({ jobs: [], total: 0 })
    vi.mocked(useLayoutStore).mockImplementation((selector?: StoreSelector<LayoutStore>) => {
      const state: DeepPartial<LayoutStore> = {
        isSessionsPanelOpen: true,
        setSessionsPanelOpen: mockSetSessionsPanelOpen,
      }
      return selector ? selector(asStoreState<LayoutStore>(state)) : state
    })
  })

  test('does not render the section, the filter, or fetch runs when the flag is off', () => {
    render(<SessionsPanel sessions={sessions} projectId="p1" projectCollection="proj_1" />)

    expect(screen.queryByTestId('deep-research-section')).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: /filter history/i })).not.toBeInTheDocument()
    // Effect early-returns when showDeepResearchSection is false.
    expect(mockListResearchRuns).not.toHaveBeenCalled()
  })

  test('renders a run count and fetches runs scoped to the project collection', async () => {
    mockListResearchRuns.mockResolvedValue({
      jobs: [makeRun({ job_id: 'job-1' }), makeRun({ job_id: 'job-2' })],
      total: 2,
    })

    renderPanel()

    // The section heading carries the count in a pill…
    const section = await screen.findByTestId('deep-research-section')
    await waitFor(() => {
      expect(within(section).getByText('2')).toBeInTheDocument()
    })
    // …and so does the scope filter's Deep Research option.
    const researchFilter = screen.getByRole('radio', { name: /deep research/i })
    expect(within(researchFilter).getByText('2')).toBeInTheDocument()

    expect(mockListResearchRuns).toHaveBeenCalledWith(
      expect.objectContaining({ projectCollection: 'proj_1' })
    )
  })

  test('shows runs by default: session-title label, untitled fallback, and deep-link hrefs', async () => {
    mockListResearchRuns.mockResolvedValue({
      jobs: [
        makeRun({ job_id: 'job-completed', status: 'completed', conversation_id: 'conv-1' }),
        makeRun({ job_id: 'job-failed', status: 'failed', conversation_id: null }),
      ],
      total: 2,
    })

    renderPanel()

    // Always open — with the History page gone this sheet is the one record,
    // so the runs are visible without a click.

    // Completed run inherits its originating session's title and links to the report.
    const completed = await screen.findByRole('link', {
      name: /Open deep research run: Fire safety review/i,
    })
    expect(completed.getAttribute('href')).toBe('/app/projects/p1/chat?job=job-completed')

    // Failed run with no local session falls back to the shared untitled label
    // and deep-links to the thinking tab.
    const failed = screen.getByRole('link', {
      name: /Open deep research run: Deep research run/i,
    })
    expect(failed.getAttribute('href')).toBe('/app/projects/p1/chat?job=job-failed&tab=thinking')
  })

  test('a run states its status in words, not only in its icon', async () => {
    mockListResearchRuns.mockResolvedValue({
      jobs: [
        makeRun({ job_id: 'job-ok', status: 'completed', conversation_id: 'conv-1' }),
        makeRun({ job_id: 'job-bad', status: 'failed', conversation_id: null }),
        makeRun({ job_id: 'job-live', status: 'running', conversation_id: null }),
      ],
      total: 3,
    })

    renderPanel()

    expect(await screen.findByText('Report ready')).toBeInTheDocument()
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    // ...and the same word reaches assistive tech through the row's own name.
    expect(
      screen.getByRole('link', { name: /Open deep research run: .* — Failed/i })
    ).toBeInTheDocument()
  })

  test('marks research-carrying sessions with a Deep Research chip', async () => {
    render(
      <SessionsPanel
        sessions={[{ id: 'conv-1', title: 'Research chat', date: today, hasCompletedReport: true }]}
        showDeepResearchSection
        projectId="p1"
        projectCollection="proj_1"
      />
    )

    // The chip lives INSIDE the row's button — scoped, because the scope
    // filter's "Deep Research" option shares the wording.
    const row = screen.getByRole('button', { name: /chat: research chat/i })
    await waitFor(() => {
      expect(within(row).getByText('Deep Research')).toBeInTheDocument()
    })
  })

  test('shows skeleton rows while the first runs fetch is pending', () => {
    mockListResearchRuns.mockReturnValue(new Promise(() => {}))

    renderPanel()

    const skeleton = screen.getByTestId('deep-research-skeleton')
    expect(skeleton).toHaveAttribute('aria-busy', 'true')
  })

  test('a failed runs fetch shows a retry line instead of a silently empty section', async () => {
    mockListResearchRuns
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        jobs: [makeRun({ job_id: 'job-1', conversation_id: 'conv-1' })],
        total: 1,
      })

    const user = userEvent.setup()
    renderPanel()

    expect(
      await screen.findByText('Deep-research runs could not be loaded.')
    ).toBeInTheDocument()

    // Retry refetches and the rows land.
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(
      await screen.findByRole('link', { name: /Open deep research run: Fire safety review/i })
    ).toBeInTheDocument()
    expect(mockListResearchRuns).toHaveBeenCalledTimes(2)
  })

  test('the scope filter shows chats, runs, or both', async () => {
    mockListResearchRuns.mockResolvedValue({
      jobs: [makeRun({ job_id: 'job-1', conversation_id: 'conv-1' })],
      total: 1,
    })

    const user = userEvent.setup()
    renderPanel()

    // "All": both lists.
    expect(await screen.findByRole('link', { name: /open deep research run/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /chat: fire safety review/i })).toBeInTheDocument()

    // "Chats": runs hidden, chats stay.
    await user.click(screen.getByRole('radio', { name: 'Chats' }))
    expect(screen.queryByRole('link', { name: /open deep research run/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /chat: fire safety review/i })).toBeInTheDocument()

    // "Deep Research": chats hidden, runs stay.
    await user.click(screen.getByRole('radio', { name: /deep research/i }))
    expect(await screen.findByRole('link', { name: /open deep research run/i })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /chat: fire safety review/i })
    ).not.toBeInTheDocument()
  })

  test('the Deep Research scope shows a proper empty state when there are no runs', async () => {
    // beforeEach resolves the fetch with zero jobs — under "All" the section
    // hides itself (no noise), under the Deep Research scope it must not.
    const user = userEvent.setup()
    renderPanel()

    await waitFor(() => {
      expect(screen.queryByTestId('deep-research-skeleton')).not.toBeInTheDocument()
    })
    expect(screen.queryByTestId('deep-research-section')).not.toBeInTheDocument()

    await user.click(screen.getByRole('radio', { name: /deep research/i }))
    expect(await screen.findByText('No deep research runs yet')).toBeInTheDocument()
  })

  test('populates the section after a quick close→reopen while the fetch is pending', async () => {
    // The component stays mounted when the panel closes, so a pending fetch that
    // resolves during a close→reopen must NOT be discarded — the section should
    // show the runs once resolved.
    let isPanelOpen = true
    let resolveRuns: (value: { jobs: ResearchRun[]; total: number }) => void = () => {}
    mockListResearchRuns.mockReturnValue(
      new Promise((resolve) => {
        resolveRuns = resolve
      })
    )
    vi.mocked(useLayoutStore).mockImplementation((selector?: StoreSelector<LayoutStore>) => {
      const state: DeepPartial<LayoutStore> = {
        isSessionsPanelOpen: isPanelOpen,
        setSessionsPanelOpen: mockSetSessionsPanelOpen,
      }
      return selector ? selector(asStoreState<LayoutStore>(state)) : state
    })

    const { rerender } = render(
      <SessionsPanel sessions={sessions} showDeepResearchSection projectId="p1" projectCollection="proj_1" />
    )

    expect(mockListResearchRuns).toHaveBeenCalledTimes(1)

    // Close, then reopen — all while the fetch is still in flight.
    isPanelOpen = false
    rerender(
      <SessionsPanel sessions={sessions} showDeepResearchSection projectId="p1" projectCollection="proj_1" />
    )
    isPanelOpen = true
    rerender(
      <SessionsPanel sessions={sessions} showDeepResearchSection projectId="p1" projectCollection="proj_1" />
    )

    // Now the original fetch resolves; the result must land in the section.
    resolveRuns({ jobs: [makeRun({ job_id: 'job-1' }), makeRun({ job_id: 'job-2' })], total: 2 })

    expect(
      await screen.findAllByRole('link', { name: /open deep research run/i })
    ).toHaveLength(2)
  })
})
