/**
 * LLM budget policies.
 *
 * GET — members see the org limits + their own member limit; org admins
 *       additionally get every active member/project policy.
 * PUT — sets a policy. Org and member scopes: org admins only. Project
 *       scope: org admins or that project's admins. Member/project limits
 *       are validated against the org limits in the service layer.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authzErrorResponse, requireAuthorizedSession } from '@/lib/auth/require-auth'
import { isOrgAdmin } from '@/lib/authz/organizations'
import { requireProjectAccess } from '@/lib/authz/projects'
import type { AuthorizedSession } from '@/lib/auth/types'
import {
  BudgetValidationError,
  clearBudgetPolicy,
  getOrgBudget,
  getScopedBudget,
  listActivePolicies,
  setBudgetPolicy,
} from '@/lib/budgets/service'

export async function GET(): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const [orgBudget, ownBudget] = await Promise.all([
      getOrgBudget(session.organizationId),
      getScopedBudget(session.organizationId, 'member', session.userId),
    ])
    const response: Record<string, unknown> = {
      organization: orgBudget,
      ownMemberLimit: ownBudget,
    }
    if (isOrgAdmin(session)) {
      response.policies = await listActivePolicies(session.organizationId)
    }
    return NextResponse.json(response)
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}

const limitSchema = z.number().min(0).finite().nullable()

const putSchema = z.object({
  scope: z.enum(['organization', 'member', 'project']),
  subjectId: z.string().min(1).max(120).nullable().optional(),
  dailyLimitEur: limitSchema,
  monthlyLimitEur: limitSchema,
  note: z.string().trim().max(500).nullable().optional(),
})

export async function PUT(request: Request): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const body = await request.json().catch(() => null)
    const parsed = putSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid budget payload' }, { status: 400 })
    }
    const { scope, dailyLimitEur, monthlyLimitEur, note } = parsed.data
    const subjectId = parsed.data.subjectId ?? null

    if (scope === 'project') {
      if (!subjectId) {
        return NextResponse.json({ error: 'project scope requires subjectId' }, { status: 400 })
      }
      // Project admins may manage their own project's budget; org admins any.
      if (!isOrgAdmin(session)) {
        await requireProjectAccess(session as AuthorizedSession, subjectId, 'project:manage')
      }
    } else if (!isOrgAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const policy = await setBudgetPolicy({
      organizationId: session.organizationId,
      scope,
      subjectId: scope === 'organization' ? null : subjectId,
      dailyLimitEur,
      monthlyLimitEur,
      actorUserId: session.userId,
      note: note ?? null,
    })
    return NextResponse.json({ policy }, { status: 201 })
  } catch (error) {
    if (error instanceof BudgetValidationError) {
      return NextResponse.json({ error: error.message }, { status: 422 })
    }
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}

const deleteSchema = z.object({
  scope: z.enum(['member', 'project']),
  subjectId: z.string().min(1).max(120),
})

/** Remove a scoped limit — the subject falls back to the org limits alone. */
export async function DELETE(request: Request): Promise<Response> {
  try {
    const session = await requireAuthorizedSession()
    const body = await request.json().catch(() => null)
    const parsed = deleteSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid payload' }, { status: 400 })
    }
    const { scope, subjectId } = parsed.data
    if (scope === 'project') {
      if (!isOrgAdmin(session)) {
        await requireProjectAccess(session as AuthorizedSession, subjectId, 'project:manage')
      }
    } else if (!isOrgAdmin(session)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    const removed = await clearBudgetPolicy({
      organizationId: session.organizationId,
      scope,
      subjectId,
      actorUserId: session.userId,
    })
    return NextResponse.json({ removed })
  } catch (error) {
    const denied = authzErrorResponse(error)
    if (denied) return denied
    throw error
  }
}
