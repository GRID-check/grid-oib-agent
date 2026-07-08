/**
 * LLM spend summary (per-model day/month breakdown for the budget UI).
 *
 * Org admins see the org-wide summary (optionally narrowed with ?userId= /
 * ?projectId=); non-admin members always get their own usage only.
 */

import { NextResponse } from 'next/server'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { isOrgAdmin } from '@/lib/authz/organizations'
import { eurPerUsd, getBudgetStatus, getOrgBudget, getSpendByMember, getSpendSummary } from '@/lib/budgets/service'

export async function GET(request: Request): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const { searchParams } = new URL(request.url)
    const admin = isOrgAdmin(session)

    const filter: { userId?: string; projectId?: string } = {}
    if (admin) {
      const userId = searchParams.get('userId')
      const projectId = searchParams.get('projectId')
      if (userId) filter.userId = userId
      if (projectId) filter.projectId = projectId
    } else {
      filter.userId = session.userId
    }

    const [summary, orgBudget, status, perMember] = await Promise.all([
      getSpendSummary(session.organizationId, filter),
      getOrgBudget(session.organizationId),
      getBudgetStatus(session.organizationId, session.userId, null),
      // Member breakdown feeds the admin member-usage table only.
      admin ? getSpendByMember(session.organizationId) : Promise.resolve(null),
    ])

    return NextResponse.json({
      summary,
      perMember,
      orgBudget: {
        dailyLimitEur: orgBudget.dailyLimitEur,
        monthlyLimitEur: orgBudget.monthlyLimitEur,
        explicit: orgBudget.explicit,
      },
      status,
      eurPerUsd: eurPerUsd(),
      scope: admin ? filter : { userId: session.userId },
    })
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
