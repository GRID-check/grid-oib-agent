/**
 * Tasks repository — SQL only (ADR-0017). Every list is bounded.
 */

import 'server-only'
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { tasks, type NewTask, type Task } from '@/lib/db/schema'

/** Newest-first page size for a project's task list. */
export const TASK_LIST_LIMIT = 100

/** How many earlier rejections a new run of the same job is told about. */
export const REJECTED_REVIEWS_CARRIED = 3

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
