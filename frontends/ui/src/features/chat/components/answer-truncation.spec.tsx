/**
 * The truncation line under the answer: the last hop, and the empty case.
 *
 * `research_truncated` on the terminal frame → `researchTruncated` on the
 * message → `AgentResponse`, which puts ONE muted line under the sources row.
 * The sentence is not the same in both cases and that is the whole point: an
 * answer that found nothing cannot be told it rests on "the evidence gathered
 * up to that point", and cut-off-before-anything-was-found is the worst case
 * this feature exists for.
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
 * into two places. The German is the product's real language and is pinned
 * separately, below.
 */
const copy = {
  truncated: en.chat.answerSources.researchTruncated,
  truncatedEmpty: en.chat.answerSources.researchTruncatedWithoutSources,
}

/** An answer that carries a real source, so the chips row renders. */
const CITED = 'Die Antwort [1].\n\n## Quellen\n[1] OIB-Richtlinie 3 — https://example.org/oib3'

describe.each(['default', 'inline'] as const)('the %s answer variant', (variant) => {
  test('a turn that was cut off says so, under the sources', async () => {
    render(<AgentResponse content={CITED} variant={variant} researchTruncated />)
    await userEvent.setup().click(screen.getByTestId('answer-details-trigger'))

    const note = screen.getByText(copy.truncated)
    expect(note).toBeInTheDocument()
    // A fact about the evidence, not an error: it is a note, not an alert.
    expect(note).toHaveAttribute('role', 'note')
  })

  test('a turn that found nothing gets the sentence that is true of it', async () => {
    render(<AgentResponse content="Dazu habe ich nichts gefunden." variant={variant} researchTruncated />)
    await userEvent.setup().click(screen.getByTestId('answer-details-trigger'))

    // The gap row above already says the answer cites nothing; promising "the
    // evidence gathered up to that point" beside it would contradict it.
    expect(screen.getByText(copy.truncatedEmpty)).toBeInTheDocument()
    expect(screen.queryByText(copy.truncated)).not.toBeInTheDocument()
  })

  test('a turn that finished its research says nothing at all', () => {
    render(<AgentResponse content={CITED} variant={variant} />)

    expect(screen.queryByText(copy.truncated)).not.toBeInTheDocument()
    expect(screen.queryByText(copy.truncatedEmpty)).not.toBeInTheDocument()
  })
})

describe('both locales carry a real sentence', () => {
  test.each([
    ['researchTruncated'],
    ['researchTruncatedWithoutSources'],
  ] as const)('%s is written twice, not translated once', (key) => {
    // German is the product's language here and English is its own sentence,
    // not a gloss of it — so the two must differ, and neither may be a
    // half-finished template that ships a brace to the reader.
    expect(de.chat.answerSources[key]).not.toBe(en.chat.answerSources[key])
    for (const text of [de.chat.answerSources[key], en.chat.answerSources[key]]) {
      expect(text.trim().length).toBeGreaterThan(20)
      expect(text).not.toContain('{')
    }
  })

  test('the two German sentences are not the same sentence', () => {
    // The empty case is the one worth getting right; a copy-paste that left
    // both keys identical would promise evidence that is not there.
    expect(de.chat.answerSources.researchTruncated).not.toBe(
      de.chat.answerSources.researchTruncatedWithoutSources
    )
  })
})
