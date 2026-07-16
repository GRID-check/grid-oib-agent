/**
 * Workflows repository — the only module that queries the `workflows` and
 * `workflow_runs` tables (ADR-0017).
 *
 * Repository rules: drizzle only; no HTTP, no auth, no WorkOS. Every query that
 * serves tenant data takes `organizationId` and scopes the WHERE clause with it
 * — tenancy is enforced in SQL. List queries are always bounded.
 */

import 'server-only'
import { and, desc, eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  workflowRuns,
  workflows,
  type NewWorkflow,
  type NewWorkflowRun,
  type Workflow,
  type WorkflowRun,
} from '@/lib/db/schema'

/** Hard cap for a project's workflow list. */
export const WORKFLOW_LIST_LIMIT = 200
/** Default page size for run history. */
export const WORKFLOW_RUNS_DEFAULT_LIMIT = 50

export async function insertWorkflow(values: NewWorkflow): Promise<Workflow> {
  const db = getDb()
  const [row] = await db.insert(workflows).values(values).returning()
  return row
}

export async function listWorkflowsInProject(
  projectId: string,
  organizationId: string,
  limit = WORKFLOW_LIST_LIMIT,
): Promise<Workflow[]> {
  const db = getDb()
  return db
    .select()
    .from(workflows)
    .where(and(eq(workflows.projectId, projectId), eq(workflows.organizationId, organizationId)))
    .orderBy(desc(workflows.createdAt))
    .limit(limit)
}

/** Load a workflow scoped to an organization (double-filtered by org). */
export async function findWorkflow(workflowId: string, organizationId: string): Promise<Workflow | null> {
  const db = getDb()
  const [row] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, organizationId)))
    .limit(1)
  return row ?? null
}

/**
 * Load a workflow by id WITHOUT an org filter — for the internal fire path,
 * which has no session. The caller uses the row's own `organizationId` for all
 * subsequent tenant-scoped work.
 */
export async function findWorkflowById(workflowId: string): Promise<Workflow | null> {
  const db = getDb()
  const [row] = await db.select().from(workflows).where(eq(workflows.id, workflowId)).limit(1)
  return row ?? null
}

/** The columns a service may update on a workflow. */
export type WorkflowUpdate = Partial<
  Pick<
    Workflow,
    | 'name'
    | 'description'
    | 'definition'
    | 'compiledPrompt'
    | 'dataSources'
    | 'enabled'
    | 'scheduleCron'
    | 'scheduleTimezone'
    | 'nextRunAt'
    | 'updatedAt'
  >
>

export async function updateWorkflow(
  workflowId: string,
  organizationId: string,
  patch: WorkflowUpdate,
): Promise<Workflow | null> {
  const db = getDb()
  const [row] = await db
    .update(workflows)
    .set(patch)
    .where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, organizationId)))
    .returning()
  return row ?? null
}

export async function deleteWorkflow(workflowId: string, organizationId: string): Promise<boolean> {
  const db = getDb()
  const deleted = await db
    .delete(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.organizationId, organizationId)))
    .returning({ id: workflows.id })
  return deleted.length > 0
}

/** Advance `last_run_at` after a fire attempt (submitted/skipped/error). */
export async function touchWorkflowLastRun(workflowId: string, at: Date): Promise<void> {
  const db = getDb()
  await db.update(workflows).set({ lastRunAt: at }).where(eq(workflows.id, workflowId))
}

export async function insertWorkflowRun(values: NewWorkflowRun): Promise<WorkflowRun> {
  const db = getDb()
  const [row] = await db.insert(workflowRuns).values(values).returning()
  return row
}

export async function listWorkflowRuns(
  workflowId: string,
  organizationId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<WorkflowRun[]> {
  const db = getDb()
  const limit = options.limit ?? WORKFLOW_RUNS_DEFAULT_LIMIT
  const offset = options.offset ?? 0
  return db
    .select()
    .from(workflowRuns)
    .where(and(eq(workflowRuns.workflowId, workflowId), eq(workflowRuns.organizationId, organizationId)))
    .orderBy(desc(workflowRuns.createdAt))
    .limit(limit)
    .offset(offset)
}
