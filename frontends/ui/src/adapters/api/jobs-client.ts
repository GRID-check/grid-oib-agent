/**
 * Jobs API Client
 *
 * Typed fetch client for the project-scoped job endpoints
 * (`/api/projects/[id]/jobs…`) plus the builder's skill picker
 * (`/api/skills/attachable`). These are grid_app-owned BFF routes, so they are
 * always called same-origin and return the camelCase JSON envelope the BFF
 * service layer produces.
 *
 * A **job is a prompt on a timer**: `prompt` is what it is, `output` is what a
 * run produces, and a skill MAY be attached on top — exactly as typing `/name`
 * before the message would attach it. The server owns validation (cron /
 * min-interval, prompt length, name rules) and snapshot semantics; this client
 * only transports the documented shapes and surfaces the BFF error envelope
 * (`{ error, code }`).
 *
 * Style follows src/adapters/api/skills-client.ts.
 */

import { ApiRequestError } from './api-error'
import type { SkillSnapshot } from './skills-client'

// ============================================================
// Types (self-contained — mirror the documented JSON contract so the UI
// stays decoupled from @/lib/jobs internals)
// ============================================================

/**
 * What a job produces — the user's choice, and the only thing that decides
 * which agent runs it (`chat` → shallow_researcher, `deep-research` →
 * deep_researcher). Was `execution`, denormalised from skill metadata.
 */
export type JobOutput = 'chat' | 'deep-research'

/** Manual vs scheduled trigger for a run. */
export type JobRunTrigger = 'manual' | 'schedule'

/** Submission outcome of a run (live job progress lives in the backend). */
export type JobRunStatus = 'submitted' | 'skipped' | 'error'

/** A project job row (`jobs`). */
export interface Job {
  id: string
  projectId: string
  name: string
  /** The scheduled prompt — fires as if typed into a new chat. */
  prompt: string
  /** The attached skill's name, or null when the prompt runs alone. */
  skillName: string | null
  /** The pinned copy of that skill; null exactly when `skillName` is null. */
  skillSnapshot: SkillSnapshot | null
  output: JobOutput
  dataSources: string[] | null
  enabled: boolean
  scheduleCron: string | null
  scheduleTimezone: string
  nextRunAt: string | null
  lastRunAt: string | null
  createdBy: string
  createdByEmail: string | null
  createdAt: string
  updatedAt: string
}

/** A single append-only run-history entry (`job_runs`). */
export interface JobRun {
  id: string
  /** The parent job's id (the column is still `schedule_id` — see 0043). */
  scheduleId: string
  /** The BACKEND async-job id, not the job's id. Null when skipped/error. */
  jobId: string | null
  trigger: JobRunTrigger
  status: JobRunStatus
  detail: string | null
  /** Where an `output: 'chat'` run landed, when one was minted. */
  conversationId: string | null
  /** The job's snapshot at fire time; `{}` when no skill was attached. */
  skillSnapshot: SkillSnapshot
  triggeredBy: string | null
  createdAt: string
}

/** Structured result of a manual `POST …/run`. */
export interface RunJobResult {
  status: JobRunStatus
  jobId?: string | null
  detail?: string | null
}

/** Job create payload (`POST …/jobs`). */
export interface CreateJobInput {
  name: string
  prompt: string
  output: JobOutput
  /** Omit (or null) for a job with no skill attached. */
  skillName?: string | null
  dataSources?: string[] | null
  enabled?: boolean
  scheduleCron?: string | null
  scheduleTimezone?: string
}

/**
 * Partial update payload for `PATCH …/jobs/[jobId]`.
 *
 * `skillName: null` DETACHES the skill; omitting the field leaves the current
 * attachment alone.
 */
export type UpdateJobInput = Partial<CreateJobInput>

export interface ListJobRunsParams {
  limit?: number
  offset?: number
}

/** A skill the picker may offer for the job's chosen output kind. */
export interface AttachableSkill {
  name: string
  description: string
  /** Full body — the builder's WYSIWYG preview embeds it. */
  body: string
  metadata: Record<string, string>
  origin: 'org' | 'platform-clone' | 'platform'
}

// ============================================================
// Errors
// ============================================================

/**
 * Carries the BFF error `code` (e.g. `UNPROCESSABLE`, `CONFLICT`) alongside
 * the HTTP status so callers can react structurally — e.g. render cron
 * validation feedback inline vs. show a generic failure alert.
 */
export class JobApiError extends ApiRequestError {
  readonly code: string | null
  /** The raw server error message (without the client-added context prefix). */
  readonly serverMessage: string | null

  constructor(message: string, status: number, code: string | null, serverMessage: string | null) {
    super(message, status)
    this.name = 'JobApiError'
    this.code = code
    this.serverMessage = serverMessage
  }
}

// ============================================================
// Helpers
// ============================================================

const jobsBase = (projectId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/jobs`

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

const throwJobApiError = async (response: Response, context: string): Promise<never> => {
  const { message, code } = await parseErrorEnvelope(response)
  throw new JobApiError(
    `${context}: ${response.status}${message ? ` - ${message}` : ''}`,
    response.status,
    code,
    message,
  )
}

const jsonHeaders: HeadersInit = { 'Content-Type': 'application/json' }

// ============================================================
// Project jobs API
// ============================================================

/** List a project's jobs (BFF orders newest-created first). */
export const listJobs = async (projectId: string): Promise<Job[]> => {
  const response = await fetch(jobsBase(projectId), { headers: jsonHeaders })
  if (!response.ok) await throwJobApiError(response, 'Failed to list jobs')
  const data = (await response.json()) as { jobs?: Job[] } | Job[]
  // Accept either a bare array or a `{ jobs }` envelope.
  return Array.isArray(data) ? data : (data.jobs ?? [])
}

/** Fetch a single job with its saved skill snapshot, if it has one. */
export const getJob = async (projectId: string, jobId: string): Promise<Job> => {
  const response = await fetch(`${jobsBase(projectId)}/${encodeURIComponent(jobId)}`, {
    headers: jsonHeaders,
  })
  if (!response.ok) await throwJobApiError(response, 'Failed to load job')
  return (await response.json()) as Job
}

/**
 * Create a job. The server validates the prompt and the cron, and snapshots the
 * attached skill (when there is one) so a later edit to that skill cannot
 * change what this job sends.
 */
export const createJob = async (projectId: string, input: CreateJobInput): Promise<Job> => {
  const response = await fetch(jobsBase(projectId), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  if (!response.ok) await throwJobApiError(response, 'Failed to create job')
  // The route answers `{ job }` on create; tolerate a bare row too.
  const parsed = (await response.json()) as { job?: Job } | Job
  return 'job' in parsed && parsed.job !== undefined ? parsed.job : (parsed as Job)
}

/** Patch a job (re-resolves the snapshot and recomputes next_run_at). */
export const updateJob = async (
  projectId: string,
  jobId: string,
  input: UpdateJobInput,
): Promise<Job> => {
  const response = await fetch(`${jobsBase(projectId)}/${encodeURIComponent(jobId)}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  if (!response.ok) await throwJobApiError(response, 'Failed to update job')
  return (await response.json()) as Job
}

/** Delete a job (cascades its run history). */
export const deleteJob = async (projectId: string, jobId: string): Promise<void> => {
  const response = await fetch(`${jobsBase(projectId)}/${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    headers: jsonHeaders,
  })
  // 204 or 200 both count as success.
  if (!response.ok) await throwJobApiError(response, 'Failed to delete job')
}

/**
 * Fire a job manually. The route returns a structured result: `submitted` with
 * a backend job id, or a friendly `skipped` (e.g. org job caps / 429) — neither
 * is an error. A disabled job yields 409, surfaced as a thrown error.
 */
export const runJob = async (projectId: string, jobId: string): Promise<RunJobResult> => {
  const response = await fetch(`${jobsBase(projectId)}/${encodeURIComponent(jobId)}/run`, {
    method: 'POST',
    headers: jsonHeaders,
  })
  if (!response.ok) await throwJobApiError(response, 'Failed to run job')
  // The route returns the recorded run row; tolerate a wrapped result too.
  // The run row carries { status, jobId, detail, … }. Narrow from `unknown`
  // explicitly: the envelope/row ambiguity is a JSON boundary, not a type.
  const parsed: unknown = await response.json()
  const data: Partial<RunJobResult> =
    parsed !== null &&
    typeof parsed === 'object' &&
    'run' in parsed &&
    (parsed as { run?: object }).run !== undefined
      ? (parsed as { run: Partial<RunJobResult> }).run
      : (parsed as Partial<RunJobResult>)
  return {
    status: data.status === 'skipped' || data.status === 'error' ? data.status : 'submitted',
    jobId: data.jobId ?? null,
    detail: data.detail ?? null,
  }
}

/** List a job's run history (newest first). */
export const listJobRuns = async (
  projectId: string,
  jobId: string,
  params: ListJobRunsParams = {},
): Promise<JobRun[]> => {
  const search = new URLSearchParams()
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  if (params.offset !== undefined) search.set('offset', String(params.offset))
  const query = search.toString()
  const response = await fetch(
    `${jobsBase(projectId)}/${encodeURIComponent(jobId)}/runs${query ? `?${query}` : ''}`,
    { headers: jsonHeaders },
  )
  if (!response.ok) await throwJobApiError(response, 'Failed to list job runs')
  const data = (await response.json()) as { runs?: JobRun[] } | JobRun[]
  return Array.isArray(data) ? data : (data.runs ?? [])
}

/**
 * The skills a job with this output kind may attach.
 *
 * `chat` resolves against `shallow_researcher` and `deep-research` against
 * `deep_researcher`, both via `grid-agents` — so the picker can never offer a
 * skill the chosen output kind cannot run. Re-fetch when the output changes.
 */
export const listAttachableSkills = async (output: JobOutput): Promise<AttachableSkill[]> => {
  const response = await fetch(
    `/api/skills/attachable?output=${encodeURIComponent(output)}`,
    { headers: jsonHeaders },
  )
  if (!response.ok) await throwJobApiError(response, 'Failed to list attachable skills')
  const data = (await response.json()) as { skills?: AttachableSkill[] } | AttachableSkill[]
  return Array.isArray(data) ? data : (data.skills ?? [])
}
