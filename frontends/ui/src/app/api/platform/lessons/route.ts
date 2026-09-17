/**
 * Platform → Lessons: the fleet-wide lesson register distilled from answer
 * feedback (docs/architecture/platform-failure-learning.md). Platform owners
 * only; thin adapters (ADR-0017) — logic and authorization live in
 * `@/lib/platform-lessons/service`.
 *
 * GET  — every lesson plus status counts, for the dashboard.
 * POST — run a manual catch-up sweep over unprocessed down-votes (the
 *        event-driven kick after each vote is the normal path; this exists for
 *        backlogs after an outage and for the first run over old feedback).
 */

import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { getLessonOverview, runLessonSweep } from '@/lib/platform-lessons/service'

export const GET = platformApiRoute(
  async ({ session }) => {
    return getLessonOverview(session)
  },
  { permission: PLATFORM_PERMISSIONS.settingsView }
)

export const POST = platformApiRoute(
  async ({ session }) => {
    return { result: await runLessonSweep(session) }
  },
  { permission: PLATFORM_PERMISSIONS.settingsManage }
)
