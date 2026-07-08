/**
 * Organization settings API (Grid-side org record).
 *
 * GET — any member may read their org's settings.
 * PUT — `org:settings:manage` holders only; merges the provided fields.
 * Thin handlers; all logic lives in `@/lib/organizations/service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { getOrgSettings, saveOrgSettings } from '@/lib/organizations/service'
import { locales } from '@/i18n/config'

const putSchema = z.object({
  displayName: z.string().trim().max(200).nullable().optional(),
  defaultLocale: z.enum(locales).optional(),
  settings: z.record(z.unknown()).optional(),
})

export const GET = apiRoute(async ({ session }) => ({
  settings: await getOrgSettings(session.organizationId),
}))

export const PUT = apiRoute(
  async ({ session, request }) => {
    const patch = await parseJsonBody(request, putSchema)
    return { settings: await saveOrgSettings(session, patch, request) }
  },
  { permission: ORG_PERMISSIONS.settingsManage },
)
