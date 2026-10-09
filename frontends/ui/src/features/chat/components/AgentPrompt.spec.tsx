import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { AgentPrompt } from './AgentPrompt'
import { en } from '@/i18n/dictionaries'
import { useChatStore } from '../store'
import { useLayoutStore } from '@/features/layout/store'

// Mock MarkdownRenderer
vi.mock('@/shared/components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}))

/** Choice options as the wire names them: ids `o1`, `o2`, … */
const opts = (...labels: string[]) => labels.map((label, i) => ({ id: `o${i + 1}`, label }))

describe('AgentPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({ respondToInteractionFn: null })
  })

  test('renders prompt content', () => {
    render(
      <AgentPrompt
        content="What programming language would you prefer?"
      />
    )

    expect(screen.getByTestId('markdown')).toHaveTextContent(
      'What programming language would you prefer?'
    )
  })

  test('shows "Piloti needs your input" when not responded', () => {
    render(
      <AgentPrompt
        content="Please provide more details"
        isResponded={false}
      />
    )

    expect(screen.getByText('Piloti needs your input')).toBeInTheDocument()
  })

  test('shows "Piloti received your input" when responded', () => {
    render(
      <AgentPrompt
        content="Please provide more details"
        isResponded={true}
        response="Here are the details"
      />
    )

    expect(screen.getByText('Piloti received your input')).toBeInTheDocument()
  })

  test('displays options for choice prompts', () => {
    const options = opts('Option A', 'Option B', 'Option C')

    render(<AgentPrompt content="Choose one:" options={options} />)

    expect(screen.getByText('Option A')).toBeInTheDocument()
    expect(screen.getByText('Option B')).toBeInTheDocument()
    expect(screen.getByText('Option C')).toBeInTheDocument()
  })

  test('keeps the chosen option selected (locked) when responded', () => {
    const options = opts('Option A', 'Option B')

    render(
      <AgentPrompt
        content="Choose one:"
        options={options}
        isResponded={true}
        response="o1"
      />
    )

    // Branch cards stay visible after answering — the chosen one remains and
    // every card is locked (aria-disabled, so a focused pick keeps its focus),
    // and the picker doubles as the response.
    expect(screen.getByText('Option A')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /option a/i })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: /option b/i })).toHaveAttribute('aria-disabled', 'true')
  })

  test('the pick keeps keyboard focus when the cards lock, and a locked card sends nothing', async () => {
    const user = userEvent.setup()
    const respond = vi.fn()
    useChatStore.setState({ respondToInteractionFn: respond })
    const options = opts('Option A', 'Option B')
    const { rerender } = render(<AgentPrompt content="Choose one:" options={options} />)
    const pick = screen.getByRole('button', { name: /option a/i })
    pick.focus()
    await user.keyboard('{Enter}')
    expect(respond).toHaveBeenCalledWith('o1')
    rerender(<AgentPrompt content="Choose one:" options={options} isResponded response="o1" />)
    expect(screen.getByRole('button', { name: /option a/i })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: /option b/i }))
    expect(respond).toHaveBeenCalledTimes(1)
  })

  test('displays user response when responded', () => {
    render(
      <AgentPrompt
        content="Question?"
        isResponded={true}
        response="My answer"
      />
    )

    expect(screen.getByText('My answer')).toBeInTheDocument()
  })

  test('displays timestamp when provided', () => {
    const timestamp = new Date('2024-01-15T10:30:00')

    render(
      <AgentPrompt content="Question?" timestamp={timestamp} />
    )

    expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
  })

  test('clicking an option submits it as the interaction response', async () => {
    const user = userEvent.setup()
    const respond = vi.fn()
    useChatStore.setState({ respondToInteractionFn: respond })

    render(
      <AgentPrompt
        content="Choose one:"
        options={opts('Option A', 'Option B')}
      />
    )

    await user.click(screen.getByRole('button', { name: /option b/i }))
    expect(respond).toHaveBeenCalledTimes(1)
    expect(respond).toHaveBeenCalledWith('o2')
  })

  test('option is keyboard-activatable with Enter', async () => {
    const user = userEvent.setup()
    const respond = vi.fn()
    useChatStore.setState({ respondToInteractionFn: respond })

    render(<AgentPrompt content="Choose one:" options={opts('Option A')} />)

    await user.tab()
    expect(screen.getByRole('button', { name: /option a/i })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(respond).toHaveBeenCalledWith('o1')
  })

  test('digit key selects the matching option', async () => {
    const user = userEvent.setup()
    const respond = vi.fn()
    useChatStore.setState({ respondToInteractionFn: respond })

    render(
      <AgentPrompt
        content="Choose one:"
        options={opts('Option A', 'Option B', 'Option C')}
      />
    )

    // Focus is on the document body (no editable element) — pressing "2"
    // selects the second option.
    await user.keyboard('2')
    expect(respond).toHaveBeenCalledTimes(1)
    expect(respond).toHaveBeenCalledWith('o2')
  })

  test('digit beyond the option count is ignored', async () => {
    const user = userEvent.setup()
    const respond = vi.fn()
    useChatStore.setState({ respondToInteractionFn: respond })

    render(<AgentPrompt content="Choose one:" options={opts('Only A')} />)

    await user.keyboard('5')
    expect(respond).not.toHaveBeenCalled()
  })

  test('digit typed inside a text field does not select an option', async () => {
    const user = userEvent.setup()
    const respond = vi.fn()
    useChatStore.setState({ respondToInteractionFn: respond })

    render(
      <>
        <input aria-label="composer" />
        <AgentPrompt
          content="Choose one:"
          options={opts('Option A', 'Option B')}
        />
      </>
    )

    await user.click(screen.getByLabelText('composer'))
    await user.keyboard('1')

    // The digit went into the field, not the option selector.
    expect(respond).not.toHaveBeenCalled()
    expect(screen.getByLabelText('composer')).toHaveValue('1')
  })

  test('digit shortcut is inert without a response callback (read-only options)', async () => {
    const user = userEvent.setup()
    render(<AgentPrompt content="Choose one:" options={opts('Option A')} />)

    // No throw, no selection — the listener is never attached.
    await user.keyboard('1')
    expect(screen.getByText('Option A')).toBeInTheDocument()
  })

  test('options render read-only (disabled) when no response callback is registered', () => {
    render(<AgentPrompt content="Choose one:" options={opts('Option A')} />)

    // Branch cards still render, but locked with no responder.
    expect(screen.getByText('Option A')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /option a/i })).toHaveAttribute('aria-disabled', 'true')
  })

  test('keeps non-approval prompt content untouched', () => {
    render(
      <AgentPrompt content="Which building class applies?" />
    )

    expect(screen.getByTestId('markdown')).toHaveTextContent('Which building class applies?')
    expect(screen.queryByText(/several minutes/i)).not.toBeInTheDocument()
  })

})

/**
 * The current three-way envelope: approve / shallow / cancel.
 *
 * The backend's plan preview now offers the middle way by name — a quick
 * shallow answer instead of the plan — and an explicit cancel. The component
 * must render all three, send the exact wire keywords, and keep translating
 * the answered bubble's echo back into human words.
 */
describe('AgentPrompt — three-way plan decision', () => {
  const THREE_WAY_CONTENT =
    '**Research Plan Preview**\n\n**Title:** Brandschutz in Wien\n\n**Sections:**\n  1. Einleitung\n\n---\n' +
    'Reply **approve** to proceed, **shallow** for a quick answer instead, ' +
    '**cancel** to dismiss, or provide feedback to revise the plan.'

  beforeEach(() => {
    useChatStore.setState({ respondToInteractionFn: null })
  })

  test('renders all three actions and sends the wire keyword for each', async () => {
    const user = userEvent.setup()
    const respond = vi.fn()
    useChatStore.setState({ respondToInteractionFn: respond })

    render(<AgentPrompt content={THREE_WAY_CONTENT} />)

    await user.click(screen.getByRole('button', { name: /cancel the research/i }))
    await user.click(screen.getByRole('button', { name: /answer the question briefly/i }))
    await user.click(screen.getByRole('button', { name: /approve plan/i }))

    expect(respond.mock.calls.map((c) => c[0])).toEqual(['cancel', 'shallow', 'approve'])
  })

  test('shows the three-way instruction', () => {
    useChatStore.setState({ respondToInteractionFn: vi.fn() })

    render(<AgentPrompt content={THREE_WAY_CONTENT} />)

    expect(
      screen.getByText(
        'Start the research, have your question answered briefly instead, or cancel.'
      )
    ).toBeInTheDocument()
  })

  test('strips the whole envelope line and localizes the plan scaffolding', () => {
    useChatStore.setState({ respondToInteractionFn: vi.fn() })

    render(<AgentPrompt content={THREE_WAY_CONTENT} />)

    const markdown = screen.getByTestId('markdown')
    expect(markdown).not.toHaveTextContent(/reply/i)
    expect(markdown).not.toHaveTextContent(/provide feedback/i)
    // English scaffolding replaced by dictionary copy; the plan's own words stay.
    expect(markdown).not.toHaveTextContent('Research Plan Preview')
    expect(markdown).toHaveTextContent('Research plan')
    expect(markdown).toHaveTextContent('Brandschutz in Wien')
  })

  test.each([
    ['approve', 'Research started'],
    ['shallow', 'Quick answer requested'],
    ['cancel', 'Research cancelled'],
  ])('echoes the %s decision in human words, never the wire keyword', (keyword, label) => {
    render(
      <AgentPrompt
        content={THREE_WAY_CONTENT}
        isResponded
        response={keyword}
      />
    )

    expect(screen.getByText(label)).toBeInTheDocument()
  })
})

/**
 * A colleague reading somebody else's question (ADR-0037).
 *
 * Once prompts are persisted, an observer in a shared thread sees the card — and
 * must NOT be offered the buttons: the agent tier refuses an answer from anybody but
 * the person it asked (`_may_answer_interaction`), so a button here would be
 * offering a refusal. Without a line explaining that, the card reads as broken
 * rather than as somebody else's turn.
 */
describe('AgentPrompt — a question addressed to somebody else', () => {
  beforeEach(() => {
    useChatStore.setState({ respondToInteractionFn: vi.fn() })
  })

  test('says who is being waited for instead of offering the choice', async () => {
    const user = userEvent.setup()
    const respond = vi.fn()
    useChatStore.setState({ respondToInteractionFn: respond })

    render(
      <AgentPrompt
        content="Welcher Kern?"
        options={opts('Nur Kern B', 'Beide Kerne')}
        isAddressee={false}
        addresseeName="Matthias Bigl"
      />
    )

    expect(screen.getByTestId('agent-prompt-awaiting-other')).toHaveTextContent(
      'Piloti is waiting for Matthias Bigl'
    )

    // The options are still READABLE — a colleague should see what was asked — but
    // pressing one must not answer for them.
    await user.click(screen.getByText('Beide Kerne'))
    expect(respond).not.toHaveBeenCalled()
  })

  test('falls back to a nameless line when the person cannot be resolved', () => {
    render(<AgentPrompt content="Frage?" isAddressee={false} />)

    expect(screen.getByTestId('agent-prompt-awaiting-other')).toHaveTextContent(
      'Piloti is waiting for another participant'
    )
  })

  test('withholds the approve/reject buttons too', () => {
    render(
      <AgentPrompt
        content="Do you approve this plan?"
        isAddressee={false}
        addresseeName="Matthias Bigl"
      />
    )

    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument()
  })

  test('an ANSWERED prompt needs no waiting line — it shows the decision', () => {
    render(
      <AgentPrompt
        content="Welcher Kern?"
        options={opts('Nur Kern B', 'Beide Kerne')}
        isResponded
        response="o2"
        isAddressee={false}
        addresseeName="Matthias Bigl"
      />
    )

    expect(screen.queryByTestId('agent-prompt-awaiting-other')).not.toBeInTheDocument()
  })

  test('the addressee still gets the full picker — the default is unchanged', async () => {
    const user = userEvent.setup()
    const respond = vi.fn()
    useChatStore.setState({ respondToInteractionFn: respond })

    render(
      <AgentPrompt
        content="Welcher Kern?"
        options={opts('Nur Kern B', 'Beide Kerne')}
      />
    )

    await user.click(screen.getByText('Beide Kerne'))
    expect(respond).toHaveBeenCalledWith('o2')
  })
})

/**
 * The plan card: the plan as data beside its text renders as controls, and an
 * edited approval carries the edits after the keyword.
 */
describe('AgentPrompt — the plan card', () => {
  const PLAN = {
    title: 'Brandschutz in Wien',
    sections: ['Gebäudeklasse', 'Fluchtwege'],
    genre: 'pruefbericht',
    depth: 'kurzpruefung',
  }
  const CONTENT =
    '**Research Plan Preview**\n\n**Title:** Brandschutz in Wien\n\n**Sections:**\n  1. Gebäudeklasse\n  2. Fluchtwege\n\n' +
    '```plan_json\n' +
    JSON.stringify(PLAN) +
    '\n```\n\n---\n' +
    'Reply **approve** to proceed, **shallow** for a quick answer instead, ' +
    '**cancel** to dismiss, or provide feedback to revise the plan.'

  beforeEach(() => {
    useChatStore.setState({ respondToInteractionFn: null })
  })

  test('renders the sections, the genre and the depth as controls, and hides the fence', () => {
    useChatStore.setState({ respondToInteractionFn: vi.fn() })
    render(<AgentPrompt content={CONTENT} />)
    expect(screen.getAllByTestId('plan-point').map((li) => li.textContent)).toEqual([
      'Gebäudeklasse',
      'Fluchtwege',
    ])
    expect(screen.getByRole('radio', { name: 'Compliance review' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByRole('radio', { name: 'Short review' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.queryByText(/plan_json/)).not.toBeInTheDocument()
  })

  test('an untouched plan approves with the bare keyword', async () => {
    const respond = vi.fn()
    useChatStore.setState({ respondToInteractionFn: respond })
    render(<AgentPrompt content={CONTENT} />)
    await userEvent.setup().click(screen.getByRole('button', { name: /approve plan/i }))
    expect(respond).toHaveBeenCalledWith('approve')
  })

  test('a struck point, a new point and a changed depth travel with the approval', async () => {
    const user = userEvent.setup()
    const respond = vi.fn()
    useChatStore.setState({ respondToInteractionFn: respond })
    render(<AgentPrompt content={CONTENT} />)
    await user.click(screen.getByRole('button', { name: 'Remove section: Fluchtwege' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Add a section' }),
      'Landesabweichungen{enter}'
    )
    await user.click(screen.getByRole('radio', { name: 'Full opinion' }))
    await user.click(screen.getByRole('button', { name: /approve plan/i }))
    const reply = respond.mock.calls[0]?.[0] as string
    expect(reply.startsWith('approve {')).toBe(true)
    expect(JSON.parse(reply.slice('approve '.length))).toEqual({
      sections: ['Gebäudeklasse', 'Landesabweichungen'],
      genre: 'pruefbericht',
      depth: 'gutachten',
      grundlage: [],
      ausgeschlossen: [],
    })
  })

  test('the composer’s sources travel with the approval as the Rahmen', async () => {
    const respond = vi.fn()
    useChatStore.setState({ respondToInteractionFn: respond })
    useLayoutStore.setState({
      enabledDataSourceIds: ['knowledge_base'],
      availableDataSources: [
        { id: 'knowledge_base', name: 'Wissensbasis' },
        { id: 'web_search', name: 'Web' },
      ],
    })
    try {
      render(<AgentPrompt content={CONTENT} />)
      expect(screen.getByTestId('plan-rahmen')).toHaveTextContent('Wissensbasis')
      expect(screen.getByTestId('plan-rahmen')).not.toHaveTextContent('Web')
      await userEvent.setup().click(screen.getByRole('button', { name: /approve plan/i }))
      const reply = respond.mock.calls[0]?.[0] as string
      expect(JSON.parse(reply.slice('approve '.length))).toMatchObject({
        data_sources: ['knowledge_base'],
      })
    } finally {
      useLayoutStore.setState({ enabledDataSourceIds: [], availableDataSources: null })
    }
  })

  test('the documents the reader names travel with the approval', async () => {
    const user = userEvent.setup()
    const respond = vi.fn()
    useChatStore.setState({ respondToInteractionFn: respond })
    const content = CONTENT.replace(
      '"depth":"kurzpruefung"',
      '"depth":"kurzpruefung","grundlage":[],"ausgeschlossen":[],"unterlagen":[{"name":"Einreichplan.pdf","title":"Einreichplan EG","shelf":"project"},{"name":"alt.pdf","shelf":"archiv"}]'
    )
    render(<AgentPrompt content={content} />)
    await user.click(screen.getByTestId('plan-unterlagen-pick'))
    await user.click(screen.getByRole('button', { name: 'Read in full: Einreichplan EG' }))
    await user.click(screen.getByRole('button', { name: 'Exclude: alt.pdf' }))
    await user.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByTestId('plan-grundlage')).toHaveTextContent('Einreichplan EG')
    expect(screen.getByTestId('plan-ausgeschlossen')).toHaveTextContent('alt.pdf')
    await user.click(screen.getByRole('button', { name: /approve plan/i }))
    const reply = respond.mock.calls[0]?.[0] as string
    expect(JSON.parse(reply.slice('approve '.length))).toMatchObject({
      grundlage: ['Einreichplan.pdf'],
      ausgeschlossen: ['alt.pdf'],
    })
  })

  // An answered plan folds to one line; it used to keep the whole card of
  // disabled controls standing above the run it started.
  test('an edited approval folds to one line naming the approved plan', () => {
    render(
      <AgentPrompt
        content={CONTENT}
        isResponded
        response='approve {"sections":["Gebäudeklasse","Fluchtwege","Brandabschnitte"],"depth":"gutachten"}'
      />
    )
    expect(screen.getByTestId('plan-record')).toHaveTextContent('Plan approved · 3 sections')
    expect(screen.queryByTestId('plan-checklist')).not.toBeInTheDocument()
  })

  test('the approved plan opens behind the record, read-only and as approved', async () => {
    const user = userEvent.setup()
    render(<AgentPrompt content={CONTENT} isResponded response='approve {"sections":["Nur Fluchtwege"]}' />)
    await user.click(screen.getByTestId('plan-record-toggle'))
    const points = screen.getAllByTestId('plan-point').map((row) => row.textContent)
    expect(points).toEqual(['Nur Fluchtwege'])
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  test('a bare approval counts the plan it was shown', () => {
    render(<AgentPrompt content={CONTENT} isResponded response="approve" />)
    expect(screen.getByTestId('plan-record')).toHaveTextContent('Plan approved · 2 sections')
  })

  test('a shallow answer to a plan says so, not that the plan was approved', () => {
    render(<AgentPrompt content={CONTENT} isResponded response="shallow" />)
    expect(screen.getByTestId('plan-record')).toHaveTextContent(en.chat.agentPrompt.responseShallow)
  })

  test('answering swaps the decision for the receipt in one slot', async () => {
    const respond = vi.fn()
    useChatStore.setState({ respondToInteractionFn: respond })
    const { rerender } = render(<AgentPrompt content={CONTENT} />)
    expect(screen.getByRole('button', { name: /approve plan/i })).toBeInTheDocument()
    rerender(<AgentPrompt content={CONTENT} isResponded response="approve" />)
    // The receipt waits for the decision to leave (`mode="wait"`).
    expect(await screen.findByTestId('plan-record')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /approve plan/i })).not.toBeInTheDocument()
  })

  test('has no entrance of its own: the thread row owns it', () => {
    const { container } = render(<AgentPrompt content={CONTENT} />)
    expect(container.innerHTML).not.toMatch(/animate-in/)
  })
})
