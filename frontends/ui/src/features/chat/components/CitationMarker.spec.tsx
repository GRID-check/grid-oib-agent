/**
 * The inline citation, as a reader uses it.
 *
 * Each case is a question the old scroll-link could not answer: what is this,
 * which chip did I just get sent to, and how do I reach the other pages.
 */

import { render, screen, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'
import { AgentResponse } from './AgentResponse'
import { resetSourcePreviewIndexCache } from './SourcePreview'
import type { CitationSource } from '../types'

vi.mock('@/features/layout/store', () => ({
  useLayoutStore: vi.fn((selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { openRightPanel: vi.fn(), setResearchPanelTab: vi.fn(), showTechnicalReasoning: false }
    return selector ? selector(state) : state
  }),
}))

vi.mock('../store', () => ({
  useChatStore: vi.fn((selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      projectId: null,
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

vi.mock('@/adapters/api', () => ({ cancelJob: vi.fn() }))

vi.mock('@/adapters/auth', () => ({ useAuth: () => ({ accessToken: null }) }))

vi.mock('../hooks', () => ({
  useLoadJobData: () => ({
    loadReport: vi.fn(),
    importJobStream: vi.fn(),
    loadResearchPanelTab: vi.fn(),
    isLoading: false,
    error: null,
    clearError: vi.fn(),
  }),
}))

// NOT mocked: the real MarkdownRenderer, because the marker only exists
// because of how it renders in-page anchors. Stubbing it would leave these
// tests asserting against markup no reader ever sees.

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/app/chat',
}))

const OIB = 'oib-rl_2.1_ausgabe_mai_2023.pdf'
const at = new Date('2026-07-28T12:00:00Z')

const jsonResponse = (data: unknown) => ({ ok: true, json: async () => data })

const fetchMock = vi.fn((input: RequestInfo | URL) => {
  const url = String(input)
  if (url === '/api/knowledge-base') {
    return Promise.resolve(
      jsonResponse({ files: [{ fileName: OIB, state: 'ingested', origin: 'corpus' }] })
    )
  }
  return Promise.resolve(jsonResponse({ documents: [] }))
})

const locus = (page: number, number: number, passage?: string): CitationSource => ({
  id: `c${number}`,
  content: passage ? `[KB] ${OIB}, p.${page}\n${passage}` : `[KB] ${OIB}, p.${page}`,
  citationKey: `${OIB}, p.${page}`,
  fileName: OIB,
  collection: 'oib_knowledge',
  title: 'OIB-Richtlinie 2.1, Ausgabe Mai 2023',
  origin: 'kb',
  kind: 'baurecht',
  lane: 'baurecht_oib',
  laneLabel: 'OIB-Richtlinie',
  page,
  number,
  isCited: true,
  timestamp: at,
})

const answer = [
  'Zwei Fluchtwege sind erforderlich [1], die Rauchableitung folgt daraus [2].',
  '',
  '## Quellen',
  `- [1] [KB] ${OIB}, p.5`,
  `- [2] [KB] ${OIB}, p.18`,
].join('\n')

const citations = [locus(5, 1, 'Garagen sind mechanisch zu entlüften.'), locus(18, 2)]

const renderAnswer = () =>
  render(
    <AgentResponse content={answer} messageId="m1" citations={citations} routingDecision="deep" />
  )

describe('an inline citation marker', () => {
  beforeEach(() => {
    resetSourcePreviewIndexCache()
    fetchMock.mockClear()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  test('says which source it is, without moving the reader anywhere', async () => {
    const user = userEvent.setup()
    renderAnswer()

    await user.click(screen.getByRole('button', { name: /Source 1: OIB-Richtlinie 2\.1/i }))

    // Scoped to the peek: the chip below names the same document, which is the
    // point — but this asserts what the MARKER put on screen.
    const peek = await screen.findByRole('dialog')
    expect(within(peek).getByText('OIB-Richtlinie 2.1, Ausgabe Mai 2023')).toBeInTheDocument()
    expect(within(peek).getByText('OIB-Richtlinie')).toBeInTheDocument()
    expect(within(peek).getByText('p. 5')).toBeInTheDocument()
    expect(within(peek).getByText('Garagen sind mechanisch zu entlüften.')).toBeInTheDocument()
  })

  test('marks the chip it points at, so the reader can see where they landed', async () => {
    const user = userEvent.setup()
    const { container } = renderAnswer()

    expect(container.querySelector('[data-focused]')).toBeNull()
    await user.click(screen.getByRole('button', { name: /Source 2: OIB-Richtlinie 2\.1/i }))

    // Both markers belong to ONE document, so the one chip is the one marked —
    // which is the truth the flat shape could only fake with two chips.
    const focused = container.querySelector('[data-focused]')
    expect(focused).not.toBeNull()
    expect(within(focused as HTMLElement).getByText(/OIB-Richtlinie 2\.1/)).toBeInTheDocument()
  })

  test('a marker for each page of one document resolves to that page', async () => {
    const user = userEvent.setup()
    renderAnswer()

    await user.click(screen.getByRole('button', { name: /Source 2: / }))
    // Marker [2] names p.18 — not p.5, which is merely the document's first
    // cited locus and what a document-level reference would have opened at.
    const peek = await screen.findByRole('dialog')
    expect(within(peek).getByText('p. 18')).toBeInTheDocument()
  })

  test('hovering asks the question; the reader never has to commit to it', async () => {
    // Checking a source mid-sentence is a glance. Charging a click for it — and
    // then a dismissal — is charging a commitment for a question the reader
    // wanted answered in passing.
    const user = userEvent.setup()
    renderAnswer()

    await user.hover(screen.getByRole('button', { name: /Source 1: OIB-Richtlinie 2\.1/i }))

    const peek = await screen.findByRole('dialog')
    expect(within(peek).getByText('Garagen sind mechanisch zu entlüften.')).toBeInTheDocument()
  })

  test('a hovered peek yields when the pointer leaves; a clicked one stays', async () => {
    // The two states earn their difference: a peek that vanished on pointer-out
    // could never hold a button, because reaching for one means leaving.
    const user = userEvent.setup()
    renderAnswer()
    const marker = screen.getByRole('button', { name: /Source 1: OIB-Richtlinie 2\.1/i })

    await user.hover(marker)
    await screen.findByRole('dialog')
    await user.unhover(marker)
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    await user.click(marker)
    await screen.findByRole('dialog')
    await user.unhover(marker)
    // Still there: the click pinned it.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  test('two sources behind one claim are two markers, not literal text', async () => {
    // `[1][2]` is the shape the report writers are told to emit for a claim
    // carried by two sources, and it used to reach the reader as the characters
    // "[1][2]" — beside neighbours that got their pill — because the markers
    // were linked by rewriting the markdown source, where an adjacent pair is
    // indistinguishable from `[label][ref]` reference-link syntax.
    const user = userEvent.setup()
    render(
      <AgentResponse
        content={[
          'Die Anforderungen an den Feuerwiderstand folgen der Klasse [1][2].',
          '',
          '## Quellen',
          `- [1] [KB] ${OIB}, p.5`,
          `- [2] [KB] ${OIB}, p.18`,
        ].join('\n')}
        messageId="m3"
        citations={citations}
        routingDecision="deep"
      />
    )

    expect(screen.getByRole('button', { name: /Source 1: OIB-Richtlinie 2\.1/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Source 2: OIB-Richtlinie 2\.1/i })).toBeInTheDocument()
    expect(screen.queryByText(/\[1\]\[2\]/)).toBeNull()

    // And each still resolves to its OWN locus.
    await user.click(screen.getByRole('button', { name: /Source 2: / }))
    expect(within(await screen.findByRole('dialog')).getByText('p. 18')).toBeInTheDocument()
  })

  test('the pill reserves no width its number does not use', () => {
    // Twice now the marker has pushed the sentence's own punctuation away from
    // the word it belongs to. First the literal brackets ("erforderlich [1] .");
    // then, after those went, a `min-w` floor a single digit could not fill,
    // whose surplus `justify-center` split evenly — parking a strip of tinted
    // pill between the digit and the period ("REI 90 1 ."). Both are the same
    // fault: a box wider than its contents has to put the difference somewhere,
    // and next to a full stop there is nowhere harmless to put it.
    //
    // jsdom has no layout to measure, but the fault is not really about pixels:
    // it is about the marker claiming width in advance. `tabular-nums` is what
    // actually holds the single-digit pills to one width, and it costs nothing.
    renderAnswer()

    const marker = screen.getByRole('button', { name: /Source 1: OIB-Richtlinie 2\.1/i })
    expect(marker.className).toMatch(/\btabular-nums\b/)
    expect(marker.className).not.toMatch(/\b(?:min-)?w-\[/)
  })

  test('an anchor that is not a citation stays an ordinary link', () => {
    render(
      <AgentResponse
        content={'See [the section](#some-heading) below.'}
        messageId="m2"
        routingDecision="deep"
      />
    )
    const link = screen.getByRole('link', { name: 'the section' })
    expect(link).toHaveAttribute('href', '#some-heading')
  })

  /**
   * A CONTROL THAT DOES NOTHING IS WORSE THAN NO CONTROL.
   *
   * „An dieser Stelle öffnen" used to be offered for every citation without an
   * outbound URL, with no resolution attempted. On a source the viewer cannot
   * render — a plan, a `.docx`, a citation whose shelf holds no such file — the
   * click mounted the dialog, which resolved to `info`, closed itself and
   * rendered nothing. The popover shut and nothing happened. Both directions
   * are pinned here, because closing only one of them would trade a silent
   * dead control for a silently missing live one.
   */
  describe('the open control is offered only when there is something to open', () => {
    test('offers it for a base-corpus PDF the viewer can render', async () => {
      const user = userEvent.setup()
      renderAnswer()

      await user.click(screen.getByRole('button', { name: /Source 1: OIB-Richtlinie 2\.1/i }))
      const peek = await screen.findByRole('dialog')

      expect(
        await within(peek).findByText('Open at this passage', {}, { timeout: 5000 })
      ).toBeInTheDocument()
      expect(peek.querySelector('[data-citation-open]')).not.toBeNull()
    })

    test('says so instead when the cited file is in no shelf the reader can reach', async () => {
      // The knowledge base answers with no such file, and there are no stored
      // documents — the citation resolves to `info`, which is exactly the state
      // that used to render a button that closed the popover and did nothing.
      fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ files: [], documents: [] })))

      const user = userEvent.setup()
      renderAnswer()

      await user.click(screen.getByRole('button', { name: /Source 1: OIB-Richtlinie 2\.1/i }))
      const peek = await screen.findByRole('dialog')

      expect(
        await within(peek).findByText('Cannot be opened in Piloti', {}, { timeout: 5000 })
      ).toBeInTheDocument()
      expect(peek.querySelector('[data-citation-open]')).toBeNull()
    })
  })
})
