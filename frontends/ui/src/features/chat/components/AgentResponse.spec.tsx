import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { AgentResponse } from './AgentResponse'

// Mock the layout store
const mockOpenRightPanel = vi.fn()
const mockSetResearchPanelTab = vi.fn()

vi.mock('@/features/layout/store', () => ({
  useLayoutStore: vi.fn((selector?: (s: any) => any) => {
    const state = {
      openRightPanel: mockOpenRightPanel,
      setResearchPanelTab: mockSetResearchPanelTab,
    }
    return selector ? selector(state) : state
  }),
}))

// Mock the chat store
vi.mock('../store', () => ({
  useChatStore: vi.fn((selector?: (s: any) => any) => {
    const state = {
      reportContent: '',
      deepResearchJobId: null,
      isDeepResearchStreaming: false,
      deepResearchStreamLoaded: false,
      currentConversation: null,
      patchConversationMessage: vi.fn(),
      reconnectToActiveJob: vi.fn(),
    }
    return selector ? selector(state) : state
  }),
}))

// Mock cancelJob API
vi.mock('@/adapters/api', () => ({
  cancelJob: vi.fn(),
}))

// Mock useAuth
vi.mock('@/adapters/auth', () => ({
  useAuth: () => ({
    accessToken: null,
  }),
}))

// Mock the useLoadJobData hook
const mockImportJobStream = vi.fn()
const mockLoadResearchPanelTab = vi.fn()

vi.mock('../hooks', () => ({
  useLoadJobData: () => ({
    loadReport: vi.fn(),
    importJobStream: mockImportJobStream,
    loadResearchPanelTab: mockLoadResearchPanelTab,
    isLoading: false,
    error: null,
    clearError: vi.fn(),
  }),
}))

// Mock MarkdownRenderer to render content as plain text for testing
vi.mock('@/shared/components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}))

describe('AgentResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockImportJobStream.mockClear()
    mockLoadResearchPanelTab.mockClear()
  })

  test('renders response content', () => {
    render(<AgentResponse content="Here is your answer" />)

    expect(screen.getByText('Here is your answer')).toBeInTheDocument()
  })

  test('returns null for empty content', () => {
    render(<AgentResponse content="" />)

    // Component returns null for empty content - check that no markdown is rendered
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
  })

  test('returns null for whitespace-only content', () => {
    render(<AgentResponse content="   " />)

    // Component returns null for whitespace-only content
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
  })

  test('displays timestamp when provided', () => {
    const timestamp = new Date('2024-01-15T14:30:00')

    render(<AgentResponse content="Response" timestamp={timestamp} />)

    expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
  })

  test('handles ISO string timestamp', () => {
    render(<AgentResponse content="Response" timestamp="2024-01-15T14:30:00Z" />)

    expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
  })

  test('shows "View Report" button when showViewReport is true', () => {
    render(<AgentResponse content="Response" showViewReport={true} />)

    expect(screen.getByRole('button', { name: 'View Report' })).toBeInTheDocument()
  })

  test('hides "View Report" button when showViewReport is false', () => {
    render(<AgentResponse content="Response" showViewReport={false} />)

    expect(screen.queryByRole('button', { name: 'View Report' })).not.toBeInTheDocument()
  })

  test('clicking "View Report" opens research panel with report tab', async () => {
    const user = userEvent.setup()

    render(<AgentResponse content="Response" showViewReport={true} />)

    await user.click(screen.getByRole('button', { name: 'View Report' }))

    expect(mockSetResearchPanelTab).toHaveBeenCalledWith('report')
    expect(mockOpenRightPanel).toHaveBeenCalledWith('research')
  })

  test('renders without timestamp', () => {
    render(<AgentResponse content="Response without timestamp" />)

    expect(screen.getByText('Response without timestamp')).toBeInTheDocument()
    // No timestamp text should be present
    expect(screen.queryByText(/\d{1,2}:\d{2}/)).not.toBeInTheDocument()
  })

  test('renders long content', () => {
    const longContent = 'This is a very long response. '.repeat(50)

    const { container } = render(<AgentResponse content={longContent} />)

    // Verify content is rendered (container should have content)
    expect(container.textContent).toContain('This is a very long response.')
  })

  test('uses shared research panel loader when clicking "View Report" with jobId', async () => {
    const user = userEvent.setup()

    render(<AgentResponse content="Response" showViewReport={true} jobId="test-job-123" />)

    await user.click(screen.getByRole('button', { name: 'View Report' }))

    expect(mockLoadResearchPanelTab).toHaveBeenCalledWith('test-job-123', 'report')
    expect(mockImportJobStream).not.toHaveBeenCalled()
  })

  test('renders the confidence chip for each level', () => {
    const { rerender } = render(<AgentResponse content="Answer" answerConfidence="high" />)
    expect(screen.getByText('Confidence: high')).toBeInTheDocument()

    rerender(<AgentResponse content="Answer" answerConfidence="medium" />)
    expect(screen.getByText('Confidence: medium')).toBeInTheDocument()

    rerender(<AgentResponse content="Answer" answerConfidence="low" />)
    expect(screen.getByText('Confidence: low')).toBeInTheDocument()
  })

  test('renders no confidence chip when answerConfidence is absent (backward compatible)', () => {
    render(<AgentResponse content="Answer without a self-assessment" />)
    expect(screen.queryByText(/Confidence:/)).not.toBeInTheDocument()
  })

  test('renders the confidence chip in the inline variant too', () => {
    render(<AgentResponse content="Answer" variant="inline" answerConfidence="high" />)
    expect(screen.getByText('Confidence: high')).toBeInTheDocument()
  })

  test('renders SummaryCard and LegalBasisCard from cards prop', () => {
    const cards = [
      {
        type: 'summary' as const,
        title: 'Summary Title',
        content: 'Summary content',
        key_points: ['Point one', 'Point two'],
      },
      {
        type: 'legal_basis' as const,
        law: 'GDPR',
        article: '5',
        section: '1',
        summary: 'Summary of the legal basis',
        original_text: 'Original legal text',
      },
    ]

    render(<AgentResponse content="Response with cards" cards={cards} />)

    expect(screen.getByText('Summary Title')).toBeInTheDocument()
    expect(screen.getByText('Summary content')).toBeInTheDocument()
    expect(screen.getByText('Point one')).toBeInTheDocument()
    expect(screen.getByText('Legal basis')).toBeInTheDocument()
    expect(screen.getByText('GDPR')).toBeInTheDocument()
    expect(screen.getByText('Summary of the legal basis')).toBeInTheDocument()
    expect(screen.getByText('Original legal text')).toBeInTheDocument()
  })
})
