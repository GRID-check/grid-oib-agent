/**
 * Run ledgers for the `/dev/run-block` preview — one per state, built with the
 * ledger's own fold helpers so a fixture is a ledger production could have
 * written, not a hand-typed object that drifts from the schema.
 *
 * Live states are anchored to module load (`startedAt = now − 102 s`), so the
 * elapsed pill reads „1:42" rather than the years since a fixed instant.
 * Terminal states are fixed to the morning of the review so their durations
 * are the same on every capture.
 */

import {
  appendStep,
  closePhase,
  emptyRunLedger,
  failRun,
  finishRun,
  openPhase,
  setRunStatus,
} from '@/lib/runs/run-ledger'
import type { RunLedger, RunLedgerDoc, RunStep } from '@/lib/runs/run-ledger-types'

const doc = (
  name: string,
  shelf: RunLedgerDoc['shelf'],
  loci: string[],
  repeat = false,
): RunLedgerDoc => ({ name, shelf, loci, ...(repeat ? { repeat } : {}) })

const OIB_2 = (loci: string[], repeat = false) => doc('OIB-Richtlinie 2, Ausgabe Mai 2023', 'base', loci, repeat)
const BO_WIEN = doc('Bauordnung für Wien § 108', 'base', ['§ 108 Abs. 2'])
const BSK = (loci: string[], repeat = false) => doc('Brandschutzkonzept Haus A', 'project', loci, repeat)
const GRUNDRISS = doc('Grundriss EG', 'project', ['Achse C–E'])
const OIB_2_3 = doc('OIB-Richtlinie 2.3, Ausgabe Mai 2023', 'base', ['Pkt. 3.1'])
const ERL_OIB_2 = doc('Erläuterungen zu OIB-Richtlinie 2', 'base', ['S. 4'])
const WBTV = doc('Wiener Bautechnikverordnung 2020', 'base', ['§ 2'])
const CHECKLISTE = doc('Checkliste Brandschutz Einreichung', 'archiv', ['Abschnitt 3'])
const ONORM = doc('ÖNORM B 1300', 'base', ['Pkt. 5.2'])

const PLAN_STEP = (at: Date): RunStep => ({
  id: 'p1',
  phase: 'planen',
  intent: 'Fluchtweglängen, Gebäudeklasse und Wiener Abweichungen für Haus A klären',
  startedAt: at.toISOString(),
  docs: [],
})

/** The three research rounds every fixture with research shares. */
const ROUNDS = (at: (s: number) => Date): RunStep[] => [
  {
    id: 'r1',
    phase: 'recherchieren',
    intent: 'Klären, welche Fluchtweglängen OIB 2 für Gebäudeklasse 4 vorsieht',
    startedAt: at(20).toISOString(),
    docs: [OIB_2(['Pkt. 5.1.1', 'S. 12']), BO_WIEN, BSK(['S. 7'])],
  },
  {
    id: 'r2',
    phase: 'recherchieren',
    intent: 'Prüfen, ob das Atrium als Ersatz für den Treppenraum gilt',
    startedAt: at(45).toISOString(),
    docs: [OIB_2(['Pkt. 4.2', 'S. 18'], true), GRUNDRISS, OIB_2_3, ERL_OIB_2],
    openPoints: ['Landesabweichung Wien prüfen'],
  },
  {
    id: 'r3',
    phase: 'recherchieren',
    intent: 'Wiener Abweichungen zur Fluchtweglänge und die Rauchabschnitte nachlesen',
    startedAt: at(80).toISOString(),
    docs: [WBTV, CHECKLISTE, ONORM, BSK(['S. 9'], true)],
    openPoints: ['Nachweis der Rauchabschnitte im Atrium', 'Abstimmung mit der MA 37 offen'],
  },
]

/** Planen done, research rounds appended, up to `rounds` of them. */
function researched(runId: string, start: Date, rounds: number): RunLedger {
  const at = (s: number): Date => new Date(start.getTime() + s * 1000)
  let ledger = emptyRunLedger(runId, start)
  ledger = openPhase(ledger, 'planen', at(0))
  ledger = appendStep(ledger, PLAN_STEP(at(1)), at(1))
  ledger = closePhase(ledger, 'planen', at(12))
  ledger = openPhase(ledger, 'recherchieren', at(12))
  for (const step of ROUNDS(at).slice(0, rounds)) {
    ledger = appendStep(ledger, step, new Date(step.startedAt))
  }
  return ledger
}

/**
 * The run's own life, frame by frame: what the ledger looks like at each step
 * of a run that goes all the way. The motion preview walks this list on a
 * timer, so the choreography can be watched rather than argued about — every
 * frame is built by the same fold helpers the real thing uses, so nothing in
 * it can be a shape the product cannot produce.
 */
export function runSequence(runId: string, start: Date): RunLedger[] {
  const at = (s: number): Date => new Date(start.getTime() + s * 1000)
  const frames: RunLedger[] = []
  let ledger = emptyRunLedger(runId, start)
  frames.push(ledger)
  ledger = openPhase(ledger, 'planen', at(1))
  frames.push(ledger)
  ledger = appendStep(ledger, PLAN_STEP(at(2)), at(2))
  ledger = closePhase(ledger, 'planen', at(12))
  ledger = openPhase(ledger, 'recherchieren', at(12))
  frames.push(ledger)
  for (const step of ROUNDS(at)) {
    ledger = appendStep(ledger, step, new Date(step.startedAt))
    frames.push(ledger)
  }
  ledger = closePhase(ledger, 'recherchieren', at(120))
  ledger = openPhase(ledger, 'pruefen', at(120))
  frames.push(ledger)
  ledger = closePhase(ledger, 'pruefen', at(145))
  ledger = openPhase(ledger, 'schreiben', at(145))
  frames.push(ledger)
  ledger = closePhase(ledger, 'schreiben', at(186))
  ledger = openPhase(ledger, 'abgelegt', at(186))
  frames.push(ledger)
  ledger = finishRun(
    ledger,
    { fileId: 'doc-brandschutz-fluchtwege', reportMessageId: 'm-report', filedAt: at(189).toISOString() },
    at(189),
  )
  frames.push(ledger)
  return frames
}

const NOW = Date.now()
const secondsAgo = (s: number): Date => new Date(NOW - s * 1000)
const MORNING = new Date('2026-09-16T07:41:00.000Z')
const morning = (s: number): Date => new Date(MORNING.getTime() + s * 1000)

export const RUN_ANGELEGT: RunLedger = emptyRunLedger('run-angelegt', secondsAgo(3))

/** Recherchieren live: 3 rounds, 9 documents, one re-read, open points. Started 1:42 ago. */
export const RUN_LAEUFT: RunLedger = researched('run-laeuft', secondsAgo(102), 3)

export const RUN_WARTET: RunLedger = setRunStatus(
  researched('run-wartet', secondsAgo(140), 2),
  'wartet',
  secondsAgo(80),
)

function finished(runId: string, fileId: string | undefined): RunLedger {
  let ledger = researched(runId, MORNING, 3)
  ledger = closePhase(ledger, 'recherchieren', morning(102))
  ledger = openPhase(ledger, 'pruefen', morning(102))
  ledger = closePhase(ledger, 'pruefen', morning(127))
  ledger = openPhase(ledger, 'schreiben', morning(127))
  ledger = closePhase(ledger, 'schreiben', morning(168))
  ledger = openPhase(ledger, 'abgelegt', morning(168))
  return finishRun(
    ledger,
    { ...(fileId ? { fileId } : {}), filedAt: morning(171).toISOString() },
    morning(171),
  )
}

export const RUN_FERTIG: RunLedger = finished('run-fertig', 'doc-brandschutz-fluchtwege')
export const RUN_FERTIG_INLINE: RunLedger = finished('run-fertig-inline', undefined)

export const RUN_FEHLGESCHLAGEN: RunLedger = (() => {
  let ledger = researched('run-fehlgeschlagen', MORNING, 2)
  ledger = closePhase(ledger, 'recherchieren', morning(70))
  ledger = openPhase(ledger, 'pruefen', morning(70))
  return failRun(ledger, 'Das Budget war aufgebraucht, bevor die Prüfung fertig war.', morning(84))
})()

export const RUN_ABGEBROCHEN: RunLedger = (() => {
  const ledger = setRunStatus(researched('run-abgebrochen', MORNING, 1), 'abgebrochen', morning(38))
  return { ...ledger, finishedAt: morning(38).toISOString() }
})()

export const RUN_UNTERBROCHEN: RunLedger = (() => {
  let ledger = researched('run-unterbrochen', MORNING, 2)
  ledger = closePhase(ledger, 'recherchieren', morning(61))
  ledger = openPhase(ledger, 'schreiben', morning(61))
  ledger = closePhase(ledger, 'schreiben', morning(95))
  ledger = openPhase(ledger, 'abgelegt', morning(95))
  ledger = finishRun(ledger, { fileId: 'doc-brandschutz-teil', filedAt: morning(97).toISOString() }, morning(97))
  return setRunStatus(ledger, 'unterbrochen', morning(97))
})()
