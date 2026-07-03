// SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Research Runs API Client
 *
 * Lists deep research async jobs ("research runs") for a project via the
 * v1 BFF proxy (src/app/api/v1/[...path]/route.ts), which forwards to the
 * backend's /v1/jobs/async/jobs endpoint.
 */

import { apiConfig } from './config'

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
  throw new Error(`${context}: ${response.status}${details ? ` - ${details}` : ''}`)
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

  return response.json()
}
