import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { vi, describe, test, expect, beforeEach } from 'vitest'
import { AgentPrompt } from './AgentPrompt'
import { useChatStore } from '../store'

// Mock MarkdownRenderer
vi.mock('@/shared/components/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}))

describe('AgentPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({ respondToInteractionFn: null })
  })

  test('renders prompt content', () => {
    render(
      <AgentPrompt
        id="prompt-1"
        type="clarification"
        content="What programming language would you prefer?"
      />
    )

    expect(screen.getByTestId('markdown')).toHaveTextContent(
      'What programming language would you prefer?'
    )
  })

  test('shows "Agent needs your input" when not responded', () => {
    render(
      <AgentPrompt
        id="prompt-1"
        type="clarification"
        content="Please provide more details"
        isResponded={false}
      />
    )

    expect(screen.getByText('Agent needs your input')).toBeInTheDocument()
  })

  test('shows "Agent received your input" when responded', () => {
    render(
      <AgentPrompt
        id="prompt-1"
        type="clarification"
        content="Please provide more details"
        isResponded={true}
        response="Here are the details"
      />
    )

    expect(screen.getByText('Agent received your input')).toBeInTheDocument()
  })

  test('displays options for choice prompts', () => {
    const options = ['Option A', 'Option B', 'Option C']

    render(<AgentPrompt id="prompt-1" type="choice" content="Choose one:" options={options} />)

    expect(screen.getByText('Option A')).toBeInTheDocument()
    expect(screen.getByText('Option B')).toBeInTheDocument()
    expect(screen.getByText('Option C')).toBeInTheDocument()
  })

  test('keeps the chosen option selected (locked) when responded', () => {
    const options = ['Option A', 'Option B']

    render(
      <AgentPrompt
        id="prompt-1"
        type="choice"
        content="Choose one:"
        options={options}
        isResponded={true}
        response="Option A"
      />
    )

    // Branch cards stay visible after answering — the chosen one remains and
    // every card is locked (disabled), so the picker doubles as the response.
    expect(screen.getByText('Option A')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /option a/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /option b/i })).toBeDisabled()
  })

  test('displays user response when responded', () => {
    render(
      <AgentPrompt
        id="prompt-1"
        type="clarification"
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
      <AgentPrompt id="prompt-1" type="clarification" content="Question?" timestamp={timestamp} />
    )

    expect(screen.getByText(/\d{1,2}:\d{2}/)).toBeInTheDocument()
  })

  test('clicking an option submits it as the interaction response', async () => {
    const user = userEvent.setup()
    const respond = vi.fn()
    useChatStore.setState({ respondToInteractionFn: respond })

    render(
      <AgentPrompt
        id="prompt-1"
        type="choice"
        content="Choose one:"
        options={['Option A', 'Option B']}
      />
    )

    await user.click(screen.getByRole('button', { name: /option b/i }))
    expect(respond).toHaveBeenCalledTimes(1)
    expect(respond).toHaveBeenCalledWith('Option B')
  })

  test('option is keyboard-activatable with Enter', async () => {
    const user = userEvent.setup()
    const respond = vi.fn()
    useChatStore.setState({ respondToInteractionFn: respond })

    render(
      <AgentPrompt id="prompt-1" type="choice" content="Choose one:" options={['Option A']} />
    )

    await user.tab()
    expect(screen.getByRole('button', { name: /option a/i })).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(respond).toHaveBeenCalledWith('Option A')
  })

  test('digit key selects the matching option', async () => {
    const user = userEvent.setup()
    const respond = vi.fn()
    useChatStore.setState({ respondToInteractionFn: respond })

    render(
      <AgentPrompt
        id="prompt-1"
        type="choice"
        content="Choose one:"
        options={['Option A', 'Option B', 'Option C']}
      />
    )

    // Focus is on the document body (no editable element) — pressing "2"
    // selects the second option.
    await user.keyboard('2')
    expect(respond).toHaveBeenCalledTimes(1)
    expect(respond).toHaveBeenCalledWith('Option B')
  })

  test('digit beyond the option count is ignored', async () => {
    const user = userEvent.setup()
    const respond = vi.fn()
    useChatStore.setState({ respondToInteractionFn: respond })

    render(
      <AgentPrompt id="prompt-1" type="choice" content="Choose one:" options={['Only A']} />
    )

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
          id="prompt-1"
          type="choice"
          content="Choose one:"
          options={['Option A', 'Option B']}
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
    render(<AgentPrompt id="prompt-1" type="choice" content="Choose one:" options={['Option A']} />)

    // No throw, no selection — the listener is never attached.
    await user.keyboard('1')
    expect(screen.getByText('Option A')).toBeInTheDocument()
  })

  test('options render read-only (disabled) when no response callback is registered', () => {
    render(<AgentPrompt id="prompt-1" type="choice" content="Choose one:" options={['Option A']} />)

    // Branch cards still render, but locked (disabled) with no responder.
    expect(screen.getByText('Option A')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /option a/i })).toBeDisabled()
  })

  test('replaces the English approval envelope with localized copy', () => {
    useChatStore.setState({ respondToInteractionFn: vi.fn() })

    render(
      <AgentPrompt
        id="prompt-1"
        type="approval"
        content={'Here is the plan.\n\nReply **approve** to proceed, **reject** to cancel.'}
      />
    )

    // The raw backend envelope sentence is stripped from the rendered content…
    expect(screen.getByTestId('markdown')).not.toHaveTextContent(/reply/i)
    expect(screen.getByTestId('markdown')).toHaveTextContent('Here is the plan.')
    // …and a localized instruction plus a duration/quota expectation appear
    // at the decision point (English fallback without an i18n provider).
    expect(
      screen.getByText('Choose "Approve" to start the research or "Reject" to cancel.')
    ).toBeInTheDocument()
    expect(
      screen.getByText(/several minutes.*quota/i)
    ).toBeInTheDocument()
  })

  test('keeps non-approval prompt content untouched', () => {
    render(
      <AgentPrompt id="prompt-1" type="clarification" content="Which building class applies?" />
    )

    expect(screen.getByTestId('markdown')).toHaveTextContent('Which building class applies?')
    expect(screen.queryByText(/several minutes/i)).not.toBeInTheDocument()
  })

  test('tabs through plan approval actions in DOM order', async () => {
    const user = userEvent.setup()
    useChatStore.setState({ respondToInteractionFn: vi.fn() })

    render(
      <AgentPrompt
        id="prompt-1"
        type="approval"
        content="Reply **approve** to proceed, **reject** to cancel"
      />
    )

    const approveButton = screen.getByRole('button', { name: /approve plan/i })
    const rejectButton = screen.getByRole('button', { name: /reject plan/i })

    expect(approveButton).not.toHaveAttribute('tabindex')
    expect(rejectButton).not.toHaveAttribute('tabindex')

    // DOM order: Reject (secondary) first, Approve (primary) last/right.
    await user.tab()
    expect(rejectButton).toHaveFocus()
    await user.tab()
    expect(approveButton).toHaveFocus()
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
        id="prompt-1"
        type="choice"
        content="Welcher Kern?"
        options={['Nur Kern B', 'Beide Kerne']}
        isAddressee={false}
        addresseeName="Matthias Bigl"
      />,
    )

    expect(screen.getByTestId('agent-prompt-awaiting-other')).toHaveTextContent(
      'Piloti is waiting for Matthias Bigl',
    )

    // The options are still READABLE — a colleague should see what was asked — but
    // pressing one must not answer for them.
    await user.click(screen.getByText('Beide Kerne'))
    expect(respond).not.toHaveBeenCalled()
  })

  test('falls back to a nameless line when the person cannot be resolved', () => {
    render(
      <AgentPrompt id="prompt-1" type="clarification" content="Frage?" isAddressee={false} />,
    )

    expect(screen.getByTestId('agent-prompt-awaiting-other')).toHaveTextContent(
      'Piloti is waiting for another participant',
    )
  })

  test('withholds the approve/reject buttons too', () => {
    render(
      <AgentPrompt
        id="prompt-1"
        type="plan_approval"
        content="Do you approve this plan?"
        isAddressee={false}
        addresseeName="Matthias Bigl"
      />,
    )

    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reject/i })).not.toBeInTheDocument()
  })

  test('an ANSWERED prompt needs no waiting line — it shows the decision', () => {
    render(
      <AgentPrompt
        id="prompt-1"
        type="choice"
        content="Welcher Kern?"
        options={['Nur Kern B', 'Beide Kerne']}
        isResponded
        response="Beide Kerne"
        isAddressee={false}
        addresseeName="Matthias Bigl"
      />,
    )

    expect(screen.queryByTestId('agent-prompt-awaiting-other')).not.toBeInTheDocument()
  })

  test('the addressee still gets the full picker — the default is unchanged', async () => {
    const user = userEvent.setup()
    const respond = vi.fn()
    useChatStore.setState({ respondToInteractionFn: respond })

    render(
      <AgentPrompt
        id="prompt-1"
        type="choice"
        content="Welcher Kern?"
        options={['Nur Kern B', 'Beide Kerne']}
      />,
    )

    await user.click(screen.getByText('Beide Kerne'))
    expect(respond).toHaveBeenCalledWith('Beide Kerne')
  })
})
