import { describe, expect, it } from 'vitest'
import {
  FINISH_MAX_MS,
  FINISH_MIN_MS,
  MAX_LAG_MS,
  advancePace,
  finishCut,
  finishDuration,
  furthestCleanCut,
  initialPace,
  isCleanCut,
  keepThroughRewrite,
  nextCleanCut,
  noteArrival,
  type PaceState,
} from './stream-pace'

/** One animation frame at 60 Hz, the step the reveal's clock takes. */
const FRAME_MS = 16

/** Step the pace for `ms` in `FRAME_MS` steps; returns the shown lengths after each. */
const run = (state: PaceState, text: string, ms: number, start = 0) => {
  const shown: number[] = []
  let now = start
  for (let t = 0; t < ms; t += FRAME_MS) {
    now += FRAME_MS
    state = advancePace(state, text, FRAME_MS, now)
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

  it('refuses a cut inside a link, a code span, a fence or a table cell', () => {
    expect(isCleanCut('Siehe [OIB-RL 2 ')).toBe(false)
    expect(isCleanCut('Siehe [OIB-RL 2](https://example ')).toBe(false)
    expect(isCleanCut('Der Wert `a ')).toBe(false)
    expect(isCleanCut('```mermaid\nflowchart ')).toBe(false)
    expect(isCleanCut('| Spalte | Wert |\n| --- | --- |\n| Treppe | offe')).toBe(false)
  })

  it('accepts a cut inside a bold phrase: the streaming renderer closes it', () => {
    expect(isCleanCut('**Die Außentreppe ist ')).toBe(true)
  })

  it('accepts a table row after a finished cell, once the delimiter row is there', () => {
    expect(isCleanCut('| Spalte | Wert |\n| --- | --- |\n| Treppe | ')).toBe(true)
    // A header row alone is still held: without its delimiter it is no table yet.
    expect(isCleanCut('| Spalte | ')).toBe(false)
  })

  it('holds a cut after a whole header line until its delimiter row has arrived', () => {
    // The header alone would render as a paragraph of pipes for a moment.
    expect(isCleanCut('Die Werte:\n\n| Spalte | Wert |\n')).toBe(false)
    expect(isCleanCut('Die Werte:\n\n| Spalte | Wert |\n| --- | --- |\n| Treppe | ')).toBe(true)
    expect(isCleanCut('| Spalte | Wert |\n| --- | --- |\n| Treppe | offen |\n')).toBe(true)
    // A blank line after it ends the run: whatever the pipes were, they are drawn.
    expect(isCleanCut('| Spalte | Wert |\n\n')).toBe(true)
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
    const { state } = run(start, PROSE, MAX_LAG_MS + FRAME_MS)
    expect(state.shown).toBe(PROSE.length)
  })

  it('shows the first clean cut at once rather than a target lag later', () => {
    const text = 'Die Außentreppe ist in GK 4 zulässig. '
    const start = noteArrival(initialPace(0), text.length, 0)
    const { shown } = run(start, text, FRAME_MS)
    expect(shown[0]).toBe(nextCleanCut(text, 0))
  })

  it('shows the first words of an answer that opens in bold at once', () => {
    // The recorded first delta of a real answer.
    const text = '**Die Außentreppe ist in GK 4 in A2'
    const start = noteArrival(initialPace(0), text.length, 0)
    const { shown } = run(start, text, FRAME_MS)
    expect(shown[0]).toBe('**Die '.length)
  })

  it('shows a table with its first row, never its header alone', () => {
    // A header-only table drew as a table for a frame and, on a phone, was
    // restacked (header hidden) when its first row came.
    expect(isCleanCut('Die Werte:\n\n| Spalte | Wert |\n| --- | --- |\n')).toBe(false)
    // A table that really has no rows is drawn once the blank line ends it.
    expect(isCleanCut('| Spalte | Wert |\n| --- | --- |\n\n')).toBe(true)
  })

  it('shows a row with its first cell, never as a blank row', () => {
    // `| ` is a row GFM pads with empty cells: it drew blank and grew per cell.
    expect(isCleanCut('| Spalte | Wert |\n| --- | --- |\n| ')).toBe(false)
    expect(isCleanCut('| Spalte | Wert |\n| --- | --- |\n| Treppe | offen |\n| ')).toBe(false)
    expect(isCleanCut('| Spalte | Wert |\n| --- | --- |\n|  | offen | ')).toBe(true)
  })

  it('reveals each table row with its first cell already written', () => {
    const head = '| Nachweis | Anforderung | Fundstelle |\n|---|---|---|\n'
    const text = `Vorab:\n\n${head}| Tragende Bauteile | R 60 | Tabelle 1b |\n| Trennwände | REI 60 | Tabelle 1b |\n`
    const start = noteArrival(initialPace(0), text.length, 0)
    const { shown } = run(start, text, 1000)
    for (const n of shown) {
      const lastLine = text.slice(0, n).split('\n').at(-1) ?? ''
      // Never a bare `| `, never the header and delimiter without a row.
      expect(/^\|\s*$/.test(lastLine)).toBe(false)
      expect(text.slice(0, n).endsWith('|---|---|---|\n')).toBe(false)
    }
  })

  it('fills a table cell by cell instead of holding each row back', () => {
    const head = '| Nachweis | Außentreppe | Treppenhaus |\n| --- | --- | --- |\n'
    const text = `${head}| Brandschutz | offen, nicht brennbar | REI 90 |\n`
    const start = noteArrival(initialPace(head.length), text.length, 0)
    const { shown } = run(start, text, 1000)
    const partial = shown.filter((n) => n > head.length && n < text.length)
    expect(partial.length).toBeGreaterThan(0)
    for (const n of partial) expect(text.slice(0, n).trimEnd().endsWith('|')).toBe(true)
  })


  it('does not show half of a bold phrase while it streams', () => {
    const text = 'Das ist **sehr wichtig** und gilt immer. '
    const start = noteArrival(initialPace(0), text.length, 0)
    const { shown } = run(start, text, 1000)
    for (const n of shown) expect(isCleanCut(text.slice(0, n)) || n === text.length).toBe(true)
  })
})

describe('the reveal, frame by frame', () => {
  it('moves a word at a time: every shown length is a word gap or the end', () => {
    const start = noteArrival(initialPace(0), PROSE.length, 0)
    const { shown } = run(start, PROSE, MAX_LAG_MS)
    const steps = shown.filter((n, i) => n !== (shown[i - 1] ?? 0))
    expect(steps.length).toBeGreaterThan(10)
    for (const n of steps) expect(n === PROSE.length || /\s/.test(PROSE[n - 1]!)).toBe(true)
  })

  it('reaches a word longer than a moment of its rate instead of stalling until the ceiling', () => {
    // At the slowest rate 200 ms of credit is 9 characters; each word is longer.
    const text = 'Die Brandschutzanforderungen, Fluchtwegslängen und Gebäudeklassenbestimmungen gelten. '
    const start = noteArrival(initialPace(0), text.length, 0)
    const { shown } = run(start, text, MAX_LAG_MS / 2)
    expect(new Set(shown.filter((n) => n > 'Die '.length)).size).toBeGreaterThanOrEqual(2)
  })
})

describe('finishCut', () => {
  const from = 'Ein zweiter Fluchtweg '.length

  it('takes longer for more text, within its bounds', () => {
    expect(finishDuration(0)).toBe(FINISH_MIN_MS)
    expect(finishDuration(100)).toBeGreaterThan(FINISH_MIN_MS)
    expect(finishDuration(100_000)).toBe(FINISH_MAX_MS)
  })

  it('reveals the rest at clean word gaps, never back, and all of it at the end', () => {
    const duration = finishDuration(PROSE.length - from)
    let shown = from
    const seen: number[] = []
    for (let t = 0; t < duration; t += FRAME_MS) {
      const next = finishCut(PROSE, from, shown, t, duration)
      expect(next).toBeGreaterThanOrEqual(shown)
      shown = next
      seen.push(shown)
    }
    expect(finishCut(PROSE, from, shown, duration, duration)).toBe(PROSE.length)
    const partial = seen.filter((n) => n > from && n < PROSE.length)
    expect(partial.length).toBeGreaterThan(3)
    for (const n of partial) expect(isCleanCut(PROSE.slice(0, n)) && /\s/.test(PROSE[n - 1]!)).toBe(true)
  })

  it('is fast at first and eases into the end', () => {
    const duration = finishDuration(PROSE.length - from)
    const half = finishCut(PROSE, from, from, duration / 2, duration)
    expect(half - from).toBeGreaterThan((PROSE.length - from) / 2)
  })
})
