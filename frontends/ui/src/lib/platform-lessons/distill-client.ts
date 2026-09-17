/**
 * HTTP client for the backend's `/v1/lesson-distill` route — the LLM half of
 * the platform-lessons pipeline (canonicalize + anonymize + match + audit).
 * Same transport discipline as the feedback digest (`lib/feedback/digest.ts`):
 * the BFF owns the data and the decision, the Python tier owns the model call,
 * and every failure returns a diagnosable error rather than throwing.
 */

import 'server-only'
import { getBackendUrl } from '@/lib/backend-proxy'
import type { DistillOutcome } from './types'

const DISTILL_TIMEOUT_MS = 60_000

const CATEGORIES = new Set(['inaccurate', 'too_slow', 'wrong_source', 'other'])

interface BackendDistillResponse {
  match_lesson_id?: string | null
  lesson?: string | null
  canonical_summary?: string | null
  category?: string | null
  generalizable?: boolean
  audit_passed?: boolean
  error?: string | null
}

export interface DistillRequest {
  /** Already PII-scrubbed and truncated by the service. */
  question: string | null
  answer: string | null
  reason: string | null
  comment: string | null
  /** The live register the matcher compares against (bounded). */
  existingLessons: { id: string; content: string }[]
}

/** One round trip to the distiller. Never throws. */
export async function distillReport(request: DistillRequest): Promise<DistillOutcome> {
  const failed = (error: string): DistillOutcome => ({
    matchLessonId: null,
    lesson: null,
    canonicalSummary: null,
    category: 'other',
    generalizable: false,
    auditPassed: false,
    error,
  })

  let response: Response
  try {
    response = await fetch(`${getBackendUrl()}/v1/lesson-distill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: request.question,
        answer: request.answer,
        reason: request.reason,
        comment: request.comment,
        existing_lessons: request.existingLessons.map((lesson) => ({
          id: lesson.id,
          content: lesson.content,
        })),
      }),
      signal: AbortSignal.timeout(DISTILL_TIMEOUT_MS),
    })
  } catch (error) {
    console.error('[PlatformLessons] Distill backend unreachable (non-fatal):', error)
    return failed('backend_unreachable')
  }

  if (!response.ok) {
    console.error('[PlatformLessons] Distill backend error:', response.status)
    return failed('backend_error')
  }

  let payload: BackendDistillResponse
  try {
    payload = (await response.json()) as BackendDistillResponse
  } catch {
    return failed('backend_error')
  }
  if (payload.error) return failed(payload.error)

  // Never trust shapes from over the wire: an unknown category falls back to
  // 'other' (the CHECK constraint would reject it otherwise), a match id must
  // be one the caller offered, and boolean gates default CLOSED.
  const matchLessonId =
    typeof payload.match_lesson_id === 'string' &&
    request.existingLessons.some((lesson) => lesson.id === payload.match_lesson_id)
      ? payload.match_lesson_id
      : null
  const category = CATEGORIES.has(payload.category ?? '')
    ? (payload.category as DistillOutcome['category'])
    : 'other'
  const lesson = typeof payload.lesson === 'string' ? payload.lesson.trim().slice(0, 500) : null
  const canonicalSummary =
    typeof payload.canonical_summary === 'string'
      ? payload.canonical_summary.trim().slice(0, 500)
      : null

  return {
    matchLessonId,
    lesson: lesson || null,
    canonicalSummary: canonicalSummary || null,
    category,
    generalizable: payload.generalizable === true,
    auditPassed: payload.audit_passed === true,
    error: null,
  }
}
