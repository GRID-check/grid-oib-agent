/**
 * The bound on the run ledger, and the moves that grow one.
 *
 * What is under test is not "does it copy fields". It is the three properties a
 * reader's safety rests on: the key set is CLOSED, every list and string is
 * BOUNDED, and everything the ledger can check for itself is DERIVED rather than
 * believed. The hostile payload at the end is the whole file in one case.
 */

import { describe, expect, it } from 'vitest'
import {
  appendStep,
  applyRunLedgerAppend,
  applyRunLedgerFinish,
  closePhase,
  emptyRunLedger,
  failRun,
  finishRun,
  openPhase,
  sanitizeRunLedger,
  setRunStatus,
} from './run-ledger'
import {
  MAX_DOCS_PER_STEP,
  MAX_INTENT_CHARS,
  MAX_LOCI_PER_DOC,
  MAX_LOCUS_CHARS,
  MAX_NAME_CHARS,
  MAX_OPEN_POINTS,
  MAX_STEPS,
  type RunStep,
} from './run-ledger-types'

const T0 = new Date('2026-09-16T08:00:00.000Z')
const T1 = new Date('2026-09-16T08:05:00.000Z')
const T2 = new Date('2026-09-16T08:09:00.000Z')

const step = (overrides: Partial<RunStep> = {}): RunStep => ({
  id: 'step-1',
  phase: 'recherchieren',
  intent: 'OIB-2 auf Fluchtwegbreiten prüfen',
  startedAt: T1.toISOString(),
  docs: [],
  ...overrides,
})

const wire = (overrides: Record<string, unknown> = {}) => ({
  runId: 'run-1',
  status: 'laeuft',
  phases: [{ phase: 'recherchieren', startedAt: T0.toISOString() }],
  steps: [step()],
  startedAt: T0.toISOString(),
  updatedAt: T1.toISOString(),
  ...overrides,
})

describe('sanitizeRunLedger', () => {
  it('keeps a well-formed ledger as it stands', () => {
    expect(sanitizeRunLedger(wire())).toEqual(wire())
  })

  it('refuses anything that does not identify a run', () => {
    expect(sanitizeRunLedger(null)).toBeNull()
    expect(sanitizeRunLedger([wire()])).toBeNull()
    expect(sanitizeRunLedger('run-1')).toBeNull()
    expect(sanitizeRunLedger({ ...wire(), runId: '  ' })).toBeNull()
  })

  it('refuses a ledger with no instant anywhere, and keeps one with any', () => {
    expect(
      sanitizeRunLedger({ runId: 'run-1', status: 'laeuft', phases: [], steps: [] }),
    ).toBeNull()
    // `startedAt` is not optional in the type and inventing "now" for a stored
    // row would date a week-old run to whenever somebody opened it, so it falls
    // back to another instant the ledger itself carries.
    const recovered = sanitizeRunLedger({
      runId: 'run-1',
      steps: [step()],
      updatedAt: T2.toISOString(),
    })
    expect(recovered?.startedAt).toBe(T2.toISOString())
  })

  it('keeps a run that has done nothing yet', () => {
    const fresh = sanitizeRunLedger(emptyRunLedger('run-1', T0))
    expect(fresh).toEqual({
      runId: 'run-1',
      status: 'angelegt',
      phases: [],
      steps: [],
      startedAt: T0.toISOString(),
      updatedAt: T0.toISOString(),
    })
  })

  it('closes the key set on the ledger, its steps and its docs', () => {
    const ledger = sanitizeRunLedger({
      ...wire(),
      secret: 'kept?', // pragma: allowlist secret -- an unknown key the sanitizer must drop, not a credential
      steps: [
        {
          ...step(),
          // The one field this ledger is defined by not having.
          tool: 'search_norms',
          docs: [{ name: 'oib-2.pdf', loci: ['S. 12'], provider: 'milvus' }],
        },
      ],
    })
    expect(ledger).not.toHaveProperty('secret')
    expect(ledger?.steps[0]).not.toHaveProperty('tool')
    expect(ledger?.steps[0].docs[0]).toEqual({ name: 'oib-2.pdf', loci: ['S. 12'] })
  })

  it('truncates every list to its budget', () => {
    function many<T>(count: number, make: (index: number) => T): T[] {
      return Array.from({ length: count }, (_, index) => make(index))
    }
    const ledger = sanitizeRunLedger({
      ...wire(),
      steps: many(MAX_STEPS + 12, (index) => step({ id: `step-${index}` })),
    })
    expect(ledger?.steps).toHaveLength(MAX_STEPS)
    // The FIRST steps are kept: the beginning of a run is what explains it.
    expect(ledger?.steps[0].id).toBe('step-0')

    const docs = sanitizeRunLedger({
      ...wire(),
      steps: [
        step({
          docs: many(MAX_DOCS_PER_STEP + 5, (index) => ({
            name: `datei-${index}.pdf`,
            loci: many(MAX_LOCI_PER_DOC + 4, (page) => `S. ${page}`),
          })),
        }),
      ],
    })
    expect(docs?.steps[0].docs).toHaveLength(MAX_DOCS_PER_STEP)
    expect(docs?.steps[0].docs[0].loci).toHaveLength(MAX_LOCI_PER_DOC)

    const points = sanitizeRunLedger({
      ...wire(),
      steps: [step({ openPoints: many(MAX_OPEN_POINTS + 7, (index) => `offen ${index}`) })],
    })
    expect(points?.steps[0].openPoints).toHaveLength(MAX_OPEN_POINTS)
  })

  it('caps every string to its budget', () => {
    const ledger = sanitizeRunLedger({
      ...wire(),
      steps: [
        step({
          intent: 'x'.repeat(MAX_INTENT_CHARS + 50),
          docs: [
            {
              name: 'n'.repeat(MAX_NAME_CHARS + 50),
              loci: ['l'.repeat(MAX_LOCUS_CHARS + 50)],
            },
          ],
        }),
      ],
    })
    expect(ledger?.steps[0].intent).toHaveLength(MAX_INTENT_CHARS)
    expect(ledger?.steps[0].docs[0].name).toHaveLength(MAX_NAME_CHARS)
    expect(ledger?.steps[0].docs[0].loci[0]).toHaveLength(MAX_LOCUS_CHARS)
  })

  it('drops a step it cannot place, and keeps the run’s other steps', () => {
    const ledger = sanitizeRunLedger({
      ...wire(),
      steps: [
        { ...step(), id: '' },
        { ...step({ id: 'no-phase' }), phase: 'kaffeetrinken' },
        { ...step({ id: 'no-intent' }), intent: '   ' },
        { ...step({ id: 'no-start' }), startedAt: 'gestern' },
        step({ id: 'good' }),
      ],
    })
    expect(ledger?.steps.map((entry) => entry.id)).toEqual(['good'])
  })

  it('records each phase once, from its first entry', () => {
    const ledger = sanitizeRunLedger({
      ...wire(),
      phases: [
        { phase: 'planen', startedAt: T0.toISOString() },
        { phase: 'planen', startedAt: T2.toISOString(), endedAt: T2.toISOString() },
        { phase: 'schwebt', startedAt: T0.toISOString() },
        { phase: 'schreiben', startedAt: 'irgendwann' },
      ],
    })
    expect(ledger?.phases).toEqual([{ phase: 'planen', startedAt: T0.toISOString() }])
  })

  it('normalises every instant to UTC', () => {
    const ledger = sanitizeRunLedger({
      ...wire(),
      startedAt: '2026-09-16T10:00:00+02:00',
      updatedAt: '2026-09-16T10:05:00+02:00',
      steps: [step({ startedAt: '2026-09-16T10:01:00+02:00' })],
    })
    expect(ledger?.startedAt).toBe('2026-09-16T08:00:00.000Z')
    expect(ledger?.steps[0].startedAt).toBe('2026-09-16T08:01:00.000Z')
  })

  it('derives the status when the payload names one it does not know', () => {
    const running = sanitizeRunLedger({ ...wire(), status: 'in_progress' })
    expect(running?.status).toBe('laeuft')

    const finished = sanitizeRunLedger({
      ...wire(),
      status: undefined,
      result: { filedAt: T2.toISOString(), fileId: 'doc-1' },
    })
    expect(finished?.status).toBe('fertig')

    const failed = sanitizeRunLedger({
      ...wire(),
      status: 'angelegt ',
      error: { reason: 'Der Anbieter hat abgebrochen.', completedBefore: [] },
    })
    expect(failed?.status).toBe('fehlgeschlagen')

    const idle = sanitizeRunLedger({ ...wire(), status: 'wer weiß', phases: [], steps: [] })
    expect(idle?.status).toBe('angelegt')
  })

  it('believes a claimed completedBefore only for phases that actually ended', () => {
    const ledger = sanitizeRunLedger({
      ...wire(),
      phases: [
        { phase: 'planen', startedAt: T0.toISOString(), endedAt: T1.toISOString() },
        { phase: 'recherchieren', startedAt: T1.toISOString() },
      ],
      error: {
        reason: 'Die Recherche ist gescheitert.',
        completedBefore: ['planen', 'recherchieren', 'schreiben', 'planen', 'unsinn'],
      },
    })
    expect(ledger?.error?.completedBefore).toEqual(['planen'])
  })

  it('drops a result with no filing instant and an error with no reason', () => {
    const ledger = sanitizeRunLedger({
      ...wire(),
      result: { fileId: 'doc-1' },
      error: { reason: '   ', completedBefore: [] },
    })
    expect(ledger?.result).toBeUndefined()
    expect(ledger?.error).toBeUndefined()
  })

  it('survives a hostile payload', () => {
    const hostile = {
      runId: 'r'.repeat(5_000),
      status: { toString: () => 'fertig' },
      phases: 'alle',
      steps: [null, 42, [], { docs: 'viele' }, step()],
      result: 'fertig!',
      error: [],
      startedAt: T0.toISOString(),
      updatedAt: { now: true },
      finishedAt: 'bald',
      __proto__: { polluted: true },
    }
    const ledger = sanitizeRunLedger(hostile)
    expect(ledger?.runId).toHaveLength(64)
    expect(ledger?.phases).toEqual([])
    expect(ledger?.steps).toEqual([step()])
    expect(ledger?.status).toBe('laeuft')
    expect(ledger?.updatedAt).toBe(T0.toISOString())
    expect(ledger).not.toHaveProperty('finishedAt')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('the moves', () => {
  it('leaves the ledger it was given untouched', () => {
    const before = emptyRunLedger('run-1', T0)
    const frozen = structuredClone(before)
    appendStep(before, step(), T1)
    openPhase(before, 'planen', T1)
    finishRun(before, { filedAt: T2.toISOString() }, T2)
    expect(before).toEqual(frozen)
  })

  it('appends a step and starts the run', () => {
    const after = appendStep(emptyRunLedger('run-1', T0), step(), T1)
    expect(after.status).toBe('laeuft')
    expect(after.steps).toEqual([step()])
    expect(after.updatedAt).toBe(T1.toISOString())
  })

  it('enters a phase once', () => {
    const opened = openPhase(emptyRunLedger('run-1', T0), 'planen', T1)
    expect(opened.phases).toEqual([{ phase: 'planen', startedAt: T1.toISOString() }])
    expect(openPhase(opened, 'planen', T2)).toBe(opened)
  })

  it('leaves a phase once, and only one it entered', () => {
    const opened = openPhase(emptyRunLedger('run-1', T0), 'planen', T1)
    const closed = closePhase(opened, 'planen', T2)
    expect(closed.phases[0].endedAt).toBe(T2.toISOString())
    expect(closePhase(closed, 'planen', T2)).toBe(closed)
    expect(closePhase(closed, 'schreiben', T2)).toBe(closed)
  })

  it('moves the status on its own, and says nothing twice', () => {
    const ledger = emptyRunLedger('run-1', T0)
    const waiting = setRunStatus(ledger, 'wartet', T1)
    expect(waiting.status).toBe('wartet')
    expect(waiting.updatedAt).toBe(T1.toISOString())
    expect(setRunStatus(waiting, 'wartet', T2)).toBe(waiting)
  })

  it('finishes: the result is on the ledger and no phase is left running', () => {
    const running = openPhase(emptyRunLedger('run-1', T0), 'schreiben', T1)
    const done = finishRun(running, { filedAt: T2.toISOString(), fileId: 'doc-1' }, T2)
    expect(done.status).toBe('fertig')
    expect(done.finishedAt).toBe(T2.toISOString())
    expect(done.result).toEqual({ filedAt: T2.toISOString(), fileId: 'doc-1' })
    expect(done.phases[0].endedAt).toBe(T2.toISOString())
  })

  it('fails: the phase it died in stays open, and completedBefore is derived', () => {
    const planned = closePhase(openPhase(emptyRunLedger('run-1', T0), 'planen', T0), 'planen', T1)
    const searching = openPhase(planned, 'recherchieren', T1)
    const failed = failRun(searching, 'Der Anbieter hat abgebrochen.', T2)
    expect(failed.status).toBe('fehlgeschlagen')
    expect(failed.error).toEqual({
      reason: 'Der Anbieter hat abgebrochen.',
      completedBefore: ['planen'],
    })
    expect(failed.phases[1].endedAt).toBeUndefined()
  })

  it('caps a reason a caller made too long', () => {
    const failed = failRun(emptyRunLedger('run-1', T0), 'x'.repeat(5_000), T1)
    expect(failed.error?.reason).toHaveLength(400)
  })

  it('applies an append op: phases, then steps, then the stated status', () => {
    const applied = applyRunLedgerAppend(
      emptyRunLedger('run-1', T0),
      {
        phases: [
          { phase: 'planen', startedAt: T0.toISOString(), endedAt: T1.toISOString() },
          { phase: 'recherchieren', startedAt: T1.toISOString() },
        ],
        steps: [step()],
        status: 'wartet',
      },
      T2,
    )
    expect(applied.phases).toEqual([
      { phase: 'planen', startedAt: T0.toISOString(), endedAt: T1.toISOString() },
      { phase: 'recherchieren', startedAt: T1.toISOString() },
    ])
    expect(applied.steps).toEqual([step()])
    // The stated status wins over the „läuft" a step implies: a run that has
    // asked the person a question is waiting, whatever it did just before.
    expect(applied.status).toBe('wartet')
  })

  it('applies a finish op either way', () => {
    const ledger = emptyRunLedger('run-1', T0)
    expect(
      applyRunLedgerFinish(ledger, { result: { filedAt: T2.toISOString() } }, T2).status,
    ).toBe('fertig')
    expect(applyRunLedgerFinish(ledger, { error: { reason: 'Zeitüberschreitung' } }, T2).status).toBe(
      'fehlgeschlagen',
    )
  })
})
