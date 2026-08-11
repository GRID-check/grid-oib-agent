import 'server-only'

/**
 * Skill review — the second opinion an author gets while writing a skill.
 *
 * Structural validation (`types.ts`) decides whether a skill is LEGAL and
 * blocks the save when it is not. This decides whether it is any GOOD, and
 * blocks nothing. The two fail in completely different ways: an illegal skill
 * is rejected with a clear message, while a legal-but-poor one saves cleanly,
 * sits in the toolbox, and then never triggers — which to its author looks like
 * the product being broken rather than like the description being too vague to
 * match anything. That failure produces no error anywhere, so the only place to
 * catch it is while the skill is still being written.
 *
 * Judging that is not a job for pattern-matching. Whether a description will
 * actually match the requests people make is a question about meaning, so it is
 * asked of a model — the same shape as the intake consistency-check
 * (`profile-service.ts`), and for the same reason.
 *
 * BEST-EFFORT, ALWAYS. Every failure — no key, timeout, non-2xx, malformed
 * payload — resolves to `{ findings: null, error }`. A review outage must never
 * stand between someone and saving their work.
 */

import { getBackendUrl } from '@/lib/backend-proxy'
import { requireSkillsEnabled } from '@/lib/authz/feature-flags'
import { ForbiddenError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'

/** A review is a nicety; a slow one is worse than none. */
const REVIEW_TIMEOUT_MS = 20_000

export const SKILL_FINDING_SEVERITIES = ['error', 'warning', 'suggestion'] as const
export type SkillFindingSeverity = (typeof SKILL_FINDING_SEVERITIES)[number]

export const SKILL_FINDING_FIELDS = ['name', 'description', 'body'] as const
export type SkillFindingField = (typeof SKILL_FINDING_FIELDS)[number]

export interface SkillReviewFinding {
  severity: SkillFindingSeverity
  field: SkillFindingField
  /** What is wrong, in one sentence, in the skill's own language. */
  message: string
  /** What to do about it. */
  fix: string
}

export interface SkillReviewResult {
  /** `null` means the review could not run — never "the skill is perfect". */
  findings: SkillReviewFinding[] | null
  error?: string
}

export interface SkillReviewInput {
  name: string
  description: string
  body: string
}

/** Defensive bounds on a model-authored list, applied before it reaches a UI. */
const MAX_FINDINGS = 12
const MAX_TEXT = 400

function toFinding(raw: unknown): SkillReviewFinding | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  const severity = entry.severity
  const field = entry.field
  const message = entry.message
  const fix = entry.fix
  if (!SKILL_FINDING_SEVERITIES.includes(severity as SkillFindingSeverity)) return null
  if (!SKILL_FINDING_FIELDS.includes(field as SkillFindingField)) return null
  if (typeof message !== 'string' || !message.trim()) return null
  return {
    severity: severity as SkillFindingSeverity,
    field: field as SkillFindingField,
    message: message.trim().slice(0, MAX_TEXT),
    fix: typeof fix === 'string' ? fix.trim().slice(0, MAX_TEXT) : '',
  }
}

/**
 * Review a skill draft. Any org member who may reach the skills feature may ask
 * for one: reviewing text you are typing is not a privileged action, and gating
 * it behind `org:skills:manage` would mean the check only reached people who
 * already know how to write a skill.
 */
export async function reviewSkill(
  session: AuthorizedSession,
  input: SkillReviewInput,
): Promise<SkillReviewResult> {
  if (requireSkillsEnabled(session)) {
    throw new ForbiddenError('Agent Skills is disabled.')
  }

  try {
    const response = await fetch(`${getBackendUrl()}/v1/skills/review`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Forwarded so the backend resolves this org's BYOK credential, exactly
        // as the sibling LLM routes do.
        'x-grid-organization-id': session.organizationId,
      },
      body: JSON.stringify({
        name: input.name,
        description: input.description,
        body: input.body,
        organization_id: session.organizationId,
      }),
      signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS),
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      console.warn('[SkillReview] Backend error (non-fatal):', response.status, detail)
      return { findings: null, error: 'review_failed' }
    }

    const payload = (await response.json()) as {
      findings?: unknown
      error?: string | null
    }
    if (!Array.isArray(payload.findings)) {
      return { findings: null, error: payload.error ?? 'review_unavailable' }
    }
    return {
      findings: payload.findings
        .map(toFinding)
        .filter((finding): finding is SkillReviewFinding => finding !== null)
        .slice(0, MAX_FINDINGS),
      error: payload.error ?? undefined,
    }
  } catch (error) {
    console.warn('[SkillReview] Request failed (non-fatal):', error)
    return { findings: null, error: 'review_request_failed' }
  }
}
