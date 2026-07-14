import { render, screen } from '@/test-utils'
import { vi, describe, test, expect } from 'vitest'
import { ReportTab } from './ReportTab'

// Mock the chat store
vi.mock('@/features/chat', () => ({
  useChatStore: vi.fn((selector?: (s: any) => any) => {
    const state = {
      reportContent: '',
      isStreaming: false,
      currentStatus: null,
    }
    return selector ? selector(state) : state
  }),
}))

// Mock MarkdownRenderer
vi.mock('@/shared/components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content, isStreaming }: { content: string; isStreaming?: boolean }) => (
    <div data-testid="markdown" data-streaming={isStreaming}>
      {content}
      {isStreaming && <span data-testid="streaming-indicator">Generating report...</span>}
    </div>
  ),
}))

// Mock ExportFooter
vi.mock('./ExportFooter', () => ({
  ExportFooter: () => <div data-testid="export-footer">Export Footer</div>,
}))

import { useChatStore } from '@/features/chat'

describe('ReportTab', () => {
  test('displays empty state when no report content', () => {
    render(<ReportTab />)

    expect(screen.getByText(/report content will appear here/i)).toBeInTheDocument()
    // Icon is rendered as SVG, verify by checking the document icon is present
    expect(document.querySelector('svg')).toBeInTheDocument()
  })

  test('renders report content via MarkdownRenderer', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) => {
      const state = {
        reportContent: '# Report Title\n\nReport content here',
        isStreaming: false,
        currentStatus: null,
        deepResearchCards: [],
      }
      return selector ? selector(state) : state
    })

    render(<ReportTab />)

    expect(screen.getByTestId('markdown')).toHaveTextContent('# Report Title')
  })

  test('renders title when provided', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) => {
      const state = {
        reportContent: 'Some content',
        isStreaming: false,
        currentStatus: null,
        deepResearchCards: [],
      }
      return selector ? selector(state) : state
    })

    render(<ReportTab />)

    expect(screen.getByText('Some content')).toBeInTheDocument()
  })

  test('shows generating indicator when streaming and writing', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) => {
      const state = {
        reportContent: 'Partial content...',
        isStreaming: true,
        currentStatus: 'writing',
        deepResearchCards: [],
      }
      return selector ? selector(state) : state
    })

    render(<ReportTab />)

    // Check that MarkdownRenderer receives isStreaming prop and shows indicator
    expect(screen.getByTestId('streaming-indicator')).toBeInTheDocument()
    expect(screen.getByText('Generating report...')).toBeInTheDocument()
  })

  test('renders children when provided', () => {
    render(
      <ReportTab>
        <div>Custom content</div>
      </ReportTab>
    )

    expect(screen.getByText('Custom content')).toBeInTheDocument()
    expect(screen.queryByTestId('markdown')).not.toBeInTheDocument()
  })

  test('always renders export footer', () => {
    render(<ReportTab />)

    expect(screen.getByTestId('export-footer')).toBeInTheDocument()
  })

  test('extracts a markdown sources section into an anchored list and linkifies [N] markers', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) => {
      const state = {
        reportContent:
          '# Report\n\nDuties differ [1].\n\n## Quellen\n1. OIB Richtlinie 2 — https://oib.or.at',
        reportContentCategory: 'final_report',
        isStreaming: false,
        currentStatus: null,
        deepResearchCards: [],
        deepResearchCitations: [],
      }
      return selector ? selector(state) : state
    })

    render(<ReportTab />)

    // Body markdown now carries an anchor link for the [1] marker…
    const body = screen.getAllByTestId('markdown')[0]
    expect(body).toHaveTextContent('[\\[1\\]](#report-source-1)')
    // …and the sources section is rendered as a list entry with a matching DOM id.
    expect(document.getElementById('report-source-1')).toBeInTheDocument()
    expect(screen.getByText('Quellen')).toBeInTheDocument()
  })

  test('appends a sources list from run citations when the markdown has none', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: (s: any) => any) => {
      const state = {
        reportContent: '# Report\n\nBody without a sources section.',
        reportContentCategory: 'final_report',
        isStreaming: false,
        currentStatus: null,
        deepResearchCards: [],
        deepResearchCitations: [
          { id: 'c1', url: 'https://oib.or.at/ri2', content: '', isCited: true },
          { id: 'c2', url: 'https://example.com/uncited', content: '', isCited: false },
        ],
      }
      return selector ? selector(state) : state
    })

    render(<ReportTab />)

    expect(screen.getByText('Sources')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'https://oib.or.at/ri2' })).toBeInTheDocument()
    // Uncited sources stay out of the report-level list.
    expect(screen.queryByText('https://example.com/uncited')).not.toBeInTheDocument()
  })
})
