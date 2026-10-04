import { parseJsonBody } from '@/lib/api/handler'
import { platformApiRoute } from '@/lib/api/platform-handler'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { platformOrgBudgetPutSchema } from '@/lib/budgets/platform-contract'
import { getPlatformOrgBudget, savePlatformOrgBudget } from '@/lib/budgets/platform-service'

interface Params {
  organizationId: string
}

export const GET = platformApiRoute<Params>(
  async ({ session, params }) => getPlatformOrgBudget(session, params.organizationId),
  { permission: PLATFORM_PERMISSIONS.organizationsView },
)

export const PUT = platformApiRoute<Params>(
  async ({ session, params, request }) =>
    savePlatformOrgBudget(session, params.organizationId, await parseJsonBody(request, platformOrgBudgetPutSchema), request),
  { permission: PLATFORM_PERMISSIONS.organizationsManage },
)
