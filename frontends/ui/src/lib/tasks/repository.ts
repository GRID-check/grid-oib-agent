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
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  taskDefinitions,
  taskRuns,
  tasks,
  type NewTask,
  type NewTaskDefinition,
  type NewTaskRun,
  type Task,
  type TaskDefinition,
  type TaskRun,
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
