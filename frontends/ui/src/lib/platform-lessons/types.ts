/**
 * Platform-lessons domain — shared shapes and zod schemas
 * (docs/architecture/platform-failure-learning.md).
 */

import { z } from 'zod'
import {
  PLATFORM_LESSON_ROOT_CAUSE_STATUSES,
  type PlatformLesson,
} from '@/lib/db/schema'

/**
 * Ceilings for what one report contributes to a distillation prompt. Bounded
 * here AND re-bounded by the backend route — a route that trusts its caller's
 * bounds is one refactor away from posting a megabyte of chat history.
 */
export const MAX_DISTILL_QUESTION_CHARS = 600
export const MAX_DISTILL_ANSWER_CHARS = 1500
export const MAX_DISTILL_COMMENT_CHARS = 600
/** Lessons handed to the matcher per call — the register is capped anyway. */
export const MAX_DISTILL_REGISTER_SIZE = 60

/** PATCH /api/platform/lessons/[lessonId] — every field optional, all audited. */
export const updateLessonSchema = z
  .object({
    /** Lifecycle transitions. 'candidate' is not a target — retire instead. */
    status: z.enum(['active', 'retired']).optional(),
    /** Replacement lesson text (platform owner editing the wording). */
    content: z.string().trim().min(1).max(500).optional(),
    rootCauseStatus: z.enum(PLATFORM_LESSON_ROOT_CAUSE_STATUSES).optional(),
    rootCauseNote: z.string().trim().max(1000).nullable().optional(),
    /** Free-text reason for a retire, kept in the trail. */
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Empty patch.' })

export type UpdateLessonInput = z.infer<typeof updateLessonSchema>

/** What the distiller backend returns for one report (already sanitized). */
export interface DistillOutcome {
  /** Id of the existing lesson this report restates, when the matcher found one. */
  matchLessonId: string | null
  /** New lesson text (anonymized, German) when no existing lesson matched. */
  lesson: string | null
  /** One anonymized sentence restating what went wrong in THIS report. */
  canonicalSummary: string | null
  category: 'inaccurate' | 'too_slow' | 'wrong_source' | 'other'
  /** False when the complaint is instance-specific and teaches the fleet nothing. */
  generalizable: boolean
  /** The auditor model's verdict on the distilled text. */
  auditPassed: boolean
  error: string | null
}

/** One lesson as the platform dashboard renders it. */
export interface PlatformLessonView {
  id: string
  content: string
  category: PlatformLesson['category']
  status: PlatformLesson['status']
  heldReason: string | null
  reportCount: number
  orgCount: number
  firstReportedAt: string
  lastReportedAt: string
  activatedAt: string | null
  activatedBy: string | null
  retiredAt: string | null
  retiredReason: string | null
  rootCauseStatus: PlatformLesson['rootCauseStatus']
  rootCauseNote: string | null
  createdAt: string
  updatedAt: string
}

export function toLessonView(row: PlatformLesson): PlatformLessonView {
  return {
    id: row.id,
    content: row.content,
    category: row.category,
    status: row.status,
    heldReason: row.heldReason ?? null,
    reportCount: row.reportCount,
    orgCount: row.orgCount,
    firstReportedAt: row.firstReportedAt.toISOString(),
    lastReportedAt: row.lastReportedAt.toISOString(),
    activatedAt: row.activatedAt?.toISOString() ?? null,
    activatedBy: row.activatedBy ?? null,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    retiredReason: row.retiredReason ?? null,
    rootCauseStatus: row.rootCauseStatus,
    rootCauseNote: row.rootCauseNote ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}
