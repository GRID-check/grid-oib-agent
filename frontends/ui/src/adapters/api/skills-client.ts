/**
 * Agent Skills API Client
 *
 * Typed fetch client for the org toolbox BFF endpoints (`/api/skills…`). These
 * are grid_app-owned BFF routes, so they are always called same-origin and
 * return the camelCase JSON envelope the BFF service layer produces.
 *
 * Jobs — a prompt on a timer, which MAY attach one of these skills — live in
 * `./jobs-client`. A skill knows nothing about time, and neither does this
 * module.
 *
 * Contract mirrors docs/architecture/agent-skills.md ("BFF API" section) and
 * ADR-0046. The server owns validation (reserved metadata, name rules); this
 * client only transports the documented shapes and surfaces the BFF error
 * envelope (`{ error, code }`).
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
  /** Full instruction body — carried so the job builder's preview needs no extra fetch. */
  body: string
  metadata: Record<string, string>
  /** 'platform' = builtin fallback; 'org'/'platform-clone' = DB rows. */
  origin: 'org' | 'platform-clone' | 'platform'
  enabled: boolean
  clonedFrom: string | null
  createdAt: string | null
  updatedAt: string | null
}

/** The deterministic snapshot a job (and every run) pins. */
export interface SkillSnapshot {
  name: string
  description: string
  body: string
  metadata: Record<string, string>
  origin: 'org' | 'platform-clone' | 'platform'
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
  /** The rulebook check that produced this, or '' when none was named. */
  check?: string
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

/** Delete an org skill (jobs keep their saved snapshot). */
export const deleteSkill = async (skillId: string): Promise<void> => {
  const response = await fetch(`${skillsBase}/${encodeURIComponent(skillId)}`, {
    method: 'DELETE',
    headers: jsonHeaders,
  })
  // 204 or 200 both count as success.
  if (!response.ok) await throwSkillApiError(response, 'Failed to delete skill')
}
