/**
 * One platform lesson: the audit drill-in and the owner mutations
 * (docs/architecture/platform-failure-learning.md). Thin adapters (ADR-0017).
 *
 * GET   — the lesson, its append-only event trail, and its provenance rows
 *         (feedback uuids + org hashes + anonymized summaries — never the raw
 *         reports; those stay behind the tenant boundary).
 * PATCH — activate / retire / edit / root-cause status. Audited to WorkOS
 *         (platform.lesson.updated) on top of the event trail.
 */

import { z } from 'zod'
import { NotFoundError } from '@/lib/api/errors'
import { parseJsonBody } from '@/lib/api/handler'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { getLessonProvenance, updateLesson } from '@/lib/platform-lessons/service'
import { updateLessonSchema } from '@/lib/platform-lessons/types'

const lessonIdSchema = z.string().uuid()

/** A path segment that is not a uuid names nothing — 404, not a 500. */
function parseLessonId(params: { lessonId?: string | string[] }): string {
  const parsed = lessonIdSchema.safeParse(params.lessonId)
  if (!parsed.success) throw new NotFoundError('Unknown lesson.')
  return parsed.data
}

export const GET = platformApiRoute<{ lessonId?: string | string[] }>(
  async ({ session, params }) => {
    return getLessonProvenance(session, parseLessonId(params))
  },
  { permission: PLATFORM_PERMISSIONS.settingsView }
)

export const PATCH = platformApiRoute<{ lessonId?: string | string[] }>(
  async ({ session, request, params }) => {
    const input = await parseJsonBody(request, updateLessonSchema)
    return { lesson: await updateLesson(session, parseLessonId(params), input, request) }
  },
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)
