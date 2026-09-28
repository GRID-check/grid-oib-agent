/**
 * The run reconciler: close the runs whose ending never arrived (backlog T3-11).
 *
 * A run ends on the backend, and until now the BFF learned that from exactly
 * one best-effort POST per fact: the outcome (`/api/internal/jobs/{id}/outcome`)
 * closes the `task_runs` row, the report (`/api/internal/runs/by-job/{id}/report`)
 * fills the run's message, the ledger's terminal op settles its block. A BFF
 * restart or a network blip at that moment, or a job that finished before this
 * tier had written its backend job id onto the row, left the run `running` for
 * good and its message empty. The worker now retries the outcome and the report
 * briefly (`aiq_api/internal_retry.py`); this is the backstop for what the
 * retry could not heal, and for a lost ledger op, which is not retried.
 *
 * ## Pull, from the one place that knows
 *
 * The job store holds the authoritative terminal status and the report long
 * after the worker's writes were lost, so the reconciler ASKS it
 * (`fetchBackendJobOutcome`) rather than waiting to be told. No queue, no
 * outbox: the outbox on a Postgres-native queue library stays deferred in T3-11.
 *
 * ## One path, not two
 *
 * Every write here is a call to the function the worker's own write reaches:
 * `writeRunReport` for the message, `recordRunOutcome` for the row and its
 * block's ledger — the last with `onlyIfActive`, so a worker's report arriving
 * in the same instant cannot make the requester hear twice.
 *
 * ## Order, and why it makes a retry safe
 *
 * Message, then ledger, then row (the recorder does the last two in that
 * order). The claim picks only active rows, so closing the row LAST means a
 * sweep that fails halfway leaves the row active and the next sweep does the
 * rest; each earlier step checks before it writes (an empty message, a live
 * ledger), so doing it twice changes nothing.
 *
 * ## Which rows, how often
 *
 * A row is due once nothing has checked it for `staleMinutes` (default 10). The
 * number comes from the backend: its ghost reaper declares a job whose worker
 * stopped heartbeating FAILURE after 5 minutes without events and sweeps every
 * minute, and the worker's own retry is done within half a minute. So ten
 * minutes after a run last showed signs of life the job store has a verdict for
 * any run that is not genuinely still working. A run that is (deep research may
 * take its full 40-minute wall clock) is asked again once per window, never once
 * per tick. The claim stamps the row as it selects it (`FOR UPDATE SKIP LOCKED`),
 * which is what keeps two BFF replicas off one run.
 *
 * ## A job nobody can find
 *
 * No backend job id on the row (the submit's own write was lost, #723), or a
 * backend that answers 404 (the job expired from the store after its 24 hours,
 * or never reached it): past `unknownGraceMinutes` (default 120, three times the
 * longest run's wall clock, so a run that did start has ended by then) the row
 * is closed as failed with a reason that says its result could not be
 * recovered. Before that, it waits.
 */

import 'server-only'
import type { TaskRun } from '@/lib/db/schema'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { fetchBackendJobOutcome, type BackendJobOutcome } from '@/lib/jobs/backend-client'
import * as taskRepository from '@/lib/tasks/repository'
import { recordRunOutcome, type TaskOutcome } from '@/lib/tasks/service'
import { readRunMessage, settleRunLedger, writeRunReport, type RunEnding } from './service'

/** How many runs one sweep claims. Bounded: the sweep is housekeeping on a timer. */
export const RECONCILE_BATCH = 25
/**
 * How many closed runs one sweep heals. Larger than the reconcile batch: a heal
 * asks no backend, it is one locked read of a message, and the first sweeps
 * after 0099 work through every closed run in the retention window.
 */
export const HEAL_BATCH = 100
/** How many of them are asked about at once; each probe has its own 10 s timeout. */
const RECONCILE_CONCURRENCY = 5

const DEFAULT_STALE_MINUTES = 10
const DEFAULT_UNKNOWN_GRACE_MINUTES = 120

/**
 * The reason a run nobody can find is closed with. German, because it is shown
 * to the reader (the Aufträge list, the run block), and free of internal names.
 */
export const LOST_JOB_REASON =
  'Der Lauf ist im Hintergrunddienst nicht mehr auffindbar; sein Ergebnis ließ sich nicht wiederherstellen.'
export const NEVER_SUBMITTED_REASON =
  'Der Lauf hat den Hintergrunddienst nie nachweislich erreicht; sein Ergebnis ließ sich nicht wiederherstellen.'

export interface ReconcileConfig {
  /** A run is due once nothing has checked it for this long. */
  staleMinutes: number
  /** A run whose job cannot be found is closed as failed once it is this old. */
  unknownGraceMinutes: number
  batch: number
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** `GRID_RUN_RECONCILE_STALE_MINUTES`, `GRID_RUN_RECONCILE_UNKNOWN_GRACE_MINUTES`. */
export function readReconcileConfig(env: Record<string, string | undefined> = process.env): ReconcileConfig {
  const staleMinutes = positiveInt(env.GRID_RUN_RECONCILE_STALE_MINUTES, DEFAULT_STALE_MINUTES)
  // Never shorter than the stale window: a grace inside it would fail a run on
  // the first look, before the backend had any chance to answer twice.
  const unknownGraceMinutes = Math.max(
    staleMinutes,
    positiveInt(env.GRID_RUN_RECONCILE_UNKNOWN_GRACE_MINUTES, DEFAULT_UNKNOWN_GRACE_MINUTES),
  )
  return { staleMinutes, unknownGraceMinutes, batch: RECONCILE_BATCH }
}

/** What asking the job store about one run produced. */
export type JobProbe =
  | { kind: 'no-job' }
  | { kind: 'not-found' }
  | { kind: 'unreachable' }
  | { kind: 'found'; outcome: BackendJobOutcome }

/** What to do about one run. */
export type ReconcileDecision =
  | { kind: 'wait'; why: 'still-running' | 'unreachable' | 'within-grace' }
  | {
      kind: 'close'
      outcome: TaskOutcome
      /** What the run's message should say, when it still says nothing. */
      message: { content: string; metadata: Record<string, unknown> } | null
    }

type RunForDecision = Pick<TaskRun, 'createdAt' | 'startedAt'>

function lostRun(reason: string): ReconcileDecision {
  return { kind: 'close', outcome: { status: 'failure', error: reason }, message: null }
}

/**
 * The whole decision, pure: the run's age, the probe's answer, the clock.
 *
 * Kept apart from the I/O so the table of cases is testable line by line, and
 * so the sweep below is nothing but the moves this answers with.
 */
export function decideReconciliation(
  run: RunForDecision,
  probe: JobProbe,
  now: Date,
  config: Pick<ReconcileConfig, 'unknownGraceMinutes'>,
): ReconcileDecision {
  if (probe.kind === 'unreachable') return { kind: 'wait', why: 'unreachable' }

  if (probe.kind === 'found') {
    const { outcome } = probe
    if (outcome.status === 'submitted' || outcome.status === 'running') {
      return { kind: 'wait', why: 'still-running' }
    }
    const taskOutcome: TaskOutcome = {
      status: outcome.status,
      error: outcome.error,
      report: outcome.report,
      cards: outcome.cards,
    }
    return { kind: 'close', outcome: taskOutcome, message: outcome.message }
  }

  const since = run.startedAt ?? run.createdAt
  const ageMinutes = (now.getTime() - since.getTime()) / 60_000
  if (ageMinutes < config.unknownGraceMinutes) return { kind: 'wait', why: 'within-grace' }
  return lostRun(probe.kind === 'no-job' ? NEVER_SUBMITTED_REASON : LOST_JOB_REASON)
}

async function probeJob(run: TaskRun): Promise<JobProbe> {
  if (!run.backendJobId) return { kind: 'no-job' }
  try {
    const outcome = await fetchBackendJobOutcome(run.backendJobId, run.organizationId)
    return outcome ? { kind: 'found', outcome } : { kind: 'not-found' }
  } catch (error) {
    console.warn('[runs] reconcile: could not ask the job store about run', run.id, error)
    return { kind: 'unreachable' }
  }
}

/** What happened to one claimed run. */
export type ReconcileVerdict = 'closed' | 'already-closed' | 'waiting' | 'failed'

/**
 * Fill the run's message with the report the worker's write never delivered,
 * only while it is still empty, so a second pass is a no-op.
 */
async function settleRunMessage(run: TaskRun, decision: Extract<ReconcileDecision, { kind: 'close' }>) {
  if (!decision.message || !run.backendJobId) return
  const current = await readRunMessage(run)
  if (!current || current.content.trim() !== '') return
  await writeRunReport(run.backendJobId, decision.message)
}

/**
 * Reconcile one claimed run, inside its own organization. Throws only for a
 * failure worth retrying, and then nothing past the failing step was written.
 */
export async function reconcileRun(
  run: TaskRun,
  config: Pick<ReconcileConfig, 'unknownGraceMinutes'>,
  now: Date = new Date(),
): Promise<ReconcileVerdict> {
  const decision = decideReconciliation(run, await probeJob(run), now, config)
  if (decision.kind === 'wait') return 'waiting'

  await settleRunMessage(run, decision)
  // The sweep's counts are the log line: the scheduler prints them whenever a
  // sweep closed or failed something.
  const recorded = await recordRunOutcome(run, decision.outcome, { onlyIfActive: true })
  return recorded.closed ? 'closed' : 'already-closed'
}

export interface ReconcileSweepResult {
  checked: number
  closed: number
  alreadyClosed: number
  waiting: number
  /** Closed runs whose block still read as live, and now reads as ended. */
  healed: number
  failed: number
}

/**
 * The ending a closed row records, as its block should show it. The row is the
 * authority here: it was closed by the outcome recorder, the reaper's report or
 * the reconciler, each with the job store's verdict.
 */
export function endingOfClosedRun(run: Pick<TaskRun, 'status' | 'error'>): RunEnding {
  if (run.status === 'succeeded') return { status: 'success' }
  if (run.status === 'interrupted') return { status: 'interrupted' }
  return { status: 'failure', error: run.error }
}

/**
 * The heal: settle the block of every closed run nothing has looked at since it
 * ended (`claimClosedRunsToHeal`). A ledger the worker or the recorder already
 * settled is left alone under its row lock, so for nearly every run this is one
 * locked read. What it does write is a run whose row closed by a path that
 * never reached its block — every such run before `recordRunOutcome` settled
 * the block itself, and any later path that forgets to.
 */
async function healClosedRuns(batch: number, now: Date): Promise<{ healed: number; failed: number }> {
  const claimed = await withPlatformAccess(
    'run reconciler: finding the closed runs of every organization not looked at since they ended',
    () => taskRepository.claimClosedRunsToHeal(batch),
  )
  const counts = { healed: 0, failed: 0 }
  for (let i = 0; i < claimed.length; i += RECONCILE_CONCURRENCY) {
    const slice = claimed.slice(i, i + RECONCILE_CONCURRENCY)
    const results = await Promise.all(
      slice.map(async (run) => {
        try {
          return await withTenant({ organizationId: run.organizationId }, () =>
            // Dated to when the row ended, not to the heal: a run reaped days
            // ago must not read as having ended today.
            settleRunLedger(run, endingOfClosedRun(run), run.finishedAt ?? now),
          )
        } catch (error) {
          // The stamp is already set, so this run is not retried on its own;
          // the error is the log line that says which one to look at.
          console.error('[runs] reconcile: the block of closed run', run.id, 'could not be settled', error)
          return 'failed' as const
        }
      }),
    )
    for (const result of results) {
      if (result === 'failed') counts.failed += 1
      else if (result) counts.healed += 1
    }
  }
  return counts
}

/**
 * One sweep: claim the due runs across every organization, then reconcile each
 * inside its own. Never throws for one run's failure; the counts say what
 * happened and a failed run is due again after the next window.
 */
export async function reconcileStaleRuns(
  now: Date = new Date(),
  config: ReconcileConfig = readReconcileConfig(),
): Promise<ReconcileSweepResult> {
  const checkedBefore = new Date(now.getTime() - config.staleMinutes * 60_000)
  const claimed = await withPlatformAccess(
    'run reconciler: finding the still-active runs of every organization that nothing has checked recently',
    () => taskRepository.claimRunsToReconcile(checkedBefore, config.batch),
  )

  const result: ReconcileSweepResult = {
    checked: claimed.length,
    closed: 0,
    alreadyClosed: 0,
    waiting: 0,
    healed: 0,
    failed: 0,
  }
  for (let i = 0; i < claimed.length; i += RECONCILE_CONCURRENCY) {
    const slice = claimed.slice(i, i + RECONCILE_CONCURRENCY)
    const verdicts = await Promise.all(
      slice.map(async (run): Promise<ReconcileVerdict> => {
        try {
          return await withTenant({ organizationId: run.organizationId }, () => reconcileRun(run, config, now))
        } catch (error) {
          console.error('[runs] reconcile: run', run.id, 'could not be reconciled', error)
          return 'failed'
        }
      }),
    )
    for (const verdict of verdicts) {
      if (verdict === 'closed') result.closed += 1
      else if (verdict === 'already-closed') result.alreadyClosed += 1
      else if (verdict === 'waiting') result.waiting += 1
      else result.failed += 1
    }
  }

  const healed = await healClosedRuns(HEAL_BATCH, now)
  result.healed = healed.healed
  result.failed += healed.failed
  return result
}
