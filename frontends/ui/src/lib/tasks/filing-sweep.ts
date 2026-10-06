/**
 * The sweep for report filings left `queued` (ADR-0078).
 *
 * A finished deep-research run's report is rendered and filed by a
 * `file_research_report` job, and the run's row says `queued` until the job has
 * an answer. The job writes that answer itself, on its last attempt at the
 * latest, so a row still `queued` a quarter of an hour later is one of three
 * things, and each gets the truth:
 *
 *   - its job is still waiting or running: left alone, however long it takes;
 *   - its job is dead (every attempt failed, or its worker vanished on the last
 *     one): the row says `failed` with the queue's own reason;
 *   - it has no job at all: if the report is filed after all (a reader's job
 *     did it) the row says `filed`, otherwise `failed`. A row must not say
 *     `queued` for work nothing is doing.
 *
 * Driven by the same clock as the document sweep
 * (`/api/internal/maintenance/reconcile-background-work`).
 */

import 'server-only'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { findFiledResearchReport } from '@/lib/documents/research-report'
import { findDeadJob, findOpenJobId } from '@/lib/jobs-queue/repository'
import type { TaskRun } from '@/lib/db/schema'
import * as repository from './repository'

/** A filing must have been queued this long before the sweep judges it. */
export const FILING_STUCK_AFTER_MINUTES = 15

/** Runs one sweep judges. Bounded: it is housekeeping on a timer. */
export const FILING_BATCH = 50

export interface StuckFilingSweepResult {
  checked: number
  /** Rows ended as `filed` because the report turned out to be there. */
  filed: number
  /** Rows ended as `failed`: a dead job, or no job and no report. */
  failed: number
  /** Rows whose job is still alive. */
  waiting: number
  errors: number
}

type Verdict = 'filed' | 'failed' | 'waiting'

async function judge(run: TaskRun): Promise<Verdict> {
  const runId = run.backendJobId
  const query = { kind: 'file_research_report', organizationId: run.organizationId, matching: { runId: runId ?? '' } }
  if (runId && (await findOpenJobId(query))) return 'waiting'

  const filed = runId
    ? await findFiledResearchReport({ organizationId: run.organizationId, projectId: run.projectId, runId })
    : null
  if (filed) {
    await repository.updateRun(run.id, run.organizationId, {
      filingStatus: 'filed',
      filingDetail: null,
      filedDocumentId: filed.documentId,
    })
    return 'filed'
  }

  const dead = runId ? await findDeadJob(query) : null
  const detail = dead
    ? `the filing job failed every attempt: ${dead.lastError ?? 'no reason kept'}`
    : 'the filing job is gone and the report was never filed'
  await repository.updateRun(run.id, run.organizationId, {
    filingStatus: 'failed',
    filingDetail: detail.slice(0, 500),
  })
  return 'failed'
}

/**
 * One sweep: find the stale `queued` filings across every organization, then
 * judge each inside its own. Never throws for one run's failure.
 */
export async function recoverStuckFilings(
  now: Date = new Date(),
  options: { staleMinutes?: number; batch?: number } = {}
): Promise<StuckFilingSweepResult> {
  const before = new Date(now.getTime() - (options.staleMinutes ?? FILING_STUCK_AFTER_MINUTES) * 60_000)
  const runs = await withPlatformAccess('filing sweep: finding report filings still queued after a quarter hour', () =>
    repository.listRunsWithStaleQueuedFiling(before, options.batch ?? FILING_BATCH)
  )

  const result: StuckFilingSweepResult = { checked: runs.length, filed: 0, failed: 0, waiting: 0, errors: 0 }
  for (const run of runs) {
    try {
      const verdict = await withTenant({ organizationId: run.organizationId }, () => judge(run))
      result[verdict] += 1
    } catch (error) {
      console.error('[runs] could not judge the queued filing of run', run.id, error)
      result.errors += 1
    }
  }
  return result
}
