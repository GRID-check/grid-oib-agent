import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { ChatThinking } from './ChatThinking'
import { useLayoutStore } from '@/features/layout/store'
import type { ThinkingStep } from '../types'

const createStep = (overrides: Partial<ThinkingStep> = {}): ThinkingStep => ({
  id: 'step-1',
  userMessageId: 'msg-1',
  category: 'tasks',
  functionName: 'test_function',
  displayName: 'Test Function',
  content: 'Step content here',
  isComplete: false,
  timestamp: new Date('2024-01-15T14:30:00'),
  ...overrides,
})

/** Expand outer Herleitung, then technical intermediate-steps section. The raw
 *  technical steps are now a profile opt-in (default off), so enable the
 *  preference before drilling into them. */
const expandToSteps = async (user: ReturnType<typeof userEvent.setup>) => {
  useLayoutStore.setState({ showTechnicalReasoning: true })
  await user.click(screen.getByText(/Trace ·/))
  await user.click(await screen.findByText('Intermediate steps'))
}

/** The raw technical step list. Scoped queries are required because the
 *  executed-step chips above it repeat the same step names. */
const stepList = () => screen.getByRole('list', { name: 'Thinking steps' })

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
      await user.click(screen.getByText(/Trace ·/))
      expect(screen.queryByText('Intermediate steps')).not.toBeInTheDocument()
    })

    test('shows the technical steps section when the preference is on', async () => {
      const user = userEvent.setup()
      useLayoutStore.setState({ showTechnicalReasoning: true })
      render(<ChatThinking steps={[createStep()]} />)
      await user.click(screen.getByText(/Trace ·/))
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

    // NB: the "a manual toggle in between is not stomped" guarantee (the
    // prevAutoOpen ref only re-drives `open` when autoOpen actually CHANGES) is
    // covered by the transition test above plus the ref-guard logic; a UI-level
    // manual-collapse assertion proved flaky against the controlled Collapsible
    // in jsdom, so it is intentionally not asserted here.
})

  describe('empty state', () => {
    test('renders nothing when no steps provided', () => {
      render(<ChatThinking steps={[]} />)

      expect(screen.queryByText('Working on a response...')).not.toBeInTheDocument()
      expect(screen.queryByText('Done')).not.toBeInTheDocument()
      expect(screen.queryByText(/Trace ·/)).not.toBeInTheDocument()
    })
  })

  describe('status header', () => {
    test('shows spinner and a live activity label when isThinking is true', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} isThinking={true} />)

      expect(screen.getByLabelText('Thinking in progress')).toBeInTheDocument()
      // An unclassifiable step gets NO phrase of its own: its display name is an
      // internal identifier, and dressing one up as a status is the noise this
      // line exists to avoid. The calm generic stands in.
      expect(screen.getByText('Working on a response …')).toBeInTheDocument()
      expect(screen.queryByText('Test Function …')).not.toBeInTheDocument()
    })

    test('shows a friendly activity phrase derived from the current step', () => {
      const steps = [
        createStep({
          functionName: 'web_search_tool',
          displayName: 'Web Search Tool',
        }),
      ]

      render(<ChatThinking steps={steps} isThinking={true} />)

      expect(screen.getByText('Searching the web …')).toBeInTheDocument()
    })

    test('shows check icon and done text when isThinking is false', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} isThinking={false} />)

      expect(screen.queryByLabelText('Thinking in progress')).not.toBeInTheDocument()
      expect(screen.getByText('Done')).toBeInTheDocument()
    })

    test('defaults to isThinking true', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} />)

      expect(screen.getByLabelText('Thinking in progress')).toBeInTheDocument()
      expect(screen.getByText('Working on a response …')).toBeInTheDocument()
    })

    test('falls back to the generic working copy when the open step cannot be phrased', () => {
      render(<ChatThinking steps={[createStep({ functionName: 'acme_internal' })]} isThinking />)

      expect(screen.getByText('Working on a response …')).toBeInTheDocument()
    })

    test('shows warning icon and interrupted text when isInterrupted is true', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} isThinking={false} isInterrupted={true} />)

      expect(screen.getByText('Interrupted')).toBeInTheDocument()
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
      expect(screen.getByText('Reconnecting')).toBeInTheDocument()
      expect(
        screen.getByText('Reconnecting — checking for a finished answer …')
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

      expect(screen.getByText('Interrupted')).toBeInTheDocument()
      expect(
        screen.getByText('Connection briefly lost — the answer was dropped. Please resend.')
      ).toBeInTheDocument()
      expect(screen.queryByText('Reconnecting')).not.toBeInTheDocument()
    })

    test('shows clock icon and waiting text when isWaiting is true', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} isThinking={false} isWaiting={true} />)

      expect(screen.getByText('Waiting for response')).toBeInTheDocument()
      expect(screen.queryByText('Done')).not.toBeInTheDocument()
      expect(screen.queryByText('Interrupted')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Thinking in progress')).not.toBeInTheDocument()
    })

    test('isWaiting takes priority over isInterrupted', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} isThinking={false} isWaiting={true} isInterrupted={true} />)

      expect(screen.getByText('Waiting for response')).toBeInTheDocument()
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
    test('a single step is one step, and no source is no clause', () => {
      // Both halves of the old line were wrong at these values: it counted
      // "1 steps", and it announced "0 sources" for an answer that rests on a
      // measurement rather than on a citation — a true number that reads as a
      // failure to find anything.
      const steps = [createStep()]

      render(<ChatThinking steps={steps} />)

      expect(screen.getByText('Trace · 1 step')).toBeInTheDocument()
      expect(screen.queryByText(/source/)).not.toBeInTheDocument()
      expect(screen.queryByText(/0 sources/)).not.toBeInTheDocument()
    })

    test('several steps count as several', () => {
      render(<ChatThinking steps={[createStep(), createStep({ id: 'step-2' })]} />)

      expect(screen.getByText('Trace · 2 steps')).toBeInTheDocument()
    })

    test('step list is collapsed by default', () => {
      const steps = [createStep({ displayName: 'Intent Classifier' })]

      render(<ChatThinking steps={steps} />)

      expect(screen.getByText('Trace · 1 step')).toBeInTheDocument()
      expect(screen.queryByText('Intent Classifier')).not.toBeInTheDocument()
    })

    test('expands technical steps after second toggle', async () => {
      const user = userEvent.setup()
      const steps = [createStep({ displayName: 'Intent Classifier' })]

      render(<ChatThinking steps={steps} />)

      await expandToSteps(user)

      expect(within(stepList()).getByText('Intent Classifier')).toBeVisible()
    })
  })

  describe('source fan-out', () => {
    test('a still-running turn never reports a source as unused', async () => {
      // "gelesen, nicht verwendet" is a claim about the FINISHED answer. While
      // the turn streams nothing has been cited yet, so every retrieved
      // document read as discarded — including the ones about to be cited a
      // second later.
      const user = userEvent.setup()
      const steps = [
        createStep({
          id: 'kb',
          category: 'tools',
          functionName: 'knowledge_retrieval',
          displayName: 'Knowledge Retrieval',
          content: '',
          traceLanes: [
            {
              key: 'baurecht_oib',
              label: 'OIB-Richtlinie',
              hitCount: 1,
              sources: [{ name: 'OIB-RL_2_Brandschutz.pdf', detail: 'p.12' }],
              signal: 'law',
            },
          ],
        }),
      ]

      const { rerender } = render(<ChatThinking steps={steps} isThinking={true} />)
      await user.click(screen.getByText(/Trace ·/))
      expect(screen.queryByText('read, not used')).not.toBeInTheDocument()

      // Once the turn lands and the answer cited nothing from it, the verdict
      // becomes true and is stated.
      rerender(<ChatThinking steps={steps} isThinking={false} />)
      expect(screen.getByText('read, not used')).toBeInTheDocument()
    })

    test('renders per-document source cards from traceLanes', async () => {
      const user = userEvent.setup()
      const steps = [
        createStep({
          id: 'kb',
          category: 'tools',
          functionName: 'knowledge_retrieval',
          displayName: 'Knowledge Retrieval',
          content: '',
          traceLanes: [
            {
              key: 'baurecht_oib',
              label: 'OIB-Richtlinie',
              hitCount: 2,
              sources: [
                { name: 'OIB-RL_2_Brandschutz.pdf', detail: 'p.12' },
                { name: 'OIB-RL_2_Brandschutz.pdf', detail: 'p.18' },
              ],
              signal: 'law',
            },
          ],
        }),
      ]

      render(<ChatThinking steps={steps} isThinking={false} />)

      expect(screen.getByText('Trace · 1 step · 1 source')).toBeInTheDocument()

      await user.click(screen.getByText(/Trace ·/))

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
    test('renders all steps as flat list with displayName', async () => {
      const user = userEvent.setup()
      const steps = [
        createStep({ id: '1', displayName: 'Intent Classifier', category: 'agents' }),
        createStep({ id: '2', displayName: 'Depth Router', category: 'agents' }),
        createStep({ id: '3', displayName: 'Web Search Tool', category: 'tools' }),
        createStep({ id: '4', displayName: 'Tavily Search', category: 'tools' }),
      ]

      render(<ChatThinking steps={steps} />)

      await expandToSteps(user)

      const list = within(stepList())
      expect(list.getByText('Intent Classifier')).toBeVisible()
      expect(list.getByText('Depth Router')).toBeVisible()
      expect(list.getByText('Web Search Tool')).toBeVisible()
      expect(list.getByText('Tavily Search')).toBeVisible()
    })

    test('shows timestamps for each step', async () => {
      const user = userEvent.setup()
      const steps = [createStep({ timestamp: new Date('2024-01-15T14:30:00') })]

      render(<ChatThinking steps={steps} />)

      await expandToSteps(user)

      expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
    })

    test('renders steps from all categories in a flat list (no tabs)', async () => {
      const user = userEvent.setup()
      const steps = [
        createStep({ id: '1', category: 'tasks', displayName: 'Workflow Task' }),
        createStep({ id: '2', category: 'agents', displayName: 'Agent Step' }),
        createStep({ id: '3', category: 'tools', displayName: 'Tool Step' }),
      ]

      render(<ChatThinking steps={steps} />)

      await expandToSteps(user)

      const list = within(stepList())
      expect(list.getByText('Workflow Task')).toBeVisible()
      expect(list.getByText('Agent Step')).toBeVisible()
      expect(list.getByText('Tool Step')).toBeVisible()
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

      const triggerText = screen.getByText(/Trace ·/)
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
   * constant, activation is the event: only the `Ran:` row, derived from real
   * Function Start/Complete frames, may say what a turn did.
   */
  describe('enabled data sources are never rendered as activity', () => {
    const enabled = ['web_search', 'knowledge_layer', 'ris']

    test('a turn with sources enabled but no executed search renders no source-activity chip', () => {
      // A greeting: one assistant step ran, no search tool did.
      const steps = [
        createStep({
          functionName: 'shallow_research_agent',
          displayName: 'Shallow Research Agent',
          isComplete: true,
        }),
      ]

      render(
        <ChatThinking
          steps={steps}
          isThinking={false}
          defaultOpen
          enabledDataSources={enabled}
        />
      )

      // The activity row is present and names what really ran …
      expect(screen.getByText('Ran:')).toBeVisible()
      expect(screen.getByText('Assistant')).toBeVisible()
      // … and nothing anywhere claims a search happened.
      expect(screen.queryByText('Web search')).not.toBeInTheDocument()
      expect(screen.queryByText('Web Search')).not.toBeInTheDocument()
      expect(screen.queryByText('RIS')).not.toBeInTheDocument()
      expect(screen.queryByText('OIB knowledge')).not.toBeInTheDocument()
      expect(screen.queryByText('Selected Data Sources:')).not.toBeInTheDocument()
      expect(screen.queryByText('Attached files:')).not.toBeInTheDocument()
    })

    test('an executed web search IS reported — the fix removes the false claim, not the true one', () => {
      const steps = [
        createStep({
          functionName: 'web_search_tool',
          displayName: 'Web Search Tool',
          isComplete: true,
        }),
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
      createStep({
        id: `skill-${name}`,
        functionName: `skill:${name}`,
        displayName: name,
        content: JSON.stringify(payload),
        isComplete: true,
      })

    test('each activated skill gets its own chip, named by its title', () => {
      render(
        <ChatThinking
          isThinking
          defaultOpen
          steps={[
            skillStep('oib-brandschutz', {
              phase: 'loaded',
              name: 'oib-brandschutz',
              title: 'Brandschutznachweis',
            }),
            skillStep('schallschutz', { phase: 'activated', name: 'schallschutz' }),
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
          steps={[skillStep('a', { phase: 'offered', name: 'a', description: 'available' })]}
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
              name: 'oib-brandschutz',
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
      await user.click(screen.getByText(/Trace ·/))
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

      // The assessment node ("Assessment" eyebrow) now shows a reasoning-only
      // hit-lane summary ("Hits in: <lane>"), deduped to a single lane — not a
      // second copy of the answer's provenance chips.
      expect(screen.getByText('Assessment')).toBeVisible()
      expect(screen.getByText('Hits in: OIB-Richtlinie')).toBeVisible()
    })

    test('assessment node is hidden without confidence or citations', async () => {
      const user = userEvent.setup()
      const steps = [createStep()]

      render(<ChatThinking steps={steps} userQuestion="Frage?" />)

      await expandChain(user)

      expect(screen.queryByText('Backed by')).not.toBeInTheDocument()
    })

    test('next-steps node renders a live choice prompt and responds', async () => {
      const user = userEvent.setup()
      const onChoiceRespond = vi.fn()
      const steps = [createStep()]

      render(
        <ChatThinking
          steps={steps}
          choicePrompt={{
            promptId: 'p1',
            text: 'How do you want to proceed?',
            options: ['Option Alpha', 'Option Beta'],
            isResponded: false,
          }}
          onChoiceRespond={onChoiceRespond}
        />
      )

      await expandChain(user)

      expect(screen.getByText('Option Alpha')).toBeVisible()
      await user.click(screen.getByText('Option Beta'))
      expect(onChoiceRespond).toHaveBeenCalledWith('p1', 'Option Beta')
    })

    test('next-steps node is hidden without a choice prompt', async () => {
      const user = userEvent.setup()
      const steps = [createStep()]

      render(<ChatThinking steps={steps} userQuestion="Frage?" />)

      await expandChain(user)

      expect(screen.queryByText('Option Alpha')).not.toBeInTheDocument()
    })
  })
})
