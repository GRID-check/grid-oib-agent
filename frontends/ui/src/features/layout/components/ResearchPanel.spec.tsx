import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { ResearchPanel } from './ResearchPanel'

// Mock the stores
const mockCloseRightPanel = vi.fn()
const mockOpenRightPanel = vi.fn()
const mockSetResearchPanelTab = vi.fn()
let mockRightPanel: string | null = 'research'
let mockResearchPanelTab = 'tasks'

interface MockLayoutSelectorState {
  rightPanel: string | null
  researchPanelTab: string
  setResearchPanelTab: typeof mockSetResearchPanelTab
  closeRightPanel: typeof mockCloseRightPanel
  openRightPanel: typeof mockOpenRightPanel
}

vi.mock('../store', () => ({
  useLayoutStore: vi.fn((selector?: (s: MockLayoutSelectorState) => unknown) => {
    const state: MockLayoutSelectorState = {
      rightPanel: mockRightPanel,
      researchPanelTab: mockResearchPanelTab,
      setResearchPanelTab: mockSetResearchPanelTab,
      closeRightPanel: mockCloseRightPanel,
      openRightPanel: mockOpenRightPanel,
    }
    return selector ? selector(state) : state
  }),
}))

vi.mock('@/adapters/auth', () => ({
  useAuth: vi.fn(() => ({ idToken: 'mock-token' })),
}))

vi.mock('@/adapters/api', () => ({
  cancelJob: vi.fn().mockResolvedValue(undefined),
}))

let mockIsDeepResearchStreaming = false
let mockDeepResearchJobId: string | null = null
let mockDeepResearchStreamLoaded = false
let mockIsLoadJobDataLoading = false
const mockImportJobStream = vi.fn()
const mockLoadResearchPanelTab = vi.fn()

const mockCancelCurrentJob = vi.fn()

vi.mock('@/features/chat', () => ({
  useChatStore: (
    selector: (state: {
      isDeepResearchStreaming: boolean
      deepResearchJobId: string | null
      deepResearchStreamLoaded: boolean
    }) => unknown
  ) =>
    selector({
      isDeepResearchStreaming: mockIsDeepResearchStreaming,
      deepResearchJobId: mockDeepResearchJobId,
      deepResearchStreamLoaded: mockDeepResearchStreamLoaded,
    }),
  useLoadJobData: () => ({
    importStreamOnly: mockImportJobStream,
    loadResearchPanelTab: mockLoadResearchPanelTab,
    isLoading: mockIsLoadJobDataLoading,
  }),
  useDeepResearch: () => ({
    cancelCurrentJob: mockCancelCurrentJob,
  }),
}))

vi.mock('./TasksTab', () => ({
  TasksTab: () => <div data-testid="tasks-tab">Tasks Tab Content</div>,
}))

vi.mock('./ThinkingTab', () => ({
  ThinkingTab: () => <div data-testid="thinking-tab">Thinking Tab Content</div>,
}))

vi.mock('./ReportTab', () => ({
  ReportTab: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="report-tab">Report Tab Content {children}</div>
  ),
}))

describe('ResearchPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRightPanel = 'research'
    mockResearchPanelTab = 'tasks'
    mockIsDeepResearchStreaming = false
    mockDeepResearchJobId = null
    mockDeepResearchStreamLoaded = false
    mockIsLoadJobDataLoading = false
    mockImportJobStream.mockClear()
    mockLoadResearchPanelTab.mockClear()
  })

  describe('panel visibility', () => {
    test('renders content when rightPanel is "research"', () => {
      mockRightPanel = 'research'

      render(<ResearchPanel />)

      expect(screen.getByTestId('research-panel-close')).toBeInTheDocument()
      expect(screen.getByTestId('tasks-tab')).toBeInTheDocument()
    })

    test('is hidden when rightPanel is null', () => {
      mockRightPanel = null

      const { container } = render(<ResearchPanel />)

      // The panel wrapper collapses and is marked hidden from AT
      const outerPanel = container.querySelector('[aria-hidden="true"]')
      expect(outerPanel).toBeInTheDocument()
    })
  })

  describe('tab navigation', () => {
    test('renders all tab options', () => {
      render(<ResearchPanel />)

      expect(screen.getByText('Tasks')).toBeInTheDocument()
      expect(screen.getByText('Thinking')).toBeInTheDocument()
      expect(screen.getByText('Report')).toBeInTheDocument()
      expect(screen.queryByText('Plan')).not.toBeInTheDocument()
      expect(screen.queryByText('Citations')).not.toBeInTheDocument()
    })

    test('calls setResearchPanelTab when tab is clicked', async () => {
      const user = userEvent.setup()

      render(<ResearchPanel />)

      await user.click(screen.getByText('Thinking'))
      expect(mockSetResearchPanelTab).toHaveBeenCalledWith('thinking')

      await user.click(screen.getByText('Report'))
      expect(mockSetResearchPanelTab).toHaveBeenCalledWith('report')
    })

    test('delegates report tab loading to the shared research panel loader', async () => {
      mockDeepResearchJobId = 'job-123'
      const user = userEvent.setup()

      render(<ResearchPanel />)

      await user.click(screen.getByText('Report'))

      expect(mockLoadResearchPanelTab).toHaveBeenCalledWith('job-123', 'report')
    })

    test('queues tab loading while another research panel load is active', async () => {
      mockDeepResearchJobId = 'job-123'
      mockIsLoadJobDataLoading = true
      const user = userEvent.setup()

      const { rerender } = render(<ResearchPanel />)

      await user.click(screen.getByText('Report'))

      expect(mockSetResearchPanelTab).toHaveBeenCalledWith('report')
      expect(mockLoadResearchPanelTab).not.toHaveBeenCalled()

      mockIsLoadJobDataLoading = false
      rerender(<ResearchPanel>Reloaded</ResearchPanel>)

      await vi.waitFor(() => {
        expect(mockLoadResearchPanelTab).toHaveBeenCalledWith('job-123', 'report')
      })
    })

    test('displays correct tab content based on researchPanelTab', () => {
      const tabs = ['tasks', 'thinking', 'report'] as const
      for (const tab of tabs) {
        mockResearchPanelTab = tab
        const { unmount } = render(<ResearchPanel />)
        expect(screen.getByTestId(`${tab}-tab`)).toBeInTheDocument()
        unmount()
      }
    })
  })

  describe('close button', () => {
    test('renders close button', () => {
      render(<ResearchPanel />)

      expect(screen.getByTestId('research-panel-close')).toBeInTheDocument()
    })

    test('calls closeRightPanel when close button clicked', async () => {
      const user = userEvent.setup()

      render(<ResearchPanel />)

      await user.click(screen.getByTestId('research-panel-close'))

      expect(mockCloseRightPanel).toHaveBeenCalled()
    })
  })

  describe('stop researching button', () => {
    test('is always rendered', () => {
      mockIsDeepResearchStreaming = false

      render(<ResearchPanel />)

      expect(screen.getByTestId('research-panel-stop')).toBeInTheDocument()
    })

    test('is disabled when not streaming', () => {
      mockIsDeepResearchStreaming = false

      render(<ResearchPanel />)

      expect(screen.getByTestId('research-panel-stop')).toBeDisabled()
    })

    test('is enabled when streaming', () => {
      mockIsDeepResearchStreaming = true

      render(<ResearchPanel />)

      expect(screen.getByTestId('research-panel-stop')).not.toBeDisabled()
    })
  })

  describe('children rendering', () => {
    test('passes children to ReportTab', () => {
      mockResearchPanelTab = 'report'

      render(
        <ResearchPanel>
          <div data-testid="custom-content">Custom Content</div>
        </ResearchPanel>
      )

      expect(screen.getByTestId('custom-content')).toBeInTheDocument()
    })
  })

  describe('segmented control groups', () => {
    test('has all tab options', () => {
      render(<ResearchPanel />)

      expect(screen.getByText('Tasks')).toBeInTheDocument()
      expect(screen.getByText('Thinking')).toBeInTheDocument()
      expect(screen.getByText('Report')).toBeInTheDocument()
      expect(screen.queryByText('Plan')).not.toBeInTheDocument()
      expect(screen.queryByText('Citations')).not.toBeInTheDocument()
    })
  })
})
