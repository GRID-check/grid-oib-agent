/**
 * „Piloti hat sich gemerkt" — the chip that tells a reader what one turn made
 * durable about their project (`docs/architecture/post-answer-stages.md` §1.1).
 *
 * The one thing this component must never do is COLLAPSE the two paths. A
 * finding the reader themselves authorised mid-answer and a finding the machine
 * distilled after the answer are different promises: the first they agreed to,
 * the second happened without them. The chip is where they are told apart, and
 * the label is the only place that distinction survives — the popover shows the
 * same words for both otherwise.
 */
import { render, screen } from '@/test-utils'
import userEvent from '@testing-library/user-event'
import { describe, expect, test } from 'vitest'
import { MemoryNotedChip } from './MemoryNotedChip'
import type { TurnMemoryItem } from '../lib/turn-memory'

const inTurn: TurnMemoryItem = {
  id: 'memory_proposal-0',
  kind: 'constraint',
  content: 'Die Fluchtwegbreite ist mit 1,20 m vorgegeben.',
  provenance: 'inTurn',
}

const afterwards: TurnMemoryItem = {
  id: 'row-1',
  kind: 'derived_fact',
  content: 'Das oberste Fluchtniveau beträgt 9,80 m.',
  provenance: 'distillation',
}

describe('MemoryNotedChip', () => {
  test('renders nothing for a turn that recorded nothing', () => {
    // Which is most turns. Reflection's most common correct outcome is "nothing
    // durable here", and an empty popover trigger would be a promise of content.
    const { container } = render(<MemoryNotedChip items={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  test('counts what this turn recorded', () => {
    render(<MemoryNotedChip items={[inTurn, afterwards]} />)
    expect(screen.getByText('Piloti noted')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Piloti noted 2 items' })).toBeInTheDocument()
  })

  test('labels the in-turn write and the post-answer one apart', async () => {
    const user = userEvent.setup()
    render(<MemoryNotedChip items={[inTurn, afterwards]} />)

    await user.click(screen.getByRole('button', { name: 'Piloti noted 2 items' }))

    expect(await screen.findByText('noted during the response')).toBeInTheDocument()
    expect(screen.getByText('added after the response')).toBeInTheDocument()
    // Both are shown in the reader's own words, verbatim — the chip is a record
    // of what is now in their project, not a summary of it.
    expect(screen.getByText(inTurn.content)).toBeInTheDocument()
    expect(screen.getByText(afterwards.content)).toBeInTheDocument()
    expect(screen.getByText('Constraint')).toBeInTheDocument()
    expect(screen.getByText('Fact')).toBeInTheDocument()
  })
})
