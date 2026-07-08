import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { ChatToolbar } from './ChatToolbar'

// Mock the layout store — the component uses both the hook selector form and
// useLayoutStore.getState() inside click handlers.
const mockToggleSessionsPanel = vi.fn()
const mockCloseRightPanel = vi.fn()
const mockOpenRightPanel = vi.fn()
let mockRightPanel: string | null = null
let mockResearchPanelTab = 'tasks'

function getLayoutState() {
  return {
    rightPanel: mockRightPanel,
    researchPanelTab: mockResearchPanelTab,
    toggleSessionsPanel: mockToggleSessionsPanel,
    closeRightPanel: mockCloseRightPanel,
    openRightPanel: mockOpenRightPanel,
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
const mockLoadResearchPanelTab = vi.fn()

vi.mock('@/features/chat', () => ({
  useChatStore: (
    selector: (state: {
      isDeepResearchStreaming: boolean
      deepResearchJobId: string | null
    }) => unknown
  ) =>
    selector({
      isDeepResearchStreaming: mockIsDeepResearchStreaming,
      deepResearchJobId: mockDeepResearchJobId,
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

  describe('sources button', () => {
    test('opens the data sources panel when closed', async () => {
      mockRightPanel = null
      const user = userEvent.setup()

      render(<ChatToolbar />)

      await user.click(screen.getByRole('button', { name: 'Add data sources' }))

      expect(mockOpenRightPanel).toHaveBeenCalledWith('data-sources')
    })

    test('closes the data sources panel when open', async () => {
      mockRightPanel = 'data-sources'
      const user = userEvent.setup()

      render(<ChatToolbar />)

      await user.click(screen.getByRole('button', { name: 'Add data sources' }))

      expect(mockCloseRightPanel).toHaveBeenCalled()
    })
  })

  describe('session title', () => {
    test('renders the current session title', () => {
      render(<ChatToolbar sessionTitle="My Session" />)

      expect(screen.getByText('My Session')).toBeInTheDocument()
    })
  })
})
