/**
 * The "Gelesen, nicht zitiert" disclosure: the last hop, the cap, and the
 * empty case.
 *
 * `read_sources` on the terminal frame → `readSources` on the message →
 * `AgentResponse`, which puts collapsed, muted document chips inside the
 * answer details. What these assert is the contract of that section: it names
 * documents, never passages (an uncited document must not ground anything),
 * it caps at eight with an overflow count, and it is absent when everything
 * retrieved was cited.
 *
 * Rendered for BOTH variants, because the prop is passed twice — the default
 * card the thread uses and the box-less inline rendering. One of the two is
 * always the one a refactor forgets.
 */

import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { de, en } from '@/i18n/dictionaries'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { AgentResponse } from './AgentResponse'
import { asStoreState, type DeepPartial, type StoreSelector } from '@/test-utils/store-fixtures'
import type { LayoutStore } from '@/features/layout/types'
import type { ChatStoreWithHydration } from '../store'
import type { CitationSource } from '../types'

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

// The disclosure fetches descriptions on expand; a standard skill has none,
// which is the shape this test wants anyway.
const listInvocableSkills = vi.fn()
vi.mock('@/adapters/api/skills-client', () => ({
  listInvocableSkills: (...args: unknown[]) => listInvocableSkills(...args),
}))

vi.mock('@/shared/components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}))

beforeEach(() => {
  listInvocableSkills.mockReset()
  listInvocableSkills.mockResolvedValue([
    { name: 'oib-brandschutz', description: 'Prüft Brandschutz nach OIB-RL 2.', origin: 'org' },
  ])
})

/**
 * The copy is READ from the dictionaries rather than pasted here: what these
 * assert is that the answer resolves the right key in whichever locale is
 * reading (the harness renders English), not that someone typed the sentence
 * into two places.
 */
const copy = {
  label: en.chat.answerDetails.readSources.label,
  more: (count: number) =>
    en.chat.answerDetails.readSources.more.replace('{count}', String(count)),
  less: en.chat.answerDetails.readSources.less,
}

const readSource = (overrides: Partial<CitationSource> = {}): CitationSource => ({
  id: `read-${overrides.fileName ?? 'x'}`,
  content: 'oib-rl_2.pdf, p.12',
  timestamp: new Date('2026-09-01T10:00:00.000Z'),
  fileName: 'oib-rl_2.pdf',
  page: 12,
  kind: 'baurecht',
  lane: 'baurecht_oib',
  ...overrides,
})

const CITED = 'Die Antwort [1].\n\n## Quellen\n[1] OIB-Richtlinie 2 — https://example.org/oib2'

describe.each(['default', 'inline'] as const)('the %s answer variant', (variant) => {
  test('read-but-uncited documents render as collapsed muted chips', async () => {
    render(
      <AgentResponse
        content={CITED}
        variant={variant}
        readSources={[readSource(), readSource({ fileName: 'plan.pdf', page: 3, id: 'read-plan' })]}
      />
    )
    // Collapsed: nothing shows before the reader opens the details.
    expect(screen.queryByTestId('read-sources')).not.toBeInTheDocument()

    await userEvent.setup().click(screen.getByTestId('answer-details-trigger'))

    expect(screen.getByTestId('read-sources')).toBeInTheDocument()
    expect(screen.getByText(copy.label)).toBeInTheDocument()
    expect(screen.getByText('oib-rl_2.pdf')).toBeInTheDocument()
    expect(screen.getByText('plan.pdf')).toBeInTheDocument()
  })

  test('the chips name documents, never passages', async () => {
    const passage = 'Die Fluchtweglänge darf 40 m nicht überschreiten.'
    render(
      <AgentResponse
        content={CITED}
        variant={variant}
        readSources={[readSource({ snippet: passage })]}
      />
    )
    await userEvent.setup().click(screen.getByTestId('answer-details-trigger'))

    // The entry carries a snippet on the object (a producer that did not
    // strip it); the section must still not print it — an uncited document
    // grounds nothing.
    expect(screen.getByText('oib-rl_2.pdf')).toBeInTheDocument()
    expect(screen.queryByText(passage)).not.toBeInTheDocument()
  })

  test('a verbose content line never leaks into the chip', async () => {
    const passage = 'Die Fluchtweglänge darf 40 m nicht überschreiten.'
    render(
      <AgentResponse
        content={CITED}
        variant={variant}
        readSources={[readSource({ content: `oib-rl_2.pdf, p.12 — ${passage}` })]}
      />
    )
    await userEvent.setup().click(screen.getByTestId('answer-details-trigger'))

    // The entry has an identity, so it renders — but as its name only. The
    // `.passthrough()` schema lets a locator line or passage ride `content`,
    // which must never become chip text.
    expect(screen.getByText('oib-rl_2.pdf')).toBeInTheDocument()
    expect(screen.queryByText(passage)).not.toBeInTheDocument()
  })

  test('an entry without any identity is skipped, never rendered', async () => {
    const passage = 'Die Fluchtweglänge darf 40 m nicht überschreiten.'
    const orphan: CitationSource = {
      id: 'read-orphan',
      content: passage,
      timestamp: new Date('2026-09-01T10:00:00.000Z'),
    }
    render(<AgentResponse content={CITED} variant={variant} readSources={[orphan]} />)
    await userEvent.setup().click(screen.getByTestId('answer-details-trigger'))

    // No fileName, title or citationKey: the old `?? source.content` fallback
    // would have printed the passage as a chip. Now the section stays absent.
    expect(screen.queryByTestId('read-sources')).not.toBeInTheDocument()
    expect(screen.queryByText(passage)).not.toBeInTheDocument()
  })

  test('the list caps at eight with an overflow count', async () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      readSource({ fileName: `doc-${index}.pdf`, id: `read-${index}` })
    )
    render(<AgentResponse content={CITED} variant={variant} readSources={many} />)
    await userEvent.setup().click(screen.getByTestId('answer-details-trigger'))

    expect(screen.getAllByTestId('read-source-chip')).toHaveLength(8)
    expect(screen.getByTestId('read-sources-more')).toHaveTextContent(copy.more(2))
  })

  test('the overflow count expands to name every document — and folds back', async () => {
    const many = Array.from({ length: 10 }, (_, index) =>
      readSource({ fileName: `doc-${index}.pdf`, id: `read-${index}` })
    )
    render(<AgentResponse content={CITED} variant={variant} readSources={many} />)
    const user = userEvent.setup()
    await user.click(screen.getByTestId('answer-details-trigger'))

    const toggle = screen.getByTestId('read-sources-more')
    expect(toggle.tagName).toBe('BUTTON')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')

    await user.click(toggle)
    expect(screen.getAllByTestId('read-source-chip')).toHaveLength(10)
    // Every retrieved document is named — and nothing else: names, no passages.
    expect(screen.getByText('doc-8.pdf')).toBeInTheDocument()
    expect(screen.getByText('doc-9.pdf')).toBeInTheDocument()
    expect(screen.getByTestId('read-sources-more')).toHaveTextContent(copy.less)
    expect(screen.getByTestId('read-sources-more').getAttribute('aria-expanded')).toBe('true')

    await user.click(screen.getByTestId('read-sources-more'))
    expect(screen.getAllByTestId('read-source-chip')).toHaveLength(8)
    expect(screen.getByTestId('read-sources-more')).toHaveTextContent(copy.more(2))
  })

  test('a turn that cited everything it read says nothing at all', async () => {
    // A timestamp so the details trigger renders; the disclosure itself must
    // still be absent.
    const at = new Date('2026-09-01T10:00:00.000Z')
    render(<AgentResponse content={CITED} variant={variant} timestamp={at} />)
    await userEvent.setup().click(screen.getByTestId('answer-details-trigger'))

    expect(screen.queryByTestId('read-sources')).not.toBeInTheDocument()
    expect(screen.queryByText(copy.label)).not.toBeInTheDocument()
  })
})

describe('both locales carry a real label', () => {
  test('the label is written twice, not translated once', () => {
    // German is the product's language here and English is its own label, not
    // a gloss of it — so the two must differ, and neither may be a
    // half-finished template that ships a brace to the reader.
    expect(de.chat.answerDetails.readSources.label).not.toBe(en.chat.answerDetails.readSources.label)
    for (const text of [
      de.chat.answerDetails.readSources.label,
      en.chat.answerDetails.readSources.label,
    ]) {
      expect(text.trim().length).toBeGreaterThan(3)
      expect(text).not.toContain('{')
    }
  })
})
