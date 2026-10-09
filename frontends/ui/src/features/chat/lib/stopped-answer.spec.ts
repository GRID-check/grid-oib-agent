/**
 * The stop rule, held to the agent tier's copy (`TurnTextFold.stopped`) by
 * the cases both suites read: `shared/wire/v2/stopped-cases.jsonl`, which
 * `tests/aiq_agent/turn/test_streaming.py` folds through the Python fold.
 * Here each case's frames through `shown.seq` go through `foldTurnEvents`, as
 * the asker's page folded them, and `stopTurnView` cuts the view the way
 * `stopStreaming` does. A difference between the two is a reload that shows
 * the reader something other than what they stopped on.
 */
import { describe, expect, it } from 'vitest'
import { eventOf, frameOf, wireFixtureLines } from '@/test-utils/wire-v2-fixtures'
import { sharedPrefixChars, stoppedAnswer } from './stopped-answer'
import { foldTurnEvents, stopTurnView } from './turn-fold'

interface StoppedCase {
  case: string
  events: Record<string, unknown>[]
  shown: { seq: number; chars: number }
  kept: { text: string; sources: number[]; answer_meta: Record<string, unknown> | null; cards: string[] }
}

const CASES = wireFixtureLines<StoppedCase>('stopped-cases.jsonl')

describe('the stop rule, shared with the agent tier', () => {
  it('has cases', () => expect(CASES.length).toBeGreaterThan(10))

  it.each(CASES.map((c) => [c.case, c] as const))('%s', (_name, { events, shown, kept }) => {
    const folded = foldTurnEvents(
      undefined,
      events.map((body, index) => eventOf(frameOf(index + 1, body))).filter((event) => event.seq <= shown.seq)
    )
    if (!folded) throw new Error('nothing folded')
    const onScreen = Array.from(folded.text).slice(0, shown.chars).join('')

    const { view, shown: position } = stopTurnView(folded, onScreen)

    expect(position).toEqual(shown)
    expect(view.text).toBe(kept.text)
    expect(view.sources.map((source) => source.number)).toEqual(kept.sources)
    expect(view.answerMeta ?? null).toEqual(kept.answer_meta)
    expect(view.cards.map((card) => card?.key)).toEqual(kept.cards)
  })
})

describe('stoppedAnswer', () => {
  it('keeps the sources array itself when it keeps them, so nothing downstream re-renders', () => {
    const sources = [{ number: 1 }]
    expect(stoppedAnswer({ text: 'Belegt [1].', settled: 'Belegt [1].', sources, cards: [] }, 11).sources).toBe(sources)
  })
})

describe('sharedPrefixChars', () => {
  it('counts the code points two texts share from the start', () => {
    expect(sharedPrefixChars('Stiege 🏢 frei.', 'Stiege 🏢 frei. Rest')).toBe(14)
    expect(sharedPrefixChars('abc', 'abd')).toBe(2)
    expect(sharedPrefixChars('', 'abc')).toBe(0)
  })
})
