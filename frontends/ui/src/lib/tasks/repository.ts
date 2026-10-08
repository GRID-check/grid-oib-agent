/**
 * Tasks repository — SQL only (ADR-0017). Every list is bounded.
 *
 * Two halves. The COLLAPSED MODEL (`task_definitions` + `task_runs`, migration
 * 0086) is the one the services read and write; the legacy half below (the
 * `tasks` and `job_runs` statements) survives only until migration 0087 drops
 * the old tables, and exists so the slice-01 characterization specs keep
 * pinning the behaviour that was moved rather than merely deleted.
 */

import 'server-only'
import { and, desc, eq, inArray, isNotNull, lt, notInArray, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  documents,
  taskDefinitions,
  taskRuns,
  tasks,
  type NewTask,
  type NewTaskDefinition,
  type NewTaskRun,
  type Task,
  type TaskDefinition,
  type TaskRun,
  type TaskRunStatus,
} from '@/lib/db/schema'

/** Newest-first page size for a project's task list. */
export const TASK_LIST_LIMIT = 100

/** How many earlier rejections a new run of the same job is told about. */
export const REJECTED_REVIEWS_CARRIED = 3

// ---------------------------------------------------------------------------
// Legacy tables (jobs/tasks era) — kept until 0087 drops them, so the slice-01
// characterization specs pin what the collapse moved. Nothing new calls these.
// ---------------------------------------------------------------------------

export async function insertTask(values: NewTask): Promise<Task> {
  const db = getDb()
  const [row] = await db.insert(tasks).values(values).returning()
  return row
}

export async function findTaskInProject(
  taskId: string,
  projectId: string,
  organizationId: string,
): Promise<Task | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId), eq(tasks.organizationId, organizationId)))
    .limit(1)
  return row ?? null
}

export async function listTasksInProject(projectId: string, organizationId: string): Promise<Task[]> {
  const db = getDb()
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.organizationId, organizationId)))
    .orderBy(desc(tasks.createdAt))
    .limit(TASK_LIST_LIMIT)
}

/**
 * The task a backend job id belongs to. NOT tenant-filtered, for the reason
 * `findJobRunByBackendJobId` gives: the worker that reports holds the backend
 * id and nothing else, so the caller runs this under platform access and
 * re-enters the task's own tenant for everything after.
 */
export async function findTaskByBackendJobId(backendJobId: string): Promise<Task | null> {
  const db = getDb()
  const [row] = await db.select().from(tasks).where(eq(tasks.backendJobId, backendJobId)).limit(1)
  return row ?? null
}

export async function updateTask(
  taskId: string,
  organizationId: string,
  patch: Partial<Omit<NewTask, 'id' | 'organizationId' | 'projectId'>>,
): Promise<Task | null> {
  const db = getDb()
  const [row] = await db
    .update(tasks)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.organizationId, organizationId)))
    .returning()
  return row ?? null
}

/**
 * The most recent rejected reviews of earlier tasks of one job, newest first —
 * what the next run is told. Only rejections with words: a rejection without
 * a reason is a decision the next run cannot act on.
 */
export async function listRejectedReviewsForJob(
  jobId: string,
  organizationId: string,
): Promise<Array<Pick<Task, 'id' | 'reviewReason' | 'reviewedAt' | 'reviewedBy'>>> {
  const db = getDb()
  return db
    .select({ id: tasks.id, reviewReason: tasks.reviewReason, reviewedAt: tasks.reviewedAt, reviewedBy: tasks.reviewedBy })
    .from(tasks)
    .where(
      and(
        eq(tasks.jobId, jobId),
        eq(tasks.organizationId, organizationId),
        eq(tasks.review, 'rejected'),
        isNotNull(tasks.reviewReason),
      ),
    )
    .orderBy(desc(tasks.reviewedAt))
    .limit(REJECTED_REVIEWS_CARRIED)
}

// ---------------------------------------------------------------------------
// The collapsed model: task_definitions + task_runs (migration 0086).
// ---------------------------------------------------------------------------

/** Newest-first page size for a project's definition list. */
export const DEFINITION_LIST_LIMIT = 100
/** Newest-first page size for a project's run list. */
export const RUN_LIST_LIMIT = 100
/** Default page size for one definition's run history. */
export const RUNS_DEFAULT_LIMIT = 50
/** Hard cap for run-history pages. */
export const RUNS_MAX_LIMIT = 200

export async function insertDefinition(values: NewTaskDefinition): Promise<TaskDefinition> {
  const db = getDb()
  const [row] = await db.insert(taskDefinitions).values(values).returning()
  return row
}

/**
 * Write a one-off definition and its first run as ONE unit. A definition
 * committed without its attempt is an enabled row nothing will ever fire, and
 * the caller's retry would insert a second one; the transaction makes the pair
 * all-or-nothing. The run's `definitionId` comes from the inserted row, never
 * from the caller.
 */
export async function insertDefinitionWithRun(
  definition: NewTaskDefinition,
  run: Omit<NewTaskRun, 'definitionId'>,
): Promise<{ definition: TaskDefinition; run: TaskRun }> {
  const db = getDb()
  return db.transaction(async (tx) => {
    const [insertedDefinition] = await tx.insert(taskDefinitions).values(definition).returning()
    const [insertedRun] = await tx
      .insert(taskRuns)
      .values({ ...run, definitionId: insertedDefinition.id })
      .returning()
    return { definition: insertedDefinition, run: insertedRun }
  })
}

export async function listDefinitionsInProject(
  projectId: string,
  organizationId: string,
  limit = DEFINITION_LIST_LIMIT,
): Promise<TaskDefinition[]> {
  const db = getDb()
  return db
    .select()
    .from(taskDefinitions)
    .where(
      and(
        eq(taskDefinitions.projectId, projectId),
        eq(taskDefinitions.organizationId, organizationId),
      ),
    )
    .orderBy(desc(taskDefinitions.createdAt))
    .limit(limit)
}

export async function findDefinition(
  definitionId: string,
  organizationId: string,
): Promise<TaskDefinition | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(taskDefinitions)
    .where(
      and(
        eq(taskDefinitions.id, definitionId),
        eq(taskDefinitions.organizationId, organizationId),
      ),
    )
    .limit(1)
  return row ?? null
}

/**
 * Load a definition by id WITHOUT an org filter — for the internal fire path,
 * which has no session. The caller uses the row's own `organizationId` for all
 * subsequent tenant-scoped work.
 */
export async function findDefinitionById(definitionId: string): Promise<TaskDefinition | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(taskDefinitions)
    .where(eq(taskDefinitions.id, definitionId))
    .limit(1)
  return row ?? null
}

/**
 * The columns a service may update on a definition. `plan` moves as a whole
 * because the prompt and its skill snapshot are frozen together.
 */
export type DefinitionUpdate = Partial<
  Pick<
    TaskDefinition,
    | 'title'
    | 'plan'
    | 'trigger'
    | 'enabled'
    | 'scheduleCron'
    | 'scheduleTimezone'
    | 'nextRunAt'
    | 'dueAt'
    | 'updatedAt'
  >
>

export async function updateDefinition(
  definitionId: string,
  organizationId: string,
  patch: DefinitionUpdate,
): Promise<TaskDefinition | null> {
  const db = getDb()
  const [row] = await db
    .update(taskDefinitions)
    .set(patch)
    .where(
      and(
        eq(taskDefinitions.id, definitionId),
        eq(taskDefinitions.organizationId, organizationId),
      ),
    )
    .returning()
  return row ?? null
}

export async function deleteDefinition(
  definitionId: string,
  organizationId: string,
): Promise<boolean> {
  const db = getDb()
  const deleted = await db
    .delete(taskDefinitions)
    .where(
      and(
        eq(taskDefinitions.id, definitionId),
        eq(taskDefinitions.organizationId, organizationId),
      ),
    )
    .returning({ id: taskDefinitions.id })
  return deleted.length > 0
}

/** Advance `last_run_at` after a fire attempt (running/skipped/error). */
export async function touchDefinitionLastRun(definitionId: string, at: Date): Promise<void> {
  const db = getDb()
  await db
    .update(taskDefinitions)
    .set({ lastRunAt: at })
    .where(eq(taskDefinitions.id, definitionId))
}

/** Where a revision task's document is now, by document id. */
export interface SubjectDocumentPlace {
  projectId: string | null
  folderId: string | null
}

/** The most subjects one read resolves: a run list is `RUN_LIST_LIMIT` long. */
const SUBJECT_LOOKUP_LIMIT = 500

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The current project and folder of each of these documents, for the ones that
 * still exist (`subject-access.ts`). Ids that are not uuids are left out
 * rather than cast: a plan is jsonb, and a malformed id must not fail the list.
 */
export async function findSubjectDocumentPlaces(
  organizationId: string,
  documentIds: readonly string[],
): Promise<Map<string, SubjectDocumentPlace>> {
  const uuids = [...new Set(documentIds)].filter((id) => UUID_PATTERN.test(id)).slice(0, SUBJECT_LOOKUP_LIMIT)
  if (uuids.length === 0) return new Map()
  const db = getDb()
  const rows = await db
    .select({ id: documents.id, projectId: documents.projectId, folderId: documents.folderId })
    .from(documents)
    .where(and(eq(documents.organizationId, organizationId), inArray(documents.id, uuids)))
    .limit(SUBJECT_LOOKUP_LIMIT)
  return new Map(rows.map((row) => [String(row.id), { projectId: row.projectId ?? null, folderId: row.folderId ?? null }]))
}

export async function insertRun(values: NewTaskRun): Promise<TaskRun> {
  const db = getDb()
  const [row] = await db.insert(taskRuns).values(values).returning()
  return row
}

export async function findRunInProject(
  runId: string,
  projectId: string,
  organizationId: string,
): Promise<TaskRun | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.id, runId),
        eq(taskRuns.projectId, projectId),
        eq(taskRuns.organizationId, organizationId),
      ),
    )
    .limit(1)
  return row ?? null
}

export async function listRunsInProject(
  projectId: string,
  organizationId: string,
  limit = RUN_LIST_LIMIT,
): Promise<TaskRun[]> {
  const db = getDb()
  return db
    .select()
    .from(taskRuns)
    .where(
      and(eq(taskRuns.projectId, projectId), eq(taskRuns.organizationId, organizationId)),
    )
    .orderBy(desc(taskRuns.createdAt))
    .limit(limit)
}

/**
 * The run a backend job id belongs to. NOT tenant-filtered, for the reason
 * `findTaskByBackendJobId` gives: the worker that reports holds the backend id
 * and nothing else, so the caller runs this under platform access and
 * re-enters the run's own tenant for everything after.
 */
/**
 * One run by its own id, with no tenant filter — the same bargain
 * `findRunByBackendJobId` makes, for the same caller shape: the worker flushing
 * a run ledger holds the run id and nothing else, so the caller runs this under
 * platform access and re-enters the run's own tenant for everything after
 * (`lib/runs/service.ts`).
 */
export async function findRunById(runId: string): Promise<TaskRun | null> {
  const db = getDb()
  const [row] = await db.select().from(taskRuns).where(eq(taskRuns.id, runId)).limit(1)
  return row ?? null
}

export async function findRunByBackendJobId(backendJobId: string): Promise<TaskRun | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(taskRuns)
    .where(eq(taskRuns.backendJobId, backendJobId))
    .limit(1)
  return row ?? null
}

export async function updateRun(
  runId: string,
  organizationId: string,
  patch: Partial<Omit<NewTaskRun, 'id' | 'organizationId' | 'projectId'>>,
): Promise<TaskRun | null> {
  const db = getDb()
  const [row] = await db
    .update(taskRuns)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(taskRuns.id, runId), eq(taskRuns.organizationId, organizationId)))
    .returning()
  return row ?? null
}

/**
 * Move a run from `queued` to `running` once a worker has started it, and stamp
 * when. Conditional on `queued`: a run that already moved (a second flush) or
 * ended is left alone, so the first flush wins and a late one cannot reopen it.
 */
export async function markRunStarted(
  runId: string,
  organizationId: string,
  startedAt: Date,
): Promise<boolean> {
  const db = getDb()
  const rows = await db
    .update(taskRuns)
    .set({ status: 'running', startedAt, updatedAt: new Date() })
    .where(
      and(
        eq(taskRuns.id, runId),
        eq(taskRuns.organizationId, organizationId),
        eq(taskRuns.status, 'queued'),
      ),
    )
    .returning({ id: taskRuns.id })
  return rows.length > 0
}

/** The statuses a run is still in the worker's hands in; see `isActiveTaskRunStatus`. */
const ACTIVE_RUN_STATUSES = ['queued', 'running'] as const satisfies readonly TaskRunStatus[]

/**
 * Close a run only while it is still active, and answer whether this call did.
 *
 * The conditional twin of {@link updateRun}, for the run reconciler: the worker's
 * own report and the reconciler can close one run at the same moment, and the
 * `status IN ('queued','running')` guard lets exactly one of them go on to file
 * the report and tell the requester. Null means the row had already ended (or
 * is not this organization's), which the caller reads as „nothing to do".
 */
export async function closeActiveRun(
  runId: string,
  organizationId: string,
  patch: Pick<NewTaskRun, 'status' | 'error' | 'finishedAt'>,
): Promise<TaskRun | null> {
  const db = getDb()
  const [row] = await db
    .update(taskRuns)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(taskRuns.id, runId),
        eq(taskRuns.organizationId, organizationId),
        inArray(taskRuns.status, [...ACTIVE_RUN_STATUSES]),
      ),
    )
    .returning()
  return row ?? null
}

/**
 * Claim up to `limit` active runs nobody has checked since `checkedBefore`, and
 * stamp them checked — in ONE statement, across every organization.
 *
 * The subquery's `FOR UPDATE SKIP LOCKED` is what makes this safe with several
 * BFF replicas: a row another sweep is claiming right now is skipped, not waited
 * for, and once this statement commits the stamp moves the row out of the
 * window, so the next sweep leaves it alone until the window has passed again.
 * A run that is genuinely still working is therefore asked about once per
 * window, never once per tick.
 *
 * The age a row is judged by is its last check, else when it started, else when
 * it was created — the same expression `idx_task_runs_reconcile_due` is built
 * on (migration 0096), so the scan stays on that partial index.
 *
 * NOT tenant-filtered: the caller runs this under platform access and does each
 * run's work inside that run's own organization.
 */
export async function claimRunsToReconcile(
  checkedBefore: Date,
  limit: number,
): Promise<TaskRun[]> {
  const db = getDb()
  const age = sql`COALESCE(${taskRuns.reconcileCheckedAt}, ${taskRuns.startedAt}, ${taskRuns.createdAt})`
  const due = db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    // An ISO string, not the Date: compared against an `sql` expression rather
    // than a column, the parameter reaches postgres-js without drizzle's column
    // encoder, and postgres-js refuses a bare Date there (ERR_INVALID_ARG_TYPE).
    .where(and(inArray(taskRuns.status, [...ACTIVE_RUN_STATUSES]), lt(age, checkedBefore.toISOString())))
    .orderBy(age)
    .limit(limit)
    .for('update', { skipLocked: true })
  return db
    .update(taskRuns)
    .set({ reconcileCheckedAt: sql`now()` })
    .where(inArray(taskRuns.id, due))
    .returning()
}

/**
 * Runs whose report has been `queued` for filing since before `before`, and
 * whose filing job is NOT alive, oldest first (`ix_task_runs_filing_queued`,
 * migration 0105).
 *
 * The filing sweep's read, and a row is only worth reading when something is
 * left to do for it: a run whose job is still waiting or running is not listed,
 * however old, exactly as the document sweep leaves out a document with a live
 * job (`listStuckProcessingDocuments`). Without that the batch filled with the
 * oldest filings of a backlog, all of them alive, and a run whose job had died
 * behind them was never reached. A job that is dead or gone (a run's report is
 * keyed by its backend job id, which the job's payload carries as `runId`) is
 * what is listed. NOT tenant-filtered: the caller runs this under platform
 * access and judges each run inside its own organization.
 */
export async function listRunsWithStaleQueuedFiling(before: Date, limit: number): Promise<TaskRun[]> {
  const db = getDb()
  const aliveJob = sql`EXISTS (
    SELECT 1 FROM bff_job_queue j
    WHERE j.kind = 'file_research_report'
      AND j.lane = ${taskRuns.organizationId}
      AND j.payload ->> 'runId' = ${taskRuns.backendJobId}
      AND j.status <> 'dead'
  )`
  return db
    .select()
    .from(taskRuns)
    // An ISO string for the same reason as `claimRunsToReconcile`.
    .where(
      and(
        eq(taskRuns.filingStatus, 'queued'),
        lt(sql`COALESCE(${taskRuns.finishedAt}, ${taskRuns.updatedAt})`, before.toISOString()),
        sql`NOT ${aliveJob}`,
      ),
    )
    .orderBy(sql`COALESCE(${taskRuns.finishedAt}, ${taskRuns.updatedAt})`)
    .limit(limit)
}

/**
 * Settle a filing that is still `queued`: write its verdict only while the row
 * says so, and say whether it did.
 *
 * What the filing sweep ends a row with. The job that files the report writes
 * its own verdict (`filed`, `refused`, `failed`) as soon as it has one, and the
 * sweep judged the row from a read made earlier: an unconditional write would
 * lay the sweep's older opinion over the job's, turning a `filed` row into a
 * `failed` one (or the reverse). A row that has left `queued` keeps what it
 * says.
 */
export async function settleQueuedFiling(
  runId: string,
  organizationId: string,
  patch: Pick<NewTaskRun, 'filingStatus' | 'filingDetail' | 'filedDocumentId'>,
): Promise<TaskRun | null> {
  const [row] = await getDb()
    .update(taskRuns)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(eq(taskRuns.id, runId), eq(taskRuns.organizationId, organizationId), eq(taskRuns.filingStatus, 'queued')),
    )
    .returning()
  return row ?? null
}

/**
 * Claim up to `limit` CLOSED runs that nothing has looked at since they ended,
 * and stamp them — the ledger heal's half of the reconciler sweep.
 *
 * A closed run whose block still reads „läuft" is one whose row was closed by
 * a path that never settled its ledger (before `recordRunOutcome` did, or any
 * path that closes a row some other way). This hands each closed run with a
 * block to the heal exactly once after it ended: the stamp moves it past its
 * own `finished_at`, out of `idx_task_runs_ledger_heal_due` (migration 0099),
 * whose predicate this WHERE repeats so the scan stays on it.
 *
 * NOT tenant-filtered, like {@link claimRunsToReconcile}: the caller runs this
 * under platform access and heals each run inside its own organization.
 */
export async function claimClosedRunsToHeal(limit: number): Promise<TaskRun[]> {
  const db = getDb()
  const ended = sql`COALESCE(${taskRuns.finishedAt}, ${taskRuns.updatedAt})`
  const due = db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .where(
      and(
        notInArray(taskRuns.status, [...ACTIVE_RUN_STATUSES]),
        isNotNull(taskRuns.runMessageId),
        sql`(${taskRuns.reconcileCheckedAt} IS NULL OR ${taskRuns.reconcileCheckedAt} < ${ended})`,
      ),
    )
    .orderBy(ended)
    .limit(limit)
    .for('update', { skipLocked: true })
  return db
    .update(taskRuns)
    .set({ reconcileCheckedAt: sql`now()` })
    .where(inArray(taskRuns.id, due))
    .returning()
}

/**
 * Hand a claimed closed run back to the heal after its settlement failed.
 *
 * The claim's stamp already sits past the run's `finished_at`, and a closed
 * run's `finished_at` never moves again, so a stamp left in place takes the run
 * out of the heal for good: its block keeps reading „läuft". Clearing it makes
 * the run due on the next sweep. Tenant-scoped: the caller holds the run's own
 * organization.
 */
export async function releaseHealClaim(runId: string): Promise<void> {
  await getDb().update(taskRuns).set({ reconcileCheckedAt: null }).where(eq(taskRuns.id, runId))
}

export async function listRunsForDefinition(
  definitionId: string,
  organizationId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<TaskRun[]> {
  const db = getDb()
  const limit = Math.min(options.limit ?? RUNS_DEFAULT_LIMIT, RUNS_MAX_LIMIT)
  const offset = options.offset ?? 0
  return db
    .select()
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.definitionId, definitionId),
        eq(taskRuns.organizationId, organizationId),
      ),
    )
    .orderBy(desc(taskRuns.createdAt))
    .limit(limit)
    .offset(offset)
}

/**
 * The most recent rejected reviews of earlier runs of one definition,
 * newest first — what the next run is told. Only rejections with words.
 */
export async function listRejectedReviewsForDefinition(
  definitionId: string,
  organizationId: string,
): Promise<Array<Pick<TaskRun, 'id' | 'reviewReason' | 'reviewedAt' | 'reviewedBy'>>> {
  const db = getDb()
  return db
    .select({
      id: taskRuns.id,
      reviewReason: taskRuns.reviewReason,
      reviewedAt: taskRuns.reviewedAt,
      reviewedBy: taskRuns.reviewedBy,
    })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.definitionId, definitionId),
        eq(taskRuns.organizationId, organizationId),
        eq(taskRuns.review, 'rejected'),
        isNotNull(taskRuns.reviewReason),
      ),
    )
    .orderBy(desc(taskRuns.reviewedAt))
    .limit(REJECTED_REVIEWS_CARRIED)
}
