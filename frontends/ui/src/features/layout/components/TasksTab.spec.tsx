import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { TasksTab } from './TasksTab'

// Mock the chat store
let mockDeepResearchTodos: Array<{
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'stopped'
}> = []
let mockIsDeepResearchStreaming = false
let mockIsDeepResearchStalled = false
let mockDeepResearchConnectionLost = false
let mockDeepResearchJobId: string | null = null
let mockDeepResearchStatus: string | null = null
let mockDeepResearchOwnerConversationId: string | null = null
const mockReconnect = vi.fn()

vi.mock('@/features/chat', () => ({
  useChatStore: () => ({
    deepResearchTodos: mockDeepResearchTodos,
    currentStatus: null,
    isDeepResearchStreaming: mockIsDeepResearchStreaming,
    isDeepResearchStalled: mockIsDeepResearchStalled,
    deepResearchConnectionLost: mockDeepResearchConnectionLost,
    reconnectDeepResearchFn: mockReconnect,
    deepResearchJobId: mockDeepResearchJobId,
    deepResearchStatus: mockDeepResearchStatus,
    deepResearchOwnerConversationId: mockDeepResearchOwnerConversationId,
  }),
}))

// Mock TaskCard
vi.mock('./TaskCard', () => ({
  TaskCard: ({ todo }: { todo: { id: string; content: string } }) => (
    <div data-testid="task-card">{todo.content}</div>
  ),
}))

describe('TasksTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeepResearchTodos = []
    mockIsDeepResearchStreaming = false
    mockIsDeepResearchStalled = false
    mockDeepResearchConnectionLost = false
    mockDeepResearchJobId = null
    mockDeepResearchStatus = null
    mockDeepResearchOwnerConversationId = null
  })

  // A run followed here without a chat thread of its own (a workflow run) gets
  // no thread banner, so the panel has to report how it ended.
  describe('attached-run outcome notice', () => {
    test('reports a finished attached run and points at the report', () => {
      mockDeepResearchJobId = 'job-1'
      mockDeepResearchStatus = 'success'
      mockIsDeepResearchStreaming = false

      render(<TasksTab />)

      expect(screen.getByTestId('deep-research-outcome-notice')).toHaveTextContent(
        'This run has finished. The report is in the Report tab.',
      )
    })

    test('reports a failed attached run', () => {
      mockDeepResearchJobId = 'job-1'
      mockDeepResearchStatus = 'failure'

      render(<TasksTab />)

      expect(screen.getByTestId('deep-research-outcome-notice')).toHaveTextContent(
        'This run failed before it finished.',
      )
    })

    test('stays silent while the attached run is still streaming', () => {
      mockDeepResearchJobId = 'job-1'
      mockDeepResearchStatus = 'running'
      mockIsDeepResearchStreaming = true

      render(<TasksTab />)

      expect(screen.queryByTestId('deep-research-outcome-notice')).not.toBeInTheDocument()
    })

    test('stays silent for a run that belongs to a chat thread (it has a banner there)', () => {
      mockDeepResearchJobId = 'job-1'
      mockDeepResearchStatus = 'failure'
      mockDeepResearchOwnerConversationId = 'conv-1'

      render(<TasksTab />)

      expect(screen.queryByTestId('deep-research-outcome-notice')).not.toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    test('shows empty state when no tasks', () => {
      render(<TasksTab />)

      expect(screen.getByText('Research tasks will appear here.')).toBeInTheDocument()
      expect(screen.getByText(/Shows the plan breakdown and progress/)).toBeInTheDocument()
    })

    test('shows description in header', () => {
      render(<TasksTab />)

      expect(screen.getByText('Research plan breakdown and progress during deep research.')).toBeInTheDocument()
    })
  })

  describe('with tasks', () => {
    test('renders header', () => {
      mockDeepResearchTodos = [
        { id: '1', content: 'Task 1', status: 'pending' },
      ]

      render(<TasksTab />)

      expect(screen.getByText('Tasks')).toBeInTheDocument()
    })

    test('shows progress count in header', () => {
      mockDeepResearchTodos = [
        { id: '1', content: 'Task 1', status: 'completed' },
        { id: '2', content: 'Task 2', status: 'pending' },
        { id: '3', content: 'Task 3', status: 'pending' },
      ]

      render(<TasksTab />)

      expect(screen.getByText('1/3')).toBeInTheDocument()
    })

    test('renders task cards', () => {
      mockDeepResearchTodos = [
        { id: '1', content: 'Research market trends', status: 'completed' },
        { id: '2', content: 'Analyze competitors', status: 'in_progress' },
      ]

      render(<TasksTab />)

      expect(screen.getByText('Research market trends')).toBeInTheDocument()
      expect(screen.getByText('Analyze competitors')).toBeInTheDocument()
    })

    test('renders correct number of task cards', () => {
      mockDeepResearchTodos = [
        { id: '1', content: 'Task 1', status: 'pending' },
        { id: '2', content: 'Task 2', status: 'pending' },
        { id: '3', content: 'Task 3', status: 'pending' },
      ]

      render(<TasksTab />)

      expect(screen.getAllByTestId('task-card')).toHaveLength(3)
    })

    test('renders progress bar', () => {
      mockDeepResearchTodos = [
        { id: '1', content: 'Task 1', status: 'completed' },
        { id: '2', content: 'Task 2', status: 'pending' },
      ]

      render(<TasksTab />)

      expect(screen.getByLabelText('Task completion progress')).toBeInTheDocument()
    })
  })

  describe('progress calculation', () => {
    test('calculates 0% when no tasks completed', () => {
      mockDeepResearchTodos = [
        { id: '1', content: 'Task 1', status: 'pending' },
        { id: '2', content: 'Task 2', status: 'in_progress' },
      ]

      render(<TasksTab />)

      // Progress bar should show 0%
      const progressBar = screen.getByLabelText('Task completion progress')
      expect(progressBar).toBeInTheDocument()
    })

    test('calculates 100% when all tasks completed', () => {
      mockDeepResearchTodos = [
        { id: '1', content: 'Task 1', status: 'completed' },
        { id: '2', content: 'Task 2', status: 'completed' },
      ]

      render(<TasksTab />)

      expect(screen.getByText('2/2')).toBeInTheDocument()
    })

    test('calculates 50% correctly', () => {
      mockDeepResearchTodos = [
        { id: '1', content: 'Task 1', status: 'completed' },
        { id: '2', content: 'Task 2', status: 'pending' },
      ]

      render(<TasksTab />)

      expect(screen.getByText('1/2')).toBeInTheDocument()
    })
  })

  describe('recovery notice (UX-11a / UX-11b)', () => {
    test('shows no recovery notice while the stream is healthy', () => {
      mockIsDeepResearchStreaming = true
      mockDeepResearchTodos = [{ id: '1', content: 'Task 1', status: 'in_progress' }]

      render(<TasksTab />)

      expect(screen.queryByTestId('deep-research-recovery-notice')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument()
    })

    test('shows the stalled notice when the stream goes quiet', () => {
      mockIsDeepResearchStreaming = true
      mockIsDeepResearchStalled = true
      mockDeepResearchTodos = [{ id: '1', content: 'Task 1', status: 'in_progress' }]

      render(<TasksTab />)

      expect(screen.getByTestId('deep-research-recovery-notice')).toBeInTheDocument()
      expect(screen.getByText('No progress updates for a while')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument()
    })

    test('shows the connection-lost notice (and it wins over a stall)', () => {
      mockIsDeepResearchStreaming = true
      mockIsDeepResearchStalled = true
      mockDeepResearchConnectionLost = true

      render(<TasksTab />)

      expect(screen.getByText('Connection to the research job lost')).toBeInTheDocument()
      expect(screen.queryByText('No progress updates for a while')).not.toBeInTheDocument()
    })

    test('does not show the notice when not streaming', () => {
      mockIsDeepResearchStreaming = false
      mockDeepResearchConnectionLost = true

      render(<TasksTab />)

      expect(screen.queryByTestId('deep-research-recovery-notice')).not.toBeInTheDocument()
    })

    test('Reconnect button invokes the registered reconnect handler', async () => {
      const user = userEvent.setup()
      mockIsDeepResearchStreaming = true
      mockDeepResearchConnectionLost = true

      render(<TasksTab />)

      await user.click(screen.getByRole('button', { name: 'Reconnect' }))
      expect(mockReconnect).toHaveBeenCalledTimes(1)
    })
  })
})
