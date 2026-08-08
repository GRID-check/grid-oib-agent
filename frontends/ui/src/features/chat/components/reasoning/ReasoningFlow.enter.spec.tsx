/**
 * Entrance behaviour of the Herleitung fan-out, at the render level.
 *
 * `ReasoningFlow.spec.ts` covers the pure builder; this one covers the thing the
 * builder cannot see — that a source card's CSS entrance fires once per card and
 * not once per DOM mount. The fan re-packs on every card-count change, so a card
 * routinely moves from one column node to another and React remounts it there.
 */

import { act, render, screen } from '@/test-utils'
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest'
import { ReasoningFlow } from './ReasoningFlow'
import type { ThinkingStep } from '../../types'

/** One knowledge-layer step carrying `n` distinct documents in one lane. */
const stepWith = (names: string[]): ThinkingStep => ({
  id: 'kb',
  userMessageId: 'msg-1',
  category: 'tools',
  functionName: 'knowledge_retrieval',
  displayName: 'Knowledge Retrieval',
  content: '',
  isComplete: true,
  timestamp: new Date('2024-01-15T14:30:00'),
  traceLanes: [
    {
      key: 'baurecht_oib',
      label: 'OIB-Richtlinie',
      hitCount: names.length,
      signal: 'law',
      sources: names.map((name) => ({ name })),
    },
  ],
})

const docs = (n: number) => Array.from({ length: n }, (_, i) => `OIB-RL_${i}_Doku.pdf`)

/** How many rendered source cards are currently playing their entrance. */
const enteringCount = () =>
  Array.from(document.querySelectorAll('[data-source-card]')).filter((el) =>
    el.parentElement?.className.includes('animate-in')
  ).length

const cardCount = () => document.querySelectorAll('[data-source-card]').length

/** Let the cascade finish, so the batch is marked as having entered. */
const settle = () => act(() => void vi.advanceTimersByTime(2000))

describe('ReasoningFlow — source cards enter once per card', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('a card that survives a re-pack does not replay its entrance', () => {
    // Five sources at the fallback width pack into four columns (2/1/1/1); six
    // pack into 2/2/1/1, so the fourth card changes column node and React
    // remounts it. Before this was keyed on card identity, that remount replayed
    // the entrance for most of the fan every time ONE source streamed in.
    const { rerender } = render(<ReasoningFlow steps={[stepWith(docs(5))]} userQuestion="Frage?" live />)
    expect(cardCount()).toBe(5)
    expect(enteringCount()).toBe(5)
    settle()

    rerender(<ReasoningFlow steps={[stepWith(docs(6))]} userQuestion="Frage?" live />)
    expect(cardCount()).toBe(6)
    // Exactly the new arrival animates — the five already on screen do not.
    expect(enteringCount()).toBe(1)
  })

  test('an entrance is never cut short by the card that interrupts it', () => {
    // The settle timer restarts when a card streams in mid-cascade, so the four
    // already animating stay in the batch rather than being marked as entered
    // (and stripped of their animation) halfway through.
    const { rerender } = render(<ReasoningFlow steps={[stepWith(docs(4))]} userQuestion="Frage?" live />)
    act(() => void vi.advanceTimersByTime(100))
    rerender(<ReasoningFlow steps={[stepWith(docs(5))]} userQuestion="Frage?" live />)
    expect(enteringCount()).toBe(5)
    settle()
    // …and once it has run, the whole batch is done: no card re-animates.
    rerender(<ReasoningFlow steps={[stepWith(docs(5))]} userQuestion="Frage?" answerConfidence="high" />)
    expect(enteringCount()).toBe(0)
  })

  test('a settled card does not re-animate on an unrelated update', () => {
    const steps = [stepWith(docs(3))]
    const { rerender } = render(<ReasoningFlow steps={steps} userQuestion="Frage?" live />)
    expect(enteringCount()).toBe(3)
    settle()
    // Once the cascade has run the cards drop the class outright, so a re-pack
    // from a plain resize — which does not change the card list at all — cannot
    // hand them a replayed entrance.
    expect(enteringCount()).toBe(0)

    // The verdict landing rebuilds the graph (pending assessment → real one)
    // without touching the sources; nothing flashes.
    rerender(<ReasoningFlow steps={steps} userQuestion="Frage?" answerConfidence="high" />)
    expect(cardCount()).toBe(3)
    expect(enteringCount()).toBe(0)
  })

  test('a late arrival cascades from zero, not from its index in the whole fan', () => {
    // The delay used to be the card's position in the ENTIRE fan, so the eighth
    // source of a turn sat invisible (animation-fill-mode: backwards) for 420ms
    // before it appeared. A card streaming in late is slot 0 of its own batch.
    const { rerender } = render(<ReasoningFlow steps={[stepWith(docs(7))]} userQuestion="Frage?" live />)
    settle()
    rerender(<ReasoningFlow steps={[stepWith(docs(8))]} userQuestion="Frage?" live />)

    const entering = Array.from(document.querySelectorAll('[data-source-card]')).filter((el) =>
      el.parentElement?.className.includes('animate-in')
    )
    expect(entering).toHaveLength(1)
    expect((entering[0]!.parentElement as HTMLElement).style.animationDelay).toBe('0ms')
  })

  test('the graph still renders its nodes while a turn streams', () => {
    render(<ReasoningFlow steps={[stepWith(docs(2))]} userQuestion="Frage?" live />)
    expect(screen.getByTestId('reasoning-flow')).toBeInTheDocument()
    expect(cardCount()).toBe(2)
  })
})
