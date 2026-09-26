import { describe, expect, it } from 'vitest'
import {
  DRAIN_MS,
  MAX_LAG_MS,
  PACE_TICK_MS,
  advancePace,
  furthestCleanCut,
  initialPace,
  isCleanCut,
  noteArrival,
  sharedPrefixLength,
  type PaceState,
} from './stream-pace'

/** Tick the pace for `ms` in `PACE_TICK_MS` steps; returns the shown lengths after each. */
const run = (state: PaceState, text: string, ms: number, streaming: boolean, start = 0) => {
  const shown: number[] = []
  let now = start
  for (let t = 0; t < ms; t += PACE_TICK_MS) {
    now += PACE_TICK_MS
    state = advancePace(state, text, PACE_TICK_MS, now, streaming)
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
    expect(furthestCleanCut(text, 0, 14, [])).toBe(10)
  })

  it('takes an arrival boundary even inside a word', () => {
    expect(furthestCleanCut('Fluchtweg', 0, 7, [5])).toBe(5)
  })
})

describe('advancePace', () => {
  it('pays a burst out steadily instead of all at once', () => {
    const start = noteArrival(initialPace(0), PROSE.length, 0)
    const { shown } = run(start, PROSE, 400, true)
    // After one tick only a part is shown, and it grows tick by tick.
    expect(shown[0]).toBeGreaterThan(0)
    expect(shown[0]).toBeLessThan(PROSE.length / 2)
    for (let i = 1; i < shown.length; i++) expect(shown[i]).toBeGreaterThanOrEqual(shown[i - 1]!)
  })

  it('never holds text back longer than the ceiling', () => {
    const start = noteArrival(initialPace(0), PROSE.length, 0)
    const { state } = run(start, PROSE, MAX_LAG_MS + PACE_TICK_MS, true)
    expect(state.shown).toBe(PROSE.length)
  })

  it('drains the rest quickly once the turn has ended', () => {
    const start = noteArrival(initialPace(0), PROSE.length, 0)
    const { state } = run(start, PROSE, DRAIN_MS + 2 * PACE_TICK_MS, false)
    expect(state.shown).toBe(PROSE.length)
  })

  it('reaches the end of a finished text that does not end on a space', () => {
    const text = 'Ja.'
    const { state } = run(initialPace(0), text, DRAIN_MS + PACE_TICK_MS, false)
    expect(state.shown).toBe(text.length)
  })

  it('does not show half of a bold phrase while it streams', () => {
    const text = 'Das ist **sehr wichtig** und gilt immer. '
    const start = noteArrival(initialPace(0), text.length, 0)
    const { shown } = run(start, text, 1000, true)
    for (const n of shown) expect(isCleanCut(text.slice(0, n)) || n === text.length).toBe(true)
  })
})

describe('sharedPrefixLength', () => {
  it('measures what a replacement keeps', () => {
    expect(sharedPrefixLength('Ein zweiter Weg', 'Ein zweiter Fluchtweg')).toBe(12)
  })
})
