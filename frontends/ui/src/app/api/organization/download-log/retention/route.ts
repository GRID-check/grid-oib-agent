/**
 * How long the organization keeps its download log.
 *
 * PUT — `org:settings:manage`. The only writer of
 *       `settings.downloadLogRetentionDays` (the generic settings save refuses
 *       the key): whole days from 30 to 365, never longer. Audited with the
 *       value before and after. A shorter time takes effect at the next daily
 *       purge by the scheduler.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { setDownloadLogRetentionDays } from '@/lib/download-log/service'

const putSchema = z.object({ days: z.number().int() })

export const PUT = apiRoute(
  async ({ session, request }) => {
    const { days } = await parseJsonBody(request, putSchema)
    return setDownloadLogRetentionDays(session, days, request)
  },
  { authz: { permission: ORG_PERMISSIONS.settingsManage } }
)
