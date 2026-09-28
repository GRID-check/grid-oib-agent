/**
 * @vitest-environment node
 */
/**
 * An observer folds with the asker's fold (ADR-0039, `chat-wire-v2.md` §d):
 * the same fixtures give the same view. What differs is only what this module
 * adds — a new turn starts a new view, a gap is skipped, and a card that acts
 * is never handed over.
 */
import { describe, expect, it } from 'vitest'
import type { WireEvent } from '@/adapters/api/wire-v2'
import { foldTurnEvents, type TurnView } from '@/features/chat/lib/turn-fold'
import { WIRE_TURN_FILES, eventOf, frameOf, wireEvents } from '@/test-utils/wire-v2-fixtures'
import { foldSpectatedEvent, hasSomethingToShow, observerCards, orderedSteps } from './spectator-frames'

const spectate = (events: readonly WireEvent[]): TurnView | null =>
  events.reduce<TurnView | null>(foldSpectatedEvent, null)

const at = (seq: number, raw: Record<string, unknown>, turnId = 'turn-1'): WireEvent => eventOf(frameOf(seq, raw, turnId))
const delta = (seq: number, text: string, turnId = 'turn-1') =>
  at(seq, { type: 'TEXT_MESSAGE_CONTENT', message_id: 'a', delta: text }, turnId)

describe('spectator parity', () => {
  it.each(WIRE_TURN_FILES)('%s folds to the asker’s view', (name) => {
    const events = wireEvents(name)
    expect(spectate(events)).toEqual(foldTurnEvents(undefined, events))
  })

  it.each(WIRE_TURN_FILES)('%s joined mid-turn ends on the asker’s terminal state', (name) => {
    const events = wireEvents(name)
    const joined = spectate(events.slice(Math.floor(events.length / 2)))
    const asker = foldTurnEvents(undefined, events)
    expect(joined).toMatchObject({ phase: asker?.phase, text: asker?.text, lastSeq: asker?.lastSeq })
  })
})

describe('what only an observer does', () => {
  it('starts a new view when the next turn begins', () => {
    const view = spectate([delta(1, 'Erste Antwort'), delta(1, 'Zweite', 'turn-2')])
    expect(view).toMatchObject({ turnId: 'turn-2', text: 'Zweite' })
  })

  it('skips a gap instead of waiting for a replay it will never ask for', () => {
    const view = spectate([delta(1, 'Ja, '), delta(5, 'Geschossen.')])
    expect(view).toMatchObject({ text: 'Ja, Geschossen.', lastSeq: 5, gap: false })
  })

  it('never takes a rejection as a turn', () => {
    const rejected = at(0, { type: 'CUSTOM', name: 'rejected', value: { of: 'user_message', code: 'auth_expired' } }, 'other')
    expect(spectate([rejected])).toBeNull()
    const view = spectate([delta(1, 'Ja')])
    expect(foldSpectatedEvent(view, rejected)).toBe(view)
  })

  it('holes a card that acts and keeps every position (ADR-0039 §5)', () => {
    const card = (seq: number, index: number, value: Record<string, unknown>) =>
      at(seq, { type: 'CUSTOM', name: 'card', value: { index, key: `k${index}`, card: value } })
    const view = spectate([
      card(1, 0, { type: 'memory_proposal', title: 'Merken?', content: 'REI 90', kind: 'preference', confidence: 'high' }),
      card(2, 1, { type: 'legal_basis', law: 'OIB-Richtlinie 2', article: '3.1', summary: 'GK 4: REI 60.' }),
    ])
    if (!view) throw new Error('nothing folded')
    const cards = observerCards(view)
    expect(cards).toHaveLength(2)
    expect(cards?.[0]).toBeUndefined()
    expect(cards?.[1]?.type).toBe('legal_basis')
  })

  it('has something to show on a step, a masthead or a prompt, not on a withheld card alone', () => {
    const withheld = spectate([
      at(1, { type: 'CUSTOM', name: 'card', value: { index: 0, key: 'k', card: { type: 'memory_proposal', title: 'x', content: 'y', kind: 'preference', confidence: 'high' } } }),
    ])
    expect(withheld && hasSomethingToShow(withheld)).toBe(false)
    const answered = spectate(wireEvents('turn-answered.jsonl').slice(0, 2))
    expect(answered && hasSomethingToShow(answered)).toBe(true)
    expect(answered && orderedSteps(answered).map((step) => step.id)).toEqual(['status:documents'])
  })
})
