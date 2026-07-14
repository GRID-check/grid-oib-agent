/**
 * Research Runs API Client
 *
 * Lists deep research async jobs ("research runs") for a project via the
 * v1 BFF proxy (src/app/api/v1/[...path]/route.ts), which forwards to the
 * backend's /v1/jobs/async/jobs endpoint.
 */

import { apiConfig } from './config'
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
  projectCollection?: string
  conversationId?: string
  status?: string
  limit?: number
  offset?: number
}

// ============================================================
// Helpers
// ============================================================

/**
 * Get the base URL for the v1 API.
 * Uses the local same-origin proxy route in the browser to avoid CORS issues,
 * and calls the backend directly on the server.
 */
const getV1BaseUrl = (): string => {
  const isBrowser = typeof window !== 'undefined'
  return isBrowser ? '/api/v1' : `${apiConfig.baseUrl}/v1`
}

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
 * project collection.
 */
export const listResearchRuns = async (
  params: ListResearchRunsParams = {},
  authToken?: string
): Promise<ListResearchRunsResponse> => {
  const { projectCollection, conversationId, status, limit, offset } = params

  const searchParams = new URLSearchParams()
  if (projectCollection) searchParams.set('project_collection', projectCollection)
  if (conversationId) searchParams.set('conversation_id', conversationId)
  if (status) searchParams.set('status', status)
  if (limit !== undefined) searchParams.set('limit', String(limit))
  if (offset !== undefined) searchParams.set('offset', String(offset))

  const query = searchParams.toString()
  const url = `${getV1BaseUrl()}/jobs/async/jobs${query ? `?${query}` : ''}`

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
