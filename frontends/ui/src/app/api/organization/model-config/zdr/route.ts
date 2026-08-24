/**
 * Zero-Data-Retention policy toggle (ADR-0014 privacy control).
 *
 * PUT — `org:models:manage` holders only. When enabled, the model picker and
 *       the save-validation path are restricted to models with a ZDR endpoint,
 *       and the Python backend adds `provider.zdr` (+ `data_collection: deny`)
 *       to every OpenRouter request for the org. Persisted in the org settings
 *       JSON; audited.
 */

import { z } from 'zod'
import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { setOrgZdrOnly } from '@/lib/organizations/service'

const putSchema = z.object({ enabled: z.boolean() })

export const PUT = apiRoute(
  async ({ session, request }) => {
    const gated = requireFeature(session, FEATURE_FLAGS.modelConfiguration)
    if (gated) return gated
    const { enabled } = await parseJsonBody(request, putSchema)
    const zdrOnly = await setOrgZdrOnly(session, enabled, request)
    return { zdrOnly }
  },
  { authz: { permission: ORG_PERMISSIONS.modelsManage } }
)
