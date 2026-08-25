/**
 * What a cut-off run cost the answer — the tokens, and the words.
 *
 * A deep run can now be CUT OFF (wall clock, step limit) and its report
 * SALVAGED from whatever it had reached. The backend records that as three
 * facts: THAT it stopped (`research_truncated`), WHY (`truncation_reason`), and
 * the ways the salvaged answer is weaker than a clean one (`degraded_reasons`).
 * Only the first of the three was ever rendered, so a partially researched
 * answer reached the reader looking exactly like a finished one — the worst
 * shape a transparency signal can take, because the reader has no way to know
 * there was anything to ask about.
 *
 * The other half is the direction of the crossing. The backend has NO locale:
 * it states stable tokens and the frontend owns the words. That makes the
 * unknown token the case worth pinning — a token is added on the producer's
 * release train, not ours, and `createTranslator` falls back to the key itself,
 * so "forgot to map it" does not render nothing, it renders
 * `answerSources.truncationReason.tool_budget` under an answer about
 * Fluchtwegbreiten. Silence is the honest rendering; the line the token merely
 * qualifies still says the thing that matters.
 *
 * And it has to survive a reload. A deep-research answer is written into the
 * thread by the JOBS runner — nobody holds a socket for a job that finishes
 * tomorrow — so the persisted row is not a backup of the live turn, it is the
 * only copy there ever was. The last describe walks that path.
 */

import { render, screen } from '@/test-utils'
import { de, en } from '@/i18n/dictionaries'
import { createTranslator } from '@/i18n/translate'
import { vi, describe, test, expect } from 'vitest'
import { AgentResponse } from './AgentResponse'
import { normalizeAgentAnswerMetadata } from '@/lib/conversations/agent-answer-metadata'
import type { MessageProvenance } from '@/lib/conversations/message-provenance'
import { asStoreState, type DeepPartial, type StoreSelector } from '@/test-utils/store-fixtures'
import type { LayoutStore } from '@/features/layout/types'
import type { ChatStoreWithHydration } from '../store'

vi.mock('../hooks/use-conversation-memory', () => ({
  useConversationMemory: () => ({ items: [], loading: false }),
}))

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

vi.mock('@/shared/components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <span>{content}</span>,
}))

/**
 * The copy is READ from the dictionary and formatted by the SAME translator the
 * component uses, so what these assert is that the answer resolves the right
 * key — not that someone typed the sentence into a second place where it can
 * quietly drift from the first. The harness renders English.
 */
const t = createTranslator(en, 'chat')
const copy = {
  truncated: en.chat.answerSources.researchTruncated,
  wallClock: en.chat.answerSources.truncationReason.wall_clock,
  stepLimit: en.chat.answerSources.truncationReason.step_limit,
  noReport: en.chat.answerSources.degradedReason.no_report_file,
  noCitations: en.chat.answerSources.degradedReason.no_valid_citations,
  removedUrl: en.chat.answerSources.citationsRemovedReason.url_not_in_registry,
}

/** An answer that carries a real source, so the chips row renders. */
const CITED = 'Die Antwort [1].\n\n## Quellen\n[1] OIB-Richtlinie 3 — https://example.org/oib3'

/** Every transparency line the answer's footer is showing, in DOM order. */
const footerNotes = (): string[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="note"]')).map(
    (element) => element.textContent ?? ''
  )

describe.each(['default', 'inline'] as const)('the %s answer variant', (variant) => {
  test('names WHY the search stopped, on the line that says it stopped', () => {
    render(
      <AgentResponse content={CITED} variant={variant} researchTruncated truncationReason="wall_clock" />
    )

    // One line, not two: "it ran out of time" is the first sentence finished,
    // not a second statement competing with it.
    const note = screen.getByText(`${copy.truncated} (${copy.wallClock})`)
    expect(note).toHaveAttribute('role', 'note')
    expect(screen.queryByText('wall_clock')).not.toBeInTheDocument()
  })

  test('the step ceiling and the clock are told apart', () => {
    render(
      <AgentResponse content={CITED} variant={variant} researchTruncated truncationReason="step_limit" />
    )

    expect(screen.getByText(`${copy.truncated} (${copy.stepLimit})`)).toBeInTheDocument()
    expect(copy.stepLimit).not.toBe(copy.wallClock)
  })

  test('a cause this build has no words for leaves the sentence exactly as it was', () => {
    // The producer adds tokens on its own release train. An unmapped one must
    // not reach the reader as an identifier, and must not cost them the fact
    // that the search stopped early — which is the part they can act on.
    render(
      <AgentResponse content={CITED} variant={variant} researchTruncated truncationReason="tool_budget" />
    )

    expect(screen.getByText(copy.truncated)).toBeInTheDocument()
    expect(screen.queryByText('tool_budget')).not.toBeInTheDocument()
    expect(screen.queryByText(/answerSources\./)).not.toBeInTheDocument()
  })

  test('a reason without the flag says nothing: presence of the flag is the fact', () => {
    render(<AgentResponse content={CITED} variant={variant} truncationReason="wall_clock" />)

    expect(footerNotes()).toHaveLength(0)
  })

  test("each degradation gets its own line, in the reader's nouns", () => {
    render(
      <AgentResponse
        content={CITED}
        variant={variant}
        researchTruncated
        degradedReasons={['no_report_file', 'no_valid_citations']}
      />
    )

    // Two lines, not one joined sentence: they ask the reader for different
    // things — where the record is, versus what to check before relying on it.
    expect(screen.getByText(copy.noReport)).toHaveAttribute('role', 'note')
    expect(screen.getByText(copy.noCitations)).toHaveAttribute('role', 'note')
  })

  test('an unknown degradation is dropped without taking the known ones with it', () => {
    render(
      <AgentResponse
        content={CITED}
        variant={variant}
        researchTruncated
        degradedReasons={['no_report_file', 'quantum_flux']}
      />
    )

    expect(screen.getByText(copy.noReport)).toBeInTheDocument()
    expect(screen.queryByText('quantum_flux')).not.toBeInTheDocument()
  })

  test('a list of nothing but unknown tokens renders no line at all', () => {
    render(<AgentResponse content={CITED} variant={variant} degradedReasons={['quantum_flux']} />)

    expect(footerNotes()).toHaveLength(0)
  })

  test('an empty list is not a claim', () => {
    // "Degraded in zero ways" is the ordinary case and is never stated — an
    // empty array must read exactly like an absent one.
    render(<AgentResponse content={CITED} variant={variant} degradedReasons={[]} />)

    expect(footerNotes()).toHaveLength(0)
  })

  test('the same degradation named twice is one line', () => {
    render(
      <AgentResponse
        content={CITED}
        variant={variant}
        degradedReasons={['no_valid_citations', 'no_valid_citations']}
      />
    )

    expect(screen.getAllByText(copy.noCitations)).toHaveLength(1)
  })
})

describe('the citation-verification reasons reach the reader as words', () => {
  test('a verification token never appears as itself', () => {
    render(
      <AgentResponse
        content={CITED}
        citationsRemoved={{ count: 1, reasons: ['url_not_in_registry'] }}
      />
    )

    // The count is the fact and rides the visible line; the reasons hang off
    // the tooltip. Neither may carry `url_not_in_registry` to an architect.
    expect(screen.queryByText('url_not_in_registry')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: t('answerSources.citationsRemoved', { count: 1 }),
      })
    ).toBeInTheDocument()
    expect(copy.removedUrl.length).toBeGreaterThan(10)
  })

  test('when no reason can be worded, the count still stands — without a tooltip to open', () => {
    render(
      <AgentResponse content={CITED} citationsRemoved={{ count: 2, reasons: ['brand_new_reason'] }} />
    )

    const label = t('answerSources.citationsRemoved', { count: 2 })
    expect(screen.getByText(label)).toHaveAttribute('role', 'note')
    expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument()
  })
})

describe('every token this build accepts has words in BOTH locales', () => {
  // The key-coverage guard cannot see these: the component builds the key from
  // the token at runtime, which is exactly the shape that ships a dot-path to
  // the reader when an entry is missing. This is that guard, for these groups.
  test.each([
    ['truncationReason', ['wall_clock', 'step_limit']],
    ['degradedReason', ['no_report_file', 'no_valid_citations']],
    [
      'citationsRemovedReason',
      [
        'url_not_in_registry',
        'citation_key_not_in_registry',
        'unverifiable',
        'duplicate',
        'ungrounded',
        'quote_unverified',
      ],
    ],
  ] as const)('%s', (group, tokens) => {
    for (const token of tokens) {
      const german = (de.chat.answerSources[group] as Record<string, string>)[token]
      const english = (en.chat.answerSources[group] as Record<string, string>)[token]

      // German is the product's language and the English is its own sentence,
      // not a gloss of it — so the two must differ, and neither may ship a
      // half-finished template or a bare token to the reader.
      expect(german, `de ${group}.${token}`).toBeTruthy()
      expect(english, `en ${group}.${token}`).toBeTruthy()
      expect(german).not.toBe(english)
      for (const text of [german, english]) {
        expect(text).not.toContain('{')
        expect(text).not.toContain(token)
      }
    }
  })
})

describe('a reopened thread shows what the live turn showed', () => {
  /**
   * The row the jobs runner writes for a finished deep run, in the backend's
   * own wire spelling (`jobs/conversation_output.write_job_turn`). This is the
   * only copy of these facts that exists for a deep answer: the client that
   * asked was long gone when the report landed.
   */
  const backendMetadata = {
    deep_research_job_id: 'job_9',
    research_truncated: true,
    truncation_reason: 'wall_clock',
    degraded_reasons: ['no_valid_citations'],
    citations_removed: { count: 2, reasons: ['url_not_in_registry'] },
  }

  const storedProvenance = (metadata: Record<string, unknown>): MessageProvenance =>
    (normalizeAgentAnswerMetadata(metadata)?.provenance ?? {}) as MessageProvenance

  test('the persisted row decodes into the same answer the socket rendered', () => {
    const live = render(
      <AgentResponse
        content={CITED}
        researchTruncated
        truncationReason="wall_clock"
        degradedReasons={['no_valid_citations']}
        citationsRemoved={{ count: 2, reasons: ['url_not_in_registry'] }}
      />
    )
    const fromTheSocket = footerNotes()
    live.unmount()

    const stored = storedProvenance(backendMetadata)
    render(
      <AgentResponse
        content={CITED}
        researchTruncated={stored.researchTruncated}
        truncationReason={stored.truncationReason}
        degradedReasons={stored.degradedReasons}
        citationsRemoved={stored.citationsRemoved}
      />
    )

    expect(footerNotes()).toEqual(fromTheSocket)
    expect(fromTheSocket).toContain(`${copy.truncated} (${copy.wallClock})`)
    expect(fromTheSocket).toContain(copy.noCitations)
    expect(
      screen.getByRole('button', { name: t('answerSources.citationsRemoved', { count: 2 }) })
    ).toBeInTheDocument()
  })

  test('a `false` on the row is read as absent, not as a second way to say no', () => {
    const stored = storedProvenance({ ...backendMetadata, research_truncated: false })

    expect(stored.researchTruncated).toBeUndefined()

    render(
      <AgentResponse
        content={CITED}
        researchTruncated={stored.researchTruncated}
        truncationReason={stored.truncationReason}
      />
    )
    // The cause is stored — a row that lost the boolean still knows something
    // true — but nothing claims the search was cut off.
    expect(stored.truncationReason).toBe('wall_clock')
    expect(screen.queryByText(new RegExp(copy.wallClock))).not.toBeInTheDocument()
    expect(footerNotes()).toHaveLength(0)
  })

  test('a token the row carries but this build cannot word costs the reader nothing else', () => {
    const stored = storedProvenance({
      research_truncated: true,
      truncation_reason: 'tool_budget',
      degraded_reasons: ['no_report_file', 'quantum_flux'],
    })

    render(
      <AgentResponse
        content={CITED}
        researchTruncated={stored.researchTruncated}
        truncationReason={stored.truncationReason}
        degradedReasons={stored.degradedReasons}
      />
    )

    expect(screen.getByText(copy.truncated)).toBeInTheDocument()
    expect(screen.getByText(copy.noReport)).toBeInTheDocument()
    expect(screen.queryByText(/tool_budget|quantum_flux/)).not.toBeInTheDocument()
  })
})
