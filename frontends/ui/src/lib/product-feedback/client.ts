/**
 * Browser-side client for product feedback. The form and the platform triage
 * page call these; nothing else in the browser talks to the routes directly.
 */

import type {
  ProductFeedbackContext,
  ProductFeedbackKind,
  ProductFeedbackListResponse,
  ProductFeedbackReportView,
  ProductFeedbackStatus,
  SubmittedProductFeedbackView,
} from './types'

export interface SubmitProductFeedbackRequest {
  kind: ProductFeedbackKind
  message: string
  pagePath: string | null
  allowContact: boolean
  context: ProductFeedbackContext
}

export type SubmitProductFeedbackResult =
  | { ok: true; report: SubmittedProductFeedbackView }
  | { ok: false; reason: 'rate-limited' | 'failed' }

export async function submitProductFeedback(
  request: SubmitProductFeedbackRequest
): Promise<SubmitProductFeedbackResult> {
  try {
    const response = await fetch('/api/feedback/reports', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
    if (response.status === 429) return { ok: false, reason: 'rate-limited' }
    if (!response.ok) return { ok: false, reason: 'failed' }
    return { ok: true, report: (await response.json()) as SubmittedProductFeedbackView }
  } catch {
    return { ok: false, reason: 'failed' }
  }
}

/**
 * What the browser can tell a triager without the reporter typing it. Read at
 * send time so it describes the moment of the report, and never the query
 * string or host — a path is enough to find the page, and a query can carry
 * anything.
 */
export function captureFeedbackContext(): { pagePath: string | null; context: ProductFeedbackContext } {
  if (typeof window === 'undefined') return { pagePath: null, context: {} }
  const intl = Intl.DateTimeFormat().resolvedOptions()
  return {
    pagePath: window.location.pathname || null,
    context: {
      userAgent: navigator.userAgent.slice(0, 500),
      viewport: `${window.innerWidth}×${window.innerHeight}`,
      locale: navigator.language,
      timeZone: intl.timeZone,
    },
  }
}

export interface ListFeedbackFilters {
  status?: ProductFeedbackStatus
  kind?: ProductFeedbackKind
  cursor?: string | null
}

export async function fetchPlatformFeedback(
  filters: ListFeedbackFilters
): Promise<ProductFeedbackListResponse> {
  const params = new URLSearchParams()
  if (filters.status) params.set('status', filters.status)
  if (filters.kind) params.set('kind', filters.kind)
  if (filters.cursor) params.set('cursor', filters.cursor)
  const query = params.toString()
  const response = await fetch(`/api/platform/feedback${query ? `?${query}` : ''}`, {
    credentials: 'same-origin',
  })
  if (!response.ok) throw new Error(`feedback list failed: ${response.status}`)
  return (await response.json()) as ProductFeedbackListResponse
}

export async function fetchPlatformFeedbackReport(id: string): Promise<ProductFeedbackReportView | null> {
  const response = await fetch(`/api/platform/feedback/${encodeURIComponent(id)}`, {
    credentials: 'same-origin',
  })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`feedback report failed: ${response.status}`)
  return (await response.json()) as ProductFeedbackReportView
}

export async function triagePlatformFeedback(
  id: string,
  status: ProductFeedbackStatus
): Promise<ProductFeedbackReportView> {
  const response = await fetch(`/api/platform/feedback/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  })
  if (!response.ok) throw new Error(`triage failed: ${response.status}`)
  return (await response.json()) as ProductFeedbackReportView
}
