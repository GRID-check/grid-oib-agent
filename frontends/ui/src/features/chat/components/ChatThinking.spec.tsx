import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { ChatThinking } from './ChatThinking'
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

/** Expand outer Herleitung, then technical intermediate-steps section. */
const expandToSteps = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByText(/Trace ·/))
  await user.click(screen.getByText('Intermediate steps'))
}

describe('ChatThinking', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
      // An unclassified step surfaces its own display name (honest fallback).
      expect(screen.getByText('Test Function …')).toBeInTheDocument()
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
      expect(screen.getByText('Test Function …')).toBeInTheDocument()
    })

    test('falls back to the generic working copy when there is no step yet', () => {
      // No steps, but data-source signal keeps the panel mounted while thinking.
      render(<ChatThinking steps={[]} isThinking={true} enabledDataSources={['web_search']} />)

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

      expect(screen.getByText('Test Function …')).toBeInTheDocument()
      expect(screen.queryByText('Interrupted')).not.toBeInTheDocument()
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

      expect(screen.getByText('Test Function …')).toBeInTheDocument()
      expect(screen.queryByText('Waiting for response')).not.toBeInTheDocument()
    })
  })

  describe('collapse/expand toggle', () => {
    test('shows Herleitung summary with step and source counts', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} />)

      expect(screen.getByText('Trace · 1 steps · 0 sources')).toBeInTheDocument()
    })

    test('step list is collapsed by default', () => {
      const steps = [createStep({ displayName: 'Intent Classifier' })]

      render(<ChatThinking steps={steps} />)

      expect(screen.getByText('Trace · 1 steps · 0 sources')).toBeInTheDocument()
      expect(screen.queryByText('Intent Classifier')).not.toBeInTheDocument()
    })

    test('expands technical steps after second toggle', async () => {
      const user = userEvent.setup()
      const steps = [createStep({ displayName: 'Intent Classifier' })]

      render(<ChatThinking steps={steps} />)

      await expandToSteps(user)

      expect(screen.getByText('Intent Classifier')).toBeVisible()
    })
  })

  describe('source fan-out', () => {
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

      expect(screen.getByText('Trace · 1 steps · 1 sources')).toBeInTheDocument()

      await user.click(screen.getByText(/Trace ·/))

      expect(screen.getByText('OIB-RL_2_Brandschutz.pdf')).toBeVisible()
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

      expect(screen.getByText('Intent Classifier')).toBeVisible()
      expect(screen.getByText('Depth Router')).toBeVisible()
      expect(screen.getByText('Web Search Tool')).toBeVisible()
      expect(screen.getByText('Tavily Search')).toBeVisible()
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

      expect(screen.getByText('Workflow Task')).toBeVisible()
      expect(screen.getByText('Agent Step')).toBeVisible()
      expect(screen.getByText('Tool Step')).toBeVisible()
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

  describe('data sources footer (always visible)', () => {
    // The basis footer (data sources + files as pills) stays visible WITHOUT
    // expanding the Herleitung — an always-present chip row.
    test('shows enabled data sources as chips without expanding', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} enabledDataSources={['web_search', 'knowledge_base']} />)

      expect(screen.getByText('Selected Data Sources:')).toBeVisible()
      expect(screen.getByText('Web Search')).toBeVisible()
      expect(screen.getByText('Knowledge Base')).toBeVisible()
    })

    test('shows files as chips', () => {
      const steps = [createStep()]
      const messageFiles = [
        { id: 'file-1', fileName: 'document.pdf' },
        { id: 'file-2', fileName: 'report.docx' },
      ]

      render(<ChatThinking steps={steps} messageFiles={messageFiles} />)

      expect(screen.getByText('document.pdf')).toBeVisible()
      expect(screen.getByText('report.docx')).toBeVisible()
    })

    test('shows both data sources and files as chips', () => {
      const steps = [createStep()]

      render(
        <ChatThinking
          steps={steps}
          enabledDataSources={['web_search']}
          messageFiles={[{ id: 'file-1', fileName: 'document.pdf' }]}
        />
      )

      expect(screen.getByText('Web Search')).toBeVisible()
      expect(screen.getByText('document.pdf')).toBeVisible()
    })

    test('maps knowledge_layer to the OIB Knowledge Base chip', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} enabledDataSources={['web_search', 'knowledge_layer']} />)

      expect(screen.getByText('OIB Knowledge Base')).toBeVisible()
      expect(screen.queryByText(/knowledge_layer/i)).not.toBeInTheDocument()
    })

    test('title-cases unknown data source ids into chips', () => {
      const steps = [createStep()]

      render(
        <ChatThinking steps={steps} enabledDataSources={['web_search', 'onedrive', 'google_drive']} />
      )

      expect(screen.getByText('Web Search')).toBeVisible()
      expect(screen.getByText('Onedrive')).toBeVisible()
      expect(screen.getByText('Google Drive')).toBeVisible()
    })

    test('shows no footer when there are no data sources or files', () => {
      const steps = [createStep()]

      render(<ChatThinking steps={steps} />)

      expect(screen.queryByText('Selected Data Sources:')).not.toBeInTheDocument()
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

      expect(screen.getByText('Question understood')).toBeVisible()
      expect(
        screen.getByText(/Wie viele Rettungswege brauche ich\?/)
      ).toBeVisible()
    })

    test('assessment node renders a confidence pill when answerConfidence is set', async () => {
      const user = userEvent.setup()
      const steps = [createStep()]

      render(<ChatThinking steps={steps} answerConfidence="high" />)

      await expandChain(user)

      expect(screen.getByText('Well supported')).toBeVisible()
    })

    test('assessment node renders citation chips (deduped by lane)', async () => {
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

      expect(screen.getByText('Backed by')).toBeVisible()
      // Deduped to a single lane chip.
      expect(screen.getAllByText('OIB-Richtlinie')).toHaveLength(1)
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
