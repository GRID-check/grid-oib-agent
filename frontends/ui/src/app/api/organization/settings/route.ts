/**
 * Organization settings API (Grid-side org record).
 *
 * GET — any member may read their org's settings.
 * PUT — `org:settings:manage` holders only; merges the provided fields.
 *       Refuses (400) keys a dedicated route owns — `zdrOnly` is switched only
 *       through `PUT /api/organization/model-config/zdr`, under
 *       `org:models:manage` — and (403) platform-owned keys. Both refusals live
 *       in `updateOrgSettings`, so no other endpoint can reopen them.
 * Thin handlers; all logic lives in `@/lib/organizations/service`.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { getOrgSettings, saveOrgSettings } from '@/lib/organizations/service'
import { locales } from '@/i18n/config'
import { CHAT_EFFORT_SETTING, CHAT_EFFORTS, isChatEffort } from '@/lib/reasoning-settings/catalog'

const putSchema = z.object({
  displayName: z.string().trim().max(200).nullable().optional(),
  defaultLocale: z.enum(locales).optional(),
  settings: z
    .record(z.unknown())
    .refine((bag) => !(CHAT_EFFORT_SETTING in bag) || isChatEffort(bag[CHAT_EFFORT_SETTING]), {
      message: `${CHAT_EFFORT_SETTING} must be one of: ${CHAT_EFFORTS.join(', ')}`,
      path: [CHAT_EFFORT_SETTING],
    })
    .optional(),
})

export const GET = apiRoute(
  async ({ session }) => ({ settings: await getOrgSettings(session.organizationId) }),
  {
    authz: {
      sessionOnly: true,
      why: "every member may read their own organization's settings; the read is keyed by session.organizationId and writes require org:settings:manage below",
    },
  }
)

export const PUT = apiRoute(
  async ({ session, request }) => {
    const patch = await parseJsonBody(request, putSchema)
    return { settings: await saveOrgSettings(session, patch, request) }
  },
  { authz: { permission: ORG_PERMISSIONS.settingsManage } }
)
