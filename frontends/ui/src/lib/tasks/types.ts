import { z } from 'zod'
import { TASK_REVIEWS } from '@/lib/db/schema'

/** Bound on a reviewer's reason: it is quoted into the next run's prompt. */
export const REVIEW_REASON_MAX_CHARS = 1000

export const reviewTaskSchema = z.object({
  decision: z.enum(TASK_REVIEWS),
  reason: z.string().trim().max(REVIEW_REASON_MAX_CHARS).optional(),
})
export type ReviewTaskInput = z.infer<typeof reviewTaskSchema>
