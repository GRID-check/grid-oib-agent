/** Version history of the org's model configuration. Org admins only. */

import { apiRoute } from '@/lib/api/handler'
import { ORG_PERMISSIONS } from '@/lib/authz/permissions'
import { FEATURE_FLAGS, requireFeature } from '@/lib/authz/feature-flags'
import { getOrgModelConfig, listVersions } from '@/lib/model-config/service'

export const GET = apiRoute(
  async ({ session }) => {
    const gated = requireFeature(session, FEATURE_FLAGS.modelConfiguration)
    if (gated) return gated
    const [versions, config] = await Promise.all([
      listVersions(session.organizationId),
      getOrgModelConfig(session.organizationId),
    ])
    return {
      versions,
      activeVersionId: config.activeVersion?.id ?? null,
    }
  },
  { permission: ORG_PERMISSIONS.modelsManage },
)
