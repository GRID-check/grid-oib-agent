import 'server-only'
import type { GridSession } from '@/lib/auth/types'
import type { BudgetPolicy } from '@/lib/db/schema'
import { hasPlatformPermission, requirePlatformPermission } from '@/lib/authz/platform'
import { PLATFORM_PERMISSIONS } from '@/lib/authz/permissions'
import { withTenant } from '@/lib/db/tenant-context'
import { getWorkOS } from '@/lib/workos/client'
import { NotFoundError, UnprocessableError } from '@/lib/api/errors'
import { recordAuditEvent } from '@/lib/audit/service'
import { BudgetValidationError, getOrgBudget, getSpendTotals, setBudgetPolicy } from './service'
import { platformOrgBudgetPutSchema, type PlatformOrgBudget, type PlatformOrgBudgetInput } from './platform-contract'

async function requireOrganization(organizationId: string): Promise<void> {
  try {
    await getWorkOS().organizations.getOrganization(organizationId)
  } catch (error) {
    if (error instanceof Error && 'status' in error && error.status === 404) {
      throw new NotFoundError('Organization not found')
    }
    throw error
  }
}

async function readBudget(session: GridSession, organizationId: string): Promise<PlatformOrgBudget> {
  return withTenant({ organizationId, userId: session.userId }, async () => {
    const [budget, spend, canManage] = await Promise.all([
      getOrgBudget(organizationId),
      getSpendTotals(organizationId),
      hasPlatformPermission(session, PLATFORM_PERMISSIONS.organizationsManage),
    ])
    return {
      organizationId,
      unit: budget.unit,
      dailyLimit: budget.dailyLimit,
      monthlyLimit: budget.monthlyLimit,
      explicit: budget.explicit,
      dayUsed: budget.unit === 'token' ? spend.day.tokens : spend.day.credits,
      monthUsed: budget.unit === 'token' ? spend.month.tokens : spend.month.credits,
      canManage,
    }
  })
}

export async function getPlatformOrgBudget(session: GridSession, organizationId: string): Promise<PlatformOrgBudget> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.organizationsView)
  await requireOrganization(organizationId)
  return readBudget(session, organizationId)
}

export async function savePlatformOrgBudget(
  session: GridSession,
  organizationId: string,
  input: PlatformOrgBudgetInput,
  request: Request,
): Promise<PlatformOrgBudget> {
  await requirePlatformPermission(session, PLATFORM_PERMISSIONS.organizationsManage)
  await requireOrganization(organizationId)
  const parsed = platformOrgBudgetPutSchema.safeParse(input)
  if (!parsed.success) throw new UnprocessableError('Invalid organization budget')

  await withTenant({ organizationId, userId: session.userId }, async () => {
    let policy: BudgetPolicy
    try {
      policy = await setBudgetPolicy({
        organizationId,
        scope: 'organization',
        subjectId: null,
        dailyLimit: parsed.data.dailyLimit,
        monthlyLimit: parsed.data.monthlyLimit,
        expectedUnit: parsed.data.unit,
        actorUserId: session.userId,
        note: parsed.data.note,
      })
    } catch (error) {
      if (error instanceof BudgetValidationError) throw new UnprocessableError(error.message)
      throw error
    }
    await recordAuditEvent({
      organizationId,
      actor: { userId: session.userId, email: session.email },
      action: 'budget.policy.set',
      targetType: 'budget_policy',
      targetId: policy.id,
      metadata: {
        scope: 'organization',
        subjectId: null,
        unit: policy.currency,
        dailyLimit: parsed.data.dailyLimit,
        monthlyLimit: parsed.data.monthlyLimit,
      },
      request,
    })
  })
  return readBudget(session, organizationId)
}
