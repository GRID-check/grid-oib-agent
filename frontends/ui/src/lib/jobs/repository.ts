/**
 * Jobs repository — the only module that queries the `jobs` and `job_runs`
 * tables (ADR-0017). The `skills` table has its own repository next door in
 * `@/lib/skills/repository`: a job ATTACHES a skill, it does not own one.
 *
 * Repository rules: drizzle only; no HTTP, no auth, no WorkOS. Every query that
 * serves tenant data takes `organizationId` and scopes the WHERE clause with it
 * — tenancy is enforced in SQL. List queries are always bounded.
 */

import 'server-only'
import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  jobRuns,
  jobs,
  type Job,
  type JobRun,
  type NewJob,
  type NewJobRun,
} from '@/lib/db/schema'

/** Hard cap for a project's job list. */
export const JOBS_LIST_LIMIT = 100
/** Default page size for run history. */
export const JOB_RUNS_DEFAULT_LIMIT = 50
/** Hard cap for run history pages. */
export const JOB_RUNS_MAX_LIMIT = 200

export async function insertJob(values: NewJob): Promise<Job> {
  const db = getDb()
  const [row] = await db.insert(jobs).values(values).returning()
  return row
}

export async function listJobsInProject(
  projectId: string,
  organizationId: string,
  limit = JOBS_LIST_LIMIT,
): Promise<Job[]> {
  const db = getDb()
  return db
    .select()
    .from(jobs)
    .where(and(eq(jobs.projectId, projectId), eq(jobs.organizationId, organizationId)))
    .orderBy(desc(jobs.createdAt))
    .limit(limit)
}

/** Load a job scoped to an organization (double-filtered by org). */
export async function findJob(jobId: string, organizationId: string): Promise<Job | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.organizationId, organizationId)))
    .limit(1)
  return row ?? null
}

/**
 * Load a job by id WITHOUT an org filter — for the internal fire path, which
 * has no session. The caller uses the row's own `organizationId` for all
 * subsequent tenant-scoped work.
 */
export async function findJobById(jobId: string): Promise<Job | null> {
  const db = getDb()
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1)
  return row ?? null
}

/**
 * The columns a service may update on a job.
 *
 * `skillName`/`skillSnapshot` are updated as a PAIR or not at all — the
 * database's `jobs_skill_pair_check` rejects a name without a snapshot (and
 * vice versa), so a patch that touches one always touches the other.
 */
export type JobUpdate = Partial<
  Pick<
    Job,
    | 'name'
    | 'prompt'
    | 'skillName'
    | 'skillSnapshot'
    | 'output'
    | 'dataSources'
    | 'enabled'
    | 'scheduleCron'
    | 'scheduleTimezone'
    | 'nextRunAt'
    | 'updatedAt'
  >
>

export async function updateJob(
  jobId: string,
  organizationId: string,
  patch: JobUpdate,
): Promise<Job | null> {
  const db = getDb()
  const [row] = await db
    .update(jobs)
    .set(patch)
    .where(and(eq(jobs.id, jobId), eq(jobs.organizationId, organizationId)))
    .returning()
  return row ?? null
}

export async function deleteJob(jobId: string, organizationId: string): Promise<boolean> {
  const db = getDb()
  const deleted = await db
    .delete(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.organizationId, organizationId)))
    .returning({ id: jobs.id })
  return deleted.length > 0
}

/** Advance `last_run_at` after a fire attempt (submitted/skipped/error). */
export async function touchJobLastRun(jobId: string, at: Date): Promise<void> {
  const db = getDb()
  await db.update(jobs).set({ lastRunAt: at }).where(eq(jobs.id, jobId))
}

/**
 * The run a backend job id belongs to. NOT tenant-filtered: the worker that
 * reports an outcome holds the backend id and nothing else, so the caller runs
 * this under platform access and re-enters the run's own tenant for everything
 * after (the same shape as `loadJobForFire`).
 */
export async function findJobRunByBackendJobId(backendJobId: string): Promise<JobRun | null> {
  const db = getDb()
  const [row] = await db.select().from(jobRuns).where(eq(jobRuns.jobId, backendJobId)).limit(1)
  return row ?? null
}

export async function insertJobRun(values: NewJobRun): Promise<JobRun> {
  const db = getDb()
  const [row] = await db.insert(jobRuns).values(values).returning()
  return row
}

export async function listJobRuns(
  jobId: string,
  organizationId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<JobRun[]> {
  const db = getDb()
  const limit = Math.min(options.limit ?? JOB_RUNS_DEFAULT_LIMIT, JOB_RUNS_MAX_LIMIT)
  const offset = options.offset ?? 0
  return db
    .select()
    .from(jobRuns)
    // `scheduleId` is the parent link (0043 kept the column name: `job_id` on
    // this table is the unrelated backend async-job id).
    .where(and(eq(jobRuns.scheduleId, jobId), eq(jobRuns.organizationId, organizationId)))
    .orderBy(desc(jobRuns.createdAt))
    .limit(limit)
    .offset(offset)
}
