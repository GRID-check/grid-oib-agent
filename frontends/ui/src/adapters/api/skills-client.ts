/**
 * Agent Skills API Client
 *
 * Typed fetch client for the Agent Skills BFF endpoints: the org toolbox
 * (`/api/skills…`) and the project-scoped skill schedules
 * (`/api/projects/[id]/skill-schedules…`). These are grid_app-owned BFF
 * routes, so they are always called same-origin and return the camelCase JSON
 * envelope the BFF service layer produces.
 *
 * Contract mirrors docs/architecture/agent-skills.md ("BFF API" section) and
 * ADR-0046. The server owns validation (cron / min-interval, reserved
 * metadata, name rules) and snapshot semantics; this client only transports
 * the documented shapes and surfaces the BFF error envelope (`{ error, code }`).
 *
 * Style follows src/adapters/api/research-runs-client.ts.
 */

import { ApiRequestError } from './api-error'

// ============================================================
// Types (self-contained — mirror the documented JSON contract so the UI
// stays decoupled from @/lib/skills internals)
// ============================================================

/**
 * A merged toolbox row (GET /api/skills): builtin platform skills have no DB
 * row yet (id null, always enabled); org-authored and cloned rows carry their
 * id and lifecycle timestamps.
 */
export interface SkillListItem {
  id: string | null
  name: string
  description: string
  /** Full instruction body — carried so the schedule builder's preview needs no extra fetch. */
  body: string
  metadata: Record<string, string>
  /** 'platform' = builtin fallback; 'org'/'platform-clone' = DB rows. */
  origin: 'org' | 'platform-clone' | 'platform'
  enabled: boolean
  clonedFrom: string | null
  createdAt: string | null
  updatedAt: string | null
}

/** The deterministic snapshot a schedule (and every run) carries. */
export interface SkillSnapshot {
  name: string
  description: string
  body: string
  metadata: Record<string, string>
  origin: 'org' | 'platform-clone' | 'platform'
}

/** Execution mode a skill demands via its reserved metadata. */
export type SkillExecution = 'chat' | 'deep-research'

/** Manual vs scheduled trigger for a run. */
export type SkillRunTrigger = 'manual' | 'schedule'

/** Submission outcome of a run (live job progress lives in the backend). */
export type SkillRunStatus = 'submitted' | 'skipped' | 'error'

/** A project skill schedule row (skill_schedules). */
export interface SkillSchedule {
  id: string
  projectId: string
  name: string
  skillName: string
  skillSnapshot: SkillSnapshot
  execution: SkillExecution
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

/** A single append-only run-history entry. */
export interface SkillRun {
  id: string
  scheduleId: string
  jobId: string | null
  trigger: SkillRunTrigger
  status: SkillRunStatus
  detail: string | null
  skillSnapshot: SkillSnapshot
  triggeredBy: string | null
  createdAt: string
}

/** Structured result of a manual `POST …/run`. */
export interface RunSkillScheduleResult {
  status: SkillRunStatus
  jobId?: string | null
  detail?: string | null
}

/** Org-toolbox create payload (`POST /api/skills`). */
export interface CreateSkillInput {
  name: string
  description: string
  body: string
  metadata?: Record<string, string>
  enabled?: boolean
  /** Platform skill name this was cloned from (marks origin platform-clone). */
  clonedFrom?: string
}

/** Partial update payload for `PATCH /api/skills/[skillId]`. */
export type UpdateSkillInput = Partial<CreateSkillInput>

/** Project schedule create payload (`POST …/skill-schedules`). */
export interface CreateSkillScheduleInput {
  name: string
  skillName: string
  dataSources?: string[] | null
  enabled?: boolean
  scheduleCron?: string | null
  scheduleTimezone?: string
}

/** Partial update payload for `PATCH …/skill-schedules/[scheduleId]`. */
export type UpdateSkillScheduleInput = Partial<CreateSkillScheduleInput>

export interface ListSkillRunsParams {
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
export class SkillApiError extends ApiRequestError {
  readonly code: string | null
  /** The raw server error message (without the client-added context prefix). */
  readonly serverMessage: string | null

  constructor(message: string, status: number, code: string | null, serverMessage: string | null) {
    super(message, status)
    this.name = 'SkillApiError'
    this.code = code
    this.serverMessage = serverMessage
  }
}

// ============================================================
// Helpers
// ============================================================

const skillsBase = '/api/skills'
const schedulesBase = (projectId: string): string =>
  `/api/projects/${encodeURIComponent(projectId)}/skill-schedules`

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

const throwSkillApiError = async (response: Response, context: string): Promise<never> => {
  const { message, code } = await parseErrorEnvelope(response)
  throw new SkillApiError(
    `${context}: ${response.status}${message ? ` - ${message}` : ''}`,
    response.status,
    code,
    message,
  )
}

const jsonHeaders: HeadersInit = { 'Content-Type': 'application/json' }

// ============================================================
// Org toolbox API
// ============================================================

/** The merged toolbox list: every builtin platform skill plus org rows. */
export const listSkills = async (): Promise<SkillListItem[]> => {
  const response = await fetch(skillsBase, { headers: jsonHeaders })
  if (!response.ok) await throwSkillApiError(response, 'Failed to list skills')
  const data = (await response.json()) as { skills?: SkillListItem[] } | SkillListItem[]
  // Accept either a bare array or a `{ skills }` envelope.
  return Array.isArray(data) ? data : (data.skills ?? [])
}

/** One entry of the composer's `/` menu — level-1 metadata only, no body. */
export interface InvocableSkill {
  name: string
  description: string
  origin: 'org' | 'platform-clone' | 'platform'
}

/**
 * The skills this member may invoke with `/name` in chat.
 *
 * Separate from `listSkills` on purpose. That one serves the toolbox and
 * carries every skill in the org WITH its instruction body; this one carries
 * only what the composer menu shows and the agent's own catalogue holds — name
 * and description — filtered to the skills a chat turn can actually run. A
 * composer that downloaded every skill body to render a menu would be shipping
 * level-2 content to draw a level-1 surface.
 */
export const listInvocableSkills = async (): Promise<InvocableSkill[]> => {
  const response = await fetch(`${skillsBase}/invocable`, { headers: jsonHeaders })
  if (!response.ok) await throwSkillApiError(response, 'Failed to list invocable skills')
  const data = (await response.json()) as { skills?: InvocableSkill[] } | InvocableSkill[]
  return Array.isArray(data) ? data : (data.skills ?? [])
}

/** One thing the reviewer thinks is wrong with a skill draft. */
export interface SkillReviewFinding {
  severity: 'error' | 'warning' | 'suggestion'
  field: 'name' | 'description' | 'body'
  message: string
  fix: string
}

export interface SkillReviewResult {
  /** `null` means the review could not run — never "the skill is perfect". */
  findings: SkillReviewFinding[] | null
  error?: string
}

/**
 * Ask the backend reviewer to critique a skill draft.
 *
 * Never throws and never rejects: a review is advisory, so a failure resolves
 * to `{ findings: null }` and the editor simply says it could not check this
 * time. The caller must not treat that as "no problems found".
 */
export const reviewSkill = async (input: {
  name: string
  description: string
  body: string
}): Promise<SkillReviewResult> => {
  try {
    const response = await fetch(`${skillsBase}/review`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(input),
    })
    if (!response.ok) return { findings: null, error: 'review_failed' }
    return (await response.json()) as SkillReviewResult
  } catch {
    return { findings: null, error: 'review_request_failed' }
  }
}

/** Author a skill in the org toolbox (requires org:skills:manage). */
export const createSkill = async (input: CreateSkillInput): Promise<SkillListItem> => {
  const response = await fetch(skillsBase, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  if (!response.ok) await throwSkillApiError(response, 'Failed to create skill')
  return (await response.json()) as SkillListItem
}

/** Patch an org skill (re-validates reserved metadata at the write boundary). */
export const updateSkill = async (skillId: string, input: UpdateSkillInput): Promise<SkillListItem> => {
  const response = await fetch(`${skillsBase}/${encodeURIComponent(skillId)}`, {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  if (!response.ok) await throwSkillApiError(response, 'Failed to update skill')
  return (await response.json()) as SkillListItem
}

/** Delete an org skill (schedules keep their saved snapshot). */
export const deleteSkill = async (skillId: string): Promise<void> => {
  const response = await fetch(`${skillsBase}/${encodeURIComponent(skillId)}`, {
    method: 'DELETE',
    headers: jsonHeaders,
  })
  // 204 or 200 both count as success.
  if (!response.ok) await throwSkillApiError(response, 'Failed to delete skill')
}

// ============================================================
// Project skill-schedule API
// ============================================================

/** List a project's skill schedules (BFF orders newest-created first). */
export const listSkillSchedules = async (projectId: string): Promise<SkillSchedule[]> => {
  const response = await fetch(schedulesBase(projectId), { headers: jsonHeaders })
  if (!response.ok) await throwSkillApiError(response, 'Failed to list skill schedules')
  const data = (await response.json()) as
    | { schedules?: SkillSchedule[] }
    | SkillSchedule[]
  // Accept either a bare array or a `{ schedules }` envelope.
  return Array.isArray(data) ? data : (data.schedules ?? [])
}

/** Fetch a single skill schedule with its saved skill snapshot. */
export const getSkillSchedule = async (
  projectId: string,
  scheduleId: string,
): Promise<SkillSchedule> => {
  const response = await fetch(
    `${schedulesBase(projectId)}/${encodeURIComponent(scheduleId)}`,
    { headers: jsonHeaders },
  )
  if (!response.ok) await throwSkillApiError(response, 'Failed to load skill schedule')
  return (await response.json()) as SkillSchedule
}

/** Create a schedule. The server snapshots the skill and validates the cron. */
export const createSkillSchedule = async (
  projectId: string,
  input: CreateSkillScheduleInput,
): Promise<SkillSchedule> => {
  const response = await fetch(schedulesBase(projectId), {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify(input),
  })
  if (!response.ok) await throwSkillApiError(response, 'Failed to create skill schedule')
  return (await response.json()) as SkillSchedule
}

/** Patch a schedule (re-resolves the snapshot and recomputes next_run_at). */
export const updateSkillSchedule = async (
  projectId: string,
  scheduleId: string,
  input: UpdateSkillScheduleInput,
): Promise<SkillSchedule> => {
  const response = await fetch(
    `${schedulesBase(projectId)}/${encodeURIComponent(scheduleId)}`,
    {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify(input),
    },
  )
  if (!response.ok) await throwSkillApiError(response, 'Failed to update skill schedule')
  return (await response.json()) as SkillSchedule
}

/** Delete a schedule (cascades its run history). */
export const deleteSkillSchedule = async (
  projectId: string,
  scheduleId: string,
): Promise<void> => {
  const response = await fetch(
    `${schedulesBase(projectId)}/${encodeURIComponent(scheduleId)}`,
    { method: 'DELETE', headers: jsonHeaders },
  )
  // 204 or 200 both count as success.
  if (!response.ok) await throwSkillApiError(response, 'Failed to delete skill schedule')
}

/**
 * Fire a skill schedule manually. The route returns a structured result:
 * `submitted` with a job id, or a friendly `skipped` (e.g. org job caps /
 * 429) — neither is an error. A disabled schedule yields 409, surfaced as a
 * thrown error.
 */
export const runSkillSchedule = async (
  projectId: string,
  scheduleId: string,
): Promise<RunSkillScheduleResult> => {
  const response = await fetch(
    `${schedulesBase(projectId)}/${encodeURIComponent(scheduleId)}/run`,
    { method: 'POST', headers: jsonHeaders },
  )
  if (!response.ok) await throwSkillApiError(response, 'Failed to run skill schedule')
  // The route returns the recorded run row; tolerate a wrapped result too.
  // The run row carries { status, jobId, detail, … }. Narrow from `unknown`
  // explicitly: the envelope/row ambiguity is a JSON boundary, not a type.
  const parsed: unknown = await response.json()
  const data: Partial<RunSkillScheduleResult> =
    parsed !== null &&
    typeof parsed === 'object' &&
    'run' in parsed &&
    (parsed as { run?: object }).run !== undefined
      ? (parsed as { run: Partial<RunSkillScheduleResult> }).run
      : (parsed as Partial<RunSkillScheduleResult>)
  return {
    status: data.status === 'skipped' || data.status === 'error' ? data.status : 'submitted',
    jobId: data.jobId ?? null,
    detail: data.detail ?? null,
  }
}

/** List a schedule's run history (newest first). */
export const listSkillRuns = async (
  projectId: string,
  scheduleId: string,
  params: ListSkillRunsParams = {},
): Promise<SkillRun[]> => {
  const search = new URLSearchParams()
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  if (params.offset !== undefined) search.set('offset', String(params.offset))
  const query = search.toString()
  const response = await fetch(
    `${schedulesBase(projectId)}/${encodeURIComponent(scheduleId)}/runs${query ? `?${query}` : ''}`,
    { headers: jsonHeaders },
  )
  if (!response.ok) await throwSkillApiError(response, 'Failed to list skill schedule runs')
  const data = (await response.json()) as { runs?: SkillRun[] } | SkillRun[]
  return Array.isArray(data) ? data : (data.runs ?? [])
}