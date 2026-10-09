import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { ChatThinking } from './ChatThinking'
import { useLayoutStore } from '@/features/layout/store'
import { storedStep } from '@/test-utils/wire-v2-steps'
import type { StoredThinkingStep } from '@/lib/conversations/message-provenance'

/** A running tool this build has no name for: it speaks on no line and earns no chip. */
const createStep = (overrides: Partial<StoredThinkingStep> = {}): StoredThinkingStep => ({
  id: 'step-1',
  userMessageId: 'msg-1',
  kind: 'tool',
  tool: 'acme_internal',
  isComplete: false,
  timestamp: '2024-01-15T14:30:00',
  ...overrides,
})

const oibSources = (hits: Array<{ name: string; detail: string }>) =>
  storedStep({
    id: 'sources:0:knowledge_search:1',
    kind: 'sources',
    tool: 'knowledge_search',
    round: 0,
    lanes: [
      { key: 'baurecht_oib', label: 'OIB-Richtlinie', kind: 'baurecht', hit_count: hits.length, sources: hits },
    ],
  })

/** Expand outer Herleitung, then technical intermediate-steps section. The raw
 *  technical steps are now a profile opt-in (default off), so enable the
 *  preference before drilling into them. */
const expandToSteps = async (user: ReturnType<typeof userEvent.setup>) => {
  useLayoutStore.setState({ showTechnicalReasoning: true })
  await user.click(screen.getByText(/^Trace( ·|$)/))
  await user.click(await screen.findByText('Intermediate steps'))
}

/** The raw technical step list. Scoped queries are required because the
 *  executed-step chips above it repeat the same step names. */
const stepList = () => screen.getByRole('list', { name: 'Thinking steps' })

/** The visible header line. The phase also sits in a status region outside it. */
const header = () => within(screen.getAllByRole('button')[0])

describe('ChatThinking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default experience: technical steps hidden unless the profile opts in.
    useLayoutStore.setState({ showTechnicalReasoning: false })
  })

  describe('technical reasoning preference', () => {
    test('hides the technical steps section by default', async () => {
      const user = userEvent.setup()
      render(<ChatThinking steps={[createStep()]} />)
      await user.click(screen.getByText(/^Trace( ·|$)/))
      expect(screen.queryByText('Intermediate steps')).not.toBeInTheDocument()
    })

    test('shows the technical steps section when the preference is on', async () => {
      const user = userEvent.setup()
      useLayoutStore.setState({ showTechnicalReasoning: true })
      render(<ChatThinking steps={[createStep()]} />)
      await user.click(screen.getByText(/^Trace( ·|$)/))
      expect(await screen.findByText('Intermediate steps')).toBeInTheDocument()
    })
  })

  describe('turn-driven autoOpen (live expands, done collapses)', () => {
    // The expanded reasoning renders the "Attached files:" footer (moved inside
    // the collapsible), so its presence is a proxy for "expanded".
    const files = [{ id: 'file-1', fileName: 'plan.pdf' }]

    test('autoOpen expands the reasoning without a click (live turn)', () => {
      render(<ChatThinking steps={[createStep()]} autoOpen messageFiles={files} />)
      expect(screen.getByText('Attached files:')).toBeVisible()
    })

    test('autoOpen=false keeps the reasoning collapsed (past/done turn)', () => {
      render(<ChatThinking steps={[createStep()]} autoOpen={false} messageFiles={files} />)
      expect(screen.queryByText('Attached files:')).not.toBeInTheDocument()
    })

    test('a live→done autoOpen transition collapses the reasoning', async () => {
      const { rerender } = render(
        <ChatThinking steps={[createStep()]} autoOpen messageFiles={files} />
      )
      expect(screen.getByText('Attached files:')).toBeVisible()
      rerender(<ChatThinking steps={[createStep()]} autoOpen={false} messageFiles={files} />)
      await waitFor(() => expect(screen.queryByText('Attached files:')).not.toBeInTheDocument())
    })

    test('the fold: the turn closes what it opened, in the render the prop changes', () => {
      const { rerender } = render(
        <ChatThinking steps={[createStep()]} isThinking autoOpen messageFiles={files} />
      )
      rerender(
        <ChatThinking steps={[createStep()]} isThinking answering autoOpen={false} messageFiles={files} />
      )
      // The content is leaving (its exit runs), and the header is still live.
      expect(screen.getByLabelText('Thinking in progress')).toBeInTheDocument()
      expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument()
    })

    test('a HITL wait does not force the panel open: the choice is answered in its prompt card', () => {
      const { rerender } = render(
        <ChatThinking steps={[createStep()]} isThinking autoOpen={false} messageFiles={files} />
      )
      rerender(
        <ChatThinking steps={[createStep()]} isThinking={false} isWaiting autoOpen={false} messageFiles={files} />
      )
      expect(screen.queryByText('Attached files:')).not.toBeInTheDocument()
    })

    test('a panel the reader opened while live keeps its cap through the settle', async () => {
      const user = userEvent.setup()
      const { rerender, container } = render(
        <ChatThinking steps={[createStep()]} isThinking autoOpen={false} messageFiles={files} />
      )
      await user.click(screen.getByRole('button', { expanded: false }))
      const capped = () => container.querySelector('[class*="max-h-[min(50svh,420px)]"]')
      expect(capped()).not.toBeNull()
      rerender(<ChatThinking steps={[createStep()]} isThinking={false} autoOpen={false} messageFiles={files} />)
      expect(capped()).not.toBeNull()
    })

    test('a panel the reader opened is not folded or reopened by the turn', async () => {
      const user = userEvent.setup()
      const { rerender } = render(
        <ChatThinking steps={[createStep()]} isThinking autoOpen={false} messageFiles={files} />
      )
      await user.click(screen.getByRole('button', { expanded: false }))
      expect(screen.getByText('Attached files:')).toBeVisible()
      rerender(<ChatThinking steps={[createStep()]} isThinking autoOpen messageFiles={files} />)
      rerender(
        <ChatThinking steps={[createStep()]} isThinking answering autoOpen={false} messageFiles={files} />
      )
      expect(screen.getByText('Attached files:')).toBeVisible()
    })
  })

  describe('the header from the send to the settle', () => {
    test('while the answer streams it stays live, names the panel, and does not shimmer', () => {
      const { container } = render(<ChatThinking steps={[createStep()]} isThinking answering />)

      expect(screen.getByLabelText('Thinking in progress')).toBeInTheDocument()
      expect(screen.getByText('Trace')).toBeInTheDocument()
      expect(header().queryByText('Working on a response …')).not.toBeInTheDocument()
      // The caret is the turn's one moving thing now: no shimmer, no spinner.
      expect(container.querySelector('[data-slot="spinner"]')).toBeNull()
    })

    test('a stopped turn shows „Stopped", never the green check', () => {
      render(<ChatThinking steps={[createStep()]} isThinking={false} isStopped />)

      expect(screen.getByText('Stopped')).toBeInTheDocument()
      expect(screen.queryByText('Done')).not.toBeInTheDocument()
    })

    test('the timer counts from the question, so a late mount does not restart it', () => {
      const since = new Date(Date.now() - 12_000)
      render(<ChatThinking steps={[createStep()]} isThinking since={since} />)

      expect(screen.getByText('12s')).toBeInTheDocument()
    })

    test('at the settle the timer freezes on the answer\'s own duration instead of vanishing', () => {
      const since = new Date(Date.now() - 12_000)
      const { rerender } = render(<ChatThinking steps={[createStep()]} isThinking since={since} />)
      rerender(
        <ChatThinking steps={[createStep()]} isThinking={false} since={since} answerDurationMs={12_400} />
      )
      expect(screen.getByText('12s')).toBeInTheDocument()
    })

    test('the trigger is named by the phase, not the per-step phrase, which is never announced', () => {
      const steps = [
        storedStep({
          id: 'status:retrieval:0',
          kind: 'retrieval',
          round: 0,
          key: 'status.retrieval.withQuery',
          values: { corpus: 'knowledge', query: 'Fluchtweg' },
        }),
      ]
      render(<ChatThinking steps={steps} isThinking />)

      const trigger = screen.getAllByRole('button')[0]
      expect(trigger).toHaveAccessibleName('Thinking in progress · Trace')
      const status = screen.getAllByRole('status').find((el) => el.getAttribute('aria-live') === 'polite')
      expect(status).toHaveTextContent('Thinking in progress')
      expect(status).not.toHaveTextContent('Fluchtweg')
    })

    test('a restored turn grows no timer', () => {
      render(<ChatThinking steps={[createStep()]} isThinking={false} answerDurationMs={11_600} />)
      expect(screen.queryByText('12s')).not.toBeInTheDocument()
    })
  })

  describe('empty state', () => {
    test('renders nothing when no steps provided', () => {
      render(<ChatThinking steps={[]} />)

      expect(screen.queryByText('Working on a response...')).not.toBeInTheDocument()
      expect(screen.queryByText('Done')).not.toBeInTheDocument()
      expect(screen.queryByText(/^Trace/)).not.toBeInTheDocument()
    })
  })

  describe('status header', () => {
    test('shows spinner and a live activity label when isThinking is true', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} isThinking={true} />)

      expect(screen.getByLabelText('Thinking in progress')).toBeInTheDocument()
      // A tool step never speaks on the live line: only a turn event does. The
      // calm generic stands in, never the identifier.
      expect(screen.getByText('Working on a response …')).toBeInTheDocument()
      expect(screen.queryByText(/acme_internal/)).not.toBeInTheDocument()
    })

    test('shows the newest turn event the backend reported, in the reader\'s words', () => {
      const steps = [
        storedStep({
          id: 'status:retrieval:0',
          kind: 'retrieval',
          round: 0,
          key: 'status.retrieval.withQuery',
          values: { corpus: 'knowledge', query: 'Fluchtweg' },
        }),
        createStep({ id: 'tool:1', tool: 'knowledge_search' }),
      ]

      render(<ChatThinking steps={steps} isThinking={true} />)

      expect(screen.getByText('Searching the knowledge base: “Fluchtweg”')).toBeInTheDocument()
    })

    test('settled, the label stays the summary: no „Done" word moves it', () => {
      // The settle swaps only the glyph and freezes the figure. „Done" in the
      // label's place moved the summary from the left of the row to the right
      // in the frame the turn ended.
      const steps = [createStep()]

      render(<ChatThinking steps={steps} isThinking={false} />)

      expect(screen.queryByLabelText('Thinking in progress')).not.toBeInTheDocument()
      const trigger = screen.getByRole('button')
      expect(trigger).toHaveAccessibleName(/Done · Trace/)
      expect(within(trigger).queryByText('Done')).not.toBeInTheDocument()
      expect(within(trigger).getAllByText(/^Trace/)).toHaveLength(1)
    })

    test('the answer streaming and the settle show the summary in the same place', () => {
      const steps = [createStep()]
      const { rerender } = render(<ChatThinking steps={steps} isThinking answering />)
      const before = within(screen.getByRole('button')).getByText(/^Trace/)

      rerender(<ChatThinking steps={steps} isThinking={false} answering />)

      // The same node: not re-keyed, so not cross-faded either.
      expect(within(screen.getByRole('button')).getByText(/^Trace/)).toBe(before)
    })

    test.each([
      ['handed_off', 'Run commissioned'],
      ['refused', 'Not handled'],
      ['failed', 'Failed'],
    ] as const)('a turn that ended %s is not „Done"', (endedAs, word) => {
      render(<ChatThinking steps={[createStep()]} isThinking={false} endedAs={endedAs} />)

      const trigger = screen.getByRole('button')
      expect(within(trigger).getByText(word)).toBeInTheDocument()
      expect(trigger).not.toHaveAccessibleName(/Done/)
    })

    test('the frozen figure is never below the last live one', () => {
      vi.useFakeTimers()
      try {
        const since = new Date(Date.now() - 7_600)
        const { rerender } = render(
          <ChatThinking steps={[createStep()]} isThinking answering since={since} />
        )
        expect(screen.getByText('7s')).toBeInTheDocument()

        // The footer's duration, measured from the send, a little shorter.
        rerender(
          <ChatThinking steps={[createStep()]} isThinking={false} answering since={since} answerDurationMs={6_900} />
        )
        expect(screen.getByText('7s')).toBeInTheDocument()
      } finally {
        vi.useRealTimers()
      }
    })

    test('the trigger is marked for the lifecycle fixtures', () => {
      render(<ChatThinking steps={[createStep()]} isThinking />)
      expect(screen.getByRole('button')).toHaveAttribute('data-herleitung-trigger')
    })

    test('while live, the executed-steps row is held before its first chip', () => {
      // The row arrives with the first tool; held, it does not push the graph
      // below it down by its height in the middle of the steps phase.
      const status = storedStep({ id: 'status:a', kind: 'status', slot: 'a', key: 'status.nope' })
      const { container } = render(<ChatThinking steps={[status]} isThinking autoOpen />)

      const held = container.querySelector('[aria-hidden="true"].invisible')
      expect(held).not.toBeNull()
    })

    test('defaults to isThinking true', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} />)

      expect(screen.getByLabelText('Thinking in progress')).toBeInTheDocument()
      expect(screen.getByText('Working on a response …')).toBeInTheDocument()
    })

    test('falls back to the generic working copy when no step can be phrased', () => {
      const unknownKey = storedStep({ id: 'status:x', kind: 'status', slot: 'x', key: 'status.nope' })
      render(<ChatThinking steps={[unknownKey]} isThinking />)

      expect(screen.getByText('Working on a response …')).toBeInTheDocument()
    })

    test('shows warning icon and interrupted text when isInterrupted is true', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} isThinking={false} isInterrupted={true} />)

      expect(header().getByText('Interrupted')).toBeInTheDocument()
      expect(screen.queryByText('Done')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Thinking in progress')).not.toBeInTheDocument()
    })

    test('isThinking takes priority over isInterrupted', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} isThinking={true} isInterrupted={true} />)

      expect(screen.getByText('Working on a response …')).toBeInTheDocument()
      expect(screen.queryByText('Interrupted')).not.toBeInTheDocument()
    })

    test('shows the calm "checking" copy while recovery is pending, not the lost notice (FIX 3)', () => {
      const steps = [createStep()]

      render(
        <ChatThinking
          steps={steps}
          isThinking={false}
          isInterrupted={true}
          isRecoveryPending={true}
        />
      )

      // Header chip + inline notice both show the reconnecting/checking copy …
      expect(header().getByText('Fetching the answer')).toBeInTheDocument()
      expect(
        screen.getByText('Piloti is still working — the answer appears here as soon as it is ready …')
      ).toBeInTheDocument()
      // … and the "answer lost" copy must NOT appear while we are still checking.
      expect(screen.queryByText('Interrupted')).not.toBeInTheDocument()
      expect(
        screen.queryByText('Connection briefly lost — the answer was dropped. Please resend.')
      ).not.toBeInTheDocument()
    })

    test('falls back to the lost/interrupted copy once recovery has settled (not pending)', () => {
      const steps = [createStep()]

      render(
        <ChatThinking
          steps={steps}
          isThinking={false}
          isInterrupted={true}
          isRecoveryPending={false}
        />
      )

      expect(header().getByText('Interrupted')).toBeInTheDocument()
      expect(
        screen.getByText('Connection briefly lost — the answer was dropped. Please resend.')
      ).toBeInTheDocument()
      expect(screen.queryByText('Fetching the answer')).not.toBeInTheDocument()
    })

    test('shows clock icon and waiting text when isWaiting is true', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} isThinking={false} isWaiting={true} />)

      expect(header().getByText('Waiting for response')).toBeInTheDocument()
      expect(screen.queryByText('Done')).not.toBeInTheDocument()
      expect(screen.queryByText('Interrupted')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Thinking in progress')).not.toBeInTheDocument()
    })

    test('isWaiting takes priority over isInterrupted', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} isThinking={false} isWaiting={true} isInterrupted={true} />)

      expect(header().getByText('Waiting for response')).toBeInTheDocument()
      expect(screen.queryByText('Interrupted')).not.toBeInTheDocument()
    })

    test('isThinking takes priority over isWaiting', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} isThinking={true} isWaiting={true} />)

      expect(screen.getByText('Working on a response …')).toBeInTheDocument()
      expect(screen.queryByText('Waiting for response')).not.toBeInTheDocument()
    })
  })

  describe('collapse/expand toggle', () => {
    test('the header counts no steps, and no source is no clause', () => {
      // A step count read as "the agent took 19 turns", and "0 sources" reads
      // as a failure to find anything.
      render(<ChatThinking steps={[createStep(), createStep({ id: 'step-2' })]} />)

      expect(screen.getByText('Trace')).toBeInTheDocument()
      expect(screen.queryByText(/step/)).not.toBeInTheDocument()
      expect(screen.queryByText(/source/)).not.toBeInTheDocument()
    })

    test('step list is collapsed by default', () => {
      const steps = [createStep({ kind: 'status', tool: undefined, slot: 'decision:routing' })]

      render(<ChatThinking steps={steps} />)

      expect(screen.getByText('Trace')).toBeInTheDocument()
      expect(screen.queryByText('decision:routing')).not.toBeInTheDocument()
    })

    test('expands technical steps after second toggle', async () => {
      const user = userEvent.setup()
      const steps = [createStep({ kind: 'status', tool: undefined, slot: 'decision:routing' })]

      render(<ChatThinking steps={steps} />)

      await expandToSteps(user)

      expect(within(stepList()).getByText('decision:routing')).toBeVisible()
    })
  })

  describe('source fan-out', () => {
    test('a still-running turn never reports a source as unused', async () => {
      // "abgerufen, nicht zitiert" is a claim about the FINISHED answer. While
      // the turn streams nothing has been cited yet, so every retrieved
      // document read as discarded — including the ones about to be cited a
      // second later.
      const user = userEvent.setup()
      const steps = [
        oibSources([{ name: 'OIB-RL_2_Brandschutz.pdf', detail: 'p.12' }]),
      ]

      const { rerender } = render(<ChatThinking steps={steps} isThinking={true} />)
      await user.click(screen.getByText(/^Trace( ·|$)/))
      expect(screen.queryByText('retrieved, not cited')).not.toBeInTheDocument()

      // Once the turn lands and the answer cited nothing from it, the verdict
      // becomes true and is stated.
      rerender(<ChatThinking steps={steps} isThinking={false} />)
      expect(screen.getByText('retrieved, not cited')).toBeInTheDocument()
    })

    test('renders per-document source cards from traceLanes', async () => {
      const user = userEvent.setup()
      const steps = [
        oibSources([
                { name: 'OIB-RL_2_Brandschutz.pdf', detail: 'p.12' },
                { name: 'OIB-RL_2_Brandschutz.pdf', detail: 'p.18' },
              ]),
      ]

      render(<ChatThinking steps={steps} isThinking={false} />)

      expect(screen.getByText('Trace · 1 source')).toBeInTheDocument()

      await user.click(screen.getByText(/^Trace( ·|$)/))

      // The card shows the DISPLAY name; the raw corpus filename only survives
      // on the tooltip, so a user never reads `oib-rl_2_ausgabe_mai_2023.pdf`.
      const name = screen.getByText('OIB-Richtlinie 2')
      expect(name).toBeVisible()
      expect(name).toHaveAttribute('title', expect.stringContaining('OIB-RL_2_Brandschutz.pdf'))
      expect(screen.queryByText('OIB-RL_2_Brandschutz.pdf')).not.toBeInTheDocument()
      expect(screen.getByText('2 hits')).toBeVisible()
      expect(screen.getByText('OIB-Richtlinie')).toBeVisible()
    })
  })

  describe('step list rendering', () => {
    test('names each row by its kind: a tool in the chip words, a slot verbatim', async () => {
      const user = userEvent.setup()
      const steps = [
        createStep({ id: '1', kind: 'status', tool: undefined, slot: 'decision:routing' }),
        createStep({ id: '2', tool: 'web_search_tool' }),
        createStep({ id: '3', tool: 'acme_internal' }),
        storedStep({ id: 'clarification', kind: 'clarification', max_turns: 3 }),
      ]

      render(<ChatThinking steps={steps} />)

      await expandToSteps(user)

      const list = within(stepList())
      expect(list.getByText('decision:routing')).toBeVisible()
      expect(list.getByText('Web search')).toBeVisible()
      expect(list.getByText('acme_internal')).toBeVisible()
      expect(list.getByText('Clarifying question')).toBeVisible()
    })

    test('shows timestamps for each step', async () => {
      const user = userEvent.setup()
      const steps = [createStep({ timestamp: '2024-01-15T14:30:00' })]

      render(<ChatThinking steps={steps} />)

      await expandToSteps(user)

      expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
    })

    test('step list has correct ARIA role', async () => {
      const user = userEvent.setup()
      const steps = [createStep()]

      render(<ChatThinking steps={steps} />)

      await expandToSteps(user)

      expect(screen.getByRole('list', { name: 'Thinking steps' })).toBeInTheDocument()
    })
  })

  describe('styling', () => {
    test('outer container has soft surface styling', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} />)

      const triggerText = screen.getByText('Trace')
      const outerDiv = triggerText.closest('.rounded-2xl.shadow-xs')
      expect(outerDiv).toBeInTheDocument()
    })
  })

  describe('attached-files footer (in expanded reasoning)', () => {
    // The basis footer (attached files as pills) lives INSIDE the expanded
    // Herleitung so the collapsed turn stays compact and answer-first
    // (P0/P2-4). It renders once the reasoning is open (`defaultOpen`).
    test('shows files as chips', () => {
      const steps = [createStep()]
      const messageFiles = [
        { id: 'file-1', fileName: 'document.pdf' },
        { id: 'file-2', fileName: 'report.docx' },
      ]

      render(<ChatThinking steps={steps} defaultOpen messageFiles={messageFiles} />)

      expect(screen.getByText('Attached files:')).toBeVisible()
      expect(screen.getByText('document.pdf')).toBeVisible()
      expect(screen.getByText('report.docx')).toBeVisible()
    })

    test('shows no footer when no files are attached', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} defaultOpen />)

      expect(screen.queryByText('Attached files:')).not.toBeInTheDocument()
    })
  })

  /**
   * The phantom web search.
   *
   * Every data source is enabled by default and `web_search` is first in the
   * registry, so the old basis footer claimed "Websuche" inside the Herleitung
   * on EVERY turn — a bare greeting included, where the backend drops all
   * data-source tools before the model ever sees them. Availability is the
   * constant, activation is the event: only the `Ran:` row, derived from the
   * turn's `tool` and `skill` steps, may say what a turn did.
   */
  describe('enabled data sources are never rendered as activity', () => {
    const enabled = ['web_search', 'knowledge_layer', 'ris']

    test('a turn with sources enabled but no executed search renders no source-activity chip', () => {
      // A greeting: the answer was composed, no search tool ran.
      const steps = [storedStep({ id: 'status:synthesis', kind: 'status', slot: 'synthesis', key: 'status.synthesis' })]

      render(
        <ChatThinking
          steps={steps}
          isThinking={false}
          defaultOpen
          enabledDataSources={enabled}
        />
      )

      // Nothing ran that has a chip, and nothing anywhere claims a search happened.
      expect(screen.queryByText('Ran:')).not.toBeInTheDocument()
      expect(screen.queryByText('Web search')).not.toBeInTheDocument()
      expect(screen.queryByText('Web Search')).not.toBeInTheDocument()
      expect(screen.queryByText('RIS')).not.toBeInTheDocument()
      expect(screen.queryByText('Knowledge')).not.toBeInTheDocument()
      expect(screen.queryByText('OIB knowledge')).not.toBeInTheDocument()
      expect(screen.queryByText('Selected Data Sources:')).not.toBeInTheDocument()
      expect(screen.queryByText('Attached files:')).not.toBeInTheDocument()
    })

    test('an executed web search IS reported — the fix removes the false claim, not the true one', () => {
      const steps = [
        createStep({ tool: 'web_search_tool', isComplete: true }),
      ]

      render(
        <ChatThinking
          steps={steps}
          isThinking={false}
          defaultOpen
          enabledDataSources={enabled}
        />
      )

      expect(screen.getByText('Web search')).toBeVisible()
    })

    test('enabled sources alone never conjure a Herleitung panel', () => {
      const { container } = render(
        <ChatThinking steps={[]} isThinking={false} enabledDataSources={enabled} />
      )

      expect(container).toBeEmptyDOMElement()
    })
  })

  /**
   * Skill activation, rendered.
   *
   * The chip row is where a reader finds out a skill shaped this answer while
   * the turn is still open; the post-hoc `SkillsUsedDisclosure` says the same
   * thing under the finished answer. They never coexist (this panel only shows
   * while thinking), and they use the same label authority so they cannot
   * disagree.
   */
  describe('skill activity', () => {
    const skillStep = (name: string, payload: Record<string, unknown>) =>
      storedStep({ id: `skill:${name}`, kind: 'skill', skill: name, ...payload })

    test('each activated skill gets its own chip, named by its title', () => {
      render(
        <ChatThinking
          isThinking
          defaultOpen
          steps={[
            skillStep('oib-brandschutz', {
              phase: 'activated',
              title: 'Brandschutznachweis',
            }),
            skillStep('schallschutz', { phase: 'activated' }),
          ]}
        />
      )

      expect(screen.getByText('Skill: Brandschutznachweis')).toBeVisible()
      // No authored title: the bare identifier, verbatim and in mono.
      const bare = screen.getByText('schallschutz')
      expect(bare).toBeVisible()
      expect(bare).toHaveClass('font-mono')
      expect(screen.queryByText(/Use Skill/i)).not.toBeInTheDocument()
    })

    test('an offered-but-unused skill claims nothing', () => {
      const { container } = render(
        <ChatThinking
          isThinking
          defaultOpen
          steps={[skillStep('a', { phase: 'offered', count: 1 })]}
        />
      )

      expect(container.textContent).not.toContain('Skill')
    })

    test('the chips stand down once the answer lands — the disclosure owns the post-hoc claim', () => {
      // `SkillsUsedDisclosure` sits under the finished answer and reports the
      // same activations with their descriptions. One fact, one owner.
      render(
        <ChatThinking
          isThinking={false}
          defaultOpen
          steps={[
            skillStep('oib-brandschutz', {
              phase: 'loaded',
              title: 'Brandschutznachweis',
            }),
          ]}
        />
      )

      expect(screen.queryByText('Skill: Brandschutznachweis')).not.toBeInTheDocument()
    })
  })

  describe('reasoning chain nodes', () => {
    const expandChain = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByText(/^Trace( ·|$)/))
    }

    test('framing node restates the user question', async () => {
      const user = userEvent.setup()
      const steps = [createStep()]

      render(<ChatThinking steps={steps} userQuestion="Wie viele Rettungswege brauche ich?" />)

      await expandChain(user)

      // The framing node restates the question (its "Framing" eyebrow labels it);
      // the leaner node no longer shows a separate "Question understood" title.
      expect(screen.getByText('Framing')).toBeVisible()
      expect(
        screen.getByText(/Wie viele Rettungswege brauche ich\?/)
      ).toBeVisible()
    })

    test('assessment node does NOT restate the confidence verdict (deduped to the answer card)', async () => {
      const user = userEvent.setup()
      const steps = [createStep()]

      render(<ChatThinking steps={steps} answerConfidence="high" />)

      await expandChain(user)

      // The trust verdict (confidence) now lives once, on the answer card — it is
      // no longer duplicated inside the Herleitung's assessment node (P1-2).
      expect(screen.queryByText('Confidence: high')).not.toBeInTheDocument()
    })

    test('assessment node summarizes hit lanes (reasoning detail, deduped by lane)', async () => {
      const user = userEvent.setup()
      const steps = [createStep()]
      const citations = [
        {
          id: 'c1',
          content: '',
          timestamp: new Date(),
          kind: 'baurecht' as const,
          lane: 'baurecht_oib',
          laneLabel: 'OIB-Richtlinie',
        },
        {
          id: 'c2',
          content: '',
          timestamp: new Date(),
          kind: 'baurecht' as const,
          lane: 'baurecht_oib',
          laneLabel: 'OIB-Richtlinie',
        },
      ]

      render(<ChatThinking steps={steps} citations={citations} />)

      await expandChain(user)

      // The findings node ("Findings" eyebrow) now shows a reasoning-only
      // hit-lane summary ("Hits in: <lane>"), deduped to a single lane — not a
      // second copy of the answer's provenance chips.
      expect(screen.getByText('Findings')).toBeVisible()
      expect(screen.getByText('Hits in: OIB-Richtlinie')).toBeVisible()
    })

    test('assessment node is hidden without confidence or citations', async () => {
      const user = userEvent.setup()
      const steps = [createStep()]

      render(<ChatThinking steps={steps} userQuestion="Frage?" />)

      await expandChain(user)

      expect(screen.queryByText('Backed by')).not.toBeInTheDocument()
    })
  })
})
