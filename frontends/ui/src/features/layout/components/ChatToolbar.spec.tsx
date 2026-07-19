import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { ChatToolbar } from './ChatToolbar'

// Mock the layout store — the component uses both the hook selector form and
// useLayoutStore.getState() inside click handlers.
const mockToggleSessionsPanel = vi.fn()
const mockCloseRightPanel = vi.fn()
const mockOpenRightPanel = vi.fn()
const mockSetMobileNavOpen = vi.fn()
let mockRightPanel: string | null = null
let mockResearchPanelTab = 'tasks'

function getLayoutState() {
  return {
    rightPanel: mockRightPanel,
    researchPanelTab: mockResearchPanelTab,
    toggleSessionsPanel: mockToggleSessionsPanel,
    closeRightPanel: mockCloseRightPanel,
    openRightPanel: mockOpenRightPanel,
    setMobileNavOpen: mockSetMobileNavOpen,
  }
}

vi.mock('../store', () => {
  const useLayoutStore = Object.assign(
    vi.fn((selector?: (s: ReturnType<typeof getLayoutState>) => unknown) => {
      const state = getLayoutState()
      return selector ? selector(state) : state
    }),
    { getState: () => getLayoutState() }
  )
  return { useLayoutStore }
})

let mockIsAuthenticated = true

vi.mock('@/adapters/auth', () => ({
  useAuth: vi.fn(() => ({ isAuthenticated: mockIsAuthenticated })),
}))

let mockIsDeepResearchStreaming = false
let mockDeepResearchJobId: string | null = null
let mockIsLoadJobDataLoading = false
let mockCurrentSessionId: string | null = 'session-1'
const mockLoadResearchPanelTab = vi.fn()
const mockUpdateConversationTitle = vi.fn()

vi.mock('@/features/chat', () => ({
  useChatStore: (
    selector: (state: {
      isDeepResearchStreaming: boolean
      deepResearchJobId: string | null
      currentConversation: { id: string } | null
      updateConversationTitle: (id: string, title: string) => void
    }) => unknown
  ) =>
    selector({
      isDeepResearchStreaming: mockIsDeepResearchStreaming,
      deepResearchJobId: mockDeepResearchJobId,
      currentConversation: mockCurrentSessionId ? { id: mockCurrentSessionId } : null,
      updateConversationTitle: mockUpdateConversationTitle,
    }),
  useLoadJobData: () => ({
    loadResearchPanelTab: mockLoadResearchPanelTab,
    isLoading: mockIsLoadJobDataLoading,
  }),
}))

describe('ChatToolbar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsAuthenticated = true
    mockRightPanel = null
    mockResearchPanelTab = 'tasks'
    mockIsDeepResearchStreaming = false
    mockDeepResearchJobId = null
    mockIsLoadJobDataLoading = false
    mockCurrentSessionId = 'session-1'
  })

  describe('research toggle', () => {
    test('renders the research toggle button', () => {
      render(<ChatToolbar />)

      expect(screen.getByTestId('research-panel-toggle')).toBeInTheDocument()
      expect(screen.getByText('Research')).toBeInTheDocument()
    })

    test('opens the research panel when closed', async () => {
      mockRightPanel = null
      const user = userEvent.setup()

      render(<ChatToolbar />)

      await user.click(screen.getByTestId('research-panel-toggle'))

      expect(mockOpenRightPanel).toHaveBeenCalledWith('research')
    })

    test('closes the research panel when open', async () => {
      mockRightPanel = 'research'
      const user = userEvent.setup()

      render(<ChatToolbar />)

      await user.click(screen.getByTestId('research-panel-toggle'))

      expect(mockCloseRightPanel).toHaveBeenCalled()
      expect(mockOpenRightPanel).not.toHaveBeenCalled()
    })

    test('reloads the active tab for the current job when opening', async () => {
      mockRightPanel = null
      mockDeepResearchJobId = 'job-123'
      mockResearchPanelTab = 'thinking'
      const user = userEvent.setup()

      render(<ChatToolbar />)

      await user.click(screen.getByTestId('research-panel-toggle'))

      expect(mockLoadResearchPanelTab).toHaveBeenCalledWith('job-123', 'thinking')
    })

    test('does not reload job data while another load is in flight', async () => {
      mockRightPanel = null
      mockDeepResearchJobId = 'job-123'
      mockIsLoadJobDataLoading = true
      const user = userEvent.setup()

      render(<ChatToolbar />)

      await user.click(screen.getByTestId('research-panel-toggle'))

      expect(mockOpenRightPanel).toHaveBeenCalledWith('research')
      expect(mockLoadResearchPanelTab).not.toHaveBeenCalled()
    })

    test('is disabled when not authenticated', () => {
      mockIsAuthenticated = false

      render(<ChatToolbar />)

      const toggleButton = screen.getByTestId('research-panel-toggle')
      expect(toggleButton).toBeDisabled()
      expect(toggleButton).toHaveAttribute('title', 'Sign in to access research panel')
    })

    test('shows a spinner while deep research is streaming', () => {
      mockIsDeepResearchStreaming = true

      render(<ChatToolbar />)

      expect(screen.getByLabelText('Researching')).toBeInTheDocument()
    })

    test('shows the sparkles icon when not streaming', () => {
      mockIsDeepResearchStreaming = false

      render(<ChatToolbar />)

      expect(screen.queryByLabelText('Researching')).not.toBeInTheDocument()
    })
  })

  describe('new session button', () => {
    test('invokes onNewSession when enabled', async () => {
      const onNewSession = vi.fn()
      const user = userEvent.setup()

      render(<ChatToolbar onNewSession={onNewSession} />)

      await user.click(screen.getByRole('button', { name: 'Create new session' }))

      expect(onNewSession).toHaveBeenCalledOnce()
    })

    test('is disabled while a session is active', () => {
      render(<ChatToolbar isNewSessionDisabled />)

      expect(screen.getByRole('button', { name: 'Create new session' })).toBeDisabled()
    })
  })

  // The data-sources toggle was removed from the toolbar: the composer's
  // Datengrundlage chip already owns opening that panel, so the navbar no
  // longer duplicates it.
  describe('sessions toggle', () => {
    test('toggles the sessions panel', async () => {
      const user = userEvent.setup()

      render(<ChatToolbar />)

      await user.click(screen.getByRole('button', { name: 'Toggle sessions sidebar' }))

      expect(mockToggleSessionsPanel).toHaveBeenCalledOnce()
    })
  })

  describe('mobile navigation opener', () => {
    test('opens the global nav drawer (the way back out of chat on mobile)', async () => {
      const user = userEvent.setup()

      render(<ChatToolbar />)

      await user.click(screen.getByRole('button', { name: 'Open navigation' }))

      expect(mockSetMobileNavOpen).toHaveBeenCalledWith(true)
    })
  })

  describe('breadcrumb + inline rename', () => {
    test('renders the current session title', () => {
      render(<ChatToolbar sessionTitle="My Session" />)

      expect(screen.getByText('My Session')).toBeInTheDocument()
    })

    test('renders "{project} / {session title}" when a project name is given', () => {
      render(<ChatToolbar sessionTitle="My Session" projectName="Wohnbau Favoriten" />)

      expect(screen.getByText('Wohnbau Favoriten')).toBeInTheDocument()
      expect(screen.getByText('/')).toBeInTheDocument()
      expect(screen.getByText('My Session')).toBeInTheDocument()
    })

    test('clicking the title switches to an input; Enter commits via the store rename action', async () => {
      const user = userEvent.setup()
      render(<ChatToolbar sessionTitle="My Session" />)

      await user.click(screen.getByRole('button', { name: /rename session/i }))

      const input = screen.getByRole('textbox', { name: /session title/i })
      expect(input).toHaveValue('My Session')

      await user.clear(input)
      await user.type(input, 'Fluchtweg OG2{Enter}')

      expect(mockUpdateConversationTitle).toHaveBeenCalledWith('session-1', 'Fluchtweg OG2')
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    test('Escape cancels the edit without renaming', async () => {
      const user = userEvent.setup()
      render(<ChatToolbar sessionTitle="My Session" />)

      await user.click(screen.getByRole('button', { name: /rename session/i }))
      const input = screen.getByRole('textbox', { name: /session title/i })
      await user.clear(input)
      await user.type(input, 'discarded{Escape}')

      expect(mockUpdateConversationTitle).not.toHaveBeenCalled()
      expect(screen.getByText('My Session')).toBeInTheDocument()
    })

    test('blur commits the edit', async () => {
      const user = userEvent.setup()
      render(<ChatToolbar sessionTitle="My Session" />)

      await user.click(screen.getByRole('button', { name: /rename session/i }))
      const input = screen.getByRole('textbox', { name: /session title/i })
      await user.clear(input)
      await user.type(input, 'Renamed on blur')
      await user.tab()

      expect(mockUpdateConversationTitle).toHaveBeenCalledWith('session-1', 'Renamed on blur')
    })

    test('committing an unchanged or empty title does not rename', async () => {
      const user = userEvent.setup()
      render(<ChatToolbar sessionTitle="My Session" />)

      await user.click(screen.getByRole('button', { name: /rename session/i }))
      await user.keyboard('{Enter}')

      expect(mockUpdateConversationTitle).not.toHaveBeenCalled()
    })

    test('rename is disabled without an active session', () => {
      mockCurrentSessionId = null
      render(<ChatToolbar sessionTitle="My Session" />)

      expect(screen.getByRole('button', { name: /rename session/i })).toBeDisabled()
    })
  })
})
