/**
 * The browser's typed client for the plan primitive (ADR-0055, ADR-0068).
 * Every path helper is exported on its own so a spec can assert on it; the
 * transport is an injectable last parameter defaulting to `fetch`.
 */

import { z } from 'zod'
import { commissionedRunSchema, type CommissionedRun } from '@/lib/runs/run-view-client'
import {
  researchPlanSchema,
  type ResearchPlan,
  type ResearchPlanDraftInput,
  type ResearchPlanEdit,
} from './plan-types'

export type PlanFetch = (input: string, init?: RequestInit) => Promise<Response>

export class PlanClientError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'PlanClientError'
  }
}

const plannedRunSchema = z.object({ plan: researchPlanSchema, run: commissionedRunSchema }).strict()
export type PlannedRun = z.infer<typeof plannedRunSchema>

export function plansPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/plans`
}

export function planPath(projectId: string, planId: string): string {
  return `${plansPath(projectId)}/${encodeURIComponent(planId)}`
}

export const planHoldPath = (projectId: string, planId: string): string => `${planPath(projectId, planId)}/hold`
export const planStartPath = (projectId: string, planId: string): string => `${planPath(projectId, planId)}/start`

const defaultFetch: PlanFetch = (input, init) => fetch(input, init)

async function request<T>(
  run: PlanFetch,
  path: string,
  method: 'GET' | 'POST' | 'PATCH',
  schema: z.ZodType<T>,
  body?: unknown
): Promise<T> {
  const response = await run(path, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    credentials: 'same-origin',
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) throw new PlanClientError(response.status, `Plan request failed with ${response.status}`)
  const payload: unknown = await response.json()
  return schema.parse(payload)
}

export async function fetchPlan(projectId: string, planId: string, run: PlanFetch = defaultFetch): Promise<ResearchPlan> {
  return request(run, planPath(projectId, planId), 'GET', researchPlanSchema)
}

export async function editPlan(
  projectId: string,
  planId: string,
  edit: ResearchPlanEdit,
  run: PlanFetch = defaultFetch
): Promise<ResearchPlan> {
  return request(run, planPath(projectId, planId), 'PATCH', researchPlanSchema, edit)
}

export async function holdPlan(projectId: string, planId: string, run: PlanFetch = defaultFetch): Promise<ResearchPlan> {
  return request(run, planHoldPath(projectId, planId), 'POST', researchPlanSchema)
}

export async function startPlan(projectId: string, planId: string, run: PlanFetch = defaultFetch): Promise<ResearchPlan> {
  return request(run, planStartPath(projectId, planId), 'POST', researchPlanSchema)
}

export interface CreatePlanInput extends ResearchPlanDraftInput {
  conversationId: string
  /** What the run is told beside the plan, e.g. a continuation's earlier findings. */
  context?: string
  /** Show the plan on the block with a countdown instead of starting at once. */
  countdown?: boolean
}

/** A plan a person wrote, and the run it commissioned. */
export async function createPlan(
  projectId: string,
  input: CreatePlanInput,
  run: PlanFetch = defaultFetch
): Promise<{ plan: ResearchPlan; run: CommissionedRun }> {
  return request(run, plansPath(projectId), 'POST', plannedRunSchema, input)
}
