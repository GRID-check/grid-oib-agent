/**
 * The routing rule, stated and changeable (ADR-0036).
 *
 * The reason this is a permanent line rather than a dismissible announcement is
 * the thing these tests pin: it has to be present at the moment the reader asks
 * "why didn't Piloti answer that?", which is not the moment the mode changed.
 */
import { describe, expect, test, vi } from 'vitest'
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'

import { EngagementNotice } from './EngagementNotice'

describe('EngagementNotice', () => {
  test('renders nothing in ask mode with nothing to offer — the composer already says it (NF-8)', () => {
    const { container } = render(<EngagementNotice mode="ask" onChange={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  /**
   * The load-bearing distinction. `ask` is the default and stays the default
   * however many people are in the thread — Piloti is the point of this product,
   * not a guest in someone else's chat app. So a multi-person thread gets a
   * QUESTION about the future, never a report of a change that already happened
   * behind the reader's back.
   */
  test('offers mention in ask mode, phrased as a question and not as a change', () => {
    render(<EngagementNotice mode="ask" suggestion="mention" onChange={vi.fn()} />)

    const notice = screen.getByTestId('engagement-notice')
    expect(notice).toHaveTextContent(
      'Several of you are talking here. Should Piloti wait to be mentioned?',
    )
    // Nothing that claims the rule already changed.
    expect(notice).not.toHaveTextContent('Piloti answers when mentioned')
  })

  test('accepting the offer sets mention', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn().mockResolvedValue(true)
    render(<EngagementNotice mode="ask" suggestion="mention" onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: 'Answer only when mentioned' }))

    expect(onChange).toHaveBeenCalledWith('mention')
  })

  test('an offer nobody may accept is not shown at all', () => {
    // A viewer cannot change the rule, and an un-actionable suggestion is noise —
    // unlike the `mention`-mode line, which explains behaviour they can see.
    const { container } = render(
      <EngagementNotice mode="ask" suggestion="mention" onChange={vi.fn()} canChange={false} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  test('states the rule in mention mode', () => {
    render(<EngagementNotice mode="mention" onChange={vi.fn()} />)

    expect(screen.getByTestId('engagement-notice')).toHaveTextContent(
      'Piloti answers when mentioned',
    )
    expect(screen.getByTestId('engagement-notice')).toHaveTextContent(
      // Deliberately not "two of you": the mode holds for any number of
      // people, and the notice used to state a headcount it does not know.
      'Several of you are talking here, so a plain message goes to everyone in the chat.',
    )
  })

  test('is the control as well as the explanation', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn().mockResolvedValue(true)
    render(<EngagementNotice mode="mention" onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: 'Let Piloti answer everything' }))

    expect(onChange).toHaveBeenCalledWith('ask')
  })

  test('a refused change says so — a control that silently does nothing reads as broken', async () => {
    const user = userEvent.setup()
    render(<EngagementNotice mode="mention" onChange={vi.fn().mockResolvedValue(false)} />)

    await user.click(screen.getByRole('button', { name: 'Let Piloti answer everything' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('That could not be changed.')
  })

  test('a thrown change is reported too, not swallowed', async () => {
    const user = userEvent.setup()
    render(
      <EngagementNotice
        mode="mention"
        onChange={vi.fn().mockRejectedValue(new Error('offline'))}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Let Piloti answer everything' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  test('a reader who cannot write here still gets the explanation, without the control', () => {
    // The rule affects what they see, so it is theirs to understand; it is not
    // theirs to change.
    render(<EngagementNotice mode="mention" onChange={vi.fn()} canChange={false} />)

    expect(screen.getByTestId('engagement-notice')).toHaveTextContent(
      'Piloti answers when mentioned',
    )
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
