/**
 * Research Runs API Client
 *
 * Lists deep research async jobs ("research runs") for a project via the job
 * proxy (src/app/api/jobs/async/[...path]/route.ts), which forwards to the
 * backend's /v1/jobs/async/jobs endpoint.
 *
 * The project is named by `projectId`, never by its collection: the proxy
 * checks the caller may chat in that project, signs it, and filters the
 * backend's listing to it (ADR-0084). The backend then lists the caller's own
 * runs plus the project's. A collection name sent from here was a project
 * nobody had checked, so the backend could only ever answer with the caller's
 * own runs in it.
 *
 * Browser only: the proxy is where the project is checked, and there is no
 * second path to the backend that skips it.
 */

import { ApiRequestError } from './api-error'

// ============================================================
// Types
// ============================================================

/** Status values for a research run, as returned by the backend */
export type ResearchRunStatus = 'submitted' | 'running' | 'completed' | 'failed' | 'cancelled'

/** A single research run summary */
export interface ResearchRun {
  job_id: string
  status: string
  created_at: string
  conversation_id: string | null
  project_collection: string | null
}

/** Response shape for listing research runs */
export interface ListResearchRunsResponse {
  jobs: ResearchRun[]
  total: number
}

/** Query params accepted by the list endpoint */
export interface ListResearchRunsParams {
  /** The project to list, checked and signed by the proxy. */
  projectId?: string
  conversationId?: string
  status?: string
  limit?: number
  offset?: number
}

// ============================================================
// Helpers
// ============================================================

const RESEARCH_RUNS_URL = '/api/jobs/async/jobs'

const getResearchRunsErrorDetails = async (response: Response): Promise<string | null> => {
  const responseText = await response.text().catch(() => '')
  if (!responseText) return null

  try {
    const parsed = JSON.parse(responseText) as {
      error?: {
        code?: unknown
        message?: unknown
      }
    }
    const code = typeof parsed.error?.code === 'string' ? parsed.error.code : ''
    const message = typeof parsed.error?.message === 'string' ? parsed.error.message : ''
    return [code, message].filter(Boolean).join(': ') || responseText
  } catch {
    return responseText
  }
}

const throwResearchRunsApiError = async (response: Response, context: string): Promise<never> => {
  const details = await getResearchRunsErrorDetails(response)
  // ApiRequestError carries the HTTP status so consumers can classify the
  // failure structurally instead of parsing the message text.
  throw new ApiRequestError(
    `${context}: ${response.status}${details ? ` - ${details}` : ''}`,
    response.status
  )
}

/**
 * Minimal runtime shape validation for the list response. The proxy forwards
 * backend JSON verbatim, so guard against malformed payloads instead of
 * trusting `response.json()` blindly: malformed entries are dropped and a
 * missing `jobs` array is treated as empty.
 */
const isResearchRun = (value: unknown): value is ResearchRun => {
  if (typeof value !== 'object' || value === null) return false
  const run = value as Record<string, unknown>
  return (
    typeof run.job_id === 'string' &&
    typeof run.status === 'string' &&
    typeof run.created_at === 'string' &&
    (run.conversation_id === null || typeof run.conversation_id === 'string' || run.conversation_id === undefined) &&
    (run.project_collection === null || typeof run.project_collection === 'string' || run.project_collection === undefined)
  )
}

const normalizeListResearchRunsResponse = (data: unknown): ListResearchRunsResponse => {
  const raw = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
  const jobs = Array.isArray(raw.jobs)
    ? raw.jobs.filter(isResearchRun).map((run) => ({
        ...run,
        conversation_id: run.conversation_id ?? null,
        project_collection: run.project_collection ?? null,
      }))
    : []
  const total = typeof raw.total === 'number' ? raw.total : jobs.length
  return { jobs, total }
}

// ============================================================
// REST API Functions
// ============================================================

/**
 * List research runs (deep research async jobs), optionally scoped to a
 * project.
 */
export const listResearchRuns = async (
  params: ListResearchRunsParams = {},
  authToken?: string
): Promise<ListResearchRunsResponse> => {
  const { projectId, conversationId, status, limit, offset } = params

  const searchParams = new URLSearchParams()
  if (projectId) searchParams.set('projectId', projectId)
  if (conversationId) searchParams.set('conversation_id', conversationId)
  if (status) searchParams.set('status', status)
  if (limit !== undefined) searchParams.set('limit', String(limit))
  if (offset !== undefined) searchParams.set('offset', String(offset))

  const query = searchParams.toString()
  const url = `${RESEARCH_RUNS_URL}${query ? `?${query}` : ''}`

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
  }
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`
  }

  const response = await fetch(url, { headers })

  if (!response.ok) {
    await throwResearchRunsApiError(response, 'Failed to list research runs')
  }

  return normalizeListResearchRunsResponse(await response.json())
}
