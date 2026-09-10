import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { ReportCard } from './ReportCard'

// Mock MarkdownRenderer
vi.mock('@/shared/components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}))

// Mock download utilities
const mockDownloadAsMarkdown = vi.fn()
vi.mock('@/utils/download-as-markdown', () => ({
  downloadAsMarkdown: (...args: unknown[]) => mockDownloadAsMarkdown(...args),
}))

const mockDownloadPdf = vi.fn()
let mockIsPdfLoading = false

vi.mock('@/hooks/use-download-pdf', () => ({
  useDownloadPdfRoute: () => ({
    downloadPdf: mockDownloadPdf,
    isLoading: mockIsPdfLoading,
  }),
}))

// Mock the centralized busy hook (replaces ad-hoc store checks)
let mockIsBusy = false
// The project of the chat this card sits in — what „Besprechen" needs to open a
// conversation about the report. `null` is a chat outside a project, where the
// control correctly does not appear.
let mockProjectId: string | null = null

vi.mock('@/features/chat', () => ({
  useIsCurrentSessionBusy: () => mockIsBusy,
  useChatStore: (selector: (state: { projectId: string | null }) => unknown) =>
    selector({ projectId: mockProjectId }),
}))

// The Freigabe controls are their own surface with their own spec; what this one
// asserts about a filed report is the „Besprechen" beside them.
vi.mock('@/features/documents/components/document-lifecycle-panel', () => ({
  DocumentLifecyclePanel: () => <div data-testid="lifecycle-panel" />,
}))

const FILED = {
  documentId: 'doc-7',
  viewer: { permissions: [], userId: 'user-1' },
} as const

describe('ReportCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsPdfLoading = false
    mockIsBusy = false
    mockProjectId = null
  })

  describe('empty state', () => {
    test('shows empty state when no content', () => {
      render(<ReportCard content="" />)

      expect(screen.getByText('The report will appear here once research is complete.')).toBeInTheDocument()
      expect(screen.getByText('You can export it as Markdown or PDF.')).toBeInTheDocument()
    })

    test('shows empty state for whitespace-only content', () => {
      render(<ReportCard content="   " />)

      expect(screen.getByText('The report will appear here once research is complete.')).toBeInTheDocument()
    })
  })

  describe('with content', () => {
    test('renders content via MarkdownRenderer', () => {
      render(<ReportCard content="# Report Title\n\nContent here" />)

      expect(screen.getByTestId('markdown')).toHaveTextContent('# Report Title')
    })

    test('displays word count', () => {
      render(<ReportCard content="One two three four five" />)

      expect(screen.getByText('5 words')).toBeInTheDocument()
    })

    test('displays title when provided', () => {
      render(<ReportCard content="Content" title="Market Analysis" />)

      expect(screen.getByText('Market Analysis')).toBeInTheDocument()
    })

    test('displays draft label when isDraft is true', () => {
      render(<ReportCard content="Content" isDraft={true} />)

      expect(screen.getByText('Draft')).toBeInTheDocument()
    })

    test('does not display draft label when isDraft is false', () => {
      render(<ReportCard content="Content" isDraft={false} />)

      expect(screen.queryByText('Draft')).not.toBeInTheDocument()
    })
  })

  describe('export buttons', () => {
    test('renders Markdown export button', () => {
      render(<ReportCard content="Content" />)

      expect(screen.getByRole('button', { name: 'Export as Markdown' })).toBeInTheDocument()
    })

    test('renders PDF export button', () => {
      render(<ReportCard content="Content" />)

      expect(screen.getByRole('button', { name: 'Export as PDF' })).toBeInTheDocument()
    })

    test('calls downloadAsMarkdown with content and title', async () => {
      const user = userEvent.setup()

      render(<ReportCard content="Report content" title="Market Analysis" />)

      await user.click(screen.getByRole('button', { name: 'Export as Markdown' }))

      expect(mockDownloadAsMarkdown).toHaveBeenCalledWith('Report content', 'Market Analysis')
    })

    test('calls downloadPdf with content and title', async () => {
      const user = userEvent.setup()

      render(<ReportCard content="Report content" title="Market Analysis" />)

      await user.click(screen.getByRole('button', { name: 'Export as PDF' }))

      expect(mockDownloadPdf).toHaveBeenCalledWith('Report content', 'Market Analysis')
    })

    test('calls downloadAsMarkdown with undefined title when not provided', async () => {
      const user = userEvent.setup()

      render(<ReportCard content="Report content" />)

      await user.click(screen.getByRole('button', { name: 'Export as Markdown' }))

      expect(mockDownloadAsMarkdown).toHaveBeenCalledWith('Report content', undefined)
    })
  })

  describe('disabled states', () => {
    test('export buttons disabled when session is busy', () => {
      mockIsBusy = true

      render(<ReportCard content="Content" />)

      expect(screen.getByRole('button', { name: /Export as Markdown/ })).toBeDisabled()
      expect(screen.getByRole('button', { name: /Export as PDF/ })).toBeDisabled()
    })

    test('PDF button disabled when loading', () => {
      mockIsPdfLoading = true

      render(<ReportCard content="Content" />)

      expect(screen.getByRole('button', { name: /Generating PDF/ })).toBeDisabled()
    })

    test('shows "Generating..." when PDF is loading', () => {
      mockIsPdfLoading = true

      render(<ReportCard content="Content" />)

      expect(screen.getByText('Generating...')).toBeInTheDocument()
    })

    test('does not call export when buttons are disabled', async () => {
      const user = userEvent.setup()
      mockIsBusy = true

      render(<ReportCard content="Content" />)

      await user.click(screen.getByRole('button', { name: /Export as Markdown/ }))
      await user.click(screen.getByRole('button', { name: /Export as PDF/ }))

      expect(mockDownloadAsMarkdown).not.toHaveBeenCalled()
      expect(mockDownloadPdf).not.toHaveBeenCalled()
    })
  })

  describe('word count calculation', () => {
    test('counts words correctly', () => {
      render(<ReportCard content="This is a test report with several words" />)

      expect(screen.getByText('8 words')).toBeInTheDocument()
    })

    test('handles multiple spaces between words', () => {
      render(<ReportCard content="One   two    three" />)

      expect(screen.getByText('3 words')).toBeInTheDocument()
    })

    test('handles newlines in content', () => {
      render(<ReportCard content={`Line one
Line two
Line three`} />)

      expect(screen.getByText('6 words')).toBeInTheDocument()
    })

    test('formats large word counts with commas', () => {
      const longContent = 'word '.repeat(1500)

      render(<ReportCard content={longContent} />)

      expect(screen.getByText('1,500 words')).toBeInTheDocument()
    })
  })

  describe('a report that was filed as a document', () => {
    test('offers Besprechen, so the reader can ask about what they just read', () => {
      mockProjectId = 'proj-1'
      render(<ReportCard content="Content" filedDocument={FILED} />)

      // A filed report is a DRAFT nobody published, so it has no chunks and used
      // to be exactly the document Piloti could not answer about. The turn now
      // reads the subject version's bytes instead, which is what makes this
      // control honest rather than decorative.
      expect(screen.getByTestId('discuss-document')).toBeInTheDocument()
    })

    test('offers nothing to discuss when the run filed no document', () => {
      mockProjectId = 'proj-1'
      render(<ReportCard content="Content" />)
      expect(screen.queryByTestId('discuss-document')).not.toBeInTheDocument()
    })

    test('offers nothing to discuss outside a project', () => {
      // No project, no project chat to open — and a report filed nowhere has no
      // subject to bind the conversation to.
      mockProjectId = null
      render(<ReportCard content="Content" filedDocument={FILED} />)
      expect(screen.queryByTestId('discuss-document')).not.toBeInTheDocument()
    })
  })
})
