import { describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor, within } from '@/test-utils'
import userEvent from '@testing-library/user-event'

import type { AwaitingStateResponse, PendingMentionView } from '@/lib/mentions/types'
import { AwaitingBanner } from './AwaitingBanner'

const person = (id: string, name: string) => ({
  userId: id,
  name,
  email: `${id}@example.com`,
  profilePictureUrl: null,
})

const request = (overrides: Partial<PendingMentionView> = {}): PendingMentionView => ({
  id: 'r-1',
  person: person('u-anna', 'Anna Weber'),
  requestedBy: person('u-matthias', 'Matthias Bigl'),
  note: null,
  anchorId: 'm-9',
  createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  ...overrides,
})

const state = (
  pending: PendingMentionView[],
  awaitingMe = false,
): AwaitingStateResponse => ({ pending, awaitingMe })

describe('AwaitingBanner — the silence is explained (MN-8)', () => {
  test('renders nothing when nothing is awaited — the agent is free to answer', () => {
    const { container } = render(<AwaitingBanner awaiting={state([])} onRelease={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  test('renders nothing when the state has not loaded yet', () => {
    const { container } = render(<AwaitingBanner awaiting={null} onRelease={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  test('names who is awaited, says why Piloti is quiet, and who asked, and since when', () => {
    render(<AwaitingBanner awaiting={state([request()])} onRelease={vi.fn()} />)
    expect(screen.getByText('Waiting for Anna Weber')).toBeInTheDocument()
    expect(screen.getByText('Piloti is holding off until someone answers.')).toBeInTheDocument()
    expect(screen.getByText('Asked by Matthias Bigl')).toBeInTheDocument()
    expect(screen.getByText(/^since /)).toBeInTheDocument()
  })

  test('shows the asker’s question when there is one (MN-12)', () => {
    render(
      <AwaitingBanner
        awaiting={state([request({ note: 'Ist das Atrium ein eigener Abschnitt?' })])}
        onRelease={vi.fn()}
      />,
    )
    expect(screen.getByText('Ist das Atrium ein eigener Abschnitt?')).toBeInTheDocument()
  })

  test('keeps the question visible when several people are awaited', () => {
    // It used to render only for a single request, so the moment a second person
    // was asked, what they were asked vanished from the banner entirely.
    render(
      <AwaitingBanner
        awaiting={state([
          request({ id: 'r-1', note: 'Ist das Atrium ein eigener Abschnitt?' }),
          request({
            id: 'r-2',
            person: person('u-tobias', 'Tobias Kern'),
            note: 'Gilt hier OIB 2 oder 2.1?',
          }),
        ])}
        onRelease={vi.fn()}
      />,
    )
    expect(screen.getByText('Ist das Atrium ein eigener Abschnitt?')).toBeInTheDocument()
    expect(screen.getByText('Gilt hier OIB 2 oder 2.1?')).toBeInTheDocument()
  })

  test('attributes each wait to the person who asked it, not to the oldest asker', () => {
    render(
      <AwaitingBanner
        awaiting={state([
          request({ id: 'r-1', requestedBy: person('u-matthias', 'Matthias Bigl') }),
          request({
            id: 'r-2',
            person: person('u-tobias', 'Tobias Kern'),
            requestedBy: person('u-lena', 'Lena Fuchs'),
          }),
        ])}
        onRelease={vi.fn()}
      />,
    )
    const rows = screen.getAllByTestId('awaiting-person')
    expect(within(rows[0]).getByText('Asked by Matthias Bigl')).toBeInTheDocument()
    expect(within(rows[1]).getByText('Asked by Lena Fuchs')).toBeInTheDocument()
  })

  test('gives each row its own since-time, not the oldest request’s', () => {
    // The thread-level "asked by X, since Y" is narrowed to the single-person
    // case precisely because it would describe somebody else's wait here — so
    // every row has to carry its own, or the fact is simply gone.
    render(
      <AwaitingBanner
        awaiting={state([
          request({ id: 'r-1', createdAt: '2026-07-29T07:15:00Z' }),
          request({
            id: 'r-2',
            person: person('u-tobias', 'Tobias Kern'),
            createdAt: '2026-07-29T09:40:00Z',
          }),
        ])}
        onRelease={vi.fn()}
      />,
    )
    const rows = screen.getAllByTestId('awaiting-person')
    const times = rows.map((row) => within(row).getByText(/^since /).textContent)
    expect(times[0]).not.toEqual(times[1])
    expect(rows[0].querySelector('time')).toHaveAttribute('datetime', '2026-07-29T07:15:00Z')
    expect(rows[1].querySelector('time')).toHaveAttribute('datetime', '2026-07-29T09:40:00Z')
  })

  test('a row reads the question before it offers the way out of it', () => {
    // A screen reader follows source order. Offering "continue without Anna" to
    // somebody who has not been told what Anna was asked is the wrong order.
    render(
      <AwaitingBanner
        awaiting={state([
          request({ id: 'r-1', note: 'Ist das Atrium ein eigener Abschnitt?' }),
          request({
            id: 'r-2',
            person: person('u-tobias', 'Tobias Kern'),
            note: 'Gilt hier OIB 2 oder 2.1?',
          }),
        ])}
        onRelease={vi.fn()}
      />,
    )
    const row = screen.getAllByTestId('awaiting-person')[0]
    const note = within(row).getByText('Ist das Atrium ein eigener Abschnitt?')
    const button = within(row).getByRole('button')
    // Document position, not `row.children` indexes: either element may be
    // nested, and `indexOf` returns -1 for a non-direct child — which compares
    // as "before" and would pass while the button actually came first.
    expect(note.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  test('tells two waits on the same person apart by name', () => {
    // One colleague can be waited on twice — asked twice, or by two people — and
    // then both buttons read "Continue without Anna Weber".
    render(
      <AwaitingBanner
        awaiting={state([
          request({ id: 'r-1', createdAt: '2026-07-29T07:15:00Z' }),
          request({
            id: 'r-2',
            requestedBy: person('u-lena', 'Lena Fuchs'),
            createdAt: '2026-07-29T09:40:00Z',
          }),
        ])}
        onRelease={vi.fn()}
      />,
    )
    const buttons = screen.getAllByRole('button', { name: /^Continue without Anna Weber/ })
    expect(buttons).toHaveLength(2)
    const labels = buttons.map((button) => button.getAttribute('aria-label'))
    expect(labels.every((label) => label?.includes('waiting since'))).toBe(true)
    expect(new Set(labels).size).toBe(2)
  })

  test('leaves the release label alone when the name is unambiguous', () => {
    render(
      <AwaitingBanner
        awaiting={state([
          request(),
          request({ id: 'r-2', person: person('u-markus', 'Markus Hofer') }),
        ])}
        onRelease={vi.fn()}
      />,
    )
    expect(
      screen.getByRole('button', { name: 'Continue without Markus Hofer' }),
    ).toBeInTheDocument()
  })

  test('carries an avatar for each awaited person', () => {
    render(
      <AwaitingBanner
        awaiting={state([
          request(),
          request({ id: 'r-2', person: person('u-markus', 'Markus Hofer') }),
        ])}
        onRelease={vi.fn()}
      />,
    )
    // Two in the header stack plus one per row of the per-person list.
    expect(screen.getAllByText('AW').length).toBeGreaterThanOrEqual(2)
    expect(screen.getAllByText('MH').length).toBeGreaterThanOrEqual(2)
  })

  test('several outstanding requests name everyone and list them per person (MN-10)', () => {
    render(
      <AwaitingBanner
        awaiting={state([
          request(),
          request({ id: 'r-2', person: person('u-markus', 'Markus Hofer') }),
        ])}
        onRelease={vi.fn()}
      />,
    )
    expect(screen.getByText('Waiting for Anna Weber, Markus Hofer')).toBeInTheDocument()
    expect(screen.getAllByTestId('awaiting-person')).toHaveLength(2)
  })
})

describe('AwaitingBanner — you are the one being awaited', () => {
  test('uses the stronger copy and marks itself as such', () => {
    render(
      <AwaitingBanner awaiting={state([request()], true)} onRelease={vi.fn()} />,
    )
    expect(screen.getByText('Your input was requested')).toBeInTheDocument()
    expect(screen.getByText('Answer in the conversation, or release the wait.')).toBeInTheDocument()
    expect(screen.getByTestId('awaiting-banner')).toHaveAttribute('data-awaiting-me', 'true')
  })

  test('does not offer to "continue without" the reader themselves', () => {
    render(<AwaitingBanner awaiting={state([request()], true)} onRelease={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Continue without waiting' })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Continue without Anna Weber' }),
    ).not.toBeInTheDocument()
  })
})

describe('AwaitingBanner — always a way out (MN-9)', () => {
  test('one outstanding request offers to continue without that person', async () => {
    const user = userEvent.setup()
    const onRelease = vi.fn(async () => true)
    render(<AwaitingBanner awaiting={state([request()])} onRelease={onRelease} />)

    await user.click(screen.getByRole('button', { name: 'Continue without Anna Weber' }))
    expect(onRelease).toHaveBeenCalledWith('r-1')
  })

  test('any participant can release the whole wait', async () => {
    const user = userEvent.setup()
    const onRelease = vi.fn(async () => true)
    render(
      <AwaitingBanner
        awaiting={state([
          request(),
          request({ id: 'r-2', person: person('u-markus', 'Markus Hofer') }),
        ])}
        onRelease={onRelease}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Continue without waiting' }))
    await waitFor(() => expect(onRelease).toHaveBeenCalledTimes(2))
    expect(onRelease).toHaveBeenCalledWith('r-1')
    expect(onRelease).toHaveBeenCalledWith('r-2')
  })

  test('a single person can be released out of several', async () => {
    const user = userEvent.setup()
    const onRelease = vi.fn(async () => true)
    render(
      <AwaitingBanner
        awaiting={state([
          request(),
          request({ id: 'r-2', person: person('u-markus', 'Markus Hofer') }),
        ])}
        onRelease={onRelease}
      />,
    )

    const row = screen.getAllByTestId('awaiting-person')[1]
    await user.click(within(row).getByRole('button', { name: 'Continue without Markus Hofer' }))
    expect(onRelease).toHaveBeenCalledTimes(1)
    expect(onRelease).toHaveBeenCalledWith('r-2')
  })

  test('offers to ask Piloti instead, which both clears the wait and starts a turn', async () => {
    const user = userEvent.setup()
    const onAskAgent = vi.fn()
    render(
      <AwaitingBanner awaiting={state([request()])} onRelease={vi.fn()} onAskAgent={onAskAgent} />,
    )
    await user.click(screen.getByRole('button', { name: 'Ask Piloti instead' }))
    expect(onAskAgent).toHaveBeenCalledTimes(1)
  })

  test('hides the ask-Piloti action when the host does not offer one', () => {
    render(<AwaitingBanner awaiting={state([request()])} onRelease={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Ask Piloti instead' })).not.toBeInTheDocument()
  })

  test('a refused release says so instead of looking like a dead button', async () => {
    const user = userEvent.setup()
    render(<AwaitingBanner awaiting={state([request()])} onRelease={async () => false} />)

    await user.click(screen.getByRole('button', { name: 'Continue without Anna Weber' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The wait could not be released.')
  })

  test('a release that throws is reported the same way', async () => {
    const user = userEvent.setup()
    render(
      <AwaitingBanner
        awaiting={state([request()])}
        onRelease={async () => {
          throw new Error('offline')
        }}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Continue without Anna Weber' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The wait could not be released.')
  })
})

/**
 * The clarifying question — the most common thing the person who was asked
 * actually needs to do, and the one move the deterministic routing gets wrong if
 * they type it as plain text: a plain contribution settles the request, so the
 * question reads as an answer, the wait ends, and Piloti is handed a thread in
 * the middle of a human conversation.
 */
describe('AwaitingBanner — asking back', () => {
  test('offers it to the person being asked, naming who to ask', () => {
    render(
      <AwaitingBanner
        awaiting={state([request()], true)}
        onRelease={vi.fn()}
        onAskBack={vi.fn()}
      />,
    )
    expect(screen.getByRole('button', { name: 'Ask Matthias Bigl back' })).toBeInTheDocument()
  })

  test('hands the asker back to the caller, so the composer can address them', async () => {
    const user = userEvent.setup()
    const onAskBack = vi.fn()
    render(
      <AwaitingBanner
        awaiting={state([request()], true)}
        onRelease={vi.fn()}
        onAskBack={onAskBack}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Ask Matthias Bigl back' }))

    expect(onAskBack).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u-matthias', name: 'Matthias Bigl' }),
    )
  })

  test('never offers it to an observer — it is not their question to send back', () => {
    render(
      <AwaitingBanner
        awaiting={state([request()], false)}
        onRelease={vi.fn()}
        onAskBack={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /Ask .* back/ })).not.toBeInTheDocument()
  })

  test('stays away when several people asked — "ask whom back?" has no honest answer', () => {
    render(
      <AwaitingBanner
        awaiting={state(
          [
            request(),
            request({ id: 'r-2', person: person('u-tobias', 'Tobias Kern') }),
          ],
          true,
        )}
        onRelease={vi.fn()}
        onAskBack={vi.fn()}
      />,
    )
    expect(screen.queryByRole('button', { name: /Ask .* back/ })).not.toBeInTheDocument()
  })
})
