/**
 * Research plans repository — SQL only (ADR-0017).
 *
 * One row per plan; no lists yet, because nothing lists plans: the block
 * reaches its plan by id from the run message, the worker by id from the job
 * payload. `findPlanById` is the one unfiltered read, for the worker's claim,
 * and its caller runs it under platform access and re-enters the row's own
 * tenant for the write that follows (the ledger route's discipline).
 */

import 'server-only'
import { and, eq, inArray } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { researchPlans, type NewResearchPlanRow, type ResearchPlanRow } from '@/lib/db/schema'
import type { PlanStatus } from '@/lib/plans/plan-types'

export async function insertPlan(values: NewResearchPlanRow): Promise<ResearchPlanRow> {
  const db = getDb()
  const [row] = await db.insert(researchPlans).values(values).returning()
  return row
}

export async function findPlanInProject(
  planId: string,
  projectId: string,
  organizationId: string
): Promise<ResearchPlanRow | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(researchPlans)
    .where(
      and(
        eq(researchPlans.id, planId),
        eq(researchPlans.projectId, projectId),
        eq(researchPlans.organizationId, organizationId)
      )
    )
    .limit(1)
  return row ?? null
}

/** Platform-scope lookup for the worker, which holds a plan id and nothing else. */
export async function findPlanById(planId: string): Promise<ResearchPlanRow | null> {
  const db = getDb()
  const [row] = await db.select().from(researchPlans).where(eq(researchPlans.id, planId)).limit(1)
  return row ?? null
}

/**
 * Write a plan, but only while it is still in one of `whenStatus`.
 *
 * The status check and the write are one statement on purpose. The service
 * reads a plan, decides, and writes; between the read and the write the
 * worker may start the plan. A write conditioned in SQL is refused (null)
 * rather than landing on a started plan, which would show the reader a plan
 * the run is not running.
 */
export async function updatePlan(
  planId: string,
  organizationId: string,
  patch: Partial<Omit<NewResearchPlanRow, 'id' | 'organizationId' | 'projectId'>>,
  whenStatus?: readonly PlanStatus[]
): Promise<ResearchPlanRow | null> {
  const db = getDb()
  const [row] = await db
    .update(researchPlans)
    .set({ ...patch, updatedAt: new Date() })
    .where(
      and(
        eq(researchPlans.id, planId),
        eq(researchPlans.organizationId, organizationId),
        ...(whenStatus ? [inArray(researchPlans.status, [...whenStatus])] : [])
      )
    )
    .returning()
  return row ?? null
}
