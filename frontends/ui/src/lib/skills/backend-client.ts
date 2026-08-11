/**
 * Backend client for the single skill submission path (Agent Skills, after
 * ADR-0023 §4).
 *
 * `fireSkillSchedule` (service.ts) POSTs to the Python backend's internal
 * submit route, guarded by the shared `GRID_INTERNAL_API_TOKEN`
 * (`X-Internal-Token`, the maintenance.py pattern — never on the external
 * allowlist). This module owns the HTTP call and maps responses to typed
 * errors:
 *   - 429 → SkippedError (with Retry-After) so the run is recorded as a
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

/**
 * Payload for the backend skill-submit route. Mirrors `WorkflowSubmitPayload`
 * but carries the resolved skill names instead of a plan; the backend expands
 * them against its own builtin registry at submit time.
 */
export interface SkillSubmitPayload {
  input: string
  skills: string[]
  execution: 'chat' | 'deep-research'
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
 * present. Recorded as a `skipped` run; fireSkillSchedule never rethrows it.
 */
export class SkillSubmitSkippedError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message)
    this.name = 'SkillSubmitSkippedError'
  }
}

/** Any other backend failure (non-429 non-2xx, or a network/transport error). */
export class SkillSubmitError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'SkillSubmitError'
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
 * Submit a skill run to the backend. Returns `{ jobId }` on success.
 * Throws SkillSubmitSkippedError on 429 and SkillSubmitError otherwise.
 *
 * `extraHeaders` carries session-derived wire metadata (e.g.
 * `x-grid-organization-id`) so the backend can resolve BYOK credentials and
 * feature flags for the run.
 */
export async function submitSkillJob(
  payload: SkillSubmitPayload,
  extraHeaders: Record<string, string>,
): Promise<{ jobId: string }> {
  const token = process.env.GRID_INTERNAL_API_TOKEN
  if (!token) {
    throw new SkillSubmitError('GRID_INTERNAL_API_TOKEN is not configured', 503)
  }

  let response: Response
  try {
    response = await fetch(`${getBackendUrl()}/v1/internal/skills/submit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-grid-internal-token': token,
        ...extraHeaders,
      },
      body: JSON.stringify(payload),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'network error'
    throw new SkillSubmitError(message, 503)
  }

  if (response.status === 429) {
    throw new SkillSubmitSkippedError(await readBody(response), parseRetryAfter(response.headers.get('retry-after')))
  }
  if (!response.ok) {
    throw new SkillSubmitError(await readBody(response), response.status)
  }

  try {
    const json = (await response.json()) as { jobId?: string }
    if (typeof json.jobId !== 'string' || json.jobId.length === 0) {
      throw new SkillSubmitError('backend returned no jobId', 502)
    }
    return { jobId: json.jobId }
  } catch (err) {
    if (err instanceof SkillSubmitError) throw err
    throw new SkillSubmitError('malformed backend response', 502)
  }
}