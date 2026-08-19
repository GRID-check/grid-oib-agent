import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { AgentResponse } from './AgentResponse'
import { asStoreState, type DeepPartial, type StoreSelector } from '@/test-utils/store-fixtures'
import type { LayoutStore } from '@/features/layout/types'
import type { ChatStoreWithHydration } from '../store'
import type { ConversationMemoryItem } from '../hooks/use-conversation-memory'

// The answer owns the memory fetch (the merged footer's meta row must know
// whether "Piloti noted N" has anything to show), so the hook is stubbed here.
const memory = vi.hoisted(() => ({ items: [] as ConversationMemoryItem[] }))

vi.mock('../hooks/use-conversation-memory', () => ({
  useConversationMemory: () => ({ items: memory.items, loading: false }),
}))

// Mock the layout store
const mockOpenRightPanel = vi.fn()
const mockSetResearchPanelTab = vi.fn()

vi.mock('@/features/layout/store', () => ({
  useLayoutStore: vi.fn((selector?: StoreSelector<LayoutStore>) => {
    const state: DeepPartial<LayoutStore> = {
      openRightPanel: mockOpenRightPanel,
      setResearchPanelTab: mockSetResearchPanelTab,
    }
    return selector ? selector(asStoreState<LayoutStore>(state)) : state
  }),
}))

// Mock the chat store
vi.mock('../store', () => ({
  useChatStore: vi.fn((selector?: StoreSelector<ChatStoreWithHydration>) => {
    const state: DeepPartial<ChatStoreWithHydration> = {
      reportContent: '',
      deepResearchJobId: null,
      isDeepResearchStreaming: false,
      deepResearchStreamLoaded: false,
      currentConversation: null,
      patchConversationMessage: vi.fn(),
      reconnectToActiveJob: vi.fn(),
    }
    return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
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
    memory.items = []
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
    expect(container.textContent).toContain('This is a very long response. ')
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
        lane: null,
        edition: null,
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

  // Cards used to open the answer, which is the one place they cannot help: two
  // of them push the written answer — the thing that was asked for — below the
  // fold. A card the answer did not place itself now follows the prose.
  // (`MarkdownRenderer` is stubbed above, so nothing is placed inline here.)
  test('renders unplaced cards after the answer body, not before it', () => {
    const cards = [
      {
        type: 'summary' as const,
        title: 'Nachgestellte Karte',
        content: 'Summary content',
        key_points: null,
      },
    ]

    const { container } = render(<AgentResponse content="Die Antwort." cards={cards} />)

    const body = (container.textContent ?? '')
    expect(body.indexOf('Die Antwort.')).toBeGreaterThanOrEqual(0)
    expect(body.indexOf('Nachgestellte Karte')).toBeGreaterThan(body.indexOf('Die Antwort.'))
  })

  // A card the answer DID place is drawn by the marker plugin inside the
  // markdown body, so the block after the prose must not draw it a second time.
  test('leaves a card the answer placed inline out of the block', () => {
    const cards = [
      {
        type: 'summary' as const,
        title: 'Platzierte Karte',
        content: 'Summary content',
        key_points: null,
      },
    ]

    render(<AgentResponse content={'Die Antwort.\n\n[[card:1]]'} cards={cards} />)

    expect(screen.queryByText('Platzierte Karte')).not.toBeInTheDocument()
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
          lane: 'baurecht_oib' as const,
          edition: 'Ausgabe Mai 2023',
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

  // The provenance footer is ONE tinted zone with two parts: the sources block
  // and a single meta row (confidence + memory left, thumbs + timestamp right).
  describe('merged provenance footer (default card)', () => {
    const memoryItem: ConversationMemoryItem = {
      id: 'mem-1',
      kind: 'decision',
      content: 'Fluchtweg über den Innenhof',
      confidence: 'high',
      provenanceType: 'in_turn',
      sourceConversationId: 'conv-1',
      createdAt: '2026-07-17T10:00:00Z',
    }

    const citations = [
      {
        id: 'c-1',
        url: 'https://example.com/article',
        content: '[Web] Some article',
        timestamp: new Date('2026-07-17T10:00:00Z'),
        isCited: true,
      },
    ]

    test('keeps the memory chip when confidence, feedback and timestamp are all absent', () => {
      // Memory is the only thing the row has to hold — it must still mount.
      memory.items = [memoryItem]

      render(
        <AgentResponse
          content="Answer"
          conversationId="conv-1"
          showConfidenceChip={false}
          showAnswerFeedback={false}
        />
      )

      expect(screen.getByText('Piloti noted')).toBeInTheDocument()
    })

    test('renders no meta row when it would hold nothing at all', () => {
      render(<AgentResponse content="Answer" showConfidenceChip={false} showAnswerFeedback={false} />)

      expect(screen.queryByText('Piloti noted')).not.toBeInTheDocument()
      expect(screen.queryByText(/\d{1,2}:\d{2}/)).not.toBeInTheDocument()
      expect(screen.queryByText('Was this helpful?')).not.toBeInTheDocument()
    })

    test('the meta row of a bare answer holds the copy action and nothing else', () => {
      // No confidence level, no messageId for the thumbs row, no timestamp and
      // no memory. The row used to be a bare spacer here and therefore did not
      // mount at all; a completed answer can always be copied, so the copy
      // action is now what keeps it from being empty — and it is alone in it.
      render(<AgentResponse content="Answer" />)

      expect(screen.getByRole('button', { name: 'Copy answer' })).toBeInTheDocument()
      expect(screen.queryByText('Piloti noted')).not.toBeInTheDocument()
      expect(screen.queryByText('Was this helpful?')).not.toBeInTheDocument()
      expect(screen.queryByText(/\d{1,2}:\d{2}/)).not.toBeInTheDocument()
    })

    test('renders no meta row at all while the answer is still streaming', () => {
      // Streaming reserves the row's height but must not mount its content —
      // an answer that is still arriving cannot be copied or rated.
      const { container } = render(<AgentResponse content="Answer" isStreaming />)

      expect(container.querySelector('[class*="animation-delay"]')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Copy answer' })).not.toBeInTheDocument()
    })

    test('reserves meta-row height while streaming so late chips do not jump the footer', () => {
      const { container } = render(<AgentResponse content="Answer" isStreaming />)

      const reserved = container.querySelector('.min-h-6')
      expect(reserved).not.toBeNull()
      // Empty reserve only — the delayed fade starts once there is content.
      expect(reserved?.className).not.toContain('animation-delay')
    })

    test('holds confidence, memory, the thumbs row and the timestamp in ONE row', () => {
      memory.items = [memoryItem]

      render(
        <AgentResponse
          content="Answer"
          messageId="m1"
          conversationId="conv-1"
          answerConfidence="high"
          timestamp={new Date('2026-07-17T10:30:00')}
        />
      )

      // The timestamp lives inside the meta row — no longer a span floating
      // outside the card. It sits in the row's acting cluster, which is a
      // `display: contents` wrapper above `sm`, so on a desktop it is not a
      // box: everything is still one row.
      const metaRow = screen.getByText(/^\d{1,2}:\d{2}/).closest('.min-h-6')
      expect(metaRow).not.toBeNull()
      expect(metaRow).toContainElement(screen.getByText('Confidence: high'))
      expect(metaRow).toContainElement(screen.getByText('Piloti noted'))
      expect(metaRow).toContainElement(
        screen.getByRole('button', { name: 'Mark this answer as helpful' })
      )
    })

    // ── the row at phone width ──────────────────────────────────────────────
    // jsdom does no layout, so the wrap itself cannot be observed. What CAN be
    // asserted is the thing that decides it: whether a line break is even
    // possible between the copy actions and the thumbs. It is not, because they
    // are not siblings in the wrapping row any more — they are one flex item.
    test('the copy actions and the thumbs cannot wrap apart at phone width', () => {
      render(
        <AgentResponse
          content="Answer"
          messageId="m1"
          conversationId="conv-1"
          answerConfidence="high"
          timestamp={new Date('2026-07-17T10:30:00')}
          citations={citations}
        />
      )

      const copy = screen.getByRole('button', { name: 'Copy answer' })
      const thumb = screen.getByRole('button', { name: 'Mark this answer as helpful' })
      const metaRow = copy.closest('.min-h-6')
      expect(metaRow).not.toBeNull()

      // Both controls hang off ONE element that is not the wrapping row.
      const cluster = copy.parentElement?.parentElement
      expect(cluster).not.toBe(metaRow)
      expect(cluster).toContainElement(thumb)
      expect(cluster).toContainElement(screen.getByText(/^\d{1,2}:\d{2}/))

      // Below `sm` that element is a full-width, non-wrapping flex line, so the
      // row breaks before it and never inside it; above `sm` it is
      // `display: contents` and the row is exactly what it was.
      expect(cluster?.className).toContain('max-sm:flex')
      expect(cluster?.className).toContain('max-sm:w-full')
      expect(cluster?.className).toContain('max-sm:flex-nowrap')
      expect(cluster?.className).toContain('contents')
    })

    test('the acting cluster still leaves the pills in the wrapping row', () => {
      memory.items = [memoryItem]

      render(
        <AgentResponse
          content="Answer"
          messageId="m1"
          conversationId="conv-1"
          answerConfidence="high"
        />
      )

      const metaRow = screen.getByText('Confidence: high').closest('.min-h-6')
      const cluster = metaRow?.querySelector('.contents')
      expect(cluster).not.toBeNull()
      // The pills stay OUT of the acting cluster, so the row's one wrap point
      // is between the two halves — which is where it belongs.
      expect(cluster).not.toContainElement(screen.getByText('Confidence: high'))
      expect(cluster).not.toContainElement(screen.getByText('Piloti noted'))
      expect(metaRow?.className).toContain('flex-wrap')
    })

    test('renders the thumbs row in its compact inline layout inside the card', () => {
      render(<AgentResponse content="Answer" messageId="m1" conversationId="conv-1" />)

      const feedbackRoot = screen
        .getByRole('button', { name: 'Mark this answer as helpful' })
        .closest('div')?.parentElement
      // compact = wrap beside the other meta items, not a stacked full-width band.
      expect(feedbackRoot?.className).toContain('flex-wrap')
      expect(feedbackRoot?.className).not.toContain('flex-col')
    })

    test('the sources row draws no divider inside the card (the body hairline already separates)', () => {
      render(<AgentResponse content="Cited answer" citations={citations} />)

      const row = screen.getByRole('list', { name: /sources this answer is backed by/i })
      expect(row.className).not.toContain('border-t')
    })

    test('the sources row keeps its own divider in the inline variant', () => {
      render(<AgentResponse content="Cited answer" variant="inline" citations={citations} />)

      const row = screen.getByRole('list', { name: /sources this answer is backed by/i })
      expect(row.className).toContain('border-t')
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
      // … and names the Richtlinie, never the corpus filename — even though
      // the written entry the row was built from spells only the filename.
      expect(screen.getByText('OIB-Richtlinie 4, Ausgabe Mai 2023')).toBeInTheDocument()
      // … and is the anchor its inline [1] marker scrolls to.
      expect(document.getElementById('answer-source-m1-1')).not.toBeNull()
    })

    test('the cited page lives behind the click, not in the row', async () => {
      const user = userEvent.setup()
      render(<AgentResponse content={answer} messageId="m1" />)

      expect(screen.queryByText('p. 9')).not.toBeInTheDocument()
      await user.click(await screen.findByRole('button', { name: /preview source/i }))

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

  describe('lede typesetting', () => {
    const LEDE = '[&>.markdown-content>p:first-child]:text-[1.0625rem]'
    const longAnswer = [
      'Für GK 4 gilt REI 90 für tragende Bauteile.',
      'A'.repeat(320),
      'B'.repeat(320),
    ].join('\n\n')

    // MarkdownRenderer is stubbed above, so there is no `.markdown-content` to
    // hang off — look for the wrapper carrying the lede variant instead.
    const hasLede = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('div')).some((el) => el.className.includes(LEDE))

    test('a long prose answer gets its opening paragraph set as a lede', () => {
      const { container } = render(<AgentResponse content={longAnswer} />)

      expect(hasLede(container)).toBe(true)
    })

    test('a short answer is its own lede and gets no enlargement', () => {
      const { container } = render(<AgentResponse content="Ja, REI 90." />)

      expect(hasLede(container)).toBe(false)
    })

    test('an answer that opens with a heading is left alone', () => {
      const { container } = render(<AgentResponse content={`## Ergebnis\n\n${longAnswer}`} />)

      expect(hasLede(container)).toBe(false)
    })

    test('a streaming answer gets no lede — the opening is still arriving', () => {
      const { container } = render(<AgentResponse content={longAnswer} isStreaming />)

      expect(hasLede(container)).toBe(false)
    })
  })
  // Getting the answer OUT: the copy actions live in the merged footer's meta
  // row, next to the feedback thumbs — never in a band of their own.
  describe('answer copy actions', () => {
    const citations = [
      {
        id: 'copy-c1',
        content: '',
        timestamp: new Date('2026-08-18T09:00:00Z'),
        title: 'OIB-Richtlinie 2',
        fileName: 'oib-rl_2.pdf',
        collection: 'oib_knowledge',
        kind: 'baurecht' as const,
        origin: 'kb' as const,
        page: 18,
        number: 1,
        isCited: true,
      },
    ]

    test('a completed answer offers a copy button', () => {
      render(<AgentResponse content="Die Antwort." />)

      expect(screen.getByRole('button', { name: 'Copy answer' })).toBeInTheDocument()
    })

    test('the citations-resolved action appears only when the answer has sources', () => {
      const { rerender } = render(<AgentResponse content="Die Antwort." />)
      expect(screen.queryByRole('button', { name: /source references/i })).not.toBeInTheDocument()

      rerender(<AgentResponse content="Die Antwort [1]." citations={citations} />)
      expect(screen.getByRole('button', { name: /source references/i })).toBeInTheDocument()
    })

    test('an answer that is still arriving cannot be copied', () => {
      render(<AgentResponse content="Die Antwort" isStreaming />)

      expect(screen.queryByRole('button', { name: 'Copy answer' })).not.toBeInTheDocument()
    })

    test('the inline variant carries no copy actions', () => {
      render(<AgentResponse content="Die Antwort." variant="inline" citations={citations} />)

      expect(screen.queryByRole('button', { name: 'Copy answer' })).not.toBeInTheDocument()
    })
  })
})
