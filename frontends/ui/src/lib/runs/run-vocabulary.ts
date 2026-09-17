/**
 * What a run ledger SAYS, derived once — the vocabulary map behind the Laufblock.
 *
 * `RunLedger` is the account of what a run did; this module is every question a
 * surface asks of it before rendering: which phase is live, what each phase's
 * state is, how many rounds and documents, what was done when it stopped, how
 * long it has been running. The pattern is `features/layout/lib/workflow-names`:
 * the identifier never reaches the reader, the dictionary supplies the word,
 * and the derivation lives in ONE place so the block in the thread, the compact
 * line in the Aufträge index and the task card cannot count the same ledger
 * three different ways.
 *
 * Pure and browser-safe on purpose — no `server-only`, no date library, no
 * store. Everything here is a function of the ledger and, where time matters,
 * of a `now` the caller passes in, so a component can tick and a test can pin
 * the clock.
 */

import {
  RUN_PHASES,
  RUN_STATUSES,
  type RunLedger,
  type RunPhase,
  type RunStatus,
  type RunStep,
} from './run-ledger-types'

/** The three ways a phase reads on the rail and in the list. */
export type PhaseState = 'done' | 'active' | 'pending'

/** The rounds and documents a run has reached — the only numbers the header shows. */
export interface RunTallies {
  /** Steps taken inside `recherchieren`: one step is one research round. */
  rounds: number
  /** Distinct document names across every step, whatever phase reached them. */
  docs: number
}

const STATUS_SET: ReadonlySet<string> = new Set<string>(RUN_STATUSES)

/**
 * The status the block shows.
 *
 * The ledger's own `status` when it is one of the seven; otherwise derived from
 * the terminal fields, so a ledger written by a producer this build predates
 * still lands on a word rather than on an empty header: an error is a failure,
 * a result is done, an opened phase is running and nothing at all is starting.
 */
export function runDisplayStatus(ledger: RunLedger): RunStatus {
  if (STATUS_SET.has(ledger.status)) return ledger.status
  if (ledger.error) return 'fehlgeschlagen'
  if (ledger.result) return 'fertig'
  return ledger.phases.length > 0 ? 'laeuft' : 'angelegt'
}

/** The states in which the run is still doing, or waiting for, something. */
export function isLiveStatus(status: RunStatus): boolean {
  return status === 'angelegt' || status === 'laeuft' || status === 'wartet'
}

/** The phase the run is in: the LAST phase entry that has not ended, else null. */
export function activePhase(ledger: RunLedger): RunPhase | null {
  for (let i = ledger.phases.length - 1; i >= 0; i--) {
    const entry = ledger.phases[i]
    if (entry && !entry.endedAt) return entry.phase
  }
  return null
}

/**
 * How one phase reads: `done` once it has ended, `active` while it is open,
 * `pending` when the run has not reached it. A phase the run opened and never
 * closed on a terminal ledger stays `active` — that is the phase it stopped
 * in, and the rail marks it as such (a ring without the pulse).
 */
export function phaseState(ledger: RunLedger, phase: RunPhase): PhaseState {
  const entry = ledger.phases.find((candidate) => candidate.phase === phase)
  if (!entry) return 'pending'
  return entry.endedAt ? 'done' : 'active'
}

/** The steps the run took inside one phase, in the order they were taken. */
export function stepsInPhase(ledger: RunLedger, phase: RunPhase): RunStep[] {
  return ledger.steps.filter((step) => step.phase === phase)
}

export function runTallies(ledger: RunLedger): RunTallies {
  const names = new Set<string>()
  for (const step of ledger.steps) {
    for (const doc of step.docs) names.add(doc.name)
  }
  return { rounds: stepsInPhase(ledger, 'recherchieren').length, docs: names.size }
}

/**
 * The phases that were finished when the run stopped, in phase order.
 *
 * The error's own `completedBefore` when the run failed (it was derived on the
 * server from the same fact); otherwise the phases that carry an `endedAt`, so a
 * cancelled or interrupted run can say the same sentence a failed one does.
 */
export function completedBefore(ledger: RunLedger): RunPhase[] {
  const done = new Set<RunPhase>(
    ledger.error?.completedBefore ??
      ledger.phases.filter((entry) => entry.endedAt).map((entry) => entry.phase),
  )
  return RUN_PHASES.filter((phase) => done.has(phase))
}

/** An ISO instant as epoch ms, or `null` when it does not parse. */
function ms(instant: string | undefined): number | null {
  if (!instant) return null
  const value = Date.parse(instant)
  return Number.isFinite(value) ? value : null
}

/**
 * How long the run has been running, or ran: `finishedAt` (else `now`) minus
 * `startedAt`, never negative, and zero for a ledger whose instants do not
 * parse — an unreadable timestamp is a bug to fix upstream, not a negative
 * number to render.
 *
 * `wartet` stops the clock at `updatedAt`, which IS the instant the run asked
 * its question: nothing folds into the ledger between the ask and the answer,
 * so that timestamp is the last thing the run did. Running it on to `now`
 * would make the pill read „68 h" on a Monday morning — a true number about
 * the wrong subject, because the pill says how long the WORK took and that
 * one would be saying how long the reader took.
 */
export function elapsedMs(ledger: RunLedger, now: number): number {
  const started = ms(ledger.startedAt)
  if (started === null) return 0
  const waiting = runDisplayStatus(ledger) === 'wartet' ? ms(ledger.updatedAt) : null
  const ended = ms(ledger.finishedAt) ?? waiting ?? now
  return Math.max(0, ended - started)
}

/**
 * How long one phase took, or has been taking. `null` for a phase the run never
 * entered; a still-open phase measures up to `now`.
 */
export function phaseDurationMs(ledger: RunLedger, phase: RunPhase, now: number): number | null {
  const entry = ledger.phases.find((candidate) => candidate.phase === phase)
  if (!entry) return null
  const started = ms(entry.startedAt)
  if (started === null) return null
  const ended = ms(entry.endedAt) ?? ms(ledger.finishedAt) ?? now
  return Math.max(0, ended - started)
}
