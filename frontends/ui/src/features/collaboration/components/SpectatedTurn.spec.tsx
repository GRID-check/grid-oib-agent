/**
 * What an observer sees while somebody else's turn runs.
 *
 * The important assertion is the negative one: the agent's question to the asker
 * must appear as text, never as a control. A prompt an observer can press is a
 * button whose every press the server refuses.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test-utils'
import type { GridCard } from '@/shared/cards/schemas'
import { EMPTY_SPECTATED_TURN, reduceSpectatedFrame, type SpectatedTurnState } from '../lib/spectator-frames'
import { SpectatedTurn } from './SpectatedTurn'

const LABEL = 'Piloti beantwortet die Frage von Anna Berger…'

function turn(overrides: Partial<SpectatedTurnState> = {}): SpectatedTurnState {
  return { ...EMPTY_SPECTATED_TURN, ...overrides }
}

describe('SpectatedTurn', () => {
  it('shows the headline before there is any answer', () => {
    render(<SpectatedTurn turn={turn()} label={LABEL} />)
    expect(screen.getByTestId('spectated-turn')).toHaveTextContent(LABEL)
  })

  it('renders the answer as it streams', () => {
    render(
      <SpectatedTurn turn={turn({ answer: 'Ja, ab drei Geschossen.' })} label={LABEL} />
    )
    expect(screen.getByTestId('spectated-turn')).toHaveTextContent('Ja, ab drei Geschossen.')
  })

  it('states the agent’s question without offering a control', () => {
    render(
      <SpectatedTurn turn={turn({ waitingOn: 'Welches Bundesland?' })} label={LABEL} />
    )
    expect(screen.getByTestId('spectated-turn')).toHaveTextContent('Welches Bundesland?')
    expect(screen.queryByRole('button', { name: /Bundesland/ })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('says so when the turn failed', () => {
    const { container } = render(
      <SpectatedTurn turn={turn({ failed: true, done: true })} label={LABEL} />
    )
    expect(container.textContent).toContain('error')
  })

  it('does not announce the streaming answer', () => {
    // A live region here would read every token mutation aloud and make the
    // thread unusable with a screen reader; the finished message's arrival
    // announcement (CC-9) is what reports the answer.
    render(<SpectatedTurn turn={turn({ answer: 'Teilantwort' })} label={LABEL} />)
    expect(screen.getByTestId('spectated-turn')).toHaveAttribute('aria-live', 'off')
  })

  it('draws a card that acts without anything to press (ADR-0039 §5)', () => {
    // The second wall: even a memory proposal that reached the view offers the
    // observer no button — pressing one wrote into the OBSERVER's organization.
    const proposal = {
      type: 'memory_proposal',
      title: 'Merken?',
      content: 'Das Büro plant GK4 immer mit REI 90.',
      kind: 'preference',
      confidence: 'high',
    } as GridCard
    render(
      <SpectatedTurn
        turn={turn({ answer: 'Fertig.', cards: [proposal], done: true })}
        label={LABEL}
      />
    )
    expect(screen.getByTestId('spectated-turn')).toHaveTextContent('REI 90')
    expect(screen.queryAllByRole('button')).toEqual([])
  })

  it('does not draw a file operation proposal for an observer', () => {
    const complete = {
      type: 'system_response_message',
      id: 'c1',
      parent_id: 'turn-1',
      status: 'complete',
      content: { text: 'Ich schlage eine Verschiebung vor.' },
      cards: [
        {
          type: 'file_operation_proposal',
          title: 'Pläne einsortieren',
          operation: 'move',
          operations: [{ document: 'Grundriss EG.pdf', source: 'projekt', current: '', target_folder: 'Einreichung' }],
        },
      ],
    }
    render(<SpectatedTurn turn={reduceSpectatedFrame(EMPTY_SPECTATED_TURN, complete)} label={LABEL} />)
    expect(screen.getByTestId('spectated-turn')).toHaveTextContent('Verschiebung')
    expect(screen.queryByText('Pläne einsortieren')).toBeNull()
    expect(screen.queryAllByRole('button')).toEqual([])
  })

  it('offers no copy controls once the turn is done', () => {
    render(<SpectatedTurn turn={turn({ answer: 'Ja, ab drei Geschossen.', done: true })} label={LABEL} />)
    expect(screen.queryAllByRole('button')).toEqual([])
  })
})
