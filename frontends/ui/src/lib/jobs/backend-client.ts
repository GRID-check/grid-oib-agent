/**
 * Backend client for the single job submission path (ADR-0023 §4).
 *
 * `fireJob` (service.ts) POSTs to the Python backend's internal submit route,
 * guarded by the shared `GRID_INTERNAL_API_TOKEN` (`X-Internal-Token`, the
 * maintenance.py pattern — never on the external allowlist). This module owns
 * the HTTP call and maps responses to typed errors:
 *   - 429 → SkippedError (with Retry-After) so the run is recorded as a
 *     `skipped` run and NOT retried before its next slot. With the research
 *     queue (ADR-0079) this is no longer capacity: a full cluster makes the job
 *     WAIT (`queued: true` in the response), and the only 429 left is an
 *     organization whose own waiting queue is past its bound;
 *   - any other non-2xx / network failure → SubmitError → `error` run.
 */

import 'server-only'
import type { PlanDocument, PlanDocuments } from '@/lib/runs/plan-documents'

/**
 * Backend base URL — same resolution as `getBackendUrl` in
 * `@/lib/backend-proxy`, deliberately NOT imported from there: that module
 * pulls `@workos-inc/authkit-nextjs`, which the session-less scheduler fire
 * path (and these unit tests) must not load. Keep the env chain in sync.
 */
function getBackendUrl(): string {
  const url =
    process.env.BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000'
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
  /**
   * The `task_runs` row this job IS (ADR-0062).
   *
   * Without it the worker wraps no ledger fold around its event store, so the
   * run message is minted and then never moves: the block sits at „Wird
   * gestartet" until the report lands. Absent only for a submit that has no run
   * row behind it.
   */
  run_id?: string
  /** The commissioning turn's settled context; the worker sets it on the agent state. */
  clarifier_result?: string
  /** The Unterlagen the reader named on the plan card (`lib/runs/plan-documents`). */
  documents?: PlanDocuments
  data_sources: string[] | null
  collection_scope: string[] | null
  project_context: string | null
  /**
   * The project-memory digest as of fire time. The worker fetches a live one
   * and keeps this only when that fetch fails, so a run sees what a chat turn
   * sees instead of the intake profile alone.
   */
  project_memory: string | null
  /** The organization's memory-reflection flag, evaluated here like the WS handshake does. */
  memory_reflection_enabled: boolean
  organization_id: string
  user_id: string | null
  project_id: string | null
  owner_email: string | null
  budget_header: string | null
  model_overrides: Record<string, string> | null
  /**
   * Where the run goes inside its organization's queue: `interactive` for a run
   * a person is waiting on, `bulk` for a scheduled fire. Absent is interactive.
   */
  priority?: JobPriority
}

/** The two priorities the research queue knows (`aiq_agent.common.claim_queue`). */
export type JobPriority = 'interactive' | 'bulk'

/**
 * The backend refused to take the job (429): the organization already has as
 * many jobs waiting as it may. Capacity is never the reason, because a full
 * cluster queues the job. Carries the parsed Retry-After (seconds) if present.
 * Recorded as a `skipped` run; fireJob never rethrows it.
 */
export class JobSubmitSkippedError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number | null
  ) {
    super(message)
    this.name = 'JobSubmitSkippedError'
  }
}

/** Any other backend failure (non-429 non-2xx, or a network/transport error). */
export class JobSubmitError extends Error {
  constructor(
    message: string,
    readonly status: number
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
 * Submit a job run to the backend. Returns `{ jobId, queued }` on success (the
 * BACKEND async-job id, not `jobs.id`; `queued` says the job waits for a free
 * worker instead of starting at once). Throws JobSubmitSkippedError on 429 and
 * JobSubmitError otherwise.
 *
 * `extraHeaders` carries session-derived wire metadata (e.g.
 * `x-grid-organization-id`) so the backend can resolve BYOK credentials and
 * feature flags for the run.
 */
export async function submitJob(
  payload: JobSubmitPayload,
  extraHeaders: Record<string, string>
): Promise<{ jobId: string; queued: boolean }> {
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
    throw new JobSubmitSkippedError(
      await readBody(response),
      parseRetryAfter(response.headers.get('retry-after'))
    )
  }
  if (!response.ok) {
    throw new JobSubmitError(await readBody(response), response.status)
  }

  try {
    const json = (await response.json()) as { jobId?: string; job_id?: string; queued?: boolean }
    // Backend sends snake_case `job_id` (SkillSubmitResponse); accept camelCase
    // too so either deploy order works.
    const jobId = json.jobId ?? json.job_id
    if (typeof jobId !== 'string' || jobId.length === 0) {
      throw new JobSubmitError('backend returned no jobId', 502)
    }
    // Absent from a backend that predates the queue, which started the job at once.
    return { jobId, queued: json.queued === true }
  } catch (err) {
    if (err instanceof JobSubmitError) throw err
    throw new JobSubmitError('malformed backend response', 502)
  }
}

/**
 * A cancel the backend refused, with the status it answered.
 *
 * The two statuses a caller decides on: 400 is the backend's verdict that the
 * job is already terminal (`Job not cancellable: <id> (status: …)`), and 404 is
 * an unknown job or one the caller does not own — the backend answers both the
 * same way on purpose. Everything else is the backend being unreachable.
 */
export class JobCancelError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'JobCancelError'
  }
}

/**
 * Who steers a job: the person's WorkOS access token and the signed context
 * envelope over the project their caller authorized
 * (`signJobRequestContext` in `@/lib/jobs/request-envelope`). Built by the
 * caller, so this module stays free of the session and authorization chain.
 */
export interface JobControlCaller {
  accessToken: string | null
  contextHeaders: Record<string, string>
}

/**
 * Cancel one backend job: `POST /v1/jobs/async/job/{id}/cancel`, the call the
 * browser already makes through `/api/jobs/async/[...path]` when it dismisses a
 * deep-research thread (`cancelJob` in `adapters/api/deep-research-client.ts`).
 * Same endpoint, same credentials: the caller's WorkOS access token and the
 * signed envelope, because the backend lets the job's owner steer it and anyone
 * else only inside the project the envelope signs (`authorize_job_access` in
 * `aiq_api/jobs/access.py`, ADR-0084). The internal token would name nobody.
 *
 * Resolves on a 2xx and throws `JobCancelError` for everything else; a network
 * failure is a 503.
 */
export async function cancelBackendJob(
  backendJobId: string,
  caller: JobControlCaller
): Promise<void> {
  return postJobControl(backendJobId, 'cancel', caller)
}

/**
 * „Jetzt schreiben": ask a running deep research to write its report from what
 * it has. Same door, same errors as the cancel; the run keeps going until the
 * report is filed.
 */
export async function writeNowBackendJob(
  backendJobId: string,
  caller: JobControlCaller
): Promise<void> {
  return postJobControl(backendJobId, 'write-now', caller)
}

/**
 * Add a document to the Grundlage of a running deep research: the worker
 * plans one dedicated research query for it in its next batch, and the run
 * block lists it beside the other Grundlage. Same door, same errors.
 */
export async function addDocumentToBackendJob(
  backendJobId: string,
  document: PlanDocument,
  caller: JobControlCaller
): Promise<void> {
  return postJobControl(backendJobId, 'documents', caller, document)
}

async function postJobControl(
  backendJobId: string,
  action: 'cancel' | 'write-now' | 'documents',
  caller: JobControlCaller,
  body?: unknown
): Promise<void> {
  let response: Response
  try {
    response = await fetch(
      `${getBackendUrl()}/v1/jobs/async/job/${encodeURIComponent(backendJobId)}/${action}`,
      {
        method: 'POST',
        headers: {
          ...caller.contextHeaders,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(caller.accessToken ? { Authorization: `Bearer ${caller.accessToken}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'network error'
    throw new JobCancelError(message, 503)
  }
  if (!response.ok) {
    throw new JobCancelError(await readBody(response), response.status)
  }
}

/** What the backend's platform kill did: `POST /v1/internal/jobs/kill-active`. */
export interface BackendKillResult {
  found: number
  killed: string[]
  alreadyFinished: number
  failed: { jobId: string; error: string }[]
  /** More live jobs than one press takes; pressing again kills the rest. */
  truncated: boolean
}

/** Generous: the backend stops and reports each job in turn, up to a thousand of them. */
const KILL_TIMEOUT_MS = 120_000

/**
 * Interrupt every submitted or running job in the job store, across every
 * organization, and stop its worker. Service-token guarded, like the outcome
 * probe below; the platform maintenance button is the one caller. Throws
 * `JobCancelError` for anything but a well-formed 2xx.
 */
export async function killActiveBackendJobs(): Promise<BackendKillResult> {
  const token = process.env.GRID_INTERNAL_API_TOKEN
  if (!token) throw new JobCancelError('GRID_INTERNAL_API_TOKEN is not configured', 503)
  let response: Response
  try {
    response = await fetch(`${getBackendUrl()}/v1/internal/jobs/kill-active`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'x-grid-internal-token': token },
      signal: AbortSignal.timeout(KILL_TIMEOUT_MS),
    })
  } catch (err) {
    throw new JobCancelError(err instanceof Error ? err.message : 'network error', 503)
  }
  if (!response.ok) throw new JobCancelError(await readBody(response), response.status)
  const raw = ((await response.json().catch(() => null)) ?? {}) as Record<string, unknown>
  if (!Array.isArray(raw.killed)) throw new JobCancelError('malformed backend response', 502)
  const failed = Array.isArray(raw.failed) ? (raw.failed as { job_id?: unknown; error?: unknown }[]) : []
  return {
    found: Number(raw.found ?? 0),
    killed: raw.killed.filter((id): id is string => typeof id === 'string'),
    alreadyFinished: Number(raw.already_finished ?? 0),
    failed: failed.map((f) => ({ jobId: String(f.job_id ?? ''), error: String(f.error ?? '') })),
    truncated: raw.truncated === true,
  }
}

/** The job store's words for a job's lifecycle, lowercased as the backend sends them. */
export type BackendJobStatus = 'submitted' | 'running' | 'success' | 'failure' | 'interrupted'

/**
 * A job's verdict as the job store holds it, for the run reconciler.
 *
 * `message` is what the run's own message should say — the report and its
 * metadata for a success, the notice for a failure or a cancel — rebuilt by the
 * backend next to the writers it mirrors (`conversation_output.run_message_for_outcome`),
 * so this tier never keeps a second copy of that text. Null while the job runs.
 */
export interface BackendJobOutcome {
  status: BackendJobStatus
  error: string | null
  report: string | null
  cards: unknown[] | null
  message: { content: string; metadata: Record<string, unknown> } | null
}

/** A probe the backend could not answer. Transient by assumption: the next sweep asks again. */
export class JobProbeError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'JobProbeError'
  }
}

const BACKEND_JOB_STATUSES: ReadonlySet<string> = new Set<BackendJobStatus>([
  'submitted',
  'running',
  'success',
  'failure',
  'interrupted',
])

const PROBE_TIMEOUT_MS = 10_000

/**
 * Ask the job store how one job stands: `GET /v1/internal/jobs/{id}/outcome`.
 *
 * The internal twin of the status route the browser polls
 * (`/v1/jobs/async/job/{id}`). That one wants a person's WorkOS token and an
 * envelope minted from their session, which a sweep holds for nobody; this one takes the service
 * token and the run's organization, which the backend checks against the job's
 * `job_access` row. Null is the backend's 404 — no such job, or not this
 * organization's — and the caller decides what that means for the run.
 * Everything else that is not a well-formed answer throws `JobProbeError`.
 */
export async function fetchBackendJobOutcome(
  backendJobId: string,
  organizationId: string
): Promise<BackendJobOutcome | null> {
  const token = process.env.GRID_INTERNAL_API_TOKEN
  if (!token) throw new JobProbeError('GRID_INTERNAL_API_TOKEN is not configured', 503)

  const url =
    `${getBackendUrl()}/v1/internal/jobs/${encodeURIComponent(backendJobId)}/outcome` +
    `?organization_id=${encodeURIComponent(organizationId)}`
  let response: Response
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json', 'x-grid-internal-token': token },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
  } catch (err) {
    throw new JobProbeError(err instanceof Error ? err.message : 'network error', 503)
  }
  if (response.status === 404) return null
  if (!response.ok) throw new JobProbeError(await readBody(response), response.status)

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new JobProbeError('malformed backend response', 502)
  }
  return parseJobOutcome(body)
}

/** Narrow the backend's JSON to the outcome, or throw: a guess here would close a run wrongly. */
function parseJobOutcome(body: unknown): BackendJobOutcome {
  const raw = (body ?? {}) as Record<string, unknown>
  if (typeof raw.status !== 'string' || !BACKEND_JOB_STATUSES.has(raw.status)) {
    throw new JobProbeError(`unknown job status ${JSON.stringify(raw.status)}`, 502)
  }
  const message = raw.message as { content?: unknown; metadata?: unknown } | null | undefined
  return {
    status: raw.status as BackendJobStatus,
    error: typeof raw.error === 'string' ? raw.error : null,
    report: typeof raw.report === 'string' && raw.report ? raw.report : null,
    cards: Array.isArray(raw.cards) ? raw.cards : null,
    message:
      message && typeof message.content === 'string'
        ? {
            content: message.content,
            metadata:
              message.metadata && typeof message.metadata === 'object'
                ? (message.metadata as Record<string, unknown>)
                : {},
          }
        : null,
  }
}
