/**
 * Workflows API Client
 *
 * Typed fetch client for the project-scoped Workflows BFF endpoints
 * (`/api/projects/[id]/workflows…`). These are grid_app-owned BFF routes
 * (not the backend v1 proxy), so they are always called same-origin and
 * return the camelCase JSON envelope the BFF service layer produces.
 *
 * Contract mirrors docs/architecture/workflows.md ("BFF API" section) and
 * ADR-0023. The server compiles the prompt authoritatively and owns cron /
 * min-interval validation; this client only transports the documented shapes
 * and surfaces the BFF error envelope (`{ error, code }`).
 *
 * Style follows src/adapters/api/research-runs-client.ts.
 */

import { ApiRequestError } from './api-error'

// ============================================================
// Types (self-contained — mirror the documented JSON contract so the UI
// stays decoupled from @/lib/workflows internals)
// ============================================================

/** Versioned builder state stored in the `definition` JSONB (version 1). */
export interface WorkflowBlocks {
  /** Required, non-empty research objective. */
  objective: string
  /** Optional background/context. */
  context?: string
  /** Optional ordered list of research questions. */
  questions?: string[]
  /** Optional free-text output/format requirements. */
  outputFormat?: string
}

export interface WorkflowDefinition {
  version: 1
  blocks: WorkflowBlocks
}

/** Manual vs scheduled trigger for a run. */
export type WorkflowRunTrigger = 'manual' | 'schedule'

/** Submission outcome of a run (live job progress lives in the backend). */
export type WorkflowRunStatus = 'submitted' | 'skipped' | 'error'

/** List-row projection returned by `GET …/workflows`. */
export interface WorkflowSummary {
  id: string
  name: string
  description: string | null
  enabled: boolean
  scheduleCron: string | null
  scheduleTimezone: string
  nextRunAt: string | null
  lastRunAt: string | null
  updatedAt: string
}

/** Full record returned by `GET …/workflows/[workflowId]`. */
export interface WorkflowDetail extends WorkflowSummary {
  definition: WorkflowDefinition
  dataSources: string[] | null
  agentType: string
  createdAt: string
}

/** A single append-only run-history entry. */
export interface WorkflowRun {
  id: string
  jobId: string | null
  trigger: WorkflowRunTrigger
  status: WorkflowRunStatus
  detail: string | null
  triggeredBy: string | null
  createdAt: string
}

/** Structured result of a manual `POST …/run`. */
export interface RunWorkflowResult {
  status: WorkflowRunStatus
  jobId?: string | null
  detail?: string | null
}

/** Create/replace payload for `POST …/workflows`. */
export interface CreateWorkflowInput {
  name: string
  description?: string | null
  definition: WorkflowDefinition
  dataSources?: string[] | null
  enabled?: boolean
  scheduleCron?: string | null
  scheduleTimezone?: string
}

/** Partial update payload for `PATCH …/workflows/[workflowId]`. */
export type UpdateWorkflowInput = Partial<CreateWorkflowInput>

export interface ListWorkflowRunsParams {
  limit?: number
  offset?: number
}

// ============================================================
// Errors
// ============================================================

/**
 * Carries the BFF error `code` (e.g. `UNPROCESSABLE`, `CONFLICT`) alongside
 * the HTTP status so callers can react structurally — e.g. render cron
 * validation feedback inline vs. show a generic failure alert.
 */
export class WorkflowApiError extends ApiRequestError {
  readonly code: string | null
  /** The raw server error message (without the client-added context prefix). */
  readonly serverMessage: string | null

  constructor(message: string, status: number, code: string | null, serverMessage: string | null) {
    super(message, status)
    this.name = 'WorkflowApiError'
    this.code = code
    this.serverMessage = serverMessage
  }
}

// ============================================================
// Helpers
// ============================================================

const workflowsBase = (projectId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/workflows`

const parseErrorEnvelope = async (
  response: Response,
): Promise<{ message: string | null; code: string | null }> => {
  const text = await response.text().catch(() => '')
  if (!text) return { message: null, code: null }
  try {
    const parsed = JSON.parse(text) as { error?: unknown; code?: unknown }
    const message = typeof parsed.error === 'string' ? parsed.error : null
    const code = typeof parsed.code === 'string' ? parsed.code : null
    return { message, code: code ?? null }
  } catch {
    return { message: text, code: null }
  }
}

const throwWorkflowApiError = async (response: Response, context: string): Promise<never> => {
  const { message, code } = await parseErrorEnvelope(response)
  throw new WorkflowApiError(
    `${context}: ${response.status}${message ? ` - ${message}` : ''}`,
    response.status,
    code,
    message,
  )
}

const jsonHeaders: HeadersInit = { 'Content-Type': 'application/json' }

// ============================================================
// REST API Functions
// ============================================================

/** List a project's workflows (BFF orders newest-created first). */
export const listWorkflows = async (projectId: string): Promise<WorkflowSummary[]> => {
  const response = await fetch(workflowsBase(projectId), { headers: jsonHeaders })
  if (!response.ok) await throwWorkflowApiError(response, 'Failed to list workflows')
  const data = (await response.json()) as { workflows?: WorkflowSummary[] } | WorkflowSummary[]
  // Accept either a bare array or a `{ workflows }` envelope.
  return Array.isArray(data) ? data : (data.workflows ?? [])
}

/** Fetch a single workflow with its full builder definition. */
export const getWorkflow = async (
  projectId: string,
  workflowId: string,
): Promise<WorkflowDetail> => {
  const response = await fetch(`${workflowsBase(projectId)}/${encodeURIComponent(workflowId)}`, {
    headers: jsonHeaders,
  })
  if (!response.ok) await throwWorkflowApiError(response, 'Failed to load workflow')
  return (await response.json()) as WorkflowDetail
}

/** Create a workflow. The server compiles the prompt and validates the cron. */
export const createWorkflow = async (
  projectId: string,
  input: CreateWorkflowInput,
): Promise<WorkflowDetail> => {
  const response = await fetch(workflowsBase(projectId), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  if (!response.ok) await throwWorkflowApiError(response, 'Failed to create workflow')
  return (await response.json()) as WorkflowDetail
}

/** Patch a workflow (recompiles the prompt and recomputes next_run_at). */
export const updateWorkflow = async (
  projectId: string,
  workflowId: string,
  input: UpdateWorkflowInput,
): Promise<WorkflowDetail> => {
  const response = await fetch(`${workflowsBase(projectId)}/${encodeURIComponent(workflowId)}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  if (!response.ok) await throwWorkflowApiError(response, 'Failed to update workflow')
  return (await response.json()) as WorkflowDetail
}

/** Delete a workflow (cascades its run history). */
export const deleteWorkflow = async (projectId: string, workflowId: string): Promise<void> => {
  const response = await fetch(`${workflowsBase(projectId)}/${encodeURIComponent(workflowId)}`, {
    method: 'DELETE',
    headers: jsonHeaders,
  })
  // 204 or 200 both count as success.
  if (!response.ok) await throwWorkflowApiError(response, 'Failed to delete workflow')
}

/**
 * Fire a workflow manually. The route returns a structured result: `submitted`
 * with a job id, or a friendly `skipped` (e.g. org job caps / 429) — neither
 * is an error. A disabled workflow yields 409, surfaced as a thrown error.
 */
export const runWorkflow = async (
  projectId: string,
  workflowId: string,
): Promise<RunWorkflowResult> => {
  const response = await fetch(
    `${workflowsBase(projectId)}/${encodeURIComponent(workflowId)}/run`,
    { method: 'POST', headers: jsonHeaders },
  )
  if (!response.ok) await throwWorkflowApiError(response, 'Failed to run workflow')
  // The route wraps the recorded run row as `{ run: … }`; tolerate a bare
  // result too. The run row carries { status, jobId, detail, … }.
  const body = (await response.json()) as { run?: Partial<RunWorkflowResult> } & Partial<RunWorkflowResult>
  const data = body.run ?? body
  return {
    status: data.status === 'skipped' || data.status === 'error' ? data.status : 'submitted',
    jobId: data.jobId ?? null,
    detail: data.detail ?? null,
  }
}

/** List a workflow's run history (newest first). */
export const listWorkflowRuns = async (
  projectId: string,
  workflowId: string,
  params: ListWorkflowRunsParams = {},
): Promise<WorkflowRun[]> => {
  const search = new URLSearchParams()
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  if (params.offset !== undefined) search.set('offset', String(params.offset))
  const query = search.toString()
  const response = await fetch(
    `${workflowsBase(projectId)}/${encodeURIComponent(workflowId)}/runs${query ? `?${query}` : ''}`,
    { headers: jsonHeaders },
  )
  if (!response.ok) await throwWorkflowApiError(response, 'Failed to list workflow runs')
  const data = (await response.json()) as { runs?: WorkflowRun[] } | WorkflowRun[]
  return Array.isArray(data) ? data : (data.runs ?? [])
}
