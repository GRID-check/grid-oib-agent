/**
 * @vitest-environment node
 */

/**
 * The vocabulary map — what one ledger is read to SAY.
 *
 * Three surfaces render from these derivations (the block, the compact line,
 * the task card), so each answer is pinned once here rather than three times
 * in three component specs. The fixtures are built with the ledger's own fold
 * helpers, at fixed instants, so a tally or a duration below is a fact about
 * the helpers and the derivation together — the same pair production runs.
 */

import { describe, expect, it } from 'vitest'
import {
  appendStep,
  closePhase,
  emptyRunLedger,
  failRun,
  finishRun,
  openPhase,
  setRunStatus,
} from './run-ledger'
import type { RunLedger, RunStep } from './run-ledger-types'
import {
  activePhase,
  completedBefore,
  elapsedMs,
  isLiveStatus,
  phaseDurationMs,
  phaseState,
  runDisplayStatus,
  runTallies,
  stepsInPhase,
} from './run-vocabulary'

const T0 = new Date('2026-09-16T08:00:00.000Z')
const at = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000)

const step = (id: string, phase: RunStep['phase'], docs: string[], seconds: number): RunStep => ({
  id,
  phase,
  intent: `Schritt ${id}`,
  startedAt: at(seconds).toISOString(),
  docs: docs.map((name) => ({ name, loci: ['S. 1'] })),
})

/** Planen done at 12 s, two research rounds over four documents, still researching. */
function researching(): RunLedger {
  let ledger = emptyRunLedger('run-1', T0)
  ledger = openPhase(ledger, 'planen', at(0))
  ledger = appendStep(ledger, step('p1', 'planen', [], 1), at(1))
  ledger = closePhase(ledger, 'planen', at(12))
  ledger = openPhase(ledger, 'recherchieren', at(12))
  ledger = appendStep(ledger, step('r1', 'recherchieren', ['OIB-Richtlinie 2', 'BO Wien'], 20), at(20))
  ledger = appendStep(
    ledger,
    step('r2', 'recherchieren', ['OIB-Richtlinie 2', 'Grundriss EG', 'Brandschutzkonzept'], 45),
    at(45),
  )
  return ledger
}

describe('runDisplayStatus', () => {
  it('is the ledger status when it is one of the seven', () => {
    expect(runDisplayStatus(researching())).toBe('laeuft')
    expect(runDisplayStatus(setRunStatus(researching(), 'wartet', at(50)))).toBe('wartet')
  })

  it('derives a word for a status this build does not know', () => {
    const unknown = { ...researching(), status: 'paused' as RunLedger['status'] }
    expect(runDisplayStatus(unknown)).toBe('laeuft')
    expect(runDisplayStatus({ ...unknown, phases: [] })).toBe('angelegt')
    expect(runDisplayStatus({ ...failRun(unknown, 'Budget', at(60)), status: unknown.status })).toBe(
      'fehlgeschlagen',
    )
    expect(
      runDisplayStatus({
        ...finishRun(unknown, { filedAt: at(60).toISOString() }, at(60)),
        status: unknown.status,
      }),
    ).toBe('fertig')
  })
})

describe('isLiveStatus', () => {
  it('is true for the three states that still move or wait', () => {
    expect(isLiveStatus('angelegt')).toBe(true)
    expect(isLiveStatus('laeuft')).toBe(true)
    expect(isLiveStatus('wartet')).toBe(true)
    expect(isLiveStatus('fertig')).toBe(false)
    expect(isLiveStatus('fehlgeschlagen')).toBe(false)
    expect(isLiveStatus('abgebrochen')).toBe(false)
    expect(isLiveStatus('unterbrochen')).toBe(false)
  })
})

describe('activePhase and phaseState', () => {
  it('names the last open phase and reads each phase relative to it', () => {
    const ledger = researching()
    expect(activePhase(ledger)).toBe('recherchieren')
    expect(phaseState(ledger, 'planen')).toBe('done')
    expect(phaseState(ledger, 'recherchieren')).toBe('active')
    expect(phaseState(ledger, 'pruefen')).toBe('pending')
    expect(phaseState(ledger, 'abgelegt')).toBe('pending')
  })

  it('has no active phase before the first one opens, or once every one has closed', () => {
    expect(activePhase(emptyRunLedger('run-0', T0))).toBeNull()
    const done = finishRun(researching(), { filedAt: at(90).toISOString() }, at(90))
    expect(activePhase(done)).toBeNull()
    expect(phaseState(done, 'recherchieren')).toBe('done')
  })

  it('keeps the phase a failed run stopped in as active — the ring without the pulse', () => {
    let ledger = closePhase(researching(), 'recherchieren', at(60))
    ledger = openPhase(ledger, 'pruefen', at(60))
    const failed = failRun(ledger, 'Das Budget war aufgebraucht.', at(70))
    expect(phaseState(failed, 'pruefen')).toBe('active')
    expect(activePhase(failed)).toBe('pruefen')
  })
})

describe('runTallies and stepsInPhase', () => {
  it('counts research rounds and distinct document names', () => {
    expect(runTallies(researching())).toEqual({ rounds: 2, docs: 4 })
    expect(stepsInPhase(researching(), 'recherchieren').map((s) => s.id)).toEqual(['r1', 'r2'])
    expect(stepsInPhase(researching(), 'pruefen')).toEqual([])
  })

  it('does not count a planning step as a round', () => {
    expect(runTallies(emptyRunLedger('run-0', T0))).toEqual({ rounds: 0, docs: 0 })
    let ledger = openPhase(emptyRunLedger('run-0', T0), 'planen', at(0))
    ledger = appendStep(ledger, step('p1', 'planen', ['Grundriss EG'], 1), at(1))
    expect(runTallies(ledger)).toEqual({ rounds: 0, docs: 1 })
  })
})

describe('completedBefore', () => {
  it('is the error’s own list on a failed run, in phase order', () => {
    let ledger = closePhase(researching(), 'recherchieren', at(60))
    ledger = openPhase(ledger, 'pruefen', at(60))
    const failed = failRun(ledger, 'Budget', at(70))
    expect(completedBefore(failed)).toEqual(['planen', 'recherchieren'])
  })

  it('falls back to the ended phases for a run that stopped without an error', () => {
    const stopped = setRunStatus(researching(), 'abgebrochen', at(50))
    expect(completedBefore(stopped)).toEqual(['planen'])
  })

  it('orders the phases as the run walks them, whatever order the error lists', () => {
    const ledger: RunLedger = {
      ...researching(),
      error: { reason: 'x', completedBefore: ['recherchieren', 'planen'] },
    }
    expect(completedBefore(ledger)).toEqual(['planen', 'recherchieren'])
  })
})

describe('elapsedMs and phaseDurationMs', () => {
  it('measures a live run up to now and a finished run up to its end', () => {
    const live = researching()
    expect(elapsedMs(live, at(102).getTime())).toBe(102_000)
    const done = finishRun(live, { filedAt: at(90).toISOString() }, at(90))
    expect(elapsedMs(done, at(500).getTime())).toBe(90_000)
  })

  it('never goes negative and reads zero for an instant it cannot parse', () => {
    expect(elapsedMs(researching(), at(-5).getTime())).toBe(0)
    expect(elapsedMs({ ...researching(), startedAt: 'gestern' }, at(10).getTime())).toBe(0)
  })

  it('measures a closed phase by its own bounds and an open one up to now', () => {
    const live = researching()
    expect(phaseDurationMs(live, 'planen', at(100).getTime())).toBe(12_000)
    expect(phaseDurationMs(live, 'recherchieren', at(100).getTime())).toBe(88_000)
    expect(phaseDurationMs(live, 'pruefen', at(100).getTime())).toBeNull()
  })

  it('stops an open phase at the run’s end once the run is terminal', () => {
    const failed = failRun(researching(), 'Budget', at(70))
    expect(phaseDurationMs(failed, 'recherchieren', at(1000).getTime())).toBe(58_000)
  })
})
