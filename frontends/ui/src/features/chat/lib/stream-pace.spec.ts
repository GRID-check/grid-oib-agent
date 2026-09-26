import { describe, expect, it } from 'vitest'
import {
  MAX_LAG_MS,
  PACE_TICK_MS,
  advancePace,
  furthestCleanCut,
  initialPace,
  isCleanCut,
  keepThroughRewrite,
  nextCleanCut,
  noteArrival,
  type PaceState,
} from './stream-pace'

/** Tick the pace for `ms` in `PACE_TICK_MS` steps; returns the shown lengths after each. */
const run = (state: PaceState, text: string, ms: number, start = 0) => {
  const shown: number[] = []
  let now = start
  for (let t = 0; t < ms; t += PACE_TICK_MS) {
    now += PACE_TICK_MS
    state = advancePace(state, text, PACE_TICK_MS, now)
    shown.push(state.shown)
  }
  return { state, shown }
}

const PROSE =
  'Ein zweiter Fluchtweg ist erforderlich, wenn der Fluchtniveau über 11 m liegt. ' +
  'Die OIB-Richtlinie 2 regelt die Ausnahmen für Gebäude der Gebäudeklassen 1 und 2. '

describe('isCleanCut', () => {
  it('accepts plain prose', () => {
    expect(isCleanCut('Ein zweiter Fluchtweg ')).toBe(true)
  })

  it('refuses a cut inside bold, a link, a code span, a fence or a table row', () => {
    expect(isCleanCut('Das ist **wichtig ')).toBe(false)
    expect(isCleanCut('Siehe [OIB-RL 2 ')).toBe(false)
    expect(isCleanCut('Siehe [OIB-RL 2](https://example ')).toBe(false)
    expect(isCleanCut('Der Wert `a ')).toBe(false)
    expect(isCleanCut('```mermaid\nflowchart ')).toBe(false)
    expect(isCleanCut('| Spalte | Wert ')).toBe(false)
  })

  it('accepts the same constructs once they are closed', () => {
    expect(isCleanCut('Das ist **wichtig** ')).toBe(true)
    expect(isCleanCut('Siehe [OIB-RL 2](https://example.org) ')).toBe(true)
    expect(isCleanCut('```mermaid\nflowchart\n```\n')).toBe(true)
  })
})

describe('furthestCleanCut', () => {
  it('never splits a word', () => {
    const text = 'Fluchtweg Brandabschnitt'
    expect(furthestCleanCut(text, 0, 14)).toBe(10)
  })
})

describe('keepThroughRewrite', () => {
  const SHOWN = 'Die Treppe ist in GK 4 zulässig [8]. Sie braucht einen zweiten Fluchtweg. '
  const SETTLED = 'Die Treppe ist in GK 4 zulässig. Sie braucht einen zweiten Fluchtweg über den Hof. '

  it('never takes shown text back to type it out again', () => {
    // A settled snapshot dropped an unverified marker near the top: the
    // reader keeps the length they had, not the first 31 characters.
    expect(keepThroughRewrite(SETTLED, SHOWN.length)).toBeGreaterThanOrEqual(SHOWN.length - ' [8]'.length)
  })

  it('stops on a clean cut', () => {
    const at = keepThroughRewrite(SETTLED, 40)
    expect(at).toBeGreaterThanOrEqual(40)
    expect(isCleanCut(SETTLED.slice(0, at))).toBe(true)
    expect(SETTLED[at - 1]).toBe(' ')
  })

  it('keeps no more than the replacement has', () => {
    expect(keepThroughRewrite('Kurz. ', 200)).toBe('Kurz. '.length)
  })
})

describe('advancePace', () => {
  it('pays a burst out steadily instead of all at once', () => {
    const start = noteArrival(initialPace(0), PROSE.length, 0)
    const { shown } = run(start, PROSE, 400)
    // After one tick only a part is shown, and it grows tick by tick.
    expect(shown[0]).toBeGreaterThan(0)
    expect(shown[0]).toBeLessThan(PROSE.length / 2)
    for (let i = 1; i < shown.length; i++) expect(shown[i]).toBeGreaterThanOrEqual(shown[i - 1]!)
  })

  it('never holds text back longer than the ceiling', () => {
    const start = noteArrival(initialPace(0), PROSE.length, 0)
    const { state } = run(start, PROSE, MAX_LAG_MS + PACE_TICK_MS)
    expect(state.shown).toBe(PROSE.length)
  })

  it('shows the first clean cut at once rather than a target lag later', () => {
    const text = 'Die Außentreppe ist in GK 4 zulässig. '
    const start = noteArrival(initialPace(0), text.length, 0)
    const { shown } = run(start, text, PACE_TICK_MS)
    expect(shown[0]).toBe(nextCleanCut(text, 0))
  })

  it('does not end a reveal where a delta ended inside a bold phrase', () => {
    // The recorded first delta of a real answer: its end is not a clean cut.
    const text = '**Die Außentreppe ist in GK 4 in A2'
    const start = noteArrival(initialPace(0), text.length, 0)
    const { shown } = run(start, text, MAX_LAG_MS - PACE_TICK_MS)
    expect(shown.every((n) => n === 0)).toBe(true)
  })

  it('does not show half of a bold phrase while it streams', () => {
    const text = 'Das ist **sehr wichtig** und gilt immer. '
    const start = noteArrival(initialPace(0), text.length, 0)
    const { shown } = run(start, text, 1000)
    for (const n of shown) expect(isCleanCut(text.slice(0, n)) || n === text.length).toBe(true)
  })
})
