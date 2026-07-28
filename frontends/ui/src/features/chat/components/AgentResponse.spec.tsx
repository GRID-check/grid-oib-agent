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

  test('hides the confidence chip when the chat-confidence-chip flag is off (default variant)', () => {
    // Flag off must suppress the chip even when the model self-assessed a level.
    render(<AgentResponse content="Answer" answerConfidence="high" showConfidenceChip={false} />)
    expect(screen.queryByText(/Confidence:/)).not.toBeInTheDocument()
    // The answer itself still renders — only the chip is gated.
    expect(screen.getByText('Answer')).toBeInTheDocument()
  })

  test('hides the confidence chip when the flag is off (inline variant)', () => {
    render(
      <AgentResponse content="Answer" variant="inline" answerConfidence="low" showConfidenceChip={false} />
    )
    expect(screen.queryByText(/Confidence:/)).not.toBeInTheDocument()
    expect(screen.getByText('Answer')).toBeInTheDocument()
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

  describe('"Belegt durch" answer sources row (WS-3)', () => {
    const citations = [
      {
        id: 'c-1',
        url: 'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=1',
        content: '[RIS] BO Wien §111',
        timestamp: new Date('2026-07-17T10:00:00Z'),
        isCited: true,
      },
      {
        id: 'c-2',
        url: 'https://example.com/article',
        content: '[Web] Some article',
        timestamp: new Date('2026-07-17T10:00:00Z'),
        isCited: true,
      },
    ]

    test('renders provenance chips when the message carries citations', () => {
      render(<AgentResponse content="Cited answer" citations={citations} />)

      const row = screen.getByRole('list', { name: /sources this answer is backed by/i })
      expect(row).toBeInTheDocument()
      expect(screen.getByText('ris.bka.gv.at')).toBeInTheDocument()
      expect(screen.getByText('example.com')).toBeInTheDocument()
      // Web citations link out.
      expect(screen.getByRole('link', { name: /example\.com/i })).toHaveAttribute(
        'href',
        'https://example.com/article'
      )
    })

    test('renders no sources row when the message has no citation/source data', () => {
      render(<AgentResponse content="Plain answer" />)

      expect(
        screen.queryByRole('list', { name: /sources this answer is backed by/i })
      ).not.toBeInTheDocument()
    })

    test('derives a law chip from a legal_basis card on shallow answers', () => {
      const cards = [
        {
          type: 'legal_basis' as const,
          law: 'OIB-Richtlinie 2',
          article: null,
          section: 'Pkt. 5.1.1',
          summary: null,
          original_text: null,
        },
      ]

      render(<AgentResponse content="Shallow answer" cards={cards} />)

      const row = screen.getByRole('list', { name: /sources this answer is backed by/i })
      expect(row).toBeInTheDocument()
      expect(screen.getByText('OIB-Richtlinie 2 Pkt. 5.1.1')).toBeInTheDocument()
    })

    test('renders the sources row in the inline variant too', () => {
      render(<AgentResponse content="Cited answer" variant="inline" citations={citations} />)

      expect(
        screen.getByRole('list', { name: /sources this answer is backed by/i })
      ).toBeInTheDocument()
    })
  })

  // Consolidation: an answer that ends in a written sources section must state
  // its sources ONCE — in the provenance block — not as dead markdown text AND
  // a chip row that each carry half the information.
  describe('consolidated source list', () => {
    const answer = [
      'Garagen brauchen zwei Fluchtwege [1].',
      '',
      '## Quellen',
      '- [1] [KB] oib-rl_4_ausgabe_mai_2023.pdf, p.9',
    ].join('\n')

    test('the written sources section is not rendered a second time in the body', () => {
      render(<AgentResponse content={answer} messageId="m1" />)

      expect(screen.queryByText(/## Quellen/)).not.toBeInTheDocument()
      expect(screen.queryByText(/\[KB\]/)).not.toBeInTheDocument()
    })

    test('its entries become numbered, anchored chips of the provenance row', () => {
      render(<AgentResponse content={answer} messageId="m1" />)

      expect(
        screen.getByRole('list', { name: /sources this answer is backed by/i })
      ).toBeInTheDocument()
      // The chip keeps its compact shape and carries the citation's [N] …
      expect(screen.getByText('1')).toBeInTheDocument()
      expect(screen.getByText('oib-rl_4_ausgabe_mai_2023.pdf')).toBeInTheDocument()
      // … and is the anchor its inline [1] marker scrolls to.
      expect(document.getElementById('answer-source-m1-1')).not.toBeNull()
    })

    test('the cited page lives behind the click, not in the row', async () => {
      const user = userEvent.setup()
      render(<AgentResponse content={answer} messageId="m1" />)

      expect(screen.queryByText('p. 9')).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: /preview source/i }))

      expect(await screen.findByText('p. 9')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /copy citation for/i })).toBeInTheDocument()
    })

    test('a written entry and its structured chip collapse into ONE row', () => {
      render(
        <AgentResponse
          content={answer}
          messageId="m1"
          citations={[
            {
              id: 'c1',
              content: '',
              timestamp: new Date(),
              isCited: true,
              kind: 'baurecht',
              lane: 'baurecht_oib',
              fileName: 'oib-rl_4_ausgabe_mai_2023.pdf',
              title: 'OIB-Richtlinie 4, Ausgabe Mai 2023',
              page: 9,
              number: 1,
            },
          ]}
        />
      )

      expect(screen.getAllByRole('listitem')).toHaveLength(1)
      // The chip keeps the human title; the raw filename is gone from the UI.
      expect(screen.getByText('OIB-Richtlinie 4, Ausgabe Mai 2023')).toBeInTheDocument()
      expect(screen.queryByText('oib-rl_4_ausgabe_mai_2023.pdf')).not.toBeInTheDocument()
    })

    test('an answer with no written section keeps the compact chip row', () => {
      render(
        <AgentResponse
          content="Cited answer"
          citations={[
            {
              id: 'c-1',
              url: 'https://example.com/article',
              content: '[Web] Some article',
              timestamp: new Date('2026-07-17T10:00:00Z'),
              isCited: true,
            },
          ]}
        />
      )

      // No numbers → no anchored rows, just the chips.
      expect(document.querySelector('[id^="answer-source-"]')).toBeNull()
      expect(
        screen.getByRole('list', { name: /sources this answer is backed by/i })
      ).toBeInTheDocument()
    })
  })

  // The routingDecision-driven visual distinction: a substantive Baurecht
  // answer (shallow/deep) wears the ink "Result" role tab; a conversational /
  // clarifying meta reply wears the quiet neutral "Note" tab. Fallback (no
  // signal) must stay identical to a substantive answer.
  describe('response-kind distinction (routingDecision)', () => {
    test('a shallow Baurecht answer wears the "Result" role tab', () => {
      render(<AgentResponse content="Baurecht answer" routingDecision="shallow" />)

      expect(screen.getByText('Result')).toBeInTheDocument()
      expect(screen.queryByText('Note')).not.toBeInTheDocument()
    })

    test('a meta reply wears the distinct "Note" role tab instead of "Result"', () => {
      render(<AgentResponse content="Hello there" routingDecision="meta" />)

      expect(screen.getByText('Note')).toBeInTheDocument()
      expect(screen.queryByText('Result')).not.toBeInTheDocument()
    })

    test('the two kinds render visibly different role tabs for the same content', () => {
      const { unmount } = render(
        <AgentResponse content="Same text" routingDecision="deep" />
      )
      expect(screen.getByText('Result')).toBeInTheDocument()
      unmount()

      render(<AgentResponse content="Same text" routingDecision="meta" />)
      expect(screen.getByText('Note')).toBeInTheDocument()
      expect(screen.queryByText('Result')).not.toBeInTheDocument()
    })

    test('fallback: absent routingDecision renders exactly as a substantive answer', () => {
      render(<AgentResponse content="Legacy answer" />)

      // No discriminator → the "Result" treatment, never the meta "Note" tab.
      expect(screen.getByText('Result')).toBeInTheDocument()
      expect(screen.queryByText('Note')).not.toBeInTheDocument()
    })

    test("fallback: an 'error' routing keeps the default \"Result\" treatment", () => {
      render(<AgentResponse content="Something went wrong" routingDecision="error" />)

      expect(screen.getByText('Result')).toBeInTheDocument()
      expect(screen.queryByText('Note')).not.toBeInTheDocument()
    })
  })
})
