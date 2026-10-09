/**
 * What an observer sees while somebody else's turn runs.
 *
 * The important assertion is the negative one: the agent's question to the asker
 * must appear as text, never as a control. A prompt an observer can press is a
 * button whose every press the server refuses.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test-utils'
import { initialTurnView, type KeyedCard, type TurnView } from '@/features/chat/lib/turn-fold'
import { eventOf, frameOf } from '@/test-utils/wire-v2-fixtures'
import { foldSpectatedEvent } from '../lib/spectator-frames'
import { SpectatedTurn } from './SpectatedTurn'
import { CARD_PREVIEW_FIXTURES } from '@/features/grid-cards/preview-fixtures'

const LABEL = 'Piloti beantwortet die Frage von Anna Berger…'

/** A turn this observer watched from its start: `RUN_STARTED` named the answer. */
function turn(overrides: Partial<TurnView> = {}): TurnView {
  return { ...initialTurnView('turn-1', 'conv_1'), messageId: 'a', ...overrides }
}

const keyed = (card: Record<string, unknown>, key = 'k'): KeyedCard => ({ key, card })

const FILE_PROPOSAL = {
  type: 'file_operation_proposal',
  title: 'Pläne einsortieren',
  operation: 'move',
  operations: [{ document: 'Grundriss EG.pdf', source: 'projekt', current: '', target_folder: 'Einreichung' }],
}

/** Raw bodies folded the way the hook folds them, from the turn's start. */
const folded = (...rest: Record<string, unknown>[]): TurnView => {
  const bodies = [{ type: 'RUN_STARTED', message_id: 'a' }, ...rest]
  const view = bodies.reduce<TurnView | null>(
    (current, body, index) => foldSpectatedEvent(current, eventOf(frameOf(index + 1, body))),
    null
  )
  if (!view) throw new Error('nothing folded')
  return view
}

describe('SpectatedTurn', () => {
  it('shows the headline before there is any answer', () => {
    render(<SpectatedTurn turn={turn()} label={LABEL} />)
    expect(screen.getByTestId('spectated-turn')).toHaveTextContent(LABEL)
  })

  it('renders the answer as it streams', () => {
    render(
      <SpectatedTurn turn={turn({ text: 'Ja, ab drei Geschossen.' })} label={LABEL} />
    )
    expect(screen.getByTestId('spectated-turn')).toHaveTextContent('Ja, ab drei Geschossen.')
  })

  it('states the agent’s question without offering a control', () => {
    render(
      <SpectatedTurn turn={turn({
          interaction: { interaction_id: 'ask_1', input: 'choice', text: 'Welches Bundesland?', options: [{ id: '1', label: 'Wien' }], placeholder: null, expires_at: 0 },
        })} label={LABEL} />
    )
    expect(screen.getByTestId('spectated-turn')).toHaveTextContent('Welches Bundesland?')
    expect(screen.queryByRole('button', { name: /Bundesland/ })).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('says so when the turn failed', () => {
    const { container } = render(
      <SpectatedTurn turn={turn({ phase: 'failed' })} label={LABEL} />
    )
    expect(container.textContent).toContain('error')
  })

  it('does not announce the streaming answer', () => {
    // A live region here would read every token mutation aloud and make the
    // thread unusable with a screen reader; the finished message's arrival
    // announcement (CC-9) is what reports the answer.
    render(<SpectatedTurn turn={turn({ text: 'Teilantwort' })} label={LABEL} />)
    expect(screen.getByTestId('spectated-turn')).toHaveAttribute('aria-live', 'off')
  })

  it('draws a card that acts without anything to press (ADR-0039 §5)', () => {
    // The second wall: even a memory proposal that reached the view offers the
    // observer no button — pressing one wrote into the OBSERVER's organization.
    // It is withheld outright, so there is nothing to press and nothing to read.
    const proposal = keyed({
      type: 'memory_proposal',
      title: 'Merken?',
      content: 'Das Büro plant GK4 immer mit REI 90.',
      kind: 'preference',
      confidence: 'high',
    })
    render(<SpectatedTurn turn={turn({ text: 'Fertig.', cards: [proposal], phase: 'finished' })} label={LABEL} />)
    expect(screen.getByTestId('spectated-turn')).toHaveTextContent('Fertig.')
    expect(screen.queryByText(/REI 90/)).toBeNull()
    expect(screen.queryAllByRole('button')).toEqual([])
  })

  it('does not draw a file operation proposal for an observer', () => {
    const view = folded(
      { type: 'CUSTOM', name: 'card', value: { index: 0, key: 'f', card: FILE_PROPOSAL } },
      { type: 'TEXT_MESSAGE_CONTENT', message_id: 'a', delta: 'Ich schlage eine Verschiebung vor.' }
    )
    render(<SpectatedTurn turn={view} label={LABEL} />)
    expect(screen.getByTestId('spectated-turn')).toHaveTextContent('Verschiebung')
    expect(screen.queryByText('Pläne einsortieren')).toBeNull()
    expect(screen.queryAllByRole('button')).toEqual([])
  })

  it('draws nothing, not a skeleton, where a withheld card stood while the turn streams', () => {
    // The observer's cards keep a hole where a card that acts was dropped. The
    // marker naming it points INSIDE the array, at a card that is never coming,
    // so it must not hold a pending skeleton for the rest of the stream; a
    // marker past the end still does, since that card is only not written yet.
    const state = folded(
      { type: 'CUSTOM', name: 'card', value: { index: 0, key: 'f', card: FILE_PROPOSAL } },
      { type: 'TEXT_MESSAGE_CONTENT', message_id: 'a', delta: 'Vorschlag:\n\n[[card:1]]\n\nWeiter.' }
    )
    expect(state.cards).toHaveLength(1)
    const { rerender } = render(<SpectatedTurn turn={state} label={LABEL} />)
    expect(screen.getByTestId('spectated-turn')).toHaveTextContent('Weiter.')
    expect(screen.queryByTestId('pending-card-slot')).toBeNull()

    rerender(<SpectatedTurn turn={{ ...state, text: `${state.text}\n\n[[card:2]]\n\nEnde.` }} label={LABEL} />)
    expect(screen.getByTestId('pending-card-slot')).toBeInTheDocument()
  })

  it('draws a turn that carries cards and no prose', () => {
    const stair = keyed({ ...CARD_PREVIEW_FIXTURES.stair_diagram!, title: 'Treppe Haus A' })
    render(<SpectatedTurn turn={turn({ cards: [stair] })} label={LABEL} />)
    expect(screen.getByTestId('spectated-turn')).toHaveTextContent('Treppe Haus A')
  })

  it('offers no copy controls once the turn is done', () => {
    render(<SpectatedTurn turn={turn({ text: 'Ja, ab drei Geschossen.', phase: 'finished' })} label={LABEL} />)
    expect(screen.queryAllByRole('button')).toEqual([])
  })

  it('an observer who joined mid-answer waits for the whole text rather than starting mid-sentence', () => {
    // No `RUN_STARTED` seen, and text from the first sight: a fragment.
    const joined = { ...initialTurnView('turn-1', 'conv_1'), streaming: true, text: 'chossen gilt das nicht.' }
    const { rerender } = render(<SpectatedTurn turn={joined} label={LABEL} />)
    expect(screen.getByTestId('spectated-turn')).not.toHaveTextContent('chossen')

    // More of the same fragment: still held.
    rerender(<SpectatedTurn turn={{ ...joined, text: `${joined.text} Weiter` }} label={LABEL} />)
    expect(screen.getByTestId('spectated-turn')).not.toHaveTextContent('Weiter')

    // A snapshot brings the answer from its start.
    rerender(
      <SpectatedTurn
        turn={{ ...joined, text: 'Ab drei Geschossen gilt das nicht. Weiter' }}
        label={LABEL}
      />
    )
    expect(screen.getByTestId('spectated-turn')).toHaveTextContent('Ab drei Geschossen gilt das nicht.')
  })

  it('an observer who joined during the steps sees the answer from its first word', () => {
    const joined = { ...initialTurnView('turn-1', 'conv_1'), stepOrder: [] }
    const { rerender } = render(<SpectatedTurn turn={joined} label={LABEL} />)
    rerender(<SpectatedTurn turn={{ ...joined, streaming: true, text: 'Ab drei' }} label={LABEL} />)
    expect(screen.getByTestId('spectated-turn')).toHaveTextContent('Ab drei')
  })

  it('keeps one ambient loop: the headline stops shimmering once the Herleitung carries it', () => {
    const steps = folded({
      type: 'STEP_STARTED',
      step: { id: 's1', kind: 'tool', tool: 'ris_search', status: 'running', scope: 'chat' },
    })
    expect(steps.stepOrder.length).toBeGreaterThan(0)
    const { container } = render(<SpectatedTurn turn={steps} label={LABEL} />)
    // The headline is plain text, the Herleitung's header the one shimmer.
    expect(screen.getAllByText(LABEL)).toHaveLength(1)
    expect(container.querySelectorAll('.animate-shimmer-window')).toHaveLength(1)
  })
})
