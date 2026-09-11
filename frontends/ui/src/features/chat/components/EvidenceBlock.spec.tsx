import { render as rtlRender, screen } from '@testing-library/react'
import { render } from '@/test-utils'
import type { ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { I18nProvider } from '@/i18n'
import type { LegalBasisCardData } from '@/shared/cards/schemas'
import { chat as enChat } from '@/i18n/dictionaries/en/chat'
import { chat as deChat } from '@/i18n/dictionaries/de/chat'
import type { DeepPartial, StoreSelector } from '@/test-utils/store-fixtures'
import { asStoreState } from '@/test-utils/store-fixtures'
import type { LayoutStore } from '@/features/layout/types'
import type { ChatStoreWithHydration } from '../store'
import { AgentResponse } from './AgentResponse'
import { EvidenceBlock } from './EvidenceBlock'

/**
 * `EvidenceBlock` — the flat RECHTSGRUNDLAGE register for a `legal_basis`
 * card no `[[card:N]]` marker claimed — and its wiring in `AgentResponse`.
 *
 * Copy is pinned in German (the reader is Austrian; `fixedLocale` like the
 * card specs). The `MarkdownRenderer` is stubbed exactly as
 * `AgentResponse.spec.tsx` stubs it, so what these wiring tests own is this
 * surface's half of the contract — which block renders, and that the same
 * card never renders in both. The splice itself (a marker drawing its card
 * inline) is the crossing `answer-card-placement.spec.tsx` proves against the
 * real parser.
 */

vi.mock('@/features/layout/store', () => ({
  useLayoutStore: vi.fn((selector?: StoreSelector<LayoutStore>) => {
    const state: DeepPartial<LayoutStore> = {
      openRightPanel: vi.fn(),
      setResearchPanelTab: vi.fn(),
    }
    return selector ? selector(asStoreState<LayoutStore>(state)) : state
  }),
}))

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

vi.mock('@/adapters/api', () => ({
  cancelJob: vi.fn(),
}))

vi.mock('@/adapters/auth', () => ({
  useAuth: () => ({
    accessToken: null,
  }),
}))

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

vi.mock('@/shared/components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}))

const renderDe = (ui: ReactElement) =>
  render(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>
  )

const renderDeBare = (ui: ReactElement) =>
  rtlRender(
    <I18nProvider initialLocale="de" fixedLocale>
      {ui}
    </I18nProvider>
  )

const renderEnBare = (ui: ReactElement) =>
  rtlRender(
    <I18nProvider initialLocale="en" fixedLocale>
      {ui}
    </I18nProvider>
  )

const EVIDENCE_DE = 'KI-generierte Zitierung — prüfen Sie den Auszug anhand der Primärquelle.'
const EVIDENCE_EN = 'AI-generated citation — check the excerpt against the primary source.'
const FRAMED_DE =
  'KI-generierte Zitierung — prüfen Sie den Auszug anhand der Primärquelle (OIB / RIS).'

const legalBasis = (law: string): LegalBasisCardData => ({
  type: 'legal_basis',
  law,
  lane: 'baurecht_oib',
  edition: 'Ausgabe Mai 2023',
  article: '3.1.1',
  section: '2.3',
  summary: 'Tragende Bauteile in GK 4: mindestens REI 60.',
  original_text: 'Tragende Bauteile sind in REI 60 auszuführen.',
})

describe('EvidenceBlock', () => {
  test('renders law, reference, quote, Fundstelle and the muted disclaimer', () => {
    renderDeBare(<EvidenceBlock card={legalBasis('OIB-Richtlinie 2')} />)

    expect(screen.getByRole('region', { name: 'Rechtsgrundlage' })).toBeInTheDocument()
    expect(screen.getByText('OIB-Richtlinie 2')).toBeInTheDocument()
    expect(screen.getByText(/3\.1\.1 · 2\.3/)).toBeInTheDocument()
    expect(
      screen.getByText('Tragende Bauteile sind in REI 60 auszuführen.')
    ).toBeInTheDocument()
    expect(screen.getByText('Ausgabe Mai 2023')).toBeInTheDocument()
    expect(screen.getByText(EVIDENCE_DE)).toBeInTheDocument()
  })

  test('paints the OIB accent for an OIB lane and the law accent otherwise', () => {
    const { container, unmount } = renderDeBare(<EvidenceBlock card={legalBasis('OIB-RL 2')} />)
    expect(container.querySelector('section')?.className).toContain('border-l-source-oib/40')
    unmount()

    const ris = renderDeBare(
      <EvidenceBlock card={{ ...legalBasis('BauO'), lane: 'baurecht_ris' }} />
    )
    expect(ris.container.querySelector('section')?.className).toContain('border-l-source-law/40')
    ris.unmount()

    const unplaced = renderDeBare(<EvidenceBlock card={{ ...legalBasis('Bescheid'), lane: null }} />)
    expect(unplaced.container.querySelector('section')?.className).toContain(
      'border-l-source-law/40'
    )
  })

  test('a bare citation renders law, eyebrow and disclaimer — nothing else', () => {
    const { container } = renderDeBare(
      <EvidenceBlock
        card={{
          type: 'legal_basis',
          law: 'OIB-Richtlinie 2',
          lane: null,
          edition: null,
          article: null,
          section: null,
          summary: null,
          original_text: null,
        }}
      />
    )
    expect(screen.getByText('OIB-Richtlinie 2')).toBeInTheDocument()
    expect(screen.getByText(EVIDENCE_DE)).toBeInTheDocument()
    expect(container.querySelector('blockquote')).toBeNull()
  })

  test('renders the English copy under an English locale', () => {
    renderEnBare(<EvidenceBlock card={legalBasis('OIB-Richtlinie 2')} />)
    expect(screen.getByRole('region', { name: 'Legal basis' })).toBeInTheDocument()
    expect(screen.getByText(EVIDENCE_EN)).toBeInTheDocument()
  })

  test('the disclaimer copy is pinned in both dictionaries', () => {
    expect(enChat.cards.evidenceQuoteDisclaimer).toBe(EVIDENCE_EN)
    expect(deChat.cards.evidenceQuoteDisclaimer).toBe(EVIDENCE_DE)
  })
})

describe('AgentResponse evidence wiring', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
    )
  })

  afterEach(() => vi.unstubAllGlobals())

  test('an unplaced legal_basis renders flat above the prose, never in the fallback grid', () => {
    const { container } = renderDe(
      <AgentResponse
        content="Die Antwort steht in der Richtlinie."
        cards={[legalBasis('OIB-Richtlinie 2')]}
      />
    )
    const text = container.textContent ?? ''
    // The flat block, above the prose …
    expect(text).toContain('Rechtsgrundlage')
    expect(text.indexOf('Rechtsgrundlage')).toBeLessThan(
      text.indexOf('Die Antwort steht in der Richtlinie.')
    )
    expect(screen.getByText(EVIDENCE_DE)).toBeInTheDocument()
    // … instead of the framed fallback-grid card, never beside it.
    expect(screen.queryByText(FRAMED_DE)).not.toBeInTheDocument()
  })

  test('a legal_basis the prose claimed draws no evidence block', () => {
    const { container } = renderDe(
      <AgentResponse
        content={'Erster Absatz.\n\n[[card:1]]\n\nZweiter Absatz.'}
        cards={[legalBasis('OIB-Richtlinie 2')]}
      />
    )
    expect(container.textContent).not.toContain('Rechtsgrundlage')
    expect(screen.queryByText(EVIDENCE_DE)).not.toBeInTheDocument()
    expect(screen.queryByText(FRAMED_DE)).not.toBeInTheDocument()
  })

  test('only the first unplaced legal_basis goes flat — the second keeps its framed fallback', () => {
    renderDe(
      <AgentResponse
        content="Die Antwort steht in zwei Quellen."
        cards={[legalBasis('OIB-Richtlinie 2'), legalBasis('Wiener Bauordnung')]}
      />
    )
    expect(screen.getAllByText(EVIDENCE_DE)).toHaveLength(1)
    expect(screen.getAllByText(FRAMED_DE)).toHaveLength(1)
    expect(screen.getByText('OIB-Richtlinie 2')).toBeInTheDocument()
    expect(screen.getByText('Wiener Bauordnung')).toBeInTheDocument()
  })

  test('without a legal_basis card there is no evidence block', () => {
    const { container } = renderDe(<AgentResponse content="Nur Prosa, keine Karte." />)
    expect(container.textContent).not.toContain('Rechtsgrundlage')
  })

  test('the evidence block waits for the stream like unclaimed cards do', () => {
    const { container } = renderDe(
      <AgentResponse
        content="Die Antwort steht in der Richtlinie."
        cards={[legalBasis('OIB-Richtlinie 2')]}
        isStreaming
      />
    )
    expect(container.textContent).not.toContain('Rechtsgrundlage')
  })

  test('a topic masthead passes through: eyebrow, title, context, summary, then prose', () => {
    const { container } = renderDe(
      <AgentResponse
        content="1,10 m sind einzuhalten."
        answerMeta={{
          v: 1,
          kind: 'walkthrough',
          topic: 'Geländerhöhe bei Balkonen',
          context: 'Neubau in GK 4.',
          summary: '1,10 m ab 60 cm Absturzhöhe.',
        }}
      />
    )
    const text = container.textContent ?? ''
    for (const part of [
      'Geländerhöhe bei Balkonen',
      'Neubau in GK 4.',
      '1,10 m ab 60 cm Absturzhöhe.',
      '1,10 m sind einzuhalten.',
    ]) {
      expect(text).toContain(part)
    }
    expect(text.indexOf('Neubau in GK 4.')).toBeLessThan(text.indexOf('1,10 m ab 60 cm'))
    expect(text.indexOf('1,10 m ab 60 cm')).toBeLessThan(text.indexOf('1,10 m sind einzuhalten.'))
  })

  test('a topic holds the lede emphasis alone — the first paragraph stays body-sized', () => {
    const longBody = `${'Ein ausreichend langer erster Absatz. '.repeat(20)}\n\nZweiter Absatz.`
    const { container } = renderDe(
      <AgentResponse
        content={longBody}
        answerMeta={{ v: 1, kind: 'walkthrough', topic: 'Geländerhöhe bei Balkonen' }}
      />
    )
    expect(container.querySelector('[class*="first-child\\]:text-"]')).toBeNull()

    const { container: plain } = renderDe(<AgentResponse content={longBody} />)
    expect(plain.querySelector('[class*="first-child\\]:text-"]')).not.toBeNull()
  })
})
