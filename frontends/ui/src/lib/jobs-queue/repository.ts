/**
 * The BFF's reads and one write on `bff_job_queue` (ADR-0017: the only
 * module that queries it from the BFF).
 *
 * Claiming, heartbeating, releasing and failing are not here: they are SQL in
 * `workers/job-queue.js`, run by the `bff-jobs` runner, because that process
 * has no build step and the claim must exist once (see `./queue.ts`). The BFF
 * adds a job, withdraws one nobody claimed, finds the open one of a kind, and
 * reads back the row a worker was handed.
 */

import 'server-only'
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import type { DbExecutor } from '@/lib/db/executor'
import { bffJobQueue, type BffJobPriority, type BffJobRow } from '@/lib/db/schema'

/**
 * Add a job to the caller's own lane. Runs in the tenant scope of the request
 * that enqueues it: the table's WITH CHECK refuses a lane that is not the
 * active organization, so a route cannot enqueue into someone else's lane even
 * by mistake.
 *
 * `executor` is the caller's transaction when the job must exist exactly when
 * the caller's other writes do (the Papierkorb queues its jobs that way).
 * `jobId` lets such a caller stamp rows with the id before the insert returns;
 * `notBefore` holds the job back until then, the same column the retry backoff
 * uses.
 */
export async function insertJob(
  job: {
    kind: string
    organizationId: string
    priority: BffJobPriority
    payload: Record<string, unknown>
    jobId?: string
    notBefore?: Date
  },
  executor: DbExecutor = getDb()
): Promise<string> {
  const [row] = await executor
    .insert(bffJobQueue)
    .values({
      ...(job.jobId ? { jobId: job.jobId } : {}),
      kind: job.kind,
      lane: job.organizationId,
      priority: job.priority,
      payload: job.payload,
      notBefore: job.notBefore ?? null,
    })
    .returning({ jobId: bffJobQueue.jobId })
  return row.jobId
}

/**
 * Withdraw a job nobody has claimed yet, in the caller's lane; whether it was
 * there. A claimed job is left alone: its worker owns it now, and a job that
 * may be withdrawn checks on its own whether it still has work.
 */
export async function deleteQueuedJob(jobId: string): Promise<boolean> {
  const db = getDb()
  const rows = await db
    .delete(bffJobQueue)
    .where(and(eq(bffJobQueue.jobId, jobId), eq(bffJobQueue.status, 'queued')))
    .returning({ jobId: bffJobQueue.jobId })
  return rows.length > 0
}

/**
 * The row a worker was handed, or `null` when that job is not claimed by that
 * worker (finished, given back, taken over by another worker, dead).
 *
 * Cross-tenant by nature: the caller is the internal run route, which reads it
 * under the platform scope and then works inside the job's own organization.
 */
export async function findClaimedJob(jobId: string, worker: string): Promise<BffJobRow | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(bffJobQueue)
    .where(and(eq(bffJobQueue.jobId, jobId), eq(bffJobQueue.claimedBy, worker), eq(bffJobQueue.status, 'claimed')))
    .limit(1)
  return row ?? null
}

/**
 * The id of a job of this kind that is still waiting or running in the caller's
 * lane and whose payload contains `matching`, or `null`.
 *
 * What lets a second click on "Re-index project" answer with the job already
 * doing it instead of queueing the same walk twice. A dead job is not open: it
 * will never run, and a person pressing the button again wants a new one. The
 * `::text::jsonb` is not decoration: postgres-js types a bare `::jsonb`
 * parameter as JSON and encodes the string a second time, so `@>` would compare
 * against a JSON string and match nothing.
 */
export async function findOpenJobId(query: {
  kind: string
  organizationId: string
  matching: Record<string, unknown>
}): Promise<string | null> {
  const db = getDb()
  const [row] = await db
    .select({ jobId: bffJobQueue.jobId })
    .from(bffJobQueue)
    .where(and(matchingJobs(query), ne(bffJobQueue.status, 'dead')))
    .orderBy(asc(bffJobQueue.createdAt))
    .limit(1)
  return row?.jobId ?? null
}

/**
 * The newest job of this kind in the caller's lane that gave up, with the
 * reason it gave, or `null`.
 *
 * What a sweep reads to tell "nothing is working on this" from "this was
 * tried and failed every attempt": a row left at `processing` or `queued`
 * whose only job is dead will never move on its own.
 */
export async function findDeadJob(query: {
  kind: string
  organizationId: string
  matching: Record<string, unknown>
}): Promise<{ jobId: string; lastError: string | null } | null> {
  const db = getDb()
  const [row] = await db
    .select({ jobId: bffJobQueue.jobId, lastError: bffJobQueue.lastError })
    .from(bffJobQueue)
    .where(and(matchingJobs(query), eq(bffJobQueue.status, 'dead')))
    .orderBy(desc(bffJobQueue.createdAt))
    .limit(1)
  return row ?? null
}

function matchingJobs(query: { kind: string; organizationId: string; matching: Record<string, unknown> }) {
  return and(
    eq(bffJobQueue.kind, query.kind),
    eq(bffJobQueue.lane, query.organizationId),
    sql`${bffJobQueue.payload} @> ${JSON.stringify(query.matching)}::text::jsonb`
  )
}
