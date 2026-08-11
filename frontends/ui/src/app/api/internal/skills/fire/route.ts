/**
 * INTERNAL skill fire endpoint - the scheduler POSTs `{ scheduleId }` here
 * after it has claimed a due row and advanced its next_run_at. Shared-token
 * guarded (GRID_INTERNAL_API_TOKEN via `internalApiRoute`, like
 * /api/internal/workflows/fire).
 *
 * Loads the schedule with NO session (the scheduler has none) and delegates to
 * `fireScheduledSkillSchedule`, which re-checks `enabled` (the row may have
 * been disabled since the claim) and the org's `skills` feature gate before
 * firing through the single `fireSkillSchedule` path.
 */

import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { withPlatformAccess, withTenant } from '@/lib/db/tenant-context'
import { NotFoundError } from '@/lib/api/errors'
import { fireScheduledSkillSchedule, loadSkillScheduleForFire } from '@/lib/skills/service'
import { internalFireSchema } from '@/lib/skills/types'

export const POST = internalApiRoute(
  'Skill Fire',
  async ({ request }) => {
    const { scheduleId } = await parseJsonBody(request, internalFireSchema)

    // Narrow on purpose: the BYPASS covers only the lookup that genuinely has
    // no tenant yet. Everything the run then does - recording the run, reading
    // budgets, building the project scope - is one organization's work and is
    // done as that organization, so row-level security still applies to it.
    const schedule = await withPlatformAccess(
      'skill fire: the scheduler identifies work by id, before any organization is known',
      () => loadSkillScheduleForFire(scheduleId)
    )
    if (!schedule) throw new NotFoundError('Unknown skill schedule')

    return withTenant({ organizationId: schedule.organizationId }, () =>
      fireScheduledSkillSchedule(schedule)
    )
  },
  { tenancy: { fromPayload: 'the skill schedule row named by body.scheduleId' } }
)