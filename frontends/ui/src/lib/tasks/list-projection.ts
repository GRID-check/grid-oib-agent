/**
 * The wire projection of a task listing — the one place a `tasks` row becomes
 * JSON.
 *
 * Stated rather than implied, for the reason `documents/list-projection.ts`
 * gives: `JSON.stringify` on a drizzle row hands `createdAt` over as an ISO
 * string, and the RSC boundary hands the same field over as a `Date`. One of
 * the two readers then gets `toISOString is not a function`.
 *
 * It also DROPS things, and the drops are the point. `plan.prompt` carries a
 * skill's whole body — the instruction the organization owns, not something a
 * project's task list needs — and `filingDetail` is marked operator-facing in
 * the schema's own comment. A projection that spread the row would ship both to
 * every viewer of a project.
 *
 * ## The run summary
 *
 * A row also carries what its run did, read off the run message's ledger
 * (ADR-0062) — the compact run line the card shows under its title, which is
 * the block's header in the thread reduced to its glyph, its word and its
 * tallies, so the index and the thread cannot disagree about one run. It is a
 * SECOND query, not a join: `task_runs` and `messages` are joined by an id the
 * run row holds, one page of runs is at most `RUN_LIST_LIMIT` rows, and every
 * row on it that has a run message is looked up — a finished row shows its
 * line too, because „Fertig · 3 Runden · 9 Dokumente" is how much work stands
 * behind the result. Three facts cross the wire per row, never the ledger: a
 * run that has read fifty documents has a ledger the size of a report, and a
 * list of a hundred rows must not carry a hundred of them.
 */

import 'server-only'
import type { TaskRunSummary, TaskWireRow } from '@/features/tasks/lib/task-view'
import { listRunLedgersByMessageIds } from '@/lib/conversations/repository'
import type { TaskRun } from '@/lib/db/schema'
import { sanitizeRunLedger } from '@/lib/runs/run-ledger'
import type { RunLedger } from '@/lib/runs/run-ledger-types'
import { runDisplayStatus, runTallies } from '@/lib/runs/run-vocabulary'
import { RUN_LIST_LIMIT } from './repository'

export function toTaskWireRow(
  task: TaskRun,
  requesterName: string | null,
  runSummary: TaskRunSummary | null = null,
): TaskWireRow {
  return {
    id: task.id,
    kind: task.kind,
    title: task.title,
    // The requester's own sentence, when there was one. A job-fired run has the
    // job's prompt and no goal, and the title is the job's name.
    goal: task.plan.goal?.trim() || null,
    // The plan the run waits on, frozen at commission (ADR-0065): what the
    // card says the run is about, beside the goal.
    research: task.plan.research ?? null,
    status: task.status,
    review: task.review ?? null,
    reviewReason: task.reviewReason,
    filedDocumentId: task.filedDocumentId,
    conversationId: task.conversationId,
    // Where in that conversation the run is. Sent so the Tasks list can land the
    // reader ON the run rather than at the bottom of a thread that may hold a
    // year of them (ADR-0062).
    runMessageId: task.runMessageId,
    // The handle on the run's own report. Added so a finished task that filed
    // no document and minted no conversation still has somewhere to go — the
    // dead end the Tasks list used to leave. Opaque, and already public in the
    // URLs the run history builds, so it widens nothing this tier was keeping.
    backendJobId: task.backendJobId,
    // How it started, so the drawer offers „als Zeitplan speichern" only on
    // work that is not already recurring. The trigger rather than the
    // definition id: since 0086 a delegated task has a definition too.
    trigger: task.trigger,
    requesterUserId: task.requesterUserId,
    // The DISPLAY NAME, resolved server-side through the directory every
    // collaboration surface in this tier resolves through. Not left to the
    // browser: the roster endpoint is `project:members:manage`, so a viewer
    // reading their own project's task list would have got a 403 for a byline.
    // `null` for an id the directory cannot resolve — a deactivated member —
    // rather than a raw `user_01…` at an architect.
    requesterName,
    createdAt: task.createdAt.toISOString(),
    finishedAt: task.finishedAt?.toISOString() ?? null,
    error: task.error,
    runSummary,
  }
}

/** The three facts the card line needs, derived the way the block derives them. */
export function runSummaryOf(ledger: RunLedger | null): TaskRunSummary | null {
  if (!ledger) return null
  const { rounds, docs } = runTallies(ledger)
  return { status: runDisplayStatus(ledger), rounds, docs }
}

/**
 * The run summary of every run on the page that has a run message, keyed by
 * run id. One query, bounded to the page; a row whose ledger is missing or
 * unreadable simply has no entry.
 */
export async function loadRunSummaries(runs: readonly TaskRun[]): Promise<Map<string, TaskRunSummary>> {
  const messageIdByRun = new Map<string, string>()
  for (const run of runs.slice(0, RUN_LIST_LIMIT)) {
    if (run.runMessageId) messageIdByRun.set(run.id, run.runMessageId)
  }
  if (messageIdByRun.size === 0) return new Map()

  const ledgers = await listRunLedgersByMessageIds([...messageIdByRun.values()])
  const summaries = new Map<string, TaskRunSummary>()
  for (const [runId, messageId] of messageIdByRun) {
    // Re-sanitised on read like every other reader of this column: the row
    // may have been written by another build.
    const summary = runSummaryOf(sanitizeRunLedger(ledgers.get(messageId)))
    if (summary) summaries.set(runId, summary)
  }
  return summaries
}
