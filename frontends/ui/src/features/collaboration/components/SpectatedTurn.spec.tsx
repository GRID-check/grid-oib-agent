/**
 * What an observer sees while somebody else's turn runs.
 *
 * The important assertion is the negative one: the agent's question to the asker
 * must appear as text, never as a control. A prompt an observer can press is a
 * button whose every press the server refuses.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test-utils'
import { EMPTY_SPECTATED_TURN, type SpectatedTurnState } from '../lib/spectator-frames'
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
})
