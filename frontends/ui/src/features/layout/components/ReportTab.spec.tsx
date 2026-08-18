import { render, screen } from '@/test-utils'
import { vi, describe, test, expect } from 'vitest'
import { ReportTab } from './ReportTab'
import { asStoreState, type DeepPartial, type StoreSelector } from '@/test-utils/store-fixtures'
import type { ChatStoreWithHydration } from '@/features/chat/store'

// Mock the chat store
vi.mock('@/features/chat', () => ({
  useChatStore: vi.fn((selector?: StoreSelector<ChatStoreWithHydration>) => {
    const state: DeepPartial<ChatStoreWithHydration> = {
      reportContent: '',
      isStreaming: false,
      currentStatus: null,
    }
    return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
  }),
}))

// The `[N]` markers are linked by a remark plugin inside the real renderer, so
// a stand-in has to expose the OTHER half of what ReportTab hands over: which
// numbers it licensed the prose to link. (That the plugin then links them is
// citation-markers.spec's job, against the real parser.)
const { markerNumbers } = vi.hoisted(() => ({
  markerNumbers: (plugins?: unknown[]): number[] => {
    for (const plugin of plugins ?? []) {
      const options = Array.isArray(plugin) ? (plugin[1] as { numbers?: Set<number> }) : null
      if (options?.numbers) return [...options.numbers]
    }
    return []
  },
}))

// Mock MarkdownRenderer
vi.mock('@/shared/components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({
    content,
    isStreaming,
    remarkPlugins,
  }: {
    content: string
    isStreaming?: boolean
    remarkPlugins?: unknown[]
  }) => (
    <div
      data-testid="markdown"
      data-streaming={isStreaming}
      data-citation-numbers={markerNumbers(remarkPlugins).join(',')}
    >
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
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: DeepPartial<ChatStoreWithHydration> = {
        reportContent: '# Report Title\n\nReport content here',
        isStreaming: false,
        currentStatus: null,
        deepResearchCards: [],
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })

    render(<ReportTab />)

    expect(screen.getByTestId('markdown')).toHaveTextContent('# Report Title')
  })

  test('renders title when provided', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: DeepPartial<ChatStoreWithHydration> = {
        reportContent: 'Some content',
        isStreaming: false,
        currentStatus: null,
        deepResearchCards: [],
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })

    render(<ReportTab />)

    expect(screen.getByText('Some content')).toBeInTheDocument()
  })

  test('shows generating indicator when streaming and writing', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: DeepPartial<ChatStoreWithHydration> = {
        reportContent: 'Partial content...',
        isStreaming: true,
        currentStatus: 'writing',
        deepResearchCards: [],
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
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

  test('extracts a markdown sources section into an anchored list and licenses its [N] markers', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: DeepPartial<ChatStoreWithHydration> = {
        reportContent:
          '# Report\n\nDuties differ [1].\n\n## Quellen\n1. OIB Richtlinie 2 — https://oib.or.at',
        reportContentCategory: 'final_report',
        isStreaming: false,
        currentStatus: null,
        deepResearchCards: [],
        deepResearchCitations: [],
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })

    render(<ReportTab />)

    // The body keeps the marker as written and carries the number that may be
    // linked…
    const body = screen.getAllByTestId('markdown')[0]
    expect(body).toHaveTextContent('Duties differ [1].')
    expect(body).toHaveAttribute('data-citation-numbers', '1')
    // …and the sources section is rendered as a list entry with a matching DOM id.
    expect(document.getElementById('report-source-1')).toBeInTheDocument()
    expect(screen.getByText('Quellen')).toBeInTheDocument()
  })

  test('appends a sources list from run citations when the markdown has none', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: DeepPartial<ChatStoreWithHydration> = {
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
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })

    render(<ReportTab />)

    expect(screen.getByText('Sources')).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://oib.or.at/ri2')
    // Uncited sources stay out of the report-level list.
    expect(screen.queryByText('https://example.com/uncited')).not.toBeInTheDocument()
  })

  test('a cited knowledge-base source renders as a real row, not a blank link', () => {
    // This list printed `citation.url` as its whole content. A document source
    // has no URL, so it rendered an empty anchor — harmless only while KB
    // sources could never be marked cited at all.
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: DeepPartial<ChatStoreWithHydration> = {
        reportContent: '# Report\n\nBody without a sources section.',
        reportContentCategory: 'final_report',
        isStreaming: false,
        currentStatus: null,
        deepResearchCards: [],
        deepResearchCitations: [
          {
            id: 'c1',
            url: undefined,
            content: '[KB] oib-rl_2_ausgabe_mai_2023.pdf, p.12',
            citationKey: 'oib-rl_2_ausgabe_mai_2023.pdf, p.12',
            fileName: 'oib-rl_2_ausgabe_mai_2023.pdf',
            page: 12,
            title: 'OIB-Richtlinie 2',
            kind: 'baurecht',
            lane: 'baurecht_oib',
            isCited: true,
          },
        ],
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })

    render(<ReportTab />)

    expect(screen.getByText('OIB-Richtlinie 2')).toBeInTheDocument()
    expect(screen.getByText('OIB')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  test('renders an origin badge per source from the parsed token', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: DeepPartial<ChatStoreWithHydration> = {
        reportContent: [
          '# Report',
          '',
          'KB fact [1]. Web fact [2]. Law [3].',
          '',
          '## Sources',
          '[1] [KB] OIB Richtlinie 2, p.3',
          '[2] [Web] Example — https://example.com',
          '[3] [RIS] BauO — https://www.ris.bka.gv.at/eli/bgbl/1985/446',
        ].join('\n'),
        reportContentCategory: 'final_report',
        isStreaming: false,
        currentStatus: null,
        deepResearchCards: [],
        deepResearchCitations: [],
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })

    render(<ReportTab />)

    // Localized badges render for each origin…
    expect(screen.getByText('Knowledge base')).toBeInTheDocument()
    expect(screen.getByText('Web')).toBeInTheDocument()
    expect(screen.getByText('RIS')).toBeInTheDocument()
    // …and the origin token is stripped from the displayed source text.
    const kbEntry = document.getElementById('report-source-1')
    expect(kbEntry).toHaveTextContent('OIB Richtlinie 2, p.3')
    expect(kbEntry).not.toHaveTextContent('[KB]')
  })

  test('hides origin badges when the source-origin-badges flag is off, keeping plain token-stripped text', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: DeepPartial<ChatStoreWithHydration> = {
        reportContent: [
          '# Report',
          '',
          'KB fact [1]. Web fact [2]. Law [3].',
          '',
          '## Sources',
          '[1] [KB] OIB Richtlinie 2, p.3',
          '[2] [Web] Example — https://example.com',
          '[3] [RIS] BauO — https://www.ris.bka.gv.at/eli/bgbl/1985/446',
        ].join('\n'),
        reportContentCategory: 'final_report',
        isStreaming: false,
        currentStatus: null,
        deepResearchCards: [],
        deepResearchCitations: [],
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })

    render(<ReportTab showSourceBadges={false} />)

    // No localized badges render…
    expect(screen.queryByText('Knowledge base')).not.toBeInTheDocument()
    expect(screen.queryByText('Web')).not.toBeInTheDocument()
    expect(screen.queryByText('RIS')).not.toBeInTheDocument()
    // …but the source entries still render as plain text with the raw origin
    // token stripped (never the raw [KB] token) — falling back to before-badges.
    const kbEntry = document.getElementById('report-source-1')
    expect(kbEntry).toHaveTextContent('OIB Richtlinie 2, p.3')
    expect(kbEntry).not.toHaveTextContent('[KB]')
    const risEntry = document.getElementById('report-source-3')
    expect(risEntry).toHaveTextContent('BauO')
    expect(risEntry).not.toHaveTextContent('[RIS]')
  })

  test('renders no origin badge for sources without a token (backward compatible)', () => {
    vi.mocked(useChatStore).mockImplementation((selector?: StoreSelector<ChatStoreWithHydration>) => {
      const state: DeepPartial<ChatStoreWithHydration> = {
        reportContent:
          '# Report\n\nDuties differ [1].\n\n## Quellen\n1. OIB Richtlinie 2 — https://oib.or.at',
        reportContentCategory: 'final_report',
        isStreaming: false,
        currentStatus: null,
        deepResearchCards: [],
        deepResearchCitations: [],
      }
      return selector ? selector(asStoreState<ChatStoreWithHydration>(state)) : state
    })

    render(<ReportTab />)

    expect(document.getElementById('report-source-1')).toBeInTheDocument()
    expect(screen.queryByText('Knowledge base')).not.toBeInTheDocument()
    expect(screen.queryByText('Wissensbasis')).not.toBeInTheDocument()
  })
})
