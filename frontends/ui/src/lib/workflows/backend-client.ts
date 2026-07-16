/**
 * Backend client for the single workflow submission path (ADR-0023 §4).
 *
 * `fireWorkflow` (service.ts) POSTs to the Python backend's internal submit
 * route, guarded by the shared `GRID_INTERNAL_API_TOKEN` (`X-Internal-Token`,
 * the maintenance.py pattern — never on the external allowlist). This module
 * owns the HTTP call and maps responses to typed errors:
 *   - 429 → SkippedError (with Retry-After) so the occurrence is recorded as a
 *     `skipped` run and NOT retried before its next slot (no cap stampede);
 *   - any other non-2xx / network failure → SubmitError → `error` run.
 */

import 'server-only'

/**
 * Backend base URL — same resolution as `getBackendUrl` in
 * `@/lib/backend-proxy`, deliberately NOT imported from there: that module
 * pulls `@workos-inc/authkit-nextjs`, which the session-less scheduler fire
 * path (and these unit tests) must not load. Keep the env chain in sync.
 */
function getBackendUrl(): string {
  const url = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000'
  return url.replace(/\/$/, '')
}

export interface WorkflowSubmitPayload {
  agent_type: string
  input: string
  job_id?: string
  data_sources: string[] | null
  collection_scope: string[] | null
  project_context: string | null
  organization_id: string
  user_id: string | null
  project_id: string | null
  owner_email: string | null
  budget_header: string | null
  model_overrides: Record<string, string> | null
}

/**
 * Admission cap hit (backend 429). Carries the parsed Retry-After (seconds) if
 * present. Recorded as a `skipped` run; fireWorkflow never rethrows it.
 */
export class WorkflowSubmitSkippedError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message)
    this.name = 'WorkflowSubmitSkippedError'
  }
}

/** Any other backend failure (non-429 non-2xx, or a network/transport error). */
export class WorkflowSubmitError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'WorkflowSubmitError'
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null
  const seconds = Number.parseInt(header.trim(), 10)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

async function readBody(response: Response): Promise<string> {
  try {
    return (await response.text()).trim()
  } catch {
    return ''
  }
}

/**
 * Submit a workflow run to the backend. Returns `{ job_id }` on success.
 * Throws WorkflowSubmitSkippedError on 429 and WorkflowSubmitError otherwise.
 *
 * `extraHeaders` carries the signed `X-Grid-Request-Context`(-Sig) envelope
 * (backlog T3-9 follow-up, 2026-07-16) `fireWorkflow` (service.ts) builds
 * from this same payload's identity/context fields — attached here rather
 * than added to `WorkflowSubmitPayload` because it is wire-transport
 * metadata (an HTTP header), not part of the backend's request body contract
 * (`WorkflowSubmitRequest` in `routes/workflows.py`).
 */
export async function submitWorkflowJob(
  payload: WorkflowSubmitPayload,
  extraHeaders?: Record<string, string>,
): Promise<{ job_id: string }> {
  const token = process.env.GRID_INTERNAL_API_TOKEN
  if (!token) {
    throw new WorkflowSubmitError('GRID_INTERNAL_API_TOKEN is not configured', 503)
  }

  let response: Response
  try {
    response = await fetch(`${getBackendUrl()}/v1/internal/workflows/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': token,
        ...extraHeaders,
      },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    // Backend unreachable — surfaced as an error run (occurrence heals on the
    // next slot per ADR-0023 risks).
    throw new WorkflowSubmitError(`Backend request failed: ${(err as Error).message}`, 0)
  }

  if (response.status === 429) {
    const retryAfter = parseRetryAfter(response.headers.get('Retry-After'))
    const body = await readBody(response)
    throw new WorkflowSubmitSkippedError(body || 'Job admission cap reached', retryAfter)
  }

  if (!response.ok) {
    const body = await readBody(response)
    throw new WorkflowSubmitError(body || `Backend returned ${response.status}`, response.status)
  }

  const data = (await response.json().catch(() => ({}))) as { job_id?: string }
  if (!data.job_id) {
    throw new WorkflowSubmitError('Backend response missing job_id', response.status)
  }
  return { job_id: data.job_id }
}
