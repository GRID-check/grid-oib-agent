/**
 * Backend client for the single job submission path (ADR-0023 §4).
 *
 * `fireJob` (service.ts) POSTs to the Python backend's internal submit route,
 * guarded by the shared `GRID_INTERNAL_API_TOKEN` (`X-Internal-Token`, the
 * maintenance.py pattern — never on the external allowlist). This module owns
 * the HTTP call and maps responses to typed errors:
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
 * Payload for the backend submit route. Mirrors `WorkflowSubmitPayload` but
 * carries the composed job prompt plus the attached skill's name, which the
 * backend expands against its own builtin registry at submit time.
 */
export interface JobSubmitPayload {
  /** The composed prompt: the job's prompt, plus the skill body when attached. */
  input: string
  /** The attached skill's name, or `[]` when the prompt runs alone. */
  skills: string[]
  /**
   * The job's output kind, which decides the agent.
   *
   * The wire field used to be `execution`; the backend reads `output` when
   * present and falls back to `execution` for one release, because the BFF and
   * the Python service deploy separately (see routes/skills.py).
   */
  output: 'chat' | 'deep-research'
  /**
   * The conversation an `output: 'chat'` run should land in.
   *
   * THE SEAM, not the feature: nothing sets this yet. Creating that
   * conversation waits on the ownership/visibility model (see the TODO in
   * `fireJob`) — a job is a team artefact, and a private conversation owned by
   * one human is the wrong default for it. The field exists so the wire shape,
   * the run row and the Python half can be built without another rename.
   */
  conversation_id?: string
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
 * present. Recorded as a `skipped` run; fireJob never rethrows it.
 */
export class JobSubmitSkippedError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(message)
    this.name = 'JobSubmitSkippedError'
  }
}

/** Any other backend failure (non-429 non-2xx, or a network/transport error). */
export class JobSubmitError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'JobSubmitError'
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
 * Submit a job run to the backend. Returns `{ jobId }` on success (the BACKEND
 * async-job id, not `jobs.id`). Throws JobSubmitSkippedError on 429 and
 * JobSubmitError otherwise.
 *
 * `extraHeaders` carries session-derived wire metadata (e.g.
 * `x-grid-organization-id`) so the backend can resolve BYOK credentials and
 * feature flags for the run.
 */
export async function submitJob(
  payload: JobSubmitPayload,
  extraHeaders: Record<string, string>,
): Promise<{ jobId: string }> {
  const token = process.env.GRID_INTERNAL_API_TOKEN
  if (!token) {
    throw new JobSubmitError('GRID_INTERNAL_API_TOKEN is not configured', 503)
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
    throw new JobSubmitError(message, 503)
  }

  if (response.status === 429) {
    throw new JobSubmitSkippedError(await readBody(response), parseRetryAfter(response.headers.get('retry-after')))
  }
  if (!response.ok) {
    throw new JobSubmitError(await readBody(response), response.status)
  }

  try {
    const json = (await response.json()) as { jobId?: string }
    if (typeof json.jobId !== 'string' || json.jobId.length === 0) {
      throw new JobSubmitError('backend returned no jobId', 502)
    }
    return { jobId: json.jobId }
  } catch (err) {
    if (err instanceof JobSubmitError) throw err
    throw new JobSubmitError('malformed backend response', 502)
  }
}
